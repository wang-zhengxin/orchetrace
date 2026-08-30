use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use orchetrace_ingest::IngestStore;
use orchetrace_protocol::{CanonicalEvent, EventType, RuntimeKind};
use orchetrace_storage::EventStore;
use serde::Serialize;
use serde_json::json;

#[derive(Debug)]
struct Configuration {
    event_count: usize,
    run_count: usize,
    agents_per_run: usize,
    database_path: PathBuf,
    remove_database: bool,
    output_path: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
struct BenchmarkReport {
    schema_version: u16,
    profile: &'static str,
    platform: &'static str,
    architecture: &'static str,
    parallelism: usize,
    event_count: usize,
    run_count: usize,
    agents_per_run: usize,
    generation_ms: f64,
    cold_fold_ms: f64,
    cold_fold_events_per_second: f64,
    sqlite_bulk_insert_ms: f64,
    sqlite_insert_events_per_second: f64,
    checkpoint_save_ms: f64,
    sqlite_reopen_load_ms: f64,
    checkpoint_restore_ms: f64,
    restored_startup_ms: f64,
    incremental_ingest_us: f64,
    delta_serialize_us: f64,
    delta_json_bytes: usize,
    snapshot_json_bytes: usize,
    database_bytes: u64,
    cold_fold_under_2s: bool,
    restored_startup_under_2s: bool,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("otrace-bench: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let configuration = parse_configuration()?;
    if configuration.event_count < configuration.run_count * configuration.agents_per_run {
        return Err("event count must cover one discovery event per synthetic agent".into());
    }

    let started = Instant::now();
    let events = generate_events(
        configuration.event_count,
        configuration.run_count,
        configuration.agents_per_run,
    );
    let generation_ms = milliseconds(started.elapsed());

    let started = Instant::now();
    let folded = IngestStore::from_events(events)?;
    let cold_fold_ms = milliseconds(started.elapsed());
    let runs = folded.runs();
    let catalog = folded.catalog();
    if runs.len() != configuration.run_count || folded.len() != configuration.event_count {
        return Err("synthetic fold produced an unexpected Run or event count".into());
    }
    let snapshot_json_bytes = runs
        .iter()
        .map(serde_json::to_vec)
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .map(Vec::len)
        .sum();
    drop(folded);

    let storage_events = generate_events(
        configuration.event_count,
        configuration.run_count,
        configuration.agents_per_run,
    );
    let mut storage = EventStore::open(&configuration.database_path)?;
    let started = Instant::now();
    let insert_outcome = storage.insert_events(&storage_events)?;
    let sqlite_bulk_insert_ms = milliseconds(started.elapsed());
    if insert_outcome.inserted != configuration.event_count || insert_outcome.duplicates != 0 {
        return Err("benchmark database was not empty before bulk insert".into());
    }
    drop(storage_events);

    let started = Instant::now();
    storage.save_checkpoint(&runs, &catalog, configuration.event_count)?;
    let checkpoint_save_ms = milliseconds(started.elapsed());
    drop(storage);

    let database_bytes = database_size(&configuration.database_path)?;
    let started = Instant::now();
    let storage = EventStore::open(&configuration.database_path)?;
    let loaded_events = storage.load_cached_events()?;
    let sqlite_reopen_load_ms = milliseconds(started.elapsed());

    let started = Instant::now();
    let checkpoint = storage
        .load_checkpoint()?
        .ok_or("benchmark checkpoint was not restored")?;
    let mut restored = IngestStore::from_cached_events_with_runs(loaded_events, checkpoint.runs)?;
    if restored.catalog() != checkpoint.catalog {
        return Err("restored Catalog does not match the checkpoint".into());
    }
    let checkpoint_restore_ms = milliseconds(started.elapsed());
    let restored_startup_ms = sqlite_reopen_load_ms + checkpoint_restore_ms;

    let update = status_event(configuration.event_count, "run-00000", None, "ready");
    let started = Instant::now();
    let outcome = restored.ingest(update)?;
    let incremental_ingest_us = microseconds(started.elapsed());
    let delta = outcome
        .run_deltas
        .first()
        .ok_or("incremental update did not produce a Run delta")?;
    let started = Instant::now();
    let delta_json = serde_json::to_vec(delta)?;
    let delta_serialize_us = microseconds(started.elapsed());

    let report = BenchmarkReport {
        schema_version: 1,
        profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        platform: env::consts::OS,
        architecture: env::consts::ARCH,
        parallelism: std::thread::available_parallelism()?.get(),
        event_count: configuration.event_count,
        run_count: configuration.run_count,
        agents_per_run: configuration.agents_per_run,
        generation_ms,
        cold_fold_ms,
        cold_fold_events_per_second: rate(configuration.event_count, cold_fold_ms),
        sqlite_bulk_insert_ms,
        sqlite_insert_events_per_second: rate(configuration.event_count, sqlite_bulk_insert_ms),
        checkpoint_save_ms,
        sqlite_reopen_load_ms,
        checkpoint_restore_ms,
        restored_startup_ms,
        incremental_ingest_us,
        delta_serialize_us,
        delta_json_bytes: delta_json.len(),
        snapshot_json_bytes,
        database_bytes,
        cold_fold_under_2s: cold_fold_ms <= 2_000.0,
        restored_startup_under_2s: restored_startup_ms <= 2_000.0,
    };
    let output = format!("{}\n", serde_json::to_string_pretty(&report)?);
    if let Some(path) = &configuration.output_path {
        write_atomic(path, output.as_bytes())?;
    }
    print!("{output}");

    drop(restored);
    drop(storage);
    if configuration.remove_database {
        remove_database_files(&configuration.database_path)?;
    }
    Ok(())
}

fn parse_configuration() -> Result<Configuration, Box<dyn std::error::Error>> {
    let mut event_count = 100_000;
    let mut run_count = 100;
    let mut agents_per_run = 10;
    let mut database_path = None;
    let mut output_path = None;
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--events" => event_count = parse_usize("--events", args.next())?,
            "--runs" => run_count = parse_usize("--runs", args.next())?,
            "--agents-per-run" => agents_per_run = parse_usize("--agents-per-run", args.next())?,
            "--db" => database_path = Some(PathBuf::from(args.next().ok_or("missing --db path")?)),
            "--output" => {
                output_path = Some(PathBuf::from(args.next().ok_or("missing --output path")?))
            }
            "--help" | "-h" => {
                println!(
                    "Usage: otrace-bench [--events 100000] [--runs 100] [--agents-per-run 10] [--db path] [--output report.json]"
                );
                std::process::exit(0);
            }
            _ => return Err(format!("unknown argument `{argument}`").into()),
        }
    }
    if event_count == 0 || run_count == 0 || agents_per_run == 0 {
        return Err("events, runs, and agents-per-run must be greater than zero".into());
    }
    let remove_database = database_path.is_none();
    let database_path = database_path.unwrap_or_else(temporary_database_path);
    Ok(Configuration {
        event_count,
        run_count,
        agents_per_run,
        database_path,
        remove_database,
        output_path,
    })
}

