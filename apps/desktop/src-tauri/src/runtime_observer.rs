use std::{
    collections::VecDeque,
    fs,
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

use crate::ingest::DiagnosticLine;

const MAX_LOG_LINES: usize = 160;
const MAX_LOG_CHARS: usize = 2_000;

#[derive(Debug, Clone)]
pub struct RuntimeObserverConfig {
    pub runtime: &'static str,
    pub node_path: PathBuf,
    pub auto_script: PathBuf,
    pub sessions_dir: PathBuf,
    pub state_dir: PathBuf,
    pub ingest_host: String,
    pub ingest_port: u16,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RuntimeObserverStatus {
    pub runtime: String,
    pub phase: String,
    pub pid: Option<u32>,
    pub sessions_dir: String,
    pub last_exit_code: Option<i32>,
    pub logs: Vec<DiagnosticLine>,
}

#[derive(Debug)]
struct ProcessRecord {
    child: Option<Child>,
    last_exit_code: Option<i32>,
    phase: &'static str,
}

impl Default for ProcessRecord {
    fn default() -> Self {
        Self {
            child: None,
            last_exit_code: None,
            phase: "stopped",
        }
    }
}

#[derive(Debug)]
pub struct ManagedRuntimeObserver {
    config: RuntimeObserverConfig,
    process: Mutex<ProcessRecord>,
    logs: Arc<Mutex<VecDeque<DiagnosticLine>>>,
}

impl ManagedRuntimeObserver {
    pub fn new(config: RuntimeObserverConfig) -> Self {
        Self {
            config,
            process: Mutex::new(ProcessRecord::default()),
            logs: Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_LINES))),
        }
    }

    pub fn status(&self) -> Result<RuntimeObserverStatus, String> {
        let mut process = self.lock_process()?;
        self.refresh(&mut process)?;
        Ok(self.snapshot(&process))
    }

    pub fn start(&self, token: &str) -> Result<RuntimeObserverStatus, String> {
        let mut process = self.lock_process()?;
        self.refresh(&mut process)?;
        if process.child.is_some() {
            return Ok(self.snapshot(&process));
        }
        self.ensure_runtime()?;
        fs::create_dir_all(&self.config.state_dir)
            .map_err(|error| format!("{}: {error}", self.config.state_dir.display()))?;
        let mut child = Command::new(&self.config.node_path)
            .arg(&self.config.auto_script)
            .arg("--sessions-dir")
            .arg(&self.config.sessions_dir)
            .arg("--state-dir")
            .arg(&self.config.state_dir)
            .arg("--host")
            .arg(&self.config.ingest_host)
            .arg("--port")
            .arg(self.config.ingest_port.to_string())
            .env("ORCHETRACE_TOKEN", token)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                format!(
                    "failed to start {} auto-discovery: {error}",
                    self.config.runtime
                )
            })?;
        let pid = child.id();
        if let Some(stdout) = child.stdout.take() {
            pump_lines(stdout, self.config.runtime, Arc::clone(&self.logs));
        }
        if let Some(stderr) = child.stderr.take() {
            pump_lines(stderr, self.config.runtime, Arc::clone(&self.logs));
        }
        push_log(
            &self.logs,
            "desktop",
            format!(
                "started {} auto-discovery process {pid}",
                self.config.runtime
            ),
        );
        process.child = Some(child);
        process.last_exit_code = None;
        process.phase = "running";
        Ok(self.snapshot(&process))
    }

    pub fn stop(&self) -> Result<RuntimeObserverStatus, String> {
        let mut process = self.lock_process()?;
        self.refresh(&mut process)?;
        let Some(mut child) = process.child.take() else {
            process.phase = "stopped";
            return Ok(self.snapshot(&process));
        };
        let exit = match child.kill() {
            Ok(()) => child.wait().map_err(|error| {
                format!(
                    "failed to reap {} auto-discovery: {error}",
                    self.config.runtime
                )
            })?,
            Err(kill_error) => child
                .try_wait()
                .map_err(|error| {
                    format!(
                        "failed to inspect {} auto-discovery: {error}",
                        self.config.runtime
                    )
                })?
                .ok_or_else(|| {
                    format!(
                        "failed to stop {} auto-discovery: {kill_error}",
                        self.config.runtime
                    )
                })?,
        };
        process.last_exit_code = exit.code();
        process.phase = "stopped";
        push_log(
            &self.logs,
            "desktop",
            format!("stopped {} auto-discovery", self.config.runtime),
        );
        Ok(self.snapshot(&process))
    }

    fn ensure_runtime(&self) -> Result<(), String> {
        if !self.config.node_path.is_file() {
            return Err(format!(
                "Node.js is unavailable at {}",
                self.config.node_path.display()
            ));
        }
        if !self.config.auto_script.is_file() {
            return Err(format!(
                "{} auto-discovery is unavailable at {}",
                self.config.runtime,
                self.config.auto_script.display()
            ));
        }
        Ok(())
    }

    fn lock_process(&self) -> Result<MutexGuard<'_, ProcessRecord>, String> {
        self.process
            .lock()
            .map_err(|_| format!("managed {} state is poisoned", self.config.runtime))
    }

    fn refresh(&self, process: &mut ProcessRecord) -> Result<(), String> {
        let exit = process
            .child
            .as_mut()
            .map(Child::try_wait)
            .transpose()
            .map_err(|error| {
                format!(
                    "failed to inspect {} auto-discovery: {error}",
                    self.config.runtime
                )
            })?
            .flatten();
        if let Some(exit) = exit {
            process.child.take();
            process.last_exit_code = exit.code();
            process.phase = "exited";
            push_log(
                &self.logs,
                "desktop",
                format!(
                    "{} auto-discovery exited with {:?}",
                    self.config.runtime,
                    exit.code()
                ),
            );
        }
        Ok(())
    }

    fn snapshot(&self, process: &ProcessRecord) -> RuntimeObserverStatus {
        let phase = if !self.config.node_path.is_file() || !self.config.auto_script.is_file() {
            "unavailable"
        } else {
            process.phase
        };
        RuntimeObserverStatus {
            runtime: self.config.runtime.to_owned(),
            phase: phase.to_owned(),
            pid: process.child.as_ref().map(Child::id),
            sessions_dir: self.config.sessions_dir.display().to_string(),
            last_exit_code: process.last_exit_code,
            logs: self
                .logs
                .lock()
                .map_or_else(|_| Vec::new(), |logs| logs.iter().cloned().collect()),
        }
    }
}

