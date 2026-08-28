use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

mod claude;
mod ingest;
mod runtime_observer;

use claude::{ClaudeConfig, ClaudeIntegrationStatus, ManagedClaude};
use ingest::{IngestConfig, IngestStatus, ManagedIngest};
use runtime_observer::{ManagedRuntimeObserver, RuntimeObserverConfig, RuntimeObserverStatus};

#[derive(Debug)]
struct DesktopState {
    data_dir: PathBuf,
    legacy_snapshot: PathBuf,
    ingest: ManagedIngest,
    claude: ManagedClaude,
    pi: ManagedRuntimeObserver,
    harness: ManagedRuntimeObserver,
}

#[derive(Debug, Serialize)]
struct DesktopInfo {
    shell: &'static str,
    version: &'static str,
    platform: &'static str,
    data_dir: String,
    native_catalog: bool,
}

#[tauri::command]
fn desktop_info(state: tauri::State<'_, DesktopState>) -> DesktopInfo {
    DesktopInfo {
        shell: "tauri",
        version: env!("CARGO_PKG_VERSION"),
        platform: env::consts::OS,
        data_dir: state.data_dir.display().to_string(),
        native_catalog: state.data_dir.join("run-catalog.json").is_file(),
    }
}

#[tauri::command]
fn read_catalog(state: tauri::State<'_, DesktopState>) -> Result<Value, String> {
    read_json(&state.data_dir.join("run-catalog.json"))
}

#[tauri::command]
fn read_run_snapshot(
    state: tauri::State<'_, DesktopState>,
    run_id: String,
) -> Result<Value, String> {
    read_json(&run_file(&state.data_dir, "runs", &run_id))
}

#[tauri::command]
fn read_run_delta(state: tauri::State<'_, DesktopState>, run_id: String) -> Result<Value, String> {
    read_json(&run_file(&state.data_dir, "deltas", &run_id))
}

#[tauri::command]
fn read_live_config(state: tauri::State<'_, DesktopState>) -> Result<Value, String> {
    read_json(&state.data_dir.join("live-config.json"))
}

#[tauri::command]
fn read_legacy_snapshot(state: tauri::State<'_, DesktopState>) -> Result<Value, String> {
    read_json(&state.legacy_snapshot)
}

#[tauri::command]
fn managed_ingest_status(state: tauri::State<'_, DesktopState>) -> Result<IngestStatus, String> {
    state.ingest.status()
}

#[tauri::command]
fn start_managed_ingest(state: tauri::State<'_, DesktopState>) -> Result<IngestStatus, String> {
    let status = state.ingest.start()?;
    if let Some(token) = status.connection_token.as_deref() {
        let _ = state.claude.start(token);
        let _ = state.pi.start(token);
        let _ = state.harness.start(token);
    }
    Ok(status)
}

#[tauri::command]
fn stop_managed_ingest(state: tauri::State<'_, DesktopState>) -> Result<IngestStatus, String> {
    let _ = state.harness.stop();
    let _ = state.pi.stop();
    let _ = state.claude.stop();
    state.ingest.stop()
}

#[tauri::command]
fn claude_integration_status(
    state: tauri::State<'_, DesktopState>,
) -> Result<ClaudeIntegrationStatus, String> {
    state.claude.status()
}

#[tauri::command]
fn start_claude_auto(
    state: tauri::State<'_, DesktopState>,
) -> Result<ClaudeIntegrationStatus, String> {
    let ingest = state.ingest.status()?;
    let token = ingest
        .connection_token
        .as_deref()
        .ok_or_else(|| "start the managed ingest service first".to_owned())?;
    state.claude.start(token)
}

#[tauri::command]
fn stop_claude_auto(
    state: tauri::State<'_, DesktopState>,
) -> Result<ClaudeIntegrationStatus, String> {
    state.claude.stop()
}

#[tauri::command]
fn enable_claude_hooks(
    state: tauri::State<'_, DesktopState>,
) -> Result<ClaudeIntegrationStatus, String> {
    state.claude.enable_hooks()
}

#[tauri::command]
fn disable_claude_hooks(
    state: tauri::State<'_, DesktopState>,
) -> Result<ClaudeIntegrationStatus, String> {
    state.claude.disable_hooks()
}