fn parse_usize(option: &str, value: Option<String>) -> Result<usize, Box<dyn std::error::Error>> {
    Ok(value
        .ok_or_else(|| format!("missing {option} value"))?
        .parse()?)
}

fn generate_events(
    event_count: usize,
    run_count: usize,
    agents_per_run: usize,
) -> Vec<CanonicalEvent> {
    let mut events = Vec::with_capacity(event_count);
    for run_index in 0..run_count {
        let root = format!("run-{run_index:05}");
        for agent_index in 0..agents_per_run {
            let session_id = if agent_index == 0 {
                root.clone()
            } else {
                format!("{root}-agent-{agent_index:03}")
            };
            let parent = (agent_index > 0).then(|| root.clone());
            let sequence = events.len();
            events.push(CanonicalEvent {
                schema_version: 1,
                event_id: format!("bench:{sequence:09}"),
                runtime: RuntimeKind::DeepSeekHarness,
                source_id: "benchmark-local".into(),
                session_id,
                parent_session_id: parent,
                source_seq: sequence as u64,
                observed_at: timestamp(sequence),
                occurred_at: None,
                event_type: if agent_index == 0 {
                    EventType::SessionDiscovered
                } else {
                    EventType::AgentSpawned
                },
                data: json!({
                    "label": format!("benchmark agent {run_index}/{agent_index}"),
                    "role": "benchmark",
                    "mode": if agent_index == 0 { "root" } else { "continuable" }
                }),
                attributes: BTreeMap::new(),
                source_ref: None,
                supersedes_event_id: None,
                ignorable: false,
            });
        }
    }
    while events.len() < event_count {
        let sequence = events.len();
        let run_index = sequence % run_count;
        let agent_index = (sequence / run_count) % agents_per_run;
        let root = format!("run-{run_index:05}");
        let session_id = if agent_index == 0 {
            root.clone()
        } else {
            format!("{root}-agent-{agent_index:03}")
        };
        events.push(status_event(
            sequence,
            &session_id,
            (agent_index > 0).then_some(root.as_str()),
            if sequence.is_multiple_of(2) {
                "running"
            } else {
                "idle"
            },
        ));
    }
    events
}

