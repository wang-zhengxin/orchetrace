use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::{BufRead, BufReader, BufWriter, Read, Write},
    net::{IpAddr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use chrono::{SecondsFormat, TimeDelta, Utc};
use orchetrace_core::fold_events;
use orchetrace_ingest::{IngestStore, RunCatalog, RunSnapshotDelta, RunState};
use orchetrace_protocol::{CanonicalEvent, CaptureMode, PrivacyPolicy, RuntimeKind};
use orchetrace_storage::{
    CheckpointStatus, EventStore, InsertOutcome, RetentionPolicy, StorageDiagnostics,
};
use serde::Serialize;
use serde_json::{Value, json};

mod live;

use live::{LiveHub, start_live_server};

const TIMELINE_PAGE_SIZE: usize = 1_000;
const TIMELINE_OVERVIEW_SIZE: usize = 500;

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
        Some("scrub") => scrub_command(args.collect()),
        Some("delete-session") => delete_session_command(args.collect()),
        Some("prune") => prune_command(args.collect()),
        Some("doctor") => doctor_command(args.collect()),
        Some("repair") => repair_command(args.collect()),
        Some("export") => export_command(args.collect()),
        Some("diagnostics") => diagnostics_command(args.collect()),
        Some("decompress-zstd") => decompress_zstd_command(args.collect()),
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

fn decompress_zstd_command(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let [input] = args.as_slice() else {
        return Err("decompress-zstd requires exactly one input path".into());
    };
    let file = fs::File::open(input)?;
    let stdout = std::io::stdout();
    decode_zstd(file, stdout.lock())?;
    Ok(())
}

fn decode_zstd<R: Read, W: Write>(reader: R, mut writer: W) -> std::io::Result<u64> {
    let mut decoder = zstd::stream::read::Decoder::new(reader)?;
    std::io::copy(&mut decoder, &mut writer)
}

fn doctor_command(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let mut database_path = PathBuf::from(".orchetrace/orchetrace.db");
    let mut json_output = false;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => database_path = PathBuf::from(args.next().ok_or("missing --db path")?),
            "--json" => json_output = true,
            _ => return Err(format!("unknown argument `{arg}`").into()),
        }
    }
    let storage = open_existing_store(&database_path)?;
    let diagnostics = storage.diagnose()?;
    if json_output {
        println!("{}", serde_json::to_string_pretty(&diagnostics)?);
    } else {
        println!(
            "database {}: {} events, schema v{}, checkpoint {:?}",
            if diagnostics.has_errors() {
                "ERROR"
            } else {
                "OK"
            },
            diagnostics.event_count,
            diagnostics.schema_version,
            diagnostics.checkpoint_status
        );
        for issue in &diagnostics.issues {
            println!(
                "{:?} {} {}: {}",
                issue.severity, issue.code, issue.location, issue.message
            );
        }
        if diagnostics.truncated_issue_count > 0 {
            println!(
                "{} additional diagnostic issue(s) omitted",
                diagnostics.truncated_issue_count
            );
        }
    }
    if diagnostics.has_errors() {
        return Err("database contains canonical fact or SQLite integrity errors".into());
    }
    Ok(())
}

fn repair_command(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let mut database_path = PathBuf::from(".orchetrace/orchetrace.db");
    let mut data_dir = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => database_path = PathBuf::from(args.next().ok_or("missing --db path")?),
            "--data-dir" => {
                data_dir = Some(PathBuf::from(args.next().ok_or("missing --data-dir path")?))
            }
            _ => return Err(format!("unknown argument `{arg}`").into()),
        }
    }
    let mut storage = open_existing_store(&database_path)?;
    let outcome = storage.repair_derived_state()?;
    if let Some(data_dir) = data_dir {
        refresh_projection(&mut storage, &data_dir)?;
    }
    println!(
        "rebuilt checkpoint for {} runs / {} canonical events; facts were not modified",
        outcome.run_count, outcome.event_count
    );
    Ok(())
}