#[tauri::command]
fn pi_integration_status(
    state: tauri::State<'_, DesktopState>,
) -> Result<RuntimeObserverStatus, String> {
    state.pi.status()
}

#[tauri::command]
fn start_pi_auto(state: tauri::State<'_, DesktopState>) -> Result<RuntimeObserverStatus, String> {
    let ingest = state.ingest.status()?;
    let token = ingest
        .connection_token
        .as_deref()
        .ok_or_else(|| "start the managed ingest service first".to_owned())?;
    state.pi.start(token)
}

#[tauri::command]
fn stop_pi_auto(state: tauri::State<'_, DesktopState>) -> Result<RuntimeObserverStatus, String> {
    state.pi.stop()
}

#[tauri::command]
fn harness_integration_status(
    state: tauri::State<'_, DesktopState>,
) -> Result<RuntimeObserverStatus, String> {
    state.harness.status()
}

#[tauri::command]
fn start_harness_auto(
    state: tauri::State<'_, DesktopState>,
) -> Result<RuntimeObserverStatus, String> {
    let ingest = state.ingest.status()?;
    let token = ingest
        .connection_token
        .as_deref()
        .ok_or_else(|| "start the managed ingest service first".to_owned())?;
    state.harness.start(token)
}

#[tauri::command]
fn stop_harness_auto(
    state: tauri::State<'_, DesktopState>,
) -> Result<RuntimeObserverStatus, String> {
    state.harness.stop()
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))
}

fn run_file(data_dir: &Path, collection: &str, run_id: &str) -> PathBuf {
    let encoded = run_id
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    data_dir
        .join(collection)
        .join(format!("run-{encoded}.json"))
}

fn development_legacy_snapshot() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/public/run-snapshot.json")
}

fn development_cli_path() -> PathBuf {
    let executable = if cfg!(windows) {
        "otrace.exe"
    } else {
        "otrace"
    };
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../target/debug")
        .join(executable)
}

fn resolve_cli_path() -> PathBuf {
    if let Some(configured) = env::var_os("ORCHETRACE_CLI_PATH") {
        return PathBuf::from(configured);
    }
    let executable = if cfg!(windows) {
        "otrace.exe"
    } else {
        "otrace"
    };
    if let Ok(current) = env::current_exe()
        && let Some(sibling) = current.parent().map(|parent| parent.join(executable))
        && sibling.is_file()
    {
        return sibling;
    }
    development_cli_path()
}