fn status_event(
    sequence: usize,
    session_id: &str,
    parent_session_id: Option<&str>,
    status: &str,
) -> CanonicalEvent {
    CanonicalEvent {
        schema_version: 1,
        event_id: format!("bench:{sequence:09}"),
        runtime: RuntimeKind::DeepSeekHarness,
        source_id: "benchmark-local".into(),
        session_id: session_id.into(),
        parent_session_id: parent_session_id.map(str::to_owned),
        source_seq: sequence as u64,
        observed_at: timestamp(sequence),
        occurred_at: None,
        event_type: EventType::AgentStatusChanged,
        data: json!({ "status": status }),
        attributes: BTreeMap::new(),
        source_ref: None,
        supersedes_event_id: None,
        ignorable: false,
    }
}

fn timestamp(sequence: usize) -> String {
    let milliseconds = sequence % 1_000;
    let total_seconds = sequence / 1_000;
    let seconds = total_seconds % 60;
    let minutes = (total_seconds / 60) % 60;
    let hours = (total_seconds / 3_600) % 24;
    format!("2026-08-25T{hours:02}:{minutes:02}:{seconds:02}.{milliseconds:03}Z")
}

fn milliseconds(duration: std::time::Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn microseconds(duration: std::time::Duration) -> f64 {
    duration.as_secs_f64() * 1_000_000.0
}

fn rate(event_count: usize, elapsed_ms: f64) -> f64 {
    event_count as f64 / (elapsed_ms / 1_000.0)
}

fn temporary_database_path() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after the Unix epoch")
        .as_nanos();
    env::temp_dir().join(format!(
        "orchetrace-benchmark-{}-{nonce}.db",
        std::process::id()
    ))
}

fn database_size(path: &Path) -> Result<u64, std::io::Error> {
    let mut bytes = fs::metadata(path)?.len();
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
        if let Ok(metadata) = fs::metadata(sidecar) {
            bytes += metadata.len();
        }
    }
    Ok(bytes)
}

fn remove_database_files(path: &Path) -> Result<(), std::io::Error> {
    for suffix in ["", "-wal", "-shm"] {
        let target = PathBuf::from(format!("{}{suffix}", path.display()));
        match fs::remove_file(target) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| std::io::Error::other("benchmark output needs a file name"))?;
    let temporary = path.with_file_name(format!(".{file_name}.tmp"));
    fs::write(&temporary, bytes)?;
    fs::rename(temporary, path)
}
