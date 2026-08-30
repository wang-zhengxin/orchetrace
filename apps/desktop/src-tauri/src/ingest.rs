use std::{
    collections::VecDeque,
    fs,
    io::{BufRead, BufReader, BufWriter, Read, Write},
    net::TcpStream,
    path::PathBuf,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

const MAX_LOG_LINES: usize = 160;
const MAX_LOG_CHARS: usize = 2_000;
const CONTROL_TIMEOUT: Duration = Duration::from_secs(1);
const GRACEFUL_EXIT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone)]
pub struct IngestConfig {
    pub cli_path: PathBuf,
    pub data_dir: PathBuf,
    pub database_path: PathBuf,
    pub ingest_endpoint: String,
    pub live_endpoint: String,
    pub web_origin: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DiagnosticLine {
    pub at_ms: u128,
    pub stream: String,
    pub severity: String,
    pub code: Option<String>,
    pub location: Option<String>,
    pub message: String,
}

impl DiagnosticLine {
    pub(crate) fn new(at_ms: u128, stream: impl Into<String>, message: impl Into<String>) -> Self {
        let stream = stream.into();
        let message = message.into();
        let (severity, code, location, message) = parse_diagnostic(&message);
        Self {
            at_ms,
            stream,
            severity,
            code,
            location,
            message,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DiagnosticSummary {
    pub health: String,
    pub warning_count: usize,
    pub error_count: usize,
    pub last_activity_at_ms: Option<u128>,
    pub last_diagnostic: Option<DiagnosticLine>,
}

pub(crate) fn summarize_diagnostics(phase: &str, logs: &[DiagnosticLine]) -> DiagnosticSummary {
    let warning_count = logs
        .iter()
        .filter(|line| line.severity == "warning")
        .count();
    let error_count = logs.iter().filter(|line| line.severity == "error").count();
    let health = match phase {
        "unavailable" => "unavailable",
        "exited" => "error",
        "stopped" => "stopped",
        "running" if error_count > 0 => "degraded",
        "running" if warning_count > 0 => "warning",
        "running" => "healthy",
        _ => "unknown",
    };
    DiagnosticSummary {
        health: health.to_owned(),
        warning_count,
        error_count,
        last_activity_at_ms: logs.last().map(|line| line.at_ms),
        last_diagnostic: logs
            .iter()
            .rev()
            .find(|line| line.severity != "info")
            .cloned(),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IngestStatus {
    pub phase: String,
    pub pid: Option<u32>,
    pub started_at_ms: Option<u128>,
    pub ingest_endpoint: String,
    pub live_endpoint: String,
    pub connection_token: Option<String>,
    pub cli_path: String,
    pub data_dir: String,
    pub last_exit_code: Option<i32>,
    pub diagnostics: DiagnosticSummary,
    pub logs: Vec<DiagnosticLine>,
}

#[derive(Debug)]
struct ProcessRecord {
    child: Option<Child>,
    started_at_ms: Option<u128>,
    connection_token: Option<String>,
    last_exit_code: Option<i32>,
    phase: &'static str,
}

impl Default for ProcessRecord {
    fn default() -> Self {
        Self {
            child: None,
            started_at_ms: None,
            connection_token: None,
            last_exit_code: None,
            phase: "stopped",
        }
    }
}

#[derive(Debug)]
pub struct ManagedIngest {
    config: IngestConfig,
    process: Mutex<ProcessRecord>,
    logs: Arc<Mutex<VecDeque<DiagnosticLine>>>,
}

impl ManagedIngest {
    pub fn new(config: IngestConfig) -> Self {
        Self {
            config,
            process: Mutex::new(ProcessRecord::default()),
            logs: Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_LINES))),
        }
    }

    pub fn status(&self) -> Result<IngestStatus, String> {
        let mut process = self.lock_process()?;
        self.refresh(&mut process)?;
        Ok(self.snapshot(&process))
    }

    pub fn start(&self) -> Result<IngestStatus, String> {
        let mut process = self.lock_process()?;
        self.refresh(&mut process)?;
        if process.child.is_some() {
            return Ok(self.snapshot(&process));
        }
        if !self.config.cli_path.is_file() {
            process.phase = "unavailable";
            return Err(format!(
                "otrace executable is unavailable at {}",
                self.config.cli_path.display()
            ));
        }

        fs::create_dir_all(&self.config.data_dir)
            .map_err(|error| format!("{}: {error}", self.config.data_dir.display()))?;
        if let Some(parent) = self.config.database_path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
        }

        self.clear_logs();
        let token = random_token()?;
        let mut command = Command::new(&self.config.cli_path);
        command
            .arg("serve")
            .arg("--listen")
            .arg(&self.config.ingest_endpoint)
            .arg("--live-listen")
            .arg(&self.config.live_endpoint)
            .arg("--web-origin")
            .arg(&self.config.web_origin)
            .arg("--db")
            .arg(&self.config.database_path)
            .arg("--data-dir")
            .arg(&self.config.data_dir)
            .env("ORCHETRACE_TOKEN", &token)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|error| {
            format!(
                "failed to start {}: {error}",
                self.config.cli_path.display()
            )
        })?;
        let pid = child.id();
        if let Some(stdout) = child.stdout.take() {
            pump_lines(stdout, "stdout", Arc::clone(&self.logs));
        }
        if let Some(stderr) = child.stderr.take() {
            pump_lines(stderr, "stderr", Arc::clone(&self.logs));
        }
        push_log(
            &self.logs,
            "desktop",
            format!("started managed ingest process {pid}"),
        );

        process.child = Some(child);
        process.started_at_ms = Some(now_ms());
        process.connection_token = Some(token);
        process.last_exit_code = None;
        process.phase = "running";
        Ok(self.snapshot(&process))
    }

