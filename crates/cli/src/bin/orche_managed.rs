use std::{
    env, fs,
    fs::File,
    io::{BufRead, BufReader, BufWriter, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use orchetrace_ingest::RunSummary;
use serde_json::{Value, json};

const INGEST_ADDRESS: &str = "127.0.0.1:43117";

pub struct ManagedObservers {
    children: Vec<Child>,
    pub summary: String,
    control: Option<ControlEndpoint>,
    management_unavailable: Option<String>,
}

struct ControlEndpoint {
    address: SocketAddr,
    token: String,
}

impl ManagedObservers {
    pub fn disabled() -> Self {
        Self {
            children: Vec::new(),
            summary: "REPLAY ONLY".into(),
            control: None,
            management_unavailable: Some("orche was started with --replay".into()),
        }
    }

    pub fn start(data_dir: &Path) -> Self {
        match Self::try_start(data_dir) {
            Ok(stack) => stack,
            Err(error) => {
                let summary = format!("OBSERVE ERROR · {error}");
                Self {
                    children: Vec::new(),
                    summary,
                    control: None,
                    management_unavailable: Some(error),
                }
            }
        }
    }

    fn try_start(data_dir: &Path) -> Result<Self, String> {
        let mut stack = Self {
            children: Vec::new(),
            summary: String::new(),
            control: None,
            management_unavailable: None,
        };
        let otrace = resolve_otrace()?;
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
            let state_root = data_dir
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| data_dir.to_path_buf());
            fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
            fs::create_dir_all(&state_root).map_err(|error| error.to_string())?;
            let mut command = Command::new(&otrace);
            command
                .arg("serve")
                .arg("--listen")
                .arg(INGEST_ADDRESS)
                .arg("--token")
                .arg(&token)
                .arg("--data-dir")
                .arg(data_dir)
                .arg("--db")
                .arg(state_root.join("orchetrace.db"))
                .arg("--no-live");
            append_env_option(&mut command, "ORCHETRACE_PRIVACY_MODE", "--privacy-mode");
            append_env_option(
                &mut command,
                "ORCHETRACE_RETENTION_DAYS",
                "--retention-days",
            );
            append_env_option(&mut command, "ORCHETRACE_MAX_EVENTS", "--max-events");
            if let Ok(keys) = env::var("ORCHETRACE_REDACT_KEYS") {
                for key in keys.split(',').map(str::trim).filter(|key| !key.is_empty()) {
                    command.arg("--redact-key").arg(key);
                }
            }
            let child = command
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

        let observers = orchetrace_protocol::REGISTERED_RUNTIMES
            .iter()
            .map(|runtime| ObserverSpec {
                label: runtime.short_label,
                script_env: runtime.observer.script_env,
                script: project_root
                    .join("packages")
                    .join(runtime.observer.package)
                    .join(runtime.observer.entrypoint),
                directory_flag: runtime.observer.directory_flag,
                sessions_dir: env::var_os(runtime.observer.sessions_env)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| expand_home(runtime.session_directory, &home)),
                state_dir: state_root.join(runtime.observer.state_directory),
            })
            .collect::<Vec<_>>();
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
                .env("ORCHETRACE_CLI_PATH", &otrace)
                .env("ORCHETRACE_ZSTD_PATH", &otrace)
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
        stack.control = Some(ControlEndpoint {
            address: endpoint,
            token,
        });
        Ok(stack)
    }

    pub fn rename_session(&self, run: &RunSummary, label: &str) -> Result<(), String> {
        self.send_control(json!({
            "kind": "control.session.rename",
            "protocol": 1,
            "runtime": run.runtime,
            "source_id": run.source_id,
            "session_id": run.root_session_id,
            "label": label
        }))
        .and_then(expect_session_control_success)
    }

    pub fn delete_session(&self, run: &RunSummary) -> Result<(usize, usize), String> {
        let response = self.send_control(json!({
            "kind": "control.session.delete",
            "protocol": 1,
            "runtime": run.runtime,
            "source_id": run.source_id,
            "session_id": run.root_session_id
        }))?;
        expect_session_control_success(response.clone())?;
        Ok((
            response
                .get("deleted_sessions")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize,
            response
                .get("deleted_events")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize,
        ))
    }

    fn send_control(&self, frame: Value) -> Result<Value, String> {
        let endpoint = self.control.as_ref().ok_or_else(|| {
            format!(
                "Session management is unavailable: {}",
                self.management_unavailable
                    .as_deref()
                    .unwrap_or("managed ingest is not connected")
            )
        })?;
        let stream = TcpStream::connect_timeout(&endpoint.address, Duration::from_secs(2))
            .map_err(|error| format!("cannot connect to ingest: {error}"))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .map_err(|error| error.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .map_err(|error| error.to_string())?;
        let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
        let mut writer = BufWriter::new(stream);
        write_control_frame(
            &mut writer,
            &json!({ "kind": "hello", "protocol": 1, "token": endpoint.token }),
        )?;
        let ready = read_control_frame(&mut reader)?;
        if ready.get("kind").and_then(Value::as_str) != Some("ready") {
            return Err(control_error(&ready));
        }
        write_control_frame(&mut writer, &frame)?;
        read_control_frame(&mut reader)
    }
}

fn write_control_frame(writer: &mut BufWriter<TcpStream>, frame: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, frame).map_err(|error| error.to_string())?;
    writer.write_all(b"\n").map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

fn read_control_frame(reader: &mut BufReader<TcpStream>) -> Result<Value, String> {
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    if line.is_empty() {
        return Err("ingest closed the control connection".into());
    }
    serde_json::from_str(line.trim()).map_err(|error| error.to_string())
}

fn expect_session_control_success(response: Value) -> Result<(), String> {
    match response.get("kind").and_then(Value::as_str) {
        Some("session.renamed" | "session.deleted") => Ok(()),
        _ => Err(control_error(&response)),
    }
}

fn control_error(response: &Value) -> String {
    response
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unexpected response from ingest")
        .to_owned()
}

pub fn run_runtime_hooks(runtime: &str, action: &str) -> Result<(), String> {
    if !matches!(action, "install" | "status" | "uninstall") {
        return Err(format!(
            "unsupported hook action `{action}`; expected install, status, or uninstall"
        ));
    }
    let descriptor = orchetrace_protocol::runtime_descriptor(runtime)
        .ok_or_else(|| format!("unknown runtime `{runtime}`"))?;
    if !descriptor.capabilities.contains(&"hooks") {
        return Err(format!(
            "{} does not declare Hook support",
            descriptor.label
        ));
    }
    let node = resolve_node()?;
    let script = resolve_project_root()?
        .join("packages")
        .join(descriptor.observer.package)
        .join("src/hook-cli.ts");
    if !script.is_file() {
        return Err(format!(
            "{} Hook integration is unavailable at {}",
            descriptor.label,
            script.display()
        ));
    }
    let status = Command::new(node)
        .arg(script)
        .arg(action)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| {
            format!(
                "failed to run {} Hook integration: {error}",
                descriptor.label
            )
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "{} Hook integration exited with {status}",
            descriptor.label
        ))
    }
}

