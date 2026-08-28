use std::{
    env, fs,
    fs::File,
    io::Read,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

const INGEST_ADDRESS: &str = "127.0.0.1:43117";

pub struct ManagedObservers {
    children: Vec<Child>,
    pub summary: String,
}

impl ManagedObservers {
    pub fn disabled() -> Self {
        Self {
            children: Vec::new(),
            summary: "REPLAY ONLY".into(),
        }
    }

    pub fn start(data_dir: &Path) -> Self {
        match Self::try_start(data_dir) {
            Ok(stack) => stack,
            Err(error) => Self {
                children: Vec::new(),
                summary: format!("OBSERVE ERROR · {error}"),
            },
        }
    }

    fn try_start(data_dir: &Path) -> Result<Self, String> {
        let mut stack = Self {
            children: Vec::new(),
            summary: String::new(),
        };
        let endpoint = INGEST_ADDRESS
            .parse::<SocketAddr>()
            .map_err(|error| error.to_string())?;
        let already_running = endpoint_is_ready(endpoint);
        let token = if already_running {
            existing_token(data_dir)
                .or_else(|| env::var("ORCHETRACE_TOKEN").ok())
                .ok_or("ingest is active but its token is unavailable")?
        } else {
            let token = secure_token()?;
            let otrace = resolve_otrace()?;
            let state_root = data_dir
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| data_dir.to_path_buf());
            fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
            fs::create_dir_all(&state_root).map_err(|error| error.to_string())?;
            let child = Command::new(otrace)
                .arg("serve")
                .arg("--listen")
                .arg(INGEST_ADDRESS)
                .arg("--token")
                .arg(&token)
                .arg("--data-dir")
                .arg(data_dir)
                .arg("--db")
                .arg(state_root.join("orchetrace.db"))
                .arg("--no-live")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| format!("failed to start ingest: {error}"))?;
            stack.children.push(child);
            wait_for_endpoint(endpoint, Duration::from_secs(4))?;
            token
        };

        let node = resolve_node()?;
        let project_root = resolve_project_root()?;
        let state_root = data_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| data_dir.to_path_buf());
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or("HOME is unavailable")?;

        let observers = [
            ObserverSpec {
                label: "CLAUDE",
                script_env: "ORCHETRACE_CLAUDE_AUTO_SCRIPT",
                script: project_root.join("packages/claude-adapter/src/auto-cli.ts"),
                directory_flag: "--projects-dir",
                sessions_dir: env::var_os("ORCHETRACE_CLAUDE_PROJECTS_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".claude/projects")),
                state_dir: state_root.join("claude-auto"),
            },
            ObserverSpec {
                label: "PI",
                script_env: "ORCHETRACE_PI_AUTO_SCRIPT",
                script: project_root.join("packages/pi-adapter/src/auto-cli.ts"),
                directory_flag: "--sessions-dir",
                sessions_dir: env::var_os("ORCHETRACE_PI_SESSIONS_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".pi/agent/sessions")),
                state_dir: state_root.join("pi-auto"),
            },
            ObserverSpec {
                label: "HARNESS",
                script_env: "ORCHETRACE_DSH_AUTO_SCRIPT",
                script: project_root.join("packages/dsh-observer/src/auto-cli.ts"),
                directory_flag: "--sessions-dir",
                sessions_dir: env::var_os("ORCHETRACE_DSH_SESSIONS_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".dsh/sessions")),
                state_dir: state_root.join("dsh-auto"),
            },
        ];
        let mut attached = Vec::new();
        for observer in observers {
            let script = env::var_os(observer.script_env)
                .map(PathBuf::from)
                .unwrap_or(observer.script);
            if !script.is_file() {
                continue;
            }
            fs::create_dir_all(&observer.state_dir).map_err(|error| error.to_string())?;
            let mut child = Command::new(&node)
                .arg(script)
                .arg(observer.directory_flag)
                .arg(observer.sessions_dir)
                .arg("--state-dir")
                .arg(observer.state_dir)
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg("43117")
                .arg("--token")
                .arg(&token)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| format!("failed to start {} observer: {error}", observer.label))?;
            thread::sleep(Duration::from_millis(35));
            if child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                attached.push(observer.label);
                stack.children.push(child);
            }
        }
        wait_for_first_run(data_dir, Duration::from_secs(3));
        let owner = if already_running { "SHARED" } else { "MANAGED" };
        let summary = if attached.is_empty() {
            format!("{owner} INGEST · NO WATCHERS")
        } else {
            format!("{owner} · {}", attached.join("/"))
        };
        stack.summary = summary;
        Ok(stack)
    }
}

impl Drop for ManagedObservers {
    fn drop(&mut self) {
        for child in self.children.iter_mut().rev() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct ObserverSpec {
    label: &'static str,
    script_env: &'static str,
    script: PathBuf,
    directory_flag: &'static str,
    sessions_dir: PathBuf,
    state_dir: PathBuf,
}

fn endpoint_is_ready(address: SocketAddr) -> bool {
    TcpStream::connect_timeout(&address, Duration::from_millis(120)).is_ok()
}

fn wait_for_endpoint(address: SocketAddr, timeout: Duration) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if endpoint_is_ready(address) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(40));
    }
    Err(format!("ingest did not listen on {address}"))
}

fn existing_token(data_dir: &Path) -> Option<String> {
    let bytes = fs::read(data_dir.join("live-config.json")).ok()?;
    let config = serde_json::from_slice::<Value>(&bytes).ok()?;
    config
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .map(str::to_owned)
}

fn wait_for_first_run(data_dir: &Path, timeout: Duration) {
    let started = Instant::now();
    while started.elapsed() < timeout {
        let has_run = fs::read(data_dir.join("run-catalog.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|catalog| catalog.get("runs").and_then(Value::as_array).cloned())
            .is_some_and(|runs| !runs.is_empty());
        if has_run {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn secure_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    if File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .is_err()
    {
        let seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos()
            ^ u128::from(std::process::id());
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = seed.rotate_left(index as u32) as u8 ^ index as u8;
        }
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn resolve_otrace() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("ORCHETRACE_CLI_PATH").map(PathBuf::from)
        && path.is_file()
    {
        return Ok(path);
    }
    if let Ok(current) = env::current_exe() {
        let sibling = current.with_file_name("otrace");
        if sibling.is_file() {
            return Ok(sibling);
        }
    }
    let development = resolve_project_root()?.join("target/debug/otrace");
    development
        .is_file()
        .then_some(development)
        .ok_or_else(|| "otrace ingest binary is unavailable; reinstall OrcheTrace".into())
}

fn resolve_node() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("ORCHETRACE_NODE_PATH").map(PathBuf::from)
        && path.is_file()
    {
        return Ok(path);
    }
    [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|path| path.is_file())
    .ok_or_else(|| "Node.js is unavailable".into())
}

fn resolve_project_root() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("ORCHETRACE_PROJECT_ROOT").map(PathBuf::from)
        && path.is_dir()
    {
        return Ok(path);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "cannot resolve the OrcheTrace project root".into())
}
