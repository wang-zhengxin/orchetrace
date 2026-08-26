use std::{
    collections::BTreeSet,
    env, fs,
    io::{BufRead, BufReader, BufWriter, Write},
    net::{IpAddr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use orchetrace_core::fold_events;
use orchetrace_ingest::{IngestStore, RunCatalog, RunSnapshotDelta, RunState};
use orchetrace_protocol::CanonicalEvent;
use orchetrace_storage::{EventStore, InsertOutcome};
use serde::Serialize;
use serde_json::{Value, json};

mod live;

use live::{LiveHub, start_live_server};

fn main() {
    if let Err(error) = run() {
        eprintln!("otrace: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("fold") => fold_command(args.collect()),
        Some("serve") => serve_command(args.collect()),
        Some(command) => {
            print_usage();
            Err(format!("unknown command `{command}`").into())
        }
        None => {
            print_usage();
            Ok(())
        }
    }
}

fn fold_command(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let mut args = args.into_iter();
    let input = args
        .next()
        .map(PathBuf::from)
        .ok_or("missing input JSONL path")?;
    let mut output = None;
    let mut data_dir = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--output" | "-o" => {
                output = Some(PathBuf::from(args.next().ok_or("missing --output path")?))
            }
            "--data-dir" => {
                data_dir = Some(PathBuf::from(args.next().ok_or("missing --data-dir path")?))
            }
            _ => return Err(format!("unknown argument `{arg}`").into()),
        }
    }

    let events = read_events(&input)?;
    if let Some(data_dir) = &data_dir {
        let store = IngestStore::from_events(events.clone())?;
        let catalog = store.catalog();
        persist_run_data(data_dir, &store.runs(), &[], &catalog, &[])?;
        prune_unlisted_run_files(data_dir, &catalog)?;
        println!(
            "wrote {} runs / {} events to {}",
            store.runs().len(),
            store.len(),
            data_dir.display()
        );
    }

    if let Some(path) = output {
        let snapshot = fold_events(events)?;
        write_json_atomic(&path, &snapshot)?;
        println!(
            "wrote {} agents / {} events to {}",
            snapshot.agents.len(),
            snapshot.event_count,
            path.display()
        );
    } else if data_dir.is_none() {
        let snapshot = fold_events(events)?;
        println!("{}", serde_json::to_string_pretty(&snapshot)?);
    }
    Ok(())
}