    pub fn stop(&self) -> Result<IngestStatus, String> {
        let mut process = self.lock_process()?;
        self.refresh(&mut process)?;
        let Some(mut child) = process.child.take() else {
            process.phase = "stopped";
            process.connection_token = None;
            return Ok(self.snapshot(&process));
        };

        push_log(&self.logs, "desktop", "stopping managed ingest process");
        let token = process.connection_token.clone();
        let exit = match stop_child(
            &mut child,
            &self.config.ingest_endpoint,
            token.as_deref(),
            &self.logs,
        ) {
            Ok(exit) => exit,
            Err(error) => {
                process.child = Some(child);
                process.phase = "running";
                return Err(error);
            }
        };
        process.last_exit_code = exit.code();
        process.connection_token = None;
        process.phase = "stopped";
        Ok(self.snapshot(&process))
    }

    fn lock_process(&self) -> Result<MutexGuard<'_, ProcessRecord>, String> {
        self.process
            .lock()
            .map_err(|_| "managed ingest state is poisoned".to_owned())
    }

    fn refresh(&self, process: &mut ProcessRecord) -> Result<(), String> {
        let exit = process
            .child
            .as_mut()
            .map(Child::try_wait)
            .transpose()
            .map_err(|error| format!("failed to inspect ingest process: {error}"))?
            .flatten();
        if let Some(exit) = exit {
            process.child.take();
            process.last_exit_code = exit.code();
            process.connection_token = None;
            process.phase = "exited";
            push_log(
                &self.logs,
                "desktop",
                format!("ingest process exited with {:?}", exit.code()),
            );
        }
        Ok(())
    }

    fn snapshot(&self, process: &ProcessRecord) -> IngestStatus {
        let phase = if process.child.is_none() && !self.config.cli_path.is_file() {
            "unavailable"
        } else {
            process.phase
        };
        let logs = self.logs.lock().map_or_else(
            |_| Vec::new(),
            |logs| logs.iter().cloned().collect::<Vec<_>>(),
        );
        let diagnostics = summarize_diagnostics(phase, &logs);
        IngestStatus {
            phase: phase.to_owned(),
            pid: process.child.as_ref().map(Child::id),
            started_at_ms: process.started_at_ms,
            ingest_endpoint: self.config.ingest_endpoint.clone(),
            live_endpoint: self.config.live_endpoint.clone(),
            connection_token: process.connection_token.clone(),
            cli_path: self.config.cli_path.display().to_string(),
            data_dir: self.config.data_dir.display().to_string(),
            last_exit_code: process.last_exit_code,
            diagnostics,
            logs,
        }
    }