fn export_command(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let mut database_path = PathBuf::from(".orchetrace/orchetrace.db");
    let mut output = None;
    let mut run_id = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => database_path = PathBuf::from(args.next().ok_or("missing --db path")?),
            "--output" | "-o" => {
                output = Some(PathBuf::from(args.next().ok_or("missing --output path")?))
            }
            "--run-id" => run_id = Some(args.next().ok_or("missing --run-id value")?),
            _ => return Err(format!("unknown argument `{arg}`").into()),
        }
    }
    let output = output.ok_or("export requires --output")?;
    if output == database_path {
        return Err("export output must not overwrite the SQLite database".into());
    }
    let storage = open_existing_store(&database_path)?;
    let events = storage.load_events()?;
    let exported = match run_id.as_deref() {
        Some(run_id) => events_for_run(events, run_id)?,
        None => events,
    };
    rewrite_events(&output, &exported)?;
    restrict_file_permissions(&output)?;
    println!(
        "exported {} canonical events to {}{}",
        exported.len(),
        output.display(),
        run_id
            .as_deref()
            .map_or_else(String::new, |run_id| format!(" for run {run_id}"))
    );
    Ok(())
}

fn diagnostics_command(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let mut database_path = PathBuf::from(".orchetrace/orchetrace.db");
    let mut output = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => database_path = PathBuf::from(args.next().ok_or("missing --db path")?),
            "--output" | "-o" => {
                output = Some(PathBuf::from(args.next().ok_or("missing --output path")?))
            }
            _ => return Err(format!("unknown argument `{arg}`").into()),
        }
    }
    let output = output.ok_or("diagnostics requires --output")?;
    if output == database_path {
        return Err("diagnostics output must not overwrite the SQLite database".into());
    }
    let storage = open_existing_store(&database_path)?;
    let storage_diagnostics = storage.diagnose()?;
    let bundle = build_diagnostic_bundle(&database_path, &storage, storage_diagnostics);
    write_json_atomic(&output, &bundle)?;
    restrict_file_permissions(&output)?;
    println!(
        "wrote content-free diagnostic bundle to {}",
        output.display()
    );
    Ok(())
}

fn scrub_command(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let mut database_path = PathBuf::from(".orchetrace/orchetrace.db");
    let mut data_dir = None;
    let mut capture_mode = CaptureMode::MetadataOnly;
    let mut sensitive_keys = Vec::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => database_path = PathBuf::from(args.next().ok_or("missing --db path")?),
            "--data-dir" => {
                data_dir = Some(PathBuf::from(args.next().ok_or("missing --data-dir path")?))
            }
            "--privacy-mode" => {
                capture_mode =
                    parse_capture_mode(&args.next().ok_or("missing --privacy-mode value")?)?
            }
            "--redact-key" => sensitive_keys.push(args.next().ok_or("missing --redact-key value")?),
            _ => return Err(format!("unknown argument `{arg}`").into()),
        }
    }
    let policy = privacy_policy(capture_mode, sensitive_keys);
    let mut storage = EventStore::open(&database_path)?;
    let outcome = storage.scrub(&policy)?;
    if let Some(data_dir) = data_dir {
        refresh_projection(&mut storage, &data_dir)?;
    }
    println!(
        "scrubbed {} events: {} redacted fields, {} omitted fields ({})",
        outcome.updated_events,
        outcome.redacted_fields,
        outcome.omitted_fields,
        capture_mode.as_str()
    );
    Ok(())
}

fn delete_session_command(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let mut database_path = PathBuf::from(".orchetrace/orchetrace.db");
    let mut data_dir = None;
    let mut runtime = None;
    let mut source_id = None;
    let mut session_id = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => database_path = PathBuf::from(args.next().ok_or("missing --db path")?),
            "--data-dir" => {
                data_dir = Some(PathBuf::from(args.next().ok_or("missing --data-dir path")?))
            }
            "--runtime" => {
                runtime = Some(parse_runtime(
                    &args.next().ok_or("missing --runtime value")?,
                )?)
            }
            "--source-id" => source_id = Some(args.next().ok_or("missing --source-id value")?),
            "--session-id" => session_id = Some(args.next().ok_or("missing --session-id value")?),
            _ => return Err(format!("unknown argument `{arg}`").into()),
        }
    }
    let runtime = runtime.ok_or("delete-session requires --runtime")?;
    let source_id = source_id.ok_or("delete-session requires --source-id")?;
    let session_id = session_id.ok_or("delete-session requires --session-id")?;
    let mut storage = EventStore::open(&database_path)?;
    let outcome = storage.delete_session_tree(&runtime, &source_id, &session_id)?;
    if let Some(data_dir) = data_dir {
        refresh_projection(&mut storage, &data_dir)?;
    }
    println!(
        "deleted {} events across {} sessions from {}",
        outcome.deleted_events,
        outcome.deleted_sessions,
        database_path.display()
    );
    Ok(())
}