impl Drop for ManagedRuntimeObserver {
    fn drop(&mut self) {
        if let Ok(process) = self.process.get_mut()
            && let Some(mut child) = process.child.take()
        {
            let _ = child.kill();
            let _ = child.wait();
        }
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
    let stream = stream.into();
    let mut message = message.into();
    if message.chars().count() > MAX_LOG_CHARS {
        message = message.chars().take(MAX_LOG_CHARS).collect();
        message.push('…');
    }
    #[cfg(debug_assertions)]
    eprintln!("[orchetrace:{stream}] {message}");
    if let Ok(mut logs) = logs.lock() {
        if logs.len() == MAX_LOG_LINES {
            logs.pop_front();
        }
        logs.push_back(DiagnosticLine {
            at_ms: now_ms(),
            stream,
            message,
        });
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}

#[cfg(test)]
mod tests {
    use super::{ManagedRuntimeObserver, RuntimeObserverConfig};
    use std::path::PathBuf;

    #[test]
    fn missing_runtime_is_reported_as_unavailable() {
        let managed = ManagedRuntimeObserver::new(RuntimeObserverConfig {
            runtime: "pi",
            node_path: PathBuf::from("/definitely/missing/node"),
            auto_script: PathBuf::from("/definitely/missing/auto.ts"),
            sessions_dir: PathBuf::from("sessions"),
            state_dir: PathBuf::from("state"),
            ingest_host: "127.0.0.1".to_owned(),
            ingest_port: 43117,
        });
        assert_eq!(
            managed.status().expect("status should load").phase,
            "unavailable"
        );
        assert!(
            managed
                .start("token")
                .expect_err("start should fail")
                .contains("Node.js")
        );
    }
}