fn serve_command(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let mut listen = "127.0.0.1:43117".to_owned();
    let mut token = None;
    let mut data_dir = PathBuf::from("apps/web/public/data");
    let mut database_path = PathBuf::from(".orchetrace/orchetrace.db");
    let mut live_listen = Some("127.0.0.1:43118".to_owned());
    let mut web_origin = "http://127.0.0.1:4173".to_owned();
    let mut legacy_snapshot_path = None;
    let mut events_path = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--listen" => listen = args.next().ok_or("missing --listen address")?,
            "--token" => token = Some(args.next().ok_or("missing --token value")?),
            "--data-dir" => data_dir = PathBuf::from(args.next().ok_or("missing --data-dir path")?),
            "--db" => database_path = PathBuf::from(args.next().ok_or("missing --db path")?),
            "--live-listen" => {
                live_listen = Some(args.next().ok_or("missing --live-listen address")?)
            }
            "--web-origin" => web_origin = args.next().ok_or("missing --web-origin value")?,
            "--no-live" => live_listen = None,
            "--snapshot" => {
                legacy_snapshot_path =
                    Some(PathBuf::from(args.next().ok_or("missing --snapshot path")?))
            }
            "--events" => {
                events_path = Some(PathBuf::from(args.next().ok_or("missing --events path")?))
            }
            _ => return Err(format!("unknown argument `{arg}`").into()),
        }
    }
    let token = token
        .or_else(|| env::var("ORCHETRACE_TOKEN").ok())
        .filter(|value| !value.trim().is_empty())
        .ok_or("serve requires --token or ORCHETRACE_TOKEN")?;
    let address: SocketAddr = listen.parse()?;
    if !is_loopback(address.ip()) {
        return Err("ingest currently accepts loopback listen addresses only".into());
    }
    let live_address = live_listen
        .as_deref()
        .map(str::parse::<SocketAddr>)
        .transpose()?;
    if live_address.is_some_and(|address| !is_loopback(address.ip())) {
        return Err("live updates currently accept loopback listen addresses only".into());
    }

    let mut storage = EventStore::open(&database_path)?;
    if let Some(path) = &events_path
        && path.exists()
    {
        let events = read_events(path)?;
        storage.insert_events(&events)?;
    }
    let events = storage.load_events()?;
    let event_count = events.len();
    let checkpoint = storage.load_checkpoint()?;
    let (ingest, checkpoint_status) = match checkpoint {
        Some(checkpoint) if checkpoint.event_count == event_count => {
            match IngestStore::from_events_with_runs(events, checkpoint.runs) {
                Ok(ingest) if ingest.catalog() == checkpoint.catalog => (ingest, "restored"),
                Ok(_) | Err(_) => (IngestStore::from_events(storage.load_events()?)?, "rebuilt"),
            }
        }
        _ => (IngestStore::from_events(events)?, "rebuilt"),
    };
    let catalog = ingest.catalog();
    storage.save_checkpoint(&ingest.runs(), &catalog, event_count)?;
    persist_run_data(&data_dir, &ingest.runs(), &[], &catalog, &[])?;
    prune_unlisted_run_files(&data_dir, &catalog)?;
    if let (Some(path), Some(run)) = (&legacy_snapshot_path, latest_run(&ingest.runs())) {
        write_json_atomic(path, &run.snapshot)?;
    }

    let listener = TcpListener::bind(address)?;
    let live_hub = Arc::new(LiveHub::default());
    let live_endpoint = if let Some(live_address) = live_address {
        let bound = start_live_server(
            live_address,
            token.clone(),
            web_origin.clone(),
            Arc::clone(&live_hub),
        )?;
        let endpoint = format!("ws://{bound}/v1/live");
        write_live_config(
            &data_dir,
            &json!({
                "schema_version": 1,
                "enabled": true,
                "websocket_url": endpoint,
                "token": token,
                "allowed_origin": web_origin
            }),
        )?;
        Some(endpoint)
    } else {
        write_live_config(&data_dir, &json!({ "schema_version": 1, "enabled": false }))?;
        None
    };
    println!(
        "Orchetrace ingest listening on {}; live -> {}; database -> {} ({checkpoint_status} checkpoint); data -> {}; events mirror -> {}",
        listener.local_addr()?,
        live_endpoint.as_deref().unwrap_or("off"),
        database_path.display(),
        data_dir.display(),
        events_path
            .as_deref()
            .map_or_else(|| "off".to_owned(), |path| path.display().to_string())
    );

    listener.set_nonblocking(true)?;
    let shared = Arc::new(Mutex::new(ServerState { ingest, storage }));
    let token = Arc::new(token);
    let data_dir = Arc::new(data_dir);
    let legacy_snapshot_path = Arc::new(legacy_snapshot_path);
    let events_path = Arc::new(events_path);
    let shutdown = Arc::new(AtomicBool::new(false));
    let mut clients = Vec::new();
    while !shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, peer)) => {
                if !peer.ip().is_loopback() {
                    continue;
                }
                let shared = Arc::clone(&shared);
                let token = Arc::clone(&token);
                let data_dir = Arc::clone(&data_dir);
                let legacy_snapshot_path = Arc::clone(&legacy_snapshot_path);
                let events_path = Arc::clone(&events_path);
                let live_hub = Arc::clone(&live_hub);
                let shutdown = Arc::clone(&shutdown);
                clients.push(std::thread::spawn(move || {
                    if let Err(error) = handle_client(
                        stream,
                        ClientContext {
                            token: &token,
                            state: &shared,
                            data_dir: &data_dir,
                            legacy_snapshot_path: legacy_snapshot_path.as_deref(),
                            events_path: events_path.as_deref(),
                            live_hub: &live_hub,
                            shutdown: &shutdown,
                        },
                    ) {
                        eprintln!("otrace: client disconnected: {error}");
                    }
                }));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => eprintln!("otrace: accept failed: {error}"),
        }
    }
    for client in clients {
        if client.join().is_err() {
            eprintln!("otrace: client handler panicked during shutdown");
        }
    }
    write_live_config(
        &data_dir,
        &json!({ "schema_version": 1, "enabled": false, "reason": "stopped" }),
    )?;
    println!("Orchetrace ingest stopped gracefully");
    Ok(())
}

