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
const HOOK_MARKER: &str = "ORCHETRACE_CLAUDE_HOOK=1";

#[derive(Debug, Clone)]
pub struct ClaudeConfig {
    pub node_path: PathBuf,
    pub auto_script: PathBuf,
    pub hook_script: PathBuf,
    pub projects_dir: PathBuf,
    pub state_dir: PathBuf,
    pub hook_events_path: PathBuf,
    pub settings_path: PathBuf,
    pub ingest_host: String,
    pub ingest_port: u16,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ClaudeIntegrationStatus {
    pub phase: String,
    pub pid: Option<u32>,
    pub hooks_installed: bool,
    pub projects_dir: String,
    pub settings_path: String,
    pub hook_events_path: String,
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
pub struct ManagedClaude {
    config: ClaudeConfig,
    process: Mutex<ProcessRecord>,
    logs: Arc<Mutex<VecDeque<DiagnosticLine>>>,
}

impl ManagedClaude {
    pub fn new(config: ClaudeConfig) -> Self {
        Self {
            config,
            process: Mutex::new(ProcessRecord::default()),
            logs: Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_LINES))),
        }
    }

    pub fn status(&self) -> Result<ClaudeIntegrationStatus, String> {
        let mut process = self.lock_process()?;
        self.refresh(&mut process)?;
        Ok(self.snapshot(&process))
    }

    pub fn start(&self, token: &str) -> Result<ClaudeIntegrationStatus, String> {
        let mut process = self.lock_process()?;
        self.refresh(&mut process)?;
        if process.child.is_some() {
            return Ok(self.snapshot(&process));
        }
        self.ensure_runtime()?;
        fs::create_dir_all(&self.config.state_dir)
            .map_err(|error| format!("{}: {error}", self.config.state_dir.display()))?;
        if let Some(parent) = self.config.hook_events_path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
        }

        let mut command = Command::new(&self.config.node_path);
        command
            .arg(&self.config.auto_script)
            .arg("--projects-dir")
            .arg(&self.config.projects_dir)
            .arg("--state-dir")
            .arg(&self.config.state_dir)
            .arg("--hook-events")
            .arg(&self.config.hook_events_path)
            .arg("--host")
            .arg(&self.config.ingest_host)
            .arg("--port")
            .arg(self.config.ingest_port.to_string())
            .env("ORCHETRACE_TOKEN", token)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start Claude auto-discovery: {error}"))?;
        let pid = child.id();
        if let Some(stdout) = child.stdout.take() {
            pump_lines(stdout, "claude-out", Arc::clone(&self.logs));
        }
        if let Some(stderr) = child.stderr.take() {
            pump_lines(stderr, "claude", Arc::clone(&self.logs));
        }
        push_log(
            &self.logs,
            "desktop",
            format!("started Claude auto-discovery process {pid}"),
        );
        process.child = Some(child);
        process.last_exit_code = None;
        process.phase = "running";
        Ok(self.snapshot(&process))
    }

    pub fn stop(&self) -> Result<ClaudeIntegrationStatus, String> {
        let mut process = self.lock_process()?;
        self.refresh(&mut process)?;
        let Some(mut child) = process.child.take() else {
            process.phase = "stopped";
            return Ok(self.snapshot(&process));
        };
        let exit = match child.kill() {
            Ok(()) => child
                .wait()
                .map_err(|error| format!("failed to reap Claude auto-discovery: {error}"))?,
            Err(kill_error) => child
                .try_wait()
                .map_err(|error| format!("failed to inspect Claude auto-discovery: {error}"))?
                .ok_or_else(|| format!("failed to stop Claude auto-discovery: {kill_error}"))?,
        };
        process.last_exit_code = exit.code();
        process.phase = "stopped";
        push_log(&self.logs, "desktop", "stopped Claude auto-discovery");
        Ok(self.snapshot(&process))
    }

    pub fn enable_hooks(&self) -> Result<ClaudeIntegrationStatus, String> {
        self.run_hook_command("install")?;
        push_log(&self.logs, "desktop", "enabled Claude lifecycle hooks");
        self.status()
    }

    pub fn disable_hooks(&self) -> Result<ClaudeIntegrationStatus, String> {
        self.run_hook_command("uninstall")?;
        push_log(&self.logs, "desktop", "disabled Claude lifecycle hooks");
        self.status()
    }

    fn run_hook_command(&self, action: &str) -> Result<(), String> {
        self.ensure_runtime()?;
        if !self.config.hook_script.is_file() {
            return Err(format!(
                "Claude hook installer is unavailable at {}",
                self.config.hook_script.display()
            ));
        }
        let output = Command::new(&self.config.node_path)
            .arg(&self.config.hook_script)
            .arg(action)
            .arg("--settings")
            .arg(&self.config.settings_path)
            .arg("--hook-events")
            .arg(&self.config.hook_events_path)
            .output()
            .map_err(|error| format!("failed to run Claude hook installer: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Claude hook installer failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(())
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
                "Claude auto-discovery is unavailable at {}",
                self.config.auto_script.display()
            ));
        }
        Ok(())
    }

    fn hooks_installed(&self) -> bool {
        fs::read_to_string(&self.config.settings_path)
            .is_ok_and(|settings| settings.matches(HOOK_MARKER).count() >= 5)
    }

    fn lock_process(&self) -> Result<MutexGuard<'_, ProcessRecord>, String> {
        self.process
            .lock()
            .map_err(|_| "managed Claude state is poisoned".to_owned())
    }

    fn refresh(&self, process: &mut ProcessRecord) -> Result<(), String> {
        let exit = process
            .child
            .as_mut()
            .map(Child::try_wait)
            .transpose()
            .map_err(|error| format!("failed to inspect Claude auto-discovery: {error}"))?
            .flatten();
        if let Some(exit) = exit {
            process.child.take();
            process.last_exit_code = exit.code();
            process.phase = "exited";
            push_log(
                &self.logs,
                "desktop",
                format!("Claude auto-discovery exited with {:?}", exit.code()),
            );
        }
        Ok(())
    }

    fn snapshot(&self, process: &ProcessRecord) -> ClaudeIntegrationStatus {
        let phase = if !self.config.node_path.is_file() || !self.config.auto_script.is_file() {
            "unavailable"
        } else {
            process.phase
        };
        ClaudeIntegrationStatus {
            phase: phase.to_owned(),
            pid: process.child.as_ref().map(Child::id),
            hooks_installed: self.hooks_installed(),
            projects_dir: self.config.projects_dir.display().to_string(),
            settings_path: self.config.settings_path.display().to_string(),
            hook_events_path: self.config.hook_events_path.display().to_string(),
            last_exit_code: process.last_exit_code,
            logs: self
                .logs
                .lock()
                .map_or_else(|_| Vec::new(), |logs| logs.iter().cloned().collect()),
        }
    }
}

impl Drop for ManagedClaude {
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
    let mut message = message.into();
    if message.chars().count() > MAX_LOG_CHARS {
        message = message.chars().take(MAX_LOG_CHARS).collect();
        message.push('…');
    }
    if let Ok(mut logs) = logs.lock() {
        if logs.len() == MAX_LOG_LINES {
            logs.pop_front();
        }
        logs.push_back(DiagnosticLine {
            at_ms: now_ms(),
            stream: stream.into(),
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
    use super::{ClaudeConfig, ManagedClaude};
    use std::path::PathBuf;

    #[test]
    fn missing_runtime_is_reported_as_unavailable() {
        let managed = ManagedClaude::new(ClaudeConfig {
            node_path: PathBuf::from("/definitely/missing/node"),
            auto_script: PathBuf::from("/definitely/missing/auto.ts"),
            hook_script: PathBuf::from("/definitely/missing/hook.ts"),
            projects_dir: PathBuf::from("projects"),
            state_dir: PathBuf::from("state"),
            hook_events_path: PathBuf::from("hooks.jsonl"),
            settings_path: PathBuf::from("settings.json"),
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
