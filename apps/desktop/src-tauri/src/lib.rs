use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

mod ingest;

use ingest::{IngestConfig, IngestStatus, ManagedIngest};

#[derive(Debug)]
struct DesktopState {
    data_dir: PathBuf,
    legacy_snapshot: PathBuf,
    ingest: ManagedIngest,
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
    state.ingest.start()
}

#[tauri::command]
fn stop_managed_ingest(state: tauri::State<'_, DesktopState>) -> Result<IngestStatus, String> {
    state.ingest.stop()
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

fn development_data_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/public/data")
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
            let data_dir = configured_data_dir.unwrap_or_else(|| {
                let native = app_data_dir.join("data");
                if cfg!(debug_assertions) && !native.join("run-catalog.json").is_file() {
                    development_data_dir()
                } else {
                    native
                }
            });
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
            app.manage(DesktopState {
                data_dir,
                legacy_snapshot,
                ingest,
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
            stop_managed_ingest
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