fn resolve_node_path() -> PathBuf {
    if let Some(configured) = env::var_os("ORCHETRACE_NODE_PATH") {
        return PathBuf::from(configured);
    }
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            let candidate = directory.join(executable);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    for candidate in [
        PathBuf::from("/opt/homebrew/bin").join(executable),
        PathBuf::from("/usr/local/bin").join(executable),
        home_dir().join(".local/bin").join(executable),
        home_dir().join(".bun/bin").join(executable),
    ] {
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from(executable)
}

fn development_claude_script(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/claude-adapter/src")
        .join(name)
}

fn development_adapter_script(package: &str, name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages")
        .join(package)
        .join("src")
        .join(name)
}

fn home_dir() -> PathBuf {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn desktop_web_origin() -> String {
    if cfg!(windows) {
        "http://tauri.localhost".to_owned()
    } else {
        "tauri://localhost".to_owned()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let configured_data_dir = env::var_os("ORCHETRACE_DATA_DIR").map(PathBuf::from);
            let data_dir = configured_data_dir.unwrap_or_else(|| app_data_dir.join("data"));
            let legacy_snapshot = env::var_os("ORCHETRACE_SNAPSHOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    if cfg!(debug_assertions) {
                        development_legacy_snapshot()
                    } else {
                        app_data_dir.join("run-snapshot.json")
                    }
                });
            let ingest = ManagedIngest::new(IngestConfig {
                cli_path: resolve_cli_path(),
                data_dir: data_dir.clone(),
                database_path: app_data_dir.join("orchetrace.db"),
                ingest_endpoint: "127.0.0.1:43117".to_owned(),
                live_endpoint: "127.0.0.1:43118".to_owned(),
                web_origin: desktop_web_origin(),
            });
            let user_home = home_dir();
            let claude = ManagedClaude::new(ClaudeConfig {
                node_path: resolve_node_path(),
                auto_script: env::var_os("ORCHETRACE_CLAUDE_AUTO_SCRIPT")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| development_claude_script("auto-cli.ts")),
                hook_script: env::var_os("ORCHETRACE_CLAUDE_HOOK_SCRIPT")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| development_claude_script("hook-cli.ts")),
                projects_dir: env::var_os("ORCHETRACE_CLAUDE_PROJECTS_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| user_home.join(".claude/projects")),
                state_dir: app_data_dir.join("claude-auto"),
                hook_events_path: user_home.join(".orchetrace/claude-hooks.jsonl"),
                settings_path: user_home.join(".claude/settings.json"),
                ingest_host: "127.0.0.1".to_owned(),
                ingest_port: 43117,
            });
            let pi = ManagedRuntimeObserver::new(RuntimeObserverConfig {
                runtime: "pi",
                node_path: resolve_node_path(),
                auto_script: env::var_os("ORCHETRACE_PI_AUTO_SCRIPT")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| development_adapter_script("pi-adapter", "auto-cli.ts")),
                sessions_dir: env::var_os("ORCHETRACE_PI_SESSIONS_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| user_home.join(".pi/agent/sessions")),
                state_dir: app_data_dir.join("pi-auto"),
                ingest_host: "127.0.0.1".to_owned(),
                ingest_port: 43117,
            });
            let harness = ManagedRuntimeObserver::new(RuntimeObserverConfig {
                runtime: "deepseek-harness",
                node_path: resolve_node_path(),
                auto_script: env::var_os("ORCHETRACE_DSH_AUTO_SCRIPT")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| development_adapter_script("dsh-observer", "auto-cli.ts")),
                sessions_dir: env::var_os("ORCHETRACE_DSH_SESSIONS_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| user_home.join(".dsh/sessions")),
                state_dir: app_data_dir.join("dsh-auto"),
                ingest_host: "127.0.0.1".to_owned(),
                ingest_port: 43117,
            });
            if env::var("ORCHETRACE_AUTOSTART").as_deref() != Ok("0")
                && let Ok(status) = ingest.start()
                && let Some(token) = status.connection_token.as_deref()
            {
                let _ = claude.start(token);
                let _ = pi.start(token);
                let _ = harness.start(token);
            }
            app.manage(DesktopState {
                data_dir,
                legacy_snapshot,
                ingest,
                claude,
                pi,
                harness,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_info,
            read_catalog,
            read_run_snapshot,
            read_run_delta,
            read_live_config,
            read_legacy_snapshot,
            managed_ingest_status,
            start_managed_ingest,
            stop_managed_ingest,
            claude_integration_status,
            start_claude_auto,
            stop_claude_auto,
            enable_claude_hooks,
            disable_claude_hooks,
            pi_integration_status,
            start_pi_auto,
            stop_pi_auto,
            harness_integration_status,
            start_harness_auto,
            stop_harness_auto
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Orchetrace desktop shell");
}

#[cfg(test)]
mod tests {
    use super::{read_json, run_file};
    use serde_json::json;
    use std::{
        fs,
        path::PathBuf,
        process,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("orchetrace-desktop-{}-{nonce}", process::id()));
        fs::create_dir_all(&path).expect("temp directory should be created");
        path
    }

    #[test]
    fn run_file_hex_encodes_the_complete_utf8_identifier() {
        let path = run_file(PathBuf::from("data").as_path(), "runs", "pi/根");
        assert_eq!(path, PathBuf::from("data/runs/run-70692fe6a0b9.json"));
    }

    #[test]
    fn read_json_returns_structured_values_and_reports_invalid_files() {
        let directory = temp_dir();
        let valid = directory.join("valid.json");
        let invalid = directory.join("invalid.json");
        fs::write(&valid, br#"{"schema_version":1}"#).expect("fixture should be written");
        fs::write(&invalid, b"not-json").expect("fixture should be written");

        assert_eq!(
            read_json(&valid).expect("valid JSON should load"),
            json!({"schema_version": 1})
        );
        assert!(
            read_json(&invalid)
                .expect_err("invalid JSON should fail")
                .contains("invalid.json")
        );
        assert!(
            read_json(&directory.join("missing.json"))
                .expect_err("missing file should fail")
                .contains("missing.json")
        );

        fs::remove_dir_all(directory).expect("temp directory should be removed");
    }
}