fn append_env_option(command: &mut Command, environment: &str, flag: &str) {
    if let Ok(value) = env::var(environment)
        && !value.trim().is_empty()
    {
        command.arg(flag).arg(value);
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

fn expand_home(value: &str, home: &Path) -> PathBuf {
    if value == "~" {
        return home.to_path_buf();
    }
    value
        .strip_prefix("~/")
        .map(|relative| home.join(relative))
        .unwrap_or_else(|| PathBuf::from(value))
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
        let sibling = current.with_file_name(executable_name("otrace"));
        if sibling.is_file() {
            return Ok(sibling);
        }
    }
    let development = resolve_project_root()?
        .join("target/debug")
        .join(executable_name("otrace"));
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
    .or_else(|| find_on_path(executable_name("node")))
    .ok_or_else(|| "Node.js is unavailable".into())
}

fn resolve_project_root() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("ORCHETRACE_PROJECT_ROOT").map(PathBuf::from)
        && path.is_dir()
    {
        return Ok(path);
    }
    if let Ok(current) = env::current_exe() {
        for ancestor in current.ancestors().skip(1) {
            if has_runtime_packages(ancestor) {
                return Ok(ancestor.to_path_buf());
            }
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "cannot resolve the OrcheTrace project root".to_string())?;
    has_runtime_packages(&development)
        .then_some(development)
        .ok_or_else(|| {
            "OrcheTrace Adapter resources are unavailable; reinstall the complete CLI package"
                .into()
        })
}

fn has_runtime_packages(root: &Path) -> bool {
    root.join("packages/adapter-runtime/src/index.ts").is_file()
        && root.join("packages/protocol-ts/src/index.ts").is_file()
}

fn executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn find_on_path(name: String) -> Option<PathBuf> {
    env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .map(|directory| directory.join(&name))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_only_reports_its_actual_management_blocker() {
        let observers = ManagedObservers::disabled();
        let error = observers
            .send_control(json!({ "kind": "control.session.delete" }))
            .unwrap_err();
        assert_eq!(
            error,
            "Session management is unavailable: orche was started with --replay"
        );
    }

    #[test]
    fn observer_start_errors_are_not_mislabeled_as_replay_only() {
        let observers = ManagedObservers {
            children: Vec::new(),
            summary: "OBSERVE ERROR · ingest token missing".into(),
            control: None,
            management_unavailable: Some("ingest token missing".into()),
        };
        let error = observers
            .send_control(json!({ "kind": "control.session.rename" }))
            .unwrap_err();
        assert_eq!(
            error,
            "Session management is unavailable: ingest token missing"
        );
    }
}
