use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use orchetrace_storage::{EventStore, StorageDiagnostics};
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
    database_path: PathBuf,
    cli_path: PathBuf,
    export_dir: PathBuf,
    legacy_snapshot: PathBuf,
    ingest: Arc<ManagedIngest>,
    claude: ManagedClaude,
    observers: BTreeMap<&'static str, ManagedRuntimeObserver>,
    maintenance: Arc<Mutex<()>>,
}

#[derive(Debug, Serialize)]
struct DesktopInfo {
    shell: &'static str,
    version: &'static str,
    platform: &'static str,
    data_dir: String,
    native_catalog: bool,
}

#[derive(Debug, Serialize)]
struct DesktopStorageStatus {
    phase: &'static str,
    database_path: String,
    diagnostics: Option<StorageDiagnostics>,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
struct DesktopMaintenanceOutcome {
    message: String,
    output_path: Option<String>,
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
async fn storage_diagnostics(
    state: tauri::State<'_, DesktopState>,
) -> Result<DesktopStorageStatus, String> {
    let database_path = state.database_path.clone();
    let maintenance = Arc::clone(&state.maintenance);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = maintenance
            .lock()
            .map_err(|_| "desktop maintenance lock is poisoned".to_owned())?;
        diagnose_storage(&database_path)
    })
    .await
    .map_err(|error| format!("storage doctor task failed: {error}"))?
}

#[tauri::command]
async fn repair_storage(
    state: tauri::State<'_, DesktopState>,
) -> Result<DesktopMaintenanceOutcome, String> {
    let maintenance = Arc::clone(&state.maintenance);
    let ingest = Arc::clone(&state.ingest);
    let cli_path = state.cli_path.clone();
    let database_path = state.database_path.clone();
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = maintenance
            .lock()
            .map_err(|_| "desktop maintenance lock is poisoned".to_owned())?;
        if ingest.status()?.phase == "running" {
            return Err("stop managed ingest before repairing derived storage".to_owned());
        }
        run_repair(&cli_path, &database_path, &data_dir)
    })
    .await
    .map_err(|error| format!("storage repair task failed: {error}"))?
}

#[tauri::command]
async fn export_run(
    state: tauri::State<'_, DesktopState>,
    run_id: String,
) -> Result<DesktopMaintenanceOutcome, String> {
    if run_id.is_empty() || run_id.chars().count() > 2_048 {
        return Err("run id must contain 1 to 2048 characters".to_owned());
    }
    let maintenance = Arc::clone(&state.maintenance);
    let cli_path = state.cli_path.clone();
    let database_path = state.database_path.clone();
    let export_dir = state.export_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = maintenance
            .lock()
            .map_err(|_| "desktop maintenance lock is poisoned".to_owned())?;
        run_export(&cli_path, &database_path, &export_dir, &run_id)
    })
    .await
    .map_err(|error| format!("run export task failed: {error}"))?
}

fn run_repair(
    cli_path: &Path,
    database_path: &Path,
    data_dir: &Path,
) -> Result<DesktopMaintenanceOutcome, String> {
    ensure_cli_available(cli_path)?;
    let output = Command::new(cli_path)
        .arg("repair")
        .arg("--db")
        .arg(database_path)
        .arg("--data-dir")
        .arg(data_dir)
        .output()
        .map_err(|error| format!("failed to start {}: {error}", cli_path.display()))?;
    Ok(DesktopMaintenanceOutcome {
        message: successful_command_message(output)?,
        output_path: None,
    })
}

fn run_export(
    cli_path: &Path,
    database_path: &Path,
    export_dir: &Path,
    run_id: &str,
) -> Result<DesktopMaintenanceOutcome, String> {
    ensure_cli_available(cli_path)?;
    fs::create_dir_all(export_dir).map_err(|error| format!("{}: {error}", export_dir.display()))?;
    let output_path = next_export_path(export_dir);
    let output = Command::new(cli_path)
        .arg("export")
        .arg("--db")
        .arg(database_path)
        .arg("--run-id")
        .arg(run_id)
        .arg("--output")
        .arg(&output_path)
        .output()
        .map_err(|error| format!("failed to start {}: {error}", cli_path.display()))?;
    let message = match successful_command_message(output) {
        Ok(message) => message,
        Err(error) => {
            let _ = fs::remove_file(&output_path);
            return Err(error);
        }
    };
    if !output_path.is_file() {
        return Err(format!(
            "export command succeeded without creating {}",
            output_path.display()
        ));
    }
    Ok(DesktopMaintenanceOutcome {
        message,
        output_path: Some(output_path.display().to_string()),
    })
}