    fn clear_logs(&self) {
        if let Ok(mut logs) = self.logs.lock() {
            logs.clear();
        }
    }
}

impl Drop for ManagedIngest {
    fn drop(&mut self) {
        if let Ok(process) = self.process.get_mut()
            && let Some(mut child) = process.child.take()
        {
            let _ = stop_child(
                &mut child,
                &self.config.ingest_endpoint,
                process.connection_token.as_deref(),
                &self.logs,
            );
        }
    }
}

fn stop_child(
    child: &mut Child,
    ingest_endpoint: &str,
    token: Option<&str>,
    logs: &Arc<Mutex<VecDeque<DiagnosticLine>>>,
) -> Result<ExitStatus, String> {
    if let Some(token) = token {
        match request_graceful_shutdown(ingest_endpoint, token) {
            Ok(()) => {
                push_log(logs, "desktop", "graceful shutdown acknowledged");
                if let Some(exit) = wait_for_exit(child, GRACEFUL_EXIT_TIMEOUT)? {
                    push_log(
                        logs,
                        "desktop",
                        format!("managed ingest stopped gracefully with {:?}", exit.code()),
                    );
                    return Ok(exit);
                }
                push_log(
                    logs,
                    "desktop",
                    "graceful shutdown timed out; forcing process termination",
                );
            }
            Err(error) => push_log(
                logs,
                "desktop",
                format!("graceful shutdown unavailable ({error}); forcing process termination"),
            ),
        }
    }

    match child.kill() {
        Ok(()) => child
            .wait()
            .map_err(|error| format!("failed to reap ingest process: {error}")),
        Err(kill_error) => child
            .try_wait()
            .map_err(|error| format!("failed to inspect ingest process: {error}"))?
            .ok_or_else(|| format!("failed to stop ingest process: {kill_error}")),
    }
}

fn request_graceful_shutdown(ingest_endpoint: &str, token: &str) -> Result<(), String> {
    let stream = TcpStream::connect(ingest_endpoint)
        .map_err(|error| format!("control connection failed: {error}"))?;
    stream
        .set_read_timeout(Some(CONTROL_TIMEOUT))
        .map_err(|error| format!("control read timeout failed: {error}"))?;
    stream
        .set_write_timeout(Some(CONTROL_TIMEOUT))
        .map_err(|error| format!("control write timeout failed: {error}"))?;
    let mut writer = BufWriter::new(
        stream
            .try_clone()
            .map_err(|error| format!("control connection clone failed: {error}"))?,
    );
    write_control_frame(
        &mut writer,
        &serde_json::json!({ "kind": "hello", "protocol": 1, "token": token }),
    )?;

    let mut reader = BufReader::new(stream);
    let ready = read_control_frame(&mut reader)?;
    if ready.get("kind").and_then(serde_json::Value::as_str) != Some("ready")
        || ready.get("protocol").and_then(serde_json::Value::as_u64) != Some(1)
    {
        return Err("server rejected the authenticated control handshake".to_owned());
    }

    write_control_frame(
        &mut writer,
        &serde_json::json!({ "kind": "control.shutdown", "protocol": 1 }),
    )?;
    let accepted = read_control_frame(&mut reader)?;
    if accepted.get("kind").and_then(serde_json::Value::as_str) != Some("shutdown.accepted")
        || accepted.get("protocol").and_then(serde_json::Value::as_u64) != Some(1)
    {
        return Err("server did not acknowledge graceful shutdown".to_owned());
    }
    Ok(())
}

fn write_control_frame(
    writer: &mut BufWriter<TcpStream>,
    frame: &serde_json::Value,
) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, frame)
        .map_err(|error| format!("control frame serialization failed: {error}"))?;
    writer
        .write_all(b"\n")
        .and_then(|()| writer.flush())
        .map_err(|error| format!("control frame write failed: {error}"))
}