struct ClientContext<'a> {
    token: &'a str,
    state: &'a Mutex<ServerState>,
    data_dir: &'a Path,
    legacy_snapshot_path: Option<&'a Path>,
    events_path: Option<&'a Path>,
    live_hub: &'a LiveHub,
    shutdown: &'a AtomicBool,
}

fn handle_client(
    stream: TcpStream,
    context: ClientContext<'_>,
) -> Result<(), Box<dyn std::error::Error>> {
    let ClientContext {
        token,
        state,
        data_dir,
        legacy_snapshot_path,
        events_path,
        live_hub,
        shutdown,
    } = context;
    stream.set_read_timeout(Some(Duration::from_millis(200)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = BufWriter::new(stream);
    let mut line = String::new();
    if !read_line_until_shutdown(&mut reader, &mut line, shutdown)? {
        return Ok(());
    }
    let hello: Value = serde_json::from_str(line.trim())?;
    if hello.get("kind").and_then(Value::as_str) != Some("hello")
        || hello.get("protocol").and_then(Value::as_u64) != Some(1)
        || hello.get("token").and_then(Value::as_str) != Some(token)
    {
        write_frame(
            &mut writer,
            &json!({ "kind": "error", "message": "unauthorized" }),
        )?;
        return Ok(());
    }
    write_frame(&mut writer, &json!({ "kind": "ready", "protocol": 1 }))?;

    loop {
        line.clear();
        if !read_line_until_shutdown(&mut reader, &mut line, shutdown)? {
            return Ok(());
        }
        if line.len() > 4 * 1024 * 1024 {
            write_frame(
                &mut writer,
                &json!({ "kind": "error", "message": "frame too large" }),
            )?;
            return Ok(());
        }
        if line.trim().is_empty() {
            continue;
        }
        let frame: Value = match serde_json::from_str(line.trim()) {
            Ok(frame) => frame,
            Err(error) => {
                write_frame(
                    &mut writer,
                    &json!({ "kind": "error", "message": format!("invalid event JSON: {error}") }),
                )?;
                return Ok(());
            }
        };
        if frame.get("kind").and_then(Value::as_str) == Some("control.shutdown") {
            if !is_shutdown_frame(&frame) {
                write_frame(
                    &mut writer,
                    &json!({ "kind": "error", "message": "unsupported shutdown protocol" }),
                )?;
                return Ok(());
            }
            live_hub.broadcast(&json!({ "kind": "server.stopping", "protocol": 1 }))?;
            shutdown.store(true, Ordering::Release);
            write_frame(
                &mut writer,
                &json!({ "kind": "shutdown.accepted", "protocol": 1 }),
            )?;
            return Ok(());
        }
        let event: CanonicalEvent = match serde_json::from_value(frame) {
            Ok(event) => event,
            Err(error) => {
                write_frame(
                    &mut writer,
                    &json!({ "kind": "error", "message": format!("invalid event JSON: {error}") }),
                )?;
                return Ok(());
            }
        };
        let event_id = event.event_id.clone();
        let mut state = state.lock().map_err(|_| "server state lock poisoned")?;
        let outcome = match state.ingest.ingest(event.clone()) {
            Ok(outcome) => outcome,
            Err(error) => {
                write_frame(
                    &mut writer,
                    &json!({ "kind": "error", "message": error.to_string() }),
                )?;
                return Ok(());
            }
        };
        let durable_outcome = state.storage.insert_event(&event)?;
        if durable_outcome == InsertOutcome::Inserted
            && let Some(events_path) = events_path
        {
            append_event(events_path, &event)?;
        }
        let durable_event_count = state.storage.event_count()?;
        if durable_outcome == InsertOutcome::Inserted {
            let catalog = state.ingest.catalog();
            state
                .storage
                .save_checkpoint(&outcome.updated_runs, &catalog, durable_event_count)?;
            persist_run_data(
                data_dir,
                &outcome.updated_runs,
                &outcome.run_deltas,
                &catalog,
                &outcome.removed_run_ids,
            )?;
            if let (Some(path), Some(run)) = (legacy_snapshot_path, latest_run(&outcome.runs)) {
                write_json_atomic(path, &run.snapshot)?;
            }
            live_hub.broadcast(&json!({
                "kind": "catalog.updated",
                "protocol": 1,
                "run_count": outcome.runs.len(),
                "pending_event_count": outcome.pending_event_count,
                "durable_event_count": durable_event_count,
                "delta_schema_version": 1,
                "updated_run_ids": outcome.updated_runs.iter().map(|run| &run.run_id).collect::<Vec<_>>(),
                "removed_run_ids": &outcome.removed_run_ids
            }))?;
        }
        drop(state);
        write_frame(
            &mut writer,
            &json!({
                "kind": "ack",
                "event_id": event_id,
                "run_count": outcome.runs.len(),
                "pending_event_count": outcome.pending_event_count,
                "durable_event_count": durable_event_count,
                "delta_schema_version": 1,
                "updated_run_ids": outcome.updated_runs.iter().map(|run| &run.run_id).collect::<Vec<_>>(),
                "removed_run_ids": &outcome.removed_run_ids
            }),
        )?;
    }
}

fn read_line_until_shutdown(
    reader: &mut BufReader<TcpStream>,
    line: &mut String,
    shutdown: &AtomicBool,
) -> std::io::Result<bool> {
    loop {
        if shutdown.load(Ordering::Acquire) {
            return Ok(false);
        }
        match reader.read_line(line) {
            Ok(0) => return Ok(false),
            Ok(_) => return Ok(true),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(error) => return Err(error),
        }
    }
}

fn is_shutdown_frame(frame: &Value) -> bool {
    frame.get("kind").and_then(Value::as_str) == Some("control.shutdown")
        && frame.get("protocol").and_then(Value::as_u64) == Some(1)
}

struct ServerState {
    ingest: IngestStore,
    storage: EventStore,
}

fn persist_run_data(
    data_dir: &Path,
    runs: &[RunState],
    deltas: &[RunSnapshotDelta],
    catalog: &RunCatalog,
    removed_run_ids: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
    let runs_dir = data_dir.join("runs");
    let deltas_dir = data_dir.join("deltas");
    fs::create_dir_all(&runs_dir)?;
    fs::create_dir_all(&deltas_dir)?;
    for run in runs {
        let path = runs_dir.join(format!("run-{}.json", encode_file_component(&run.run_id)));
        write_json_atomic(&path, &run.snapshot)?;
    }
    for delta in deltas {
        let path = deltas_dir.join(format!("run-{}.json", encode_file_component(&delta.run_id)));
        write_json_atomic(&path, delta)?;
    }
    // Catalog is the commit point: readers only see a revision after its snapshot and delta exist.
    write_json_atomic(&data_dir.join("run-catalog.json"), catalog)?;
    for run_id in removed_run_ids {
        let file_name = format!("run-{}.json", encode_file_component(run_id));
        for directory in [&runs_dir, &deltas_dir] {
            match fs::remove_file(directory.join(&file_name)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(())
}

fn prune_unlisted_run_files(
    data_dir: &Path,
    catalog: &RunCatalog,
) -> Result<(), Box<dyn std::error::Error>> {
    let active_files = catalog
        .runs
        .iter()
        .map(|run| format!("run-{}.json", encode_file_component(&run.run_id)))
        .collect::<BTreeSet<_>>();
    for directory in [data_dir.join("runs"), data_dir.join("deltas")] {
        if !directory.exists() {
            continue;
        }
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let file_name = entry.file_name();
            let Some(file_name) = file_name.to_str() else {
                continue;
            };
            if file_name.starts_with("run-")
                && file_name.ends_with(".json")
                && !active_files.contains(file_name)
            {
                fs::remove_file(entry.path())?;
            }
        }
    }
    Ok(())
}

fn latest_run(runs: &[RunState]) -> Option<&RunState> {
    runs.iter().max_by(|left, right| {
        (&left.snapshot.last_activity_at, &left.run_id)
            .cmp(&(&right.snapshot.last_activity_at, &right.run_id))
    })
}

fn encode_file_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len() * 2);
    for byte in value.as_bytes() {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded
}

fn read_events(path: &Path) -> Result<Vec<CanonicalEvent>, Box<dyn std::error::Error>> {
    let text = fs::read_to_string(path)?;
    let mut events = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let event = serde_json::from_str(line)
            .map_err(|error| format!("{}:{}: {error}", path.display(), index + 1))?;
        events.push(event);
    }
    Ok(events)
}

fn append_event(path: &Path, event: &CanonicalEvent) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    serde_json::to_writer(&mut file, event)?;
    file.write_all(b"\n")?;
    file.flush()?;
    Ok(())
}

fn write_json_atomic<T: Serialize>(
    path: &Path,
    value: &T,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("atomic JSON path needs a file name")?;
    let temporary = path.with_file_name(format!(".{file_name}.tmp"));
    let mut file = fs::File::create(&temporary)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn write_live_config(data_dir: &Path, value: &Value) -> Result<(), Box<dyn std::error::Error>> {
    let path = data_dir.join("live-config.json");
    write_json_atomic(&path, value)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn write_frame(writer: &mut BufWriter<TcpStream>, frame: &Value) -> std::io::Result<()> {
    serde_json::to_writer(&mut *writer, frame)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn is_loopback(ip: IpAddr) -> bool {
    ip.is_loopback()
}

fn print_usage() {
    println!(
        "Orchetrace CLI\n\nUsage:\n  otrace fold <events.jsonl> [--output snapshot.json] [--data-dir dir]\n  otrace serve [--listen 127.0.0.1:43117] --token <token> [--db path] [--data-dir dir] [--live-listen 127.0.0.1:43118] [--web-origin origin] [--no-live] [--snapshot legacy.json] [--events mirror.jsonl]"
    );
}

#[cfg(test)]
mod tests {
    use super::{encode_file_component, is_shutdown_frame};
    use serde_json::json;

    #[test]
    fn run_id_file_names_are_path_safe_and_utf8_stable() {
        assert_eq!(
            encode_file_component("deepseek-harness:本地/root"),
            "646565707365656b2d6861726e6573733ae69cace59cb02f726f6f74"
        );
    }

    #[test]
    fn shutdown_control_requires_the_supported_protocol() {
        assert!(is_shutdown_frame(
            &json!({ "kind": "control.shutdown", "protocol": 1 })
        ));
        assert!(!is_shutdown_frame(
            &json!({ "kind": "control.shutdown", "protocol": 2 })
        ));
        assert!(!is_shutdown_frame(&json!({ "kind": "control.shutdown" })));
        assert!(!is_shutdown_frame(
            &json!({ "kind": "event", "protocol": 1 })
        ));
    }
}