fn prune_command(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let mut database_path = PathBuf::from(".orchetrace/orchetrace.db");
    let mut data_dir = None;
    let mut observed_before = None;
    let mut max_events = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => database_path = PathBuf::from(args.next().ok_or("missing --db path")?),
            "--data-dir" => {
                data_dir = Some(PathBuf::from(args.next().ok_or("missing --data-dir path")?))
            }
            "--before" => observed_before = Some(args.next().ok_or("missing --before value")?),
            "--older-than-days" => {
                let days = args
                    .next()
                    .ok_or("missing --older-than-days value")?
                    .parse::<i64>()?;
                let age = TimeDelta::try_days(days).ok_or("--older-than-days is out of range")?;
                observed_before =
                    Some((Utc::now() - age).to_rfc3339_opts(SecondsFormat::Millis, true));
            }
            "--max-events" => {
                max_events = Some(
                    args.next()
                        .ok_or("missing --max-events value")?
                        .parse::<usize>()?,
                )
            }
            _ => return Err(format!("unknown argument `{arg}`").into()),
        }
    }
    let policy = RetentionPolicy {
        observed_before,
        max_events,
    };
    if !policy.is_configured() {
        return Err("prune requires --before, --older-than-days, or --max-events".into());
    }
    let mut storage = EventStore::open(&database_path)?;
    let outcome = storage.apply_retention(&policy)?;
    if let Some(data_dir) = data_dir {
        refresh_projection(&mut storage, &data_dir)?;
    }
    println!(
        "pruned {} runs / {} events; {} events remain",
        outcome.deleted_runs, outcome.deleted_events, outcome.remaining_events
    );
    Ok(())
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
    let mut capture_mode = env::var("ORCHETRACE_PRIVACY_MODE")
        .ok()
        .map(|value| parse_capture_mode(&value))
        .transpose()?
        .unwrap_or(CaptureMode::Standard);
    let mut sensitive_keys = env::var("ORCHETRACE_REDACT_KEYS")
        .ok()
        .into_iter()
        .flat_map(|keys| {
            keys.split(',')
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let mut retention_policy = RetentionPolicy {
        observed_before: env::var("ORCHETRACE_RETENTION_DAYS")
            .ok()
            .map(|value| retention_cutoff(&value, "ORCHETRACE_RETENTION_DAYS"))
            .transpose()?,
        max_events: env::var("ORCHETRACE_MAX_EVENTS")
            .ok()
            .map(|value| value.parse::<usize>())
            .transpose()?,
    };
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
            "--privacy-mode" => {
                capture_mode =
                    parse_capture_mode(&args.next().ok_or("missing --privacy-mode value")?)?
            }
            "--redact-key" => sensitive_keys.push(args.next().ok_or("missing --redact-key value")?),
            "--retention-days" => {
                retention_policy.observed_before = Some(retention_cutoff(
                    &args.next().ok_or("missing --retention-days value")?,
                    "--retention-days",
                )?);
            }
            "--max-events" => {
                retention_policy.max_events = Some(
                    args.next()
                        .ok_or("missing --max-events value")?
                        .parse::<usize>()?,
                )
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

    let privacy_policy = privacy_policy(capture_mode, sensitive_keys);
    let mut storage = EventStore::open(&database_path)?;
    let scrub_outcome = storage.scrub(&privacy_policy)?;
    if let Some(path) = &events_path
        && path.exists()
    {
        let mut events = read_events(path)?;
        for event in &mut events {
            privacy_policy.sanitize_event(event);
        }
        storage.insert_events(&events)?;
    }
    let retention_outcome = storage.apply_retention(&retention_policy)?;
    if let Some(path) = &events_path {
        let events = storage.load_events()?;
        rewrite_events(path, &events)?;
    }
    let event_count = storage.event_count()?;
    let checkpoint = storage.load_checkpoint()?;
    let (ingest, checkpoint_status) = match checkpoint {
        Some(checkpoint) if checkpoint.event_count == event_count => {
            match IngestStore::from_cached_events_with_runs(
                storage.load_cached_events()?,
                checkpoint.runs,
            ) {
                Ok(ingest) if ingest.catalog() == checkpoint.catalog => (ingest, "restored"),
                Ok(_) | Err(_) => (IngestStore::from_events(storage.load_events()?)?, "rebuilt"),
            }
        }
        _ => (IngestStore::from_events(storage.load_events()?)?, "rebuilt"),
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
        "Orchetrace ingest listening on {}; live -> {}; database -> {} ({checkpoint_status} checkpoint, privacy {}, {} existing events scrubbed, {} retention events pruned); data -> {}; events mirror -> {}",
        listener.local_addr()?,
        live_endpoint.as_deref().unwrap_or("off"),
        database_path.display(),
        capture_mode.as_str(),
        scrub_outcome.updated_events,
        retention_outcome.deleted_events,
        data_dir.display(),
        events_path
            .as_deref()
            .map_or_else(|| "off".to_owned(), |path| path.display().to_string())
    );

    listener.set_nonblocking(true)?;
    let shared = Arc::new(Mutex::new(ServerState {
        ingest,
        storage,
        privacy_policy,
    }));
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
        let mut event: CanonicalEvent = match serde_json::from_value(frame) {
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
        state.privacy_policy.sanitize_event(&mut event);
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
    privacy_policy: PrivacyPolicy,
}

#[derive(Serialize)]
struct DiagnosticBundle {
    schema_version: u16,
    generated_at: String,
    application: DiagnosticApplication,
    database: DiagnosticDatabase,
    storage: BundleStorageDiagnostics,
    projection_available: bool,
    runtime_counts: BTreeMap<String, usize>,
    runs: Vec<Value>,
}

#[derive(Serialize)]
struct DiagnosticApplication {
    version: &'static str,
    operating_system: &'static str,
    architecture: &'static str,
}

#[derive(Serialize)]
struct DiagnosticDatabase {
    database_bytes: u64,
    wal_bytes: u64,
}

#[derive(Serialize)]
struct BundleStorageDiagnostics {
    schema_version: i64,
    event_count: usize,
    integrity_ok: bool,
    foreign_key_violations: usize,
    invalid_event_payloads: usize,
    indexed_field_mismatches: usize,
    checkpoint_status: CheckpointStatus,
    checkpoint_event_count: Option<usize>,
    checkpoint_run_count: usize,
    issue_codes: BTreeMap<String, usize>,
    truncated_issue_count: usize,
}

fn build_diagnostic_bundle(
    database_path: &Path,
    storage: &EventStore,
    storage_diagnostics: StorageDiagnostics,
) -> DiagnosticBundle {
    let storage_has_errors = storage_diagnostics.has_errors();
    let mut projection_available = false;
    let mut runtime_counts = BTreeMap::new();
    let mut runs = Vec::new();
    if !storage_has_errors
        && let Ok(events) = storage.load_events()
        && let Ok(ingest) = IngestStore::from_events(events)
    {
        projection_available = true;
        for (index, run) in ingest.catalog().runs.into_iter().enumerate() {
            *runtime_counts
                .entry(run.runtime.as_str().to_owned())
                .or_insert(0) += 1;
            runs.push(json!({
                "index": index,
                "runtime": run.runtime,
                "status": run.status,
                "outcome": run.outcome,
                "agent_count": run.agent_count,
                "edge_count": run.edge_count,
                "event_count": run.event_count,
                "started_at": run.started_at,
                "last_activity_at": run.last_activity_at,
            }));
        }
    }
    DiagnosticBundle {
        schema_version: 1,
        generated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        application: DiagnosticApplication {
            version: env!("CARGO_PKG_VERSION"),
            operating_system: env::consts::OS,
            architecture: env::consts::ARCH,
        },
        database: DiagnosticDatabase {
            database_bytes: file_size(database_path),
            wal_bytes: file_size(&sqlite_sidecar_path(database_path, "-wal")),
        },
        storage: content_free_storage_diagnostics(storage_diagnostics),
        projection_available,
        runtime_counts,
        runs,
    }
}

fn content_free_storage_diagnostics(diagnostics: StorageDiagnostics) -> BundleStorageDiagnostics {
    let mut issue_codes = BTreeMap::new();
    for issue in diagnostics.issues {
        *issue_codes.entry(issue.code).or_insert(0) += 1;
    }
    BundleStorageDiagnostics {
        schema_version: diagnostics.schema_version,
        event_count: diagnostics.event_count,
        integrity_ok: diagnostics.integrity_ok,
        foreign_key_violations: diagnostics.foreign_key_violations,
        invalid_event_payloads: diagnostics.invalid_event_payloads,
        indexed_field_mismatches: diagnostics.indexed_field_mismatches,
        checkpoint_status: diagnostics.checkpoint_status,
        checkpoint_event_count: diagnostics.checkpoint_event_count,
        checkpoint_run_count: diagnostics.checkpoint_run_count,
        issue_codes,
        truncated_issue_count: diagnostics.truncated_issue_count,
    }
}

fn events_for_run(
    events: Vec<CanonicalEvent>,
    run_id: &str,
) -> Result<Vec<CanonicalEvent>, Box<dyn std::error::Error>> {
    let ingest = IngestStore::from_events(events.clone())?;
    let run = ingest
        .runs()
        .into_iter()
        .find(|run| run.run_id == run_id)
        .ok_or_else(|| format!("run `{run_id}` was not found"))?;
    let session_ids = run
        .snapshot
        .agents
        .iter()
        .map(|agent| agent.id.as_str())
        .collect::<BTreeSet<_>>();
    Ok(events
        .into_iter()
        .filter(|event| {
            event.runtime == run.runtime
                && event.source_id == run.source_id
                && session_ids.contains(event.session_id.as_str())
        })
        .collect())
}

fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map_or(0, |metadata| metadata.len())
}

fn open_existing_store(path: &Path) -> Result<EventStore, Box<dyn std::error::Error>> {
    if !path.is_file() {
        return Err(format!("database does not exist: {}", path.display()).into());
    }
    Ok(EventStore::open(path)?)
}

fn restrict_file_permissions(_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(_path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn privacy_policy(
    capture_mode: CaptureMode,
    sensitive_keys: impl IntoIterator<Item = String>,
) -> PrivacyPolicy {
    let mut policy = PrivacyPolicy::new(capture_mode);
    for key in sensitive_keys {
        policy.add_sensitive_key(key);
    }
    policy
}

fn parse_capture_mode(value: &str) -> Result<CaptureMode, Box<dyn std::error::Error>> {
    match value {
        "standard" => Ok(CaptureMode::Standard),
        "metadata-only" | "metadata" => Ok(CaptureMode::MetadataOnly),
        _ => {
            Err(format!("unsupported privacy mode `{value}`; use standard or metadata-only").into())
        }
    }
}

fn parse_runtime(value: &str) -> Result<RuntimeKind, Box<dyn std::error::Error>> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || !trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(format!("invalid runtime identifier `{value}`").into());
    }
    Ok(RuntimeKind::from_slug(trimmed))
}

fn retention_cutoff(value: &str, option: &str) -> Result<String, Box<dyn std::error::Error>> {
    let days = value.parse::<i64>()?;
    let age = TimeDelta::try_days(days).ok_or_else(|| format!("{option} is out of range"))?;
    Ok((Utc::now() - age).to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn refresh_projection(
    storage: &mut EventStore,
    data_dir: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let events = storage.load_events()?;
    let event_count = events.len();
    let ingest = IngestStore::from_events(events)?;
    let catalog = ingest.catalog();
    storage.save_checkpoint(&ingest.runs(), &catalog, event_count)?;
    persist_run_data(data_dir, &ingest.runs(), &[], &catalog, &[])?;
    prune_unlisted_run_files(data_dir, &catalog)?;
    Ok(())
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
        let delta = deltas.iter().find(|delta| delta.run_id == run.run_id);
        if delta.is_none_or(|delta| delta.timeline.is_some()) {
            let timeline_replace_from = delta
                .and_then(|delta| delta.timeline.as_ref())
                .map(|timeline| timeline.replace_from);
            persist_timeline_pages(data_dir, run, timeline_replace_from)?;
        }
        let path = runs_dir.join(format!("run-{}.json", encode_file_component(&run.run_id)));
        write_json_atomic(&path, &persisted_run_snapshot(run)?)?;
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
        let timeline_directory = data_dir
            .join("timelines")
            .join(format!("run-{}", encode_file_component(run_id)));
        match fs::remove_dir_all(timeline_directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn persisted_run_snapshot(run: &RunState) -> Result<Value, serde_json::Error> {
    let mut value = serde_json::to_value(&run.snapshot)?;
    let timeline = &run.snapshot.timeline;
    if timeline.len() <= TIMELINE_PAGE_SIZE {
        return Ok(value);
    }
    let overview = (0..TIMELINE_OVERVIEW_SIZE)
        .map(|index| {
            let source_index = index * (timeline.len() - 1) / (TIMELINE_OVERVIEW_SIZE - 1);
            &timeline[source_index]
        })
        .collect::<Vec<_>>();
    value["timeline"] = serde_json::to_value(overview)?;
    value["timeline_paging"] = json!({
        "schema_version": 1,
        "total_entries": timeline.len(),
        "page_size": TIMELINE_PAGE_SIZE,
        "page_count": timeline.len().div_ceil(TIMELINE_PAGE_SIZE),
        "complete": false
    });
    Ok(value)
}

fn persist_timeline_pages(
    data_dir: &Path,
    run: &RunState,
    replace_from: Option<usize>,
) -> Result<(), Box<dyn std::error::Error>> {
    let directory = data_dir
        .join("timelines")
        .join(format!("run-{}", encode_file_component(&run.run_id)));
    if run.snapshot.timeline.len() <= TIMELINE_PAGE_SIZE {
        match fs::remove_dir_all(directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        return Ok(());
    }
    let existed = directory.is_dir();
    fs::create_dir_all(&directory)?;
    let page_count = run.snapshot.timeline.len().div_ceil(TIMELINE_PAGE_SIZE);
    let first_page = if existed {
        replace_from.unwrap_or(0) / TIMELINE_PAGE_SIZE
    } else {
        0
    };
    for page in first_page..page_count {
        let start = page * TIMELINE_PAGE_SIZE;
        let end = (start + TIMELINE_PAGE_SIZE).min(run.snapshot.timeline.len());
        write_json_atomic(
            &directory.join(format!("page-{page:06}.json")),
            &run.snapshot.timeline[start..end],
        )?;
    }
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(page) = name
            .strip_prefix("page-")
            .and_then(|value| value.strip_suffix(".json"))
            .and_then(|value| value.parse::<usize>().ok())
        else {
            continue;
        };
        if page >= page_count {
            fs::remove_file(entry.path())?;
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
    let timelines_dir = data_dir.join("timelines");
    if timelines_dir.exists() {
        for entry in fs::read_dir(&timelines_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let Some(encoded) = name.to_str().and_then(|name| name.strip_prefix("run-")) else {
                continue;
            };
            if !active_files.contains(&format!("run-{encoded}.json")) {
                fs::remove_dir_all(entry.path())?;
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

fn rewrite_events(
    path: &Path,
    events: &[CanonicalEvent],
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("events mirror path needs a file name")?;
    let temporary = path.with_file_name(format!(".{file_name}.tmp"));
    let mut file = fs::File::create(&temporary)?;
    for event in events {
        serde_json::to_writer(&mut file, event)?;
        file.write_all(b"\n")?;
    }
    file.sync_all()?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn write_json_atomic<T: Serialize + ?Sized>(
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
        "Orchetrace CLI\n\nUsage:\n  otrace fold <events.jsonl> [--output snapshot.json] [--data-dir dir]\n  otrace serve [--listen 127.0.0.1:43117] --token <token> [--db path] [--data-dir dir] [--privacy-mode standard|metadata-only] [--redact-key key] [--retention-days days] [--max-events count] [--live-listen 127.0.0.1:43118] [--web-origin origin] [--no-live] [--snapshot legacy.json] [--events mirror.jsonl]\n  otrace scrub [--db path] [--data-dir dir] [--privacy-mode standard|metadata-only] [--redact-key key]\n  otrace delete-session [--db path] [--data-dir dir] --runtime runtime --source-id id --session-id id\n  otrace prune [--db path] [--data-dir dir] [--before RFC3339 | --older-than-days days] [--max-events count]\n  otrace doctor [--db path] [--json]\n  otrace repair [--db path] [--data-dir dir]\n  otrace export [--db path] --output events.jsonl [--run-id id]\n  otrace diagnostics [--db path] --output diagnostics.json"
    );
}

#[cfg(test)]
mod tests {
    use super::{
        build_diagnostic_bundle, decode_zstd, diagnostics_command, doctor_command,
        encode_file_component, events_for_run, export_command, is_shutdown_frame, persist_run_data,
        repair_command,
    };
    use orchetrace_ingest::{RunCatalog, RunState};
    use orchetrace_protocol::{CanonicalEvent, EventType, RuntimeKind};
    use orchetrace_storage::EventStore;
    use serde_json::json;
    use std::{
        collections::BTreeMap,
        fs, process,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn run_id_file_names_are_path_safe_and_utf8_stable() {
        assert_eq!(
            encode_file_component("deepseek-harness:本地/root"),
            "646565707365656b2d6861726e6573733ae69cace59cb02f726f6f74"
        );
    }

    #[test]
    fn bundled_decoder_reads_concatenated_zstd_frames() {
        let mut frames = zstd::encode_all(b"first\n".as_slice(), 1).unwrap();
        frames.extend(zstd::encode_all(b"second\n".as_slice(), 1).unwrap());
        let mut decoded = Vec::new();

        decode_zstd(frames.as_slice(), &mut decoded).unwrap();

        assert_eq!(decoded, b"first\nsecond\n");
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

    #[test]
    fn long_timelines_are_persisted_as_an_overview_and_pages() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "orchetrace-timeline-pages-{}-{nonce}",
            process::id()
        ));
        let timeline = (0..1_005)
            .map(|index| {
                json!({
                    "session_id": "root",
                    "at": format!("2026-01-01T00:{:02}:{:02}.000Z", (index / 60) % 60, index % 60),
                    "kind": "message",
                    "label": format!("event-{index}"),
                    "outcome": null
                })
            })
            .collect::<Vec<_>>();
        let run: RunState = serde_json::from_value(json!({
            "run_id": "runtime:4:test:4:root",
            "source_id": "test",
            "runtime": "synthetic-runtime",
            "snapshot": {
                "schema_version": 1,
                "root_session_id": "root",
                "runtimes": ["synthetic-runtime"],
                "event_count": 1_005,
                "started_at": "2026-01-01T00:00:00.000Z",
                "last_activity_at": "2026-01-01T00:16:44.000Z",
                "agents": [],
                "edges": [],
                "timeline": timeline
            }
        }))
        .unwrap();
        let catalog: RunCatalog = serde_json::from_value(json!({
            "schema_version": 1,
            "pending_event_count": 0,
            "runs": []
        }))
        .unwrap();

        persist_run_data(&directory, &[run.clone()], &[], &catalog, &[]).unwrap();
        let encoded = encode_file_component(&run.run_id);
        let snapshot: serde_json::Value = serde_json::from_slice(
            &fs::read(directory.join("runs").join(format!("run-{encoded}.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(snapshot["timeline"].as_array().unwrap().len(), 500);
        assert_eq!(snapshot["timeline_paging"]["total_entries"], 1_005);
        assert_eq!(snapshot["timeline_paging"]["page_count"], 2);
        let pages = directory.join("timelines").join(format!("run-{encoded}"));
        let first: serde_json::Value =
            serde_json::from_slice(&fs::read(pages.join("page-000000.json")).unwrap()).unwrap();
        let second: serde_json::Value =
            serde_json::from_slice(&fs::read(pages.join("page-000001.json")).unwrap()).unwrap();
        assert_eq!(first.as_array().unwrap().len(), 1_000);
        assert_eq!(second.as_array().unwrap().len(), 5);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn run_export_contains_only_the_selected_topology() {
        let events = vec![
            diagnostic_event("root-a", "root-a", None, 1, "visible"),
            diagnostic_event("child-a", "child-a", Some("root-a"), 2, "child"),
            diagnostic_event("root-b", "root-b", None, 3, "other"),
        ];
        let ingest = orchetrace_ingest::IngestStore::from_events(events.clone()).unwrap();
        let selected_id = ingest
            .runs()
            .into_iter()
            .find(|run| run.snapshot.root_session_id == "root-a")
            .unwrap()
            .run_id;
        let selected = events_for_run(events, &selected_id).unwrap();
        assert_eq!(
            selected
                .iter()
                .map(|event| event.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["root-a", "child-a"]
        );
    }

    #[test]
    fn diagnostic_bundle_excludes_event_content_and_identifiers() {
        let directory = temporary_directory("diagnostic-bundle");
        let database = directory.join("events.db");
        let mut store = EventStore::open(&database).unwrap();
        store
            .insert_event(&diagnostic_event(
                "private-event-id",
                "private-session-id",
                None,
                1,
                "TOP SECRET PROMPT",
            ))
            .unwrap();
        let diagnostics = store.diagnose().unwrap();
        let bundle = build_diagnostic_bundle(&database, &store, diagnostics);
        let serialized = serde_json::to_string(&bundle).unwrap();
        assert!(!serialized.contains("TOP SECRET PROMPT"));
        assert!(!serialized.contains("private-event-id"));
        assert!(!serialized.contains("private-session-id"));
        assert!(serialized.contains("deepseek-harness"));
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn maintenance_commands_complete_a_safe_operational_round_trip() {
        let directory = temporary_directory("maintenance-round-trip");
        let database = directory.join("events.db");
        let data_dir = directory.join("projection");
        let export = directory.join("events.jsonl");
        let diagnostics = directory.join("diagnostics.json");
        let mut store = EventStore::open(&database).unwrap();
        store
            .insert_event(&diagnostic_event("event-1", "root", None, 1, "private"))
            .unwrap();
        drop(store);

        doctor_command(vec![
            "--db".into(),
            database.display().to_string(),
            "--json".into(),
        ])
        .unwrap();
        repair_command(vec![
            "--db".into(),
            database.display().to_string(),
            "--data-dir".into(),
            data_dir.display().to_string(),
        ])
        .unwrap();
        export_command(vec![
            "--db".into(),
            database.display().to_string(),
            "--output".into(),
            export.display().to_string(),
        ])
        .unwrap();
        diagnostics_command(vec![
            "--db".into(),
            database.display().to_string(),
            "--output".into(),
            diagnostics.display().to_string(),
        ])
        .unwrap();

        assert_eq!(fs::read_to_string(&export).unwrap().lines().count(), 1);
        assert!(data_dir.join("run-catalog.json").is_file());
        let bundle = fs::read_to_string(&diagnostics).unwrap();
        assert!(bundle.contains("\"projection_available\": true"));
        assert!(!bundle.contains("private"));
        fs::remove_dir_all(directory).unwrap();
    }

    fn diagnostic_event(
        event_id: &str,
        session_id: &str,
        parent_session_id: Option<&str>,
        source_seq: u64,
        label: &str,
    ) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            event_id: event_id.to_owned(),
            runtime: RuntimeKind::DeepSeekHarness,
            source_id: "private-source-id".to_owned(),
            session_id: session_id.to_owned(),
            parent_session_id: parent_session_id.map(str::to_owned),
            source_seq,
            observed_at: format!("2026-08-30T00:00:{source_seq:02}Z"),
            occurred_at: None,
            event_type: EventType::SessionDiscovered,
            data: json!({ "label": label }),
            attributes: BTreeMap::new(),
            source_ref: None,
            supersedes_event_id: None,
            ignorable: false,
        }
    }

    fn temporary_directory(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("orchetrace-{label}-{}-{nonce}", process::id()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }
}