fn ensure_cli_available(cli_path: &Path) -> Result<(), String> {
    if cli_path.is_file() {
        Ok(())
    } else {
        Err(format!(
            "otrace executable is unavailable at {}",
            cli_path.display()
        ))
    }
}

fn successful_command_message(output: std::process::Output) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if output.status.success() {
        Ok(if stdout.is_empty() {
            "maintenance command completed".to_owned()
        } else {
            stdout
        })
    } else {
        Err(if stderr.is_empty() {
            "maintenance command failed without diagnostic output".to_owned()
        } else {
            stderr
        })
    }
}

fn next_export_path(export_dir: &Path) -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    (0..1_000)
        .map(|suffix| {
            let suffix = if suffix == 0 {
                String::new()
            } else {
                format!("-{suffix}")
            };
            export_dir.join(format!("orchetrace-run-{now}{suffix}.jsonl"))
        })
        .find(|candidate| !candidate.exists())
        .unwrap_or_else(|| export_dir.join(format!("orchetrace-run-{now}-overflow.jsonl")))
}

fn diagnose_storage(database_path: &Path) -> Result<DesktopStorageStatus, String> {
    if !database_path.is_file() {
        return Ok(DesktopStorageStatus {
            phase: "empty",
            database_path: database_path.display().to_string(),
            diagnostics: None,
            message: Some("The canonical event database has not been created yet.".to_owned()),
        });
    }
    let storage = EventStore::open(database_path).map_err(|error| error.to_string())?;
    let diagnostics = storage.diagnose().map_err(|error| error.to_string())?;
    let phase = if diagnostics.has_errors() {
        "error"
    } else if diagnostics.issues.is_empty() {
        "healthy"
    } else {
        "warning"
    };
    Ok(DesktopStorageStatus {
        phase,
        database_path: database_path.display().to_string(),
        diagnostics: Some(diagnostics),
        message: None,
    })
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
fn read_run_timeline_page(
    state: tauri::State<'_, DesktopState>,
    run_id: String,
    page: u32,
) -> Result<Value, String> {
    read_json(
        &state
            .data_dir
            .join("timelines")
            .join(format!("run-{}", encode_run_id(&run_id)))
            .join(format!("page-{page:06}.json")),
    )
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
fn rename_session(
    state: tauri::State<'_, DesktopState>,
    runtime: String,
    source_id: String,
    session_id: String,
    label: String,
) -> Result<Value, String> {
    let label = label.trim();
    if label.is_empty() || label.chars().count() > 80 {
        return Err("session name must contain 1 to 80 characters".to_owned());
    }
    let response = state.ingest.send_control(serde_json::json!({
        "kind": "control.session.rename",
        "protocol": 1,
        "runtime": runtime,
        "source_id": source_id,
        "session_id": session_id,
        "label": label
    }))?;
    expect_control_response(response, "session.renamed")
}

#[tauri::command]
fn delete_session(
    state: tauri::State<'_, DesktopState>,
    runtime: String,
    source_id: String,
    session_id: String,
) -> Result<Value, String> {
    let response = state.ingest.send_control(serde_json::json!({
        "kind": "control.session.delete",
        "protocol": 1,
        "runtime": runtime,
        "source_id": source_id,
        "session_id": session_id
    }))?;
    expect_control_response(response, "session.deleted")
}

fn expect_control_response(response: Value, expected: &str) -> Result<Value, String> {
    if response.get("kind").and_then(Value::as_str) == Some(expected) {
        Ok(response)
    } else {
        Err(response
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unexpected response from managed ingest")
            .to_owned())
    }
}

#[tauri::command]
fn managed_ingest_status(state: tauri::State<'_, DesktopState>) -> Result<IngestStatus, String> {
    state.ingest.status()
}

#[tauri::command]
fn start_managed_ingest(state: tauri::State<'_, DesktopState>) -> Result<IngestStatus, String> {
    let _guard = state
        .maintenance
        .lock()
        .map_err(|_| "desktop maintenance lock is poisoned".to_owned())?;
    let status = state.ingest.start()?;
    if let Some(token) = status.connection_token.as_deref() {
        let _ = state.claude.start(token);
        for observer in state.observers.values() {
            let _ = observer.start(token);
        }
    }
    Ok(status)
}

#[tauri::command]
fn stop_managed_ingest(state: tauri::State<'_, DesktopState>) -> Result<IngestStatus, String> {
    let _guard = state
        .maintenance
        .lock()
        .map_err(|_| "desktop maintenance lock is poisoned".to_owned())?;
    for observer in state.observers.values().rev() {
        let _ = observer.stop();
    }
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
    runtime_status(&state, "pi")
}

#[tauri::command]
fn start_pi_auto(state: tauri::State<'_, DesktopState>) -> Result<RuntimeObserverStatus, String> {
    start_runtime(&state, "pi")
}

#[tauri::command]
fn stop_pi_auto(state: tauri::State<'_, DesktopState>) -> Result<RuntimeObserverStatus, String> {
    stop_runtime(&state, "pi")
}

#[tauri::command]
fn harness_integration_status(
    state: tauri::State<'_, DesktopState>,
) -> Result<RuntimeObserverStatus, String> {
    runtime_status(&state, "deepseek-harness")
}

#[tauri::command]
fn start_harness_auto(
    state: tauri::State<'_, DesktopState>,
) -> Result<RuntimeObserverStatus, String> {
    start_runtime(&state, "deepseek-harness")
}

#[tauri::command]
fn stop_harness_auto(
    state: tauri::State<'_, DesktopState>,
) -> Result<RuntimeObserverStatus, String> {
    stop_runtime(&state, "deepseek-harness")
}

#[tauri::command]
fn codex_integration_status(
    state: tauri::State<'_, DesktopState>,
) -> Result<RuntimeObserverStatus, String> {
    runtime_status(&state, "codex")
}

#[tauri::command]
fn start_codex_auto(
    state: tauri::State<'_, DesktopState>,
) -> Result<RuntimeObserverStatus, String> {
    start_runtime(&state, "codex")
}

#[tauri::command]
fn stop_codex_auto(state: tauri::State<'_, DesktopState>) -> Result<RuntimeObserverStatus, String> {
    stop_runtime(&state, "codex")
}

#[tauri::command]
fn runtime_integration_status(
    state: tauri::State<'_, DesktopState>,
    runtime: String,
) -> Result<RuntimeObserverStatus, String> {
    runtime_status(&state, &runtime)
}

#[tauri::command]
fn start_runtime_auto(
    state: tauri::State<'_, DesktopState>,
    runtime: String,
) -> Result<RuntimeObserverStatus, String> {
    start_runtime(&state, &runtime)
}

#[tauri::command]
fn stop_runtime_auto(
    state: tauri::State<'_, DesktopState>,
    runtime: String,
) -> Result<RuntimeObserverStatus, String> {
    stop_runtime(&state, &runtime)
}

fn runtime_observer<'a>(
    state: &'a DesktopState,
    runtime: &str,
) -> Result<&'a ManagedRuntimeObserver, String> {
    let canonical = orchetrace_protocol::runtime_descriptor(runtime)
        .map(|descriptor| descriptor.id)
        .unwrap_or(runtime);
    state
        .observers
        .get(canonical)
        .ok_or_else(|| format!("managed observer {runtime} is unavailable"))
}