fn read_control_frame(reader: &mut BufReader<TcpStream>) -> Result<serde_json::Value, String> {
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) => return Err("control connection closed before a response".to_owned()),
        Ok(_) => {}
        Err(error) => return Err(format!("control response read failed: {error}")),
    }
    serde_json::from_str(line.trim())
        .map_err(|error| format!("control response was invalid JSON: {error}"))
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> Result<Option<ExitStatus>, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(exit) = child
            .try_wait()
            .map_err(|error| format!("failed to inspect ingest process: {error}"))?
        {
            return Ok(Some(exit));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn pump_lines(
    reader: impl Read + Send + 'static,
    stream: &'static str,
    logs: Arc<Mutex<VecDeque<DiagnosticLine>>>,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(line) => push_log(&logs, stream, line),
                Err(error) => {
                    push_log(
                        &logs,
                        "desktop",
                        format!("failed to read {stream}: {error}"),
                    );
                    break;
                }
            }
        }
    });
}

fn push_log(
    logs: &Arc<Mutex<VecDeque<DiagnosticLine>>>,
    stream: impl Into<String>,
    message: impl Into<String>,
) {
    let mut message = message.into();
    if message.chars().count() > MAX_LOG_CHARS {
        message = message.chars().take(MAX_LOG_CHARS).collect();
        message.push('…');
    }
    if let Ok(mut logs) = logs.lock() {
        if logs.len() == MAX_LOG_LINES {
            logs.pop_front();
        }
        logs.push_back(DiagnosticLine::new(now_ms(), stream, message));
    }
}