fn runtime_status(state: &DesktopState, runtime: &str) -> Result<RuntimeObserverStatus, String> {
    runtime_observer(state, runtime)?.status()
}

fn start_runtime(state: &DesktopState, runtime: &str) -> Result<RuntimeObserverStatus, String> {
    let ingest = state.ingest.status()?;
    let token = ingest
        .connection_token
        .as_deref()
        .ok_or_else(|| "start the managed ingest service first".to_owned())?;
    runtime_observer(state, runtime)?.start(token)
}

fn stop_runtime(state: &DesktopState, runtime: &str) -> Result<RuntimeObserverStatus, String> {
    runtime_observer(state, runtime)?.stop()
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))
}

fn run_file(data_dir: &Path, collection: &str, run_id: &str) -> PathBuf {
    let encoded = encode_run_id(run_id);
    data_dir
        .join(collection)
        .join(format!("run-{encoded}.json"))
}

fn encode_run_id(run_id: &str) -> String {
    run_id
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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

fn packaged_executable(resource_dir: &Path, name: &str) -> Option<PathBuf> {
    let executable = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let mut candidates = Vec::new();
    if let Ok(current) = env::current_exe()
        && let Some(parent) = current.parent()
    {
        candidates.push(parent.join(&executable));
    }
    candidates.push(resource_dir.join(&executable));
    candidates.push(resource_dir.join("binaries").join(&executable));
    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn packaged_resource_dir(_executable: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let candidate = _executable
        .parent()
        .and_then(Path::parent)
        .map(|contents| contents.join("Resources"));
    #[cfg(target_os = "windows")]
    let candidate = _executable.parent().map(Path::to_path_buf);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let candidate: Option<PathBuf> = None;
    candidate.filter(|path| path.is_dir())
}

fn executable_resource_dir() -> Option<PathBuf> {
    env::current_exe()
        .ok()
        .and_then(|executable| packaged_resource_dir(&executable))
}

fn resolve_cli_path(resource_dir: &Path) -> PathBuf {
    if let Some(configured) = env::var_os("ORCHETRACE_CLI_PATH") {
        return PathBuf::from(configured);
    }
    if let Some(packaged) = packaged_executable(resource_dir, "otrace") {
        return packaged;
    }
    development_cli_path()
}

fn resolve_node_path(resource_dir: &Path) -> PathBuf {
    if let Some(configured) = env::var_os("ORCHETRACE_NODE_PATH") {
        return PathBuf::from(configured);
    }
    if let Some(packaged) = packaged_executable(resource_dir, "orchetrace-node") {
        return packaged;
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

fn development_adapter_entry(package: &str, entrypoint: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages")
        .join(package)
        .join(entrypoint)
}

fn resolve_adapter_entry(resource_dir: &Path, package: &str, entrypoint: &str) -> PathBuf {
    let packaged = resource_dir.join("packages").join(package).join(entrypoint);
    if packaged.is_file() {
        packaged
    } else {
        development_adapter_entry(package, entrypoint)
    }
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

fn runtime_observer_config(
    runtime: &'static str,
    app_data_dir: &Path,
    user_home: &Path,
    resource_dir: &Path,
) -> Result<RuntimeObserverConfig, String> {
    let descriptor = orchetrace_protocol::runtime_descriptor(runtime)
        .ok_or_else(|| format!("runtime descriptor {runtime} is unavailable"))?;
    Ok(RuntimeObserverConfig {
        runtime: descriptor.id,
        node_path: resolve_node_path(resource_dir),
        helper_path: resolve_cli_path(resource_dir),
        auto_script: env::var_os(descriptor.observer.script_env)
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                resolve_adapter_entry(
                    resource_dir,
                    descriptor.observer.package,
                    descriptor.observer.entrypoint,
                )
            }),
        directory_flag: descriptor.observer.directory_flag,
        sessions_dir: env::var_os(descriptor.observer.sessions_env)
            .map(PathBuf::from)
            .unwrap_or_else(|| expand_home(descriptor.session_directory, user_home)),
        state_dir: app_data_dir.join(descriptor.observer.state_directory),
        ingest_host: "127.0.0.1".to_owned(),
        ingest_port: 43117,
    })
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
            let app_data_dir = match env::var_os("ORCHETRACE_APP_DATA_DIR") {
                Some(path) => PathBuf::from(path),
                None => app.path().app_data_dir()?,
            };
            let resource_dir = match env::var_os("ORCHETRACE_RESOURCE_DIR") {
                Some(path) => PathBuf::from(path),
                None => match app.path().resource_dir() {
                    Ok(path) => path,
                    Err(error) => executable_resource_dir().ok_or(error)?,
                },
            };
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
            let database_path = app_data_dir.join("orchetrace.db");
            let cli_path = resolve_cli_path(&resource_dir);
            let ingest = Arc::new(ManagedIngest::new(IngestConfig {
                cli_path: cli_path.clone(),
                data_dir: data_dir.clone(),
                database_path: database_path.clone(),
                ingest_endpoint: "127.0.0.1:43117".to_owned(),
                live_endpoint: "127.0.0.1:43118".to_owned(),
                web_origin: desktop_web_origin(),
            }));
            let user_home = home_dir();
            let claude_runtime = orchetrace_protocol::runtime_descriptor("claude-code")
                .ok_or("Claude runtime descriptor is unavailable")?;
            let claude = ManagedClaude::new(ClaudeConfig {
                node_path: resolve_node_path(&resource_dir),
                auto_script: env::var_os(claude_runtime.observer.script_env)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        resolve_adapter_entry(
                            &resource_dir,
                            claude_runtime.observer.package,
                            claude_runtime.observer.entrypoint,
                        )
                    }),
                hook_script: env::var_os("ORCHETRACE_CLAUDE_HOOK_SCRIPT")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        resolve_adapter_entry(
                            &resource_dir,
                            claude_runtime.observer.package,
                            "src/hook-cli.ts",
                        )
                    }),
                projects_dir: env::var_os(claude_runtime.observer.sessions_env)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| expand_home(claude_runtime.session_directory, &user_home)),
                state_dir: app_data_dir.join(claude_runtime.observer.state_directory),
                hook_events_path: user_home.join(".orchetrace/claude-hooks.jsonl"),
                settings_path: user_home.join(".claude/settings.json"),
                ingest_host: "127.0.0.1".to_owned(),
                ingest_port: 43117,
            });
            let observers = orchetrace_protocol::REGISTERED_RUNTIMES
                .iter()
                .filter(|descriptor| descriptor.id != "claude-code")
                .map(|descriptor| {
                    runtime_observer_config(descriptor.id, &app_data_dir, &user_home, &resource_dir)
                        .map(|config| (descriptor.id, ManagedRuntimeObserver::new(config)))
                })
                .collect::<Result<BTreeMap<_, _>, _>>()?;
            if env::var("ORCHETRACE_AUTOSTART").as_deref() != Ok("0")
                && let Ok(status) = ingest.start()
                && let Some(token) = status.connection_token.as_deref()
            {
                let _ = claude.start(token);
                for observer in observers.values() {
                    let _ = observer.start(token);
                }
            }
            app.manage(DesktopState {
                data_dir,
                database_path,
                cli_path,
                export_dir: app_data_dir.join("exports"),
                legacy_snapshot,
                ingest,
                claude,
                observers,
                maintenance: Arc::new(Mutex::new(())),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_info,
            storage_diagnostics,
            repair_storage,
            export_run,
            read_catalog,
            read_run_snapshot,
            read_run_delta,
            read_run_timeline_page,
            read_live_config,
            read_legacy_snapshot,
            rename_session,
            delete_session,
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
            stop_harness_auto,
            codex_integration_status,
            start_codex_auto,
            stop_codex_auto,
            runtime_integration_status,
            start_runtime_auto,
            stop_runtime_auto
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Orchetrace desktop shell");
}

#[cfg(test)]
mod tests {
    use super::{
        diagnose_storage, next_export_path, packaged_executable, packaged_resource_dir, read_json,
        resolve_adapter_entry, run_export, run_file, run_repair,
    };
    use orchetrace_storage::EventStore;
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

    #[test]
    fn storage_diagnostics_distinguish_an_empty_install_from_a_healthy_database() {
        let directory = temp_dir();
        let database = directory.join("orchetrace.db");
        let empty = diagnose_storage(&database).expect("missing database should be a valid state");
        assert_eq!(empty.phase, "empty");
        assert!(empty.diagnostics.is_none());

        drop(EventStore::open(&database).expect("database should initialize"));
        let healthy = diagnose_storage(&database).expect("database should be diagnosed");
        assert_eq!(healthy.phase, "healthy");
        assert_eq!(
            healthy
                .diagnostics
                .expect("diagnostics should be present")
                .event_count,
            0
        );

        fs::remove_dir_all(directory).expect("temp directory should be removed");
    }

    #[test]
    fn managed_exports_never_overwrite_an_existing_file() {
        let directory = temp_dir();
        let first = next_export_path(&directory);
        assert_eq!(first.parent(), Some(directory.as_path()));
        fs::write(&first, b"existing export").expect("first export should be written");
        let second = next_export_path(&directory);
        assert_eq!(second.parent(), Some(directory.as_path()));
        assert_ne!(second, first);

        fs::remove_dir_all(directory).expect("temp directory should be removed");
    }

    #[cfg(unix)]
    #[test]
    fn maintenance_helpers_keep_outputs_inside_managed_directories() {
        use std::os::unix::fs::PermissionsExt;

        let directory = temp_dir();
        let cli = directory.join("otrace-test");
        fs::write(
            &cli,
            b"#!/bin/sh\ncase \"$1\" in\nrepair) printf 'repaired\\n' ;;\nexport) shift; while [ \"$#\" -gt 0 ]; do if [ \"$1\" = '--output' ]; then shift; printf 'event\\n' > \"$1\"; fi; shift; done; printf 'exported\\n' ;;\n*) exit 2 ;;\nesac\n",
        )
        .expect("fake CLI should be written");
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o700))
            .expect("fake CLI should be executable");
        let database = directory.join("orchetrace.db");
        let data = directory.join("data");
        let exports = directory.join("exports");
        fs::write(&database, b"fixture").expect("database placeholder should be written");

        let repair = run_repair(&cli, &database, &data).expect("repair should complete");
        assert_eq!(repair.output_path, None);
        assert_eq!(repair.message, "repaired");
        let export =
            run_export(&cli, &database, &exports, "opaque/run-id").expect("export should complete");
        let output = PathBuf::from(export.output_path.expect("export path should be returned"));
        assert_eq!(output.parent(), Some(exports.as_path()));
        assert_eq!(fs::read_to_string(output).unwrap(), "event\n");

        fs::remove_dir_all(directory).expect("temp directory should be removed");
    }

    #[test]
    fn packaged_resources_are_preferred_over_development_paths() {
        let directory = temp_dir();
        let executable_name = if cfg!(windows) {
            "orchetrace-test-runtime.exe"
        } else {
            "orchetrace-test-runtime"
        };
        let executable = directory.join(executable_name);
        let adapter = directory.join("packages/example-adapter/src/auto-cli.ts");
        fs::create_dir_all(adapter.parent().expect("adapter should have a parent"))
            .expect("adapter directory should be created");
        fs::write(&executable, b"runtime").expect("runtime should be written");
        fs::write(&adapter, b"export {};").expect("adapter should be written");

        assert_eq!(
            packaged_executable(&directory, "orchetrace-test-runtime"),
            Some(executable)
        );
        assert_eq!(
            resolve_adapter_entry(&directory, "example-adapter", "src/auto-cli.ts"),
            adapter
        );

        fs::remove_dir_all(directory).expect("temp directory should be removed");
    }

    #[test]
    fn packaged_resource_directory_can_be_recovered_from_the_executable() {
        let directory = temp_dir();
        #[cfg(target_os = "macos")]
        let (executable, resources) = {
            let contents = directory.join("Orchetrace.app/Contents");
            let executable = contents.join("MacOS/orchetrace-desktop");
            let resources = contents.join("Resources");
            (executable, resources)
        };
        #[cfg(target_os = "windows")]
        let (executable, resources) = {
            let resources = directory.join("Orchetrace");
            (resources.join("orchetrace-desktop.exe"), resources)
        };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let (executable, resources) = (directory.join("orchetrace-desktop"), directory.clone());
        fs::create_dir_all(
            executable
                .parent()
                .expect("executable should have a parent"),
        )
        .expect("executable directory should be created");
        fs::create_dir_all(&resources).expect("resources directory should be created");
        fs::write(&executable, b"desktop").expect("executable should be written");

        #[cfg(any(target_os = "macos", target_os = "windows"))]
        assert_eq!(packaged_resource_dir(&executable), Some(resources));
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        assert_eq!(packaged_resource_dir(&executable), None);

        fs::remove_dir_all(directory).expect("temp directory should be removed");
    }
}