fn parse_diagnostic(message: &str) -> (String, Option<String>, Option<String>, String) {
    let (severity, remainder) = if let Some(remainder) = message.strip_prefix("ERROR") {
        ("error", remainder)
    } else if let Some(remainder) = message.strip_prefix("WARNING") {
        ("warning", remainder)
    } else {
        return ("info".to_owned(), None, None, message.to_owned());
    };
    let remainder = remainder.trim_start();
    if let Some(message) = remainder.strip_prefix(':') {
        return (
            severity.to_owned(),
            None,
            None,
            message.trim_start().to_owned(),
        );
    }
    let Some((header, body)) = remainder.split_once(": ") else {
        return (severity.to_owned(), None, None, remainder.to_owned());
    };
    let mut fields = header.split_whitespace();
    let code = fields
        .next()
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let location = fields.collect::<Vec<_>>().join(" ");
    (
        severity.to_owned(),
        code,
        (!location.is_empty()).then_some(location),
        body.trim_start().to_owned(),
    )
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("system random source failed: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}

#[cfg(test)]
mod tests {
    use super::{
        DiagnosticLine, IngestConfig, MAX_LOG_CHARS, MAX_LOG_LINES, ManagedIngest, push_log,
        random_token, request_graceful_shutdown, summarize_diagnostics,
    };
    use std::{
        collections::HashSet,
        fs,
        net::{TcpListener, TcpStream},
        path::PathBuf,
        sync::{Arc, Mutex},
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn connection_tokens_are_unique_256_bit_hex_values() {
        let tokens = (0..8)
            .map(|_| random_token().expect("system randomness should be available"))
            .collect::<HashSet<_>>();
        assert_eq!(tokens.len(), 8);
        assert!(tokens.iter().all(|token| token.len() == 64));
        assert!(
            tokens
                .iter()
                .all(|token| token.bytes().all(|byte| byte.is_ascii_hexdigit()))
        );
    }

    #[test]
    fn diagnostic_buffer_is_bounded_and_truncates_large_lines() {
        let logs = Arc::new(Mutex::new(std::collections::VecDeque::new()));
        for index in 0..=MAX_LOG_LINES {
            push_log(&logs, "test", format!("line-{index}"));
        }
        push_log(&logs, "test", "x".repeat(MAX_LOG_CHARS + 20));
        let logs = logs.lock().expect("logs should not be poisoned");
        assert_eq!(logs.len(), MAX_LOG_LINES);
        assert_eq!(
            logs.back()
                .expect("last line should exist")
                .message
                .chars()
                .count(),
            MAX_LOG_CHARS + 1
        );
        assert!(!logs.iter().any(|line| line.message == "line-0"));
    }

    #[test]
    fn adapter_diagnostics_are_structured_and_affect_health() {
        let logs = vec![
            DiagnosticLine::new(1, "pi", "watching sessions"),
            DiagnosticLine::new(
                2,
                "pi",
                "WARNING line-json-invalid session.jsonl#3: cannot parse JSON",
            ),
            DiagnosticLine::new(3, "pi", "ERROR rpc-process-error: process stopped"),
        ];
        assert_eq!(logs[1].severity, "warning");
        assert_eq!(logs[1].code.as_deref(), Some("line-json-invalid"));
        assert_eq!(logs[1].location.as_deref(), Some("session.jsonl#3"));
        let summary = summarize_diagnostics("running", &logs);
        assert_eq!(summary.health, "degraded");
        assert_eq!(summary.warning_count, 1);
        assert_eq!(summary.error_count, 1);
        assert_eq!(summary.last_diagnostic.as_ref().unwrap().at_ms, 3);
    }

    #[test]
    fn missing_sidecar_is_reported_without_spawning_an_arbitrary_command() {
        let managed = ManagedIngest::new(IngestConfig {
            cli_path: PathBuf::from("/definitely/missing/orchetrace/otrace"),
            data_dir: PathBuf::from("data"),
            database_path: PathBuf::from("orchetrace.db"),
            ingest_endpoint: "127.0.0.1:43117".to_owned(),
            live_endpoint: "127.0.0.1:43118".to_owned(),
            web_origin: "tauri://localhost".to_owned(),
        });
        assert_eq!(
            managed.status().expect("status should load").phase,
            "unavailable"
        );
        assert!(
            managed
                .start()
                .expect_err("start should fail")
                .contains("unavailable")
        );
    }

    #[test]
    #[ignore = "requires ORCHETRACE_TEST_CLI pointing to a built otrace sidecar"]
    fn real_sidecar_starts_writes_authenticated_live_config_and_stops() {
        let cli_path = std::env::var_os("ORCHETRACE_TEST_CLI")
            .map(PathBuf::from)
            .expect("ORCHETRACE_TEST_CLI is required");
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "orchetrace-managed-ingest-{}-{nonce}",
            std::process::id()
        ));
        let data_dir = directory.join("data");
        let ingest_endpoint = reserve_loopback_address();
        let live_endpoint = reserve_loopback_address();
        let managed = ManagedIngest::new(IngestConfig {
            cli_path,
            data_dir: data_dir.clone(),
            database_path: directory.join("orchetrace.db"),
            ingest_endpoint: ingest_endpoint.clone(),
            live_endpoint: live_endpoint.clone(),
            web_origin: "tauri://localhost".to_owned(),
        });

        let started = managed.start().expect("sidecar should start");
        assert_eq!(started.phase, "running");
        wait_for_listener(&ingest_endpoint);
        wait_for_listener(&live_endpoint);
        assert!(request_graceful_shutdown(&ingest_endpoint, "wrong-token").is_err());
        assert_eq!(
            managed
                .status()
                .expect("unauthorized control must not stop the sidecar")
                .phase,
            "running"
        );

        let live_config: serde_json::Value = serde_json::from_slice(
            &fs::read(data_dir.join("live-config.json")).expect("live config should exist"),
        )
        .expect("live config should be valid JSON");
        assert_eq!(live_config["enabled"], true);
        assert_eq!(live_config["allowed_origin"], "tauri://localhost");
        assert_eq!(
            live_config["token"].as_str(),
            started.connection_token.as_deref()
        );

        let stopped = managed.stop().expect("sidecar should stop");
        assert_eq!(stopped.phase, "stopped");
        assert!(stopped.pid.is_none());
        assert!(stopped.connection_token.is_none());
        assert_eq!(stopped.last_exit_code, Some(0));
        assert!(
            stopped
                .logs
                .iter()
                .any(|line| line.message.contains("stopped gracefully"))
        );
        let stopped_live_config: serde_json::Value = serde_json::from_slice(
            &fs::read(data_dir.join("live-config.json")).expect("stopped live config should exist"),
        )
        .expect("stopped live config should be valid JSON");
        assert_eq!(stopped_live_config["enabled"], false);
        assert!(stopped_live_config.get("token").is_none());
        fs::remove_dir_all(directory).expect("smoke directory should be removed");
    }

    fn reserve_loopback_address() -> String {
        TcpListener::bind("127.0.0.1:0")
            .expect("ephemeral listener should bind")
            .local_addr()
            .expect("listener address should resolve")
            .to_string()
    }

    fn wait_for_listener(address: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if TcpStream::connect(address).is_ok() {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("listener {address} did not become ready");
    }
}
