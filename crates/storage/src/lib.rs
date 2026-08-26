use std::{collections::BTreeSet, fs, path::Path};

use orchetrace_ingest::{RunCatalog, RunState};
use orchetrace_protocol::{CanonicalEvent, RuntimeKind, ValidationError};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

const SCHEMA_VERSION: i64 = 2;

pub struct EventStore {
    connection: Connection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertOutcome {
    Inserted,
    Duplicate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BatchInsertOutcome {
    pub inserted: usize,
    pub duplicates: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectionCheckpoint {
    pub event_count: usize,
    pub runs: Vec<RunState>,
    pub catalog: RunCatalog,
}

#[derive(Debug)]
pub enum StorageError {
    Sql(rusqlite::Error),
    Json(serde_json::Error),
    Io(std::io::Error),
    InvalidEvent {
        event_id: String,
        source: ValidationError,
    },
    SourceSequenceOutOfRange {
        event_id: String,
        source_seq: u64,
    },
    ConflictingDuplicate(String),
    UnsupportedSchema(i64),
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sql(source) => write!(formatter, "SQLite error: {source}"),
            Self::Json(source) => write!(formatter, "stored event JSON error: {source}"),
            Self::Io(source) => write!(formatter, "storage filesystem error: {source}"),
            Self::InvalidEvent { event_id, source } => {
                write!(formatter, "invalid event `{event_id}`: {source}")
            }
            Self::SourceSequenceOutOfRange {
                event_id,
                source_seq,
            } => write!(
                formatter,
                "event `{event_id}` source sequence {source_seq} exceeds SQLite INTEGER range"
            ),
            Self::ConflictingDuplicate(event_id) => {
                write!(formatter, "conflicting duplicate event `{event_id}`")
            }
            Self::UnsupportedSchema(version) => {
                write!(formatter, "unsupported storage schema version {version}")
            }
        }
    }
}

impl std::error::Error for StorageError {}

impl From<rusqlite::Error> for StorageError {
    fn from(source: rusqlite::Error) -> Self {
        Self::Sql(source)
    }
}

impl From<serde_json::Error> for StorageError {
    fn from(source: serde_json::Error) -> Self {
        Self::Json(source)
    }
}

impl From<std::io::Error> for StorageError {
    fn from(source: std::io::Error) -> Self {
        Self::Io(source)
    }
}

impl EventStore {
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        Self::from_connection(Connection::open(path)?)
    }

    fn from_connection(connection: Connection) -> Result<Self, StorageError> {
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;

        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(StorageError::UnsupportedSchema(version));
        }
        if version == 0 {
            connection.execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE canonical_events (
                    event_id TEXT PRIMARY KEY NOT NULL,
                    runtime TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    parent_session_id TEXT,
                    source_seq INTEGER NOT NULL,
                    observed_at TEXT NOT NULL,
                    occurred_at TEXT,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                 ) WITHOUT ROWID;
                 CREATE INDEX canonical_events_session_seq
                    ON canonical_events(runtime, source_id, session_id, source_seq);
                 CREATE INDEX canonical_events_observed_at
                    ON canonical_events(observed_at, event_id);
                 PRAGMA user_version = 1;
                 COMMIT;",
            )?;
        }
        if version <= 1 {
            connection.execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS run_snapshots (
                    run_id TEXT PRIMARY KEY NOT NULL,
                    checkpoint_event_count INTEGER NOT NULL,
                    run_json TEXT NOT NULL
                 ) WITHOUT ROWID;
                 CREATE TABLE IF NOT EXISTS run_catalog_checkpoint (
                    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
                    checkpoint_event_count INTEGER NOT NULL,
                    catalog_json TEXT NOT NULL
                 );
                 PRAGMA user_version = 2;
                 COMMIT;",
            )?;
        }
        Ok(Self { connection })
    }

    pub fn insert_event(&mut self, event: &CanonicalEvent) -> Result<InsertOutcome, StorageError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let outcome = insert_event_in_transaction(&transaction, event)?;
        transaction.commit()?;
        Ok(outcome)
    }

    pub fn insert_events(
        &mut self,
        events: &[CanonicalEvent],
    ) -> Result<BatchInsertOutcome, StorageError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut outcome = BatchInsertOutcome::default();
        for event in events {
            match insert_event_in_transaction(&transaction, event)? {
                InsertOutcome::Inserted => outcome.inserted += 1,
                InsertOutcome::Duplicate => outcome.duplicates += 1,
            }
        }
        transaction.commit()?;
        Ok(outcome)
    }

    pub fn load_events(&self) -> Result<Vec<CanonicalEvent>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT payload_json
             FROM canonical_events
             ORDER BY observed_at, runtime, source_id, session_id, source_seq, event_id",
        )?;
        let payloads = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut events = Vec::new();
        for payload in payloads {
            events.push(serde_json::from_str(&payload?)?);
        }
        Ok(events)
    }

    pub fn event_count(&self) -> Result<usize, StorageError> {
        let count: i64 =
            self.connection
                .query_row("SELECT COUNT(*) FROM canonical_events", [], |row| {
                    row.get(0)
                })?;
        Ok(usize::try_from(count).expect("SQLite COUNT(*) cannot be negative"))
    }

    pub fn save_checkpoint(
        &mut self,
        updated_runs: &[RunState],
        catalog: &RunCatalog,
        event_count: usize,
    ) -> Result<(), StorageError> {
        let event_count = i64::try_from(event_count).expect("event count fits SQLite INTEGER");
        let active_run_ids: BTreeSet<_> =
            catalog.runs.iter().map(|run| run.run_id.as_str()).collect();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for run in updated_runs {
            transaction.execute(
                "INSERT INTO run_snapshots (run_id, checkpoint_event_count, run_json)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(run_id) DO UPDATE SET
                    checkpoint_event_count = excluded.checkpoint_event_count,
                    run_json = excluded.run_json",
                params![run.run_id, event_count, serde_json::to_string(run)?],
            )?;
        }
        let stored_run_ids = {
            let mut statement = transaction.prepare("SELECT run_id FROM run_snapshots")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for run_id in stored_run_ids {
            if !active_run_ids.contains(run_id.as_str()) {
                transaction.execute("DELETE FROM run_snapshots WHERE run_id = ?1", [&run_id])?;
            }
        }
        transaction.execute(
            "INSERT INTO run_catalog_checkpoint
                (singleton, checkpoint_event_count, catalog_json)
             VALUES (1, ?1, ?2)
             ON CONFLICT(singleton) DO UPDATE SET
                checkpoint_event_count = excluded.checkpoint_event_count,
                catalog_json = excluded.catalog_json",
            params![event_count, serde_json::to_string(catalog)?],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn load_checkpoint(&self) -> Result<Option<ProjectionCheckpoint>, StorageError> {
        let catalog_row: Option<(i64, String)> = self
            .connection
            .query_row(
                "SELECT checkpoint_event_count, catalog_json
                 FROM run_catalog_checkpoint WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((event_count, catalog_json)) = catalog_row else {
            return Ok(None);
        };
        let catalog: RunCatalog = match serde_json::from_str(&catalog_json) {
            Ok(catalog) => catalog,
            Err(_) => return Ok(None),
        };
        let mut statement = self.connection.prepare(
            "SELECT checkpoint_event_count, run_json FROM run_snapshots ORDER BY run_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut runs = Vec::new();
        for row in rows {
            let (run_event_count, run_json) = row?;
            if run_event_count > event_count {
                return Ok(None);
            }
            match serde_json::from_str(&run_json) {
                Ok(run) => runs.push(run),
                Err(_) => return Ok(None),
            }
        }
        let catalog_ids: BTreeSet<_> = catalog.runs.iter().map(|run| &run.run_id).collect();
        let run_ids: BTreeSet<_> = runs.iter().map(|run: &RunState| &run.run_id).collect();
        if catalog_ids != run_ids || event_count < 0 {
            return Ok(None);
        }
        Ok(Some(ProjectionCheckpoint {
            event_count: usize::try_from(event_count)
                .expect("non-negative SQLite event count fits usize"),
            runs,
            catalog,
        }))
    }

    #[cfg(test)]
    fn open_in_memory() -> Result<Self, StorageError> {
        Self::from_connection(Connection::open_in_memory()?)
    }
}

fn insert_event_in_transaction(
    transaction: &Transaction<'_>,
    event: &CanonicalEvent,
) -> Result<InsertOutcome, StorageError> {
    event
        .validate()
        .map_err(|source| StorageError::InvalidEvent {
            event_id: event.event_id.clone(),
            source,
        })?;
    let source_seq =
        i64::try_from(event.source_seq).map_err(|_| StorageError::SourceSequenceOutOfRange {
            event_id: event.event_id.clone(),
            source_seq: event.source_seq,
        })?;
    let payload = serde_json::to_string(event)?;
    let runtime = runtime_slug(&event.runtime);
    let event_type = serde_json::to_string(&event.event_type)?;
    let event_type = event_type.trim_matches('"');

    let inserted = transaction.execute(
        "INSERT OR IGNORE INTO canonical_events (
                event_id, runtime, source_id, session_id, parent_session_id,
                source_seq, observed_at, occurred_at, event_type, payload_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            event.event_id,
            runtime,
            event.source_id,
            event.session_id,
            event.parent_session_id,
            source_seq,
            event.observed_at,
            event.occurred_at,
            event_type,
            payload,
        ],
    )?;
    let outcome = if inserted == 1 {
        InsertOutcome::Inserted
    } else {
        let existing: Option<String> = transaction
            .query_row(
                "SELECT payload_json FROM canonical_events WHERE event_id = ?1",
                [&event.event_id],
                |row| row.get(0),
            )
            .optional()?;
        if existing.as_deref() != Some(payload.as_str()) {
            return Err(StorageError::ConflictingDuplicate(event.event_id.clone()));
        }
        InsertOutcome::Duplicate
    };
    Ok(outcome)
}

fn runtime_slug(runtime: &RuntimeKind) -> &'static str {
    match runtime {
        RuntimeKind::ClaudeCode => "claude-code",
        RuntimeKind::Pi => "pi",
        RuntimeKind::DeepSeekHarness => "deepseek-harness",
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    use orchetrace_protocol::{EventType, RuntimeKind};
    use serde_json::json;

    use super::*;

    fn event(id: &str, sequence: u64, label: &str) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            event_id: id.into(),
            runtime: RuntimeKind::DeepSeekHarness,
            source_id: "local".into(),
            session_id: "root".into(),
            parent_session_id: None,
            source_seq: sequence,
            observed_at: format!("2026-08-25T00:00:{sequence:02}Z"),
            occurred_at: None,
            event_type: EventType::SessionDiscovered,
            data: json!({ "label": label }),
            attributes: BTreeMap::new(),
            source_ref: None,
            supersedes_event_id: None,
            ignorable: false,
        }
    }

    #[test]
    fn identical_event_is_idempotent_and_reloadable() {
        let mut store = EventStore::open_in_memory().unwrap();
        let event = event("evt-1", 1, "root");
        assert_eq!(store.insert_event(&event).unwrap(), InsertOutcome::Inserted);
        assert_eq!(
            store.insert_event(&event).unwrap(),
            InsertOutcome::Duplicate
        );
        assert_eq!(store.event_count().unwrap(), 1);
        assert_eq!(store.load_events().unwrap(), vec![event]);
    }

    #[test]
    fn conflicting_duplicate_is_rejected_without_replacing_the_fact() {
        let mut store = EventStore::open_in_memory().unwrap();
        let original = event("evt-1", 1, "root");
        let conflicting = event("evt-1", 1, "changed");
        store.insert_event(&original).unwrap();
        let error = store.insert_event(&conflicting).unwrap_err();
        assert!(matches!(error, StorageError::ConflictingDuplicate(_)));
        assert_eq!(store.load_events().unwrap(), vec![original]);
    }

    #[test]
    fn batch_insert_is_atomic_and_reports_duplicates() {
        let mut store = EventStore::open_in_memory().unwrap();
        let first = event("evt-1", 1, "first");
        let second = event("evt-2", 2, "second");
        store.insert_event(&first).unwrap();
        let outcome = store
            .insert_events(&[first.clone(), second.clone()])
            .unwrap();
        assert_eq!(outcome.inserted, 1);
        assert_eq!(outcome.duplicates, 1);

        let conflicting = event("evt-1", 1, "conflict");
        let third = event("evt-3", 3, "third");
        let error = store.insert_events(&[third, conflicting]).unwrap_err();
        assert!(matches!(error, StorageError::ConflictingDuplicate(_)));
        assert_eq!(store.load_events().unwrap(), vec![first, second]);
    }

    #[test]
    fn reload_order_is_deterministic() {
        let mut store = EventStore::open_in_memory().unwrap();
        let later = event("evt-2", 2, "later");
        let earlier = event("evt-1", 1, "earlier");
        store.insert_event(&later).unwrap();
        store.insert_event(&earlier).unwrap();
        assert_eq!(store.load_events().unwrap(), vec![earlier, later]);
    }

    #[test]
    fn file_database_recovers_events_after_reopen() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "orchetrace-storage-test-{}-{nonce}.db",
            std::process::id()
        ));
        let original = event("evt-restart", 1, "recovered");
        {
            let mut store = EventStore::open(&path).unwrap();
            store.insert_event(&original).unwrap();
        }
        {
            let store = EventStore::open(&path).unwrap();
            assert_eq!(store.load_events().unwrap(), vec![original]);
        }
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn checkpoint_round_trip_supports_partial_updates_and_prunes_stale_runs() {
        let first = event("evt-1", 1, "first");
        let mut second = event("evt-2", 2, "second");
        second.session_id = "second-root".into();
        let ingest = orchetrace_ingest::IngestStore::from_events([first, second]).unwrap();
        let runs = ingest.runs();
        let catalog = ingest.catalog();
        let mut store = EventStore::open_in_memory().unwrap();
        store.save_checkpoint(&runs, &catalog, 2).unwrap();
        let checkpoint = store.load_checkpoint().unwrap().unwrap();
        assert_eq!(checkpoint.event_count, 2);
        assert_eq!(checkpoint.runs, runs);
        assert_eq!(checkpoint.catalog, catalog);

        store.save_checkpoint(&runs[..1], &catalog, 3).unwrap();
        let partial = store.load_checkpoint().unwrap().unwrap();
        assert_eq!(partial.runs.len(), 2);
        assert_eq!(partial.event_count, 3);

        let mut reduced_catalog = catalog;
        reduced_catalog
            .runs
            .retain(|summary| summary.run_id == runs[0].run_id);
        store
            .save_checkpoint(&runs[..1], &reduced_catalog, 4)
            .unwrap();
        let reduced = store.load_checkpoint().unwrap().unwrap();
        assert_eq!(reduced.runs, runs[..1]);
    }

    #[test]
    fn version_one_database_is_migrated_to_checkpoint_schema() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE canonical_events (
                    event_id TEXT PRIMARY KEY NOT NULL,
                    runtime TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    parent_session_id TEXT,
                    source_seq INTEGER NOT NULL,
                    observed_at TEXT NOT NULL,
                    occurred_at TEXT,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                 ) WITHOUT ROWID;
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        let store = EventStore::from_connection(connection).unwrap();
        let version: i64 = store
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);
        assert!(store.load_checkpoint().unwrap().is_none());
    }

    #[test]
    fn corrupted_derived_checkpoint_is_ignored() {
        let ingest =
            orchetrace_ingest::IngestStore::from_events([event("evt-1", 1, "root")]).unwrap();
        let mut store = EventStore::open_in_memory().unwrap();
        store
            .save_checkpoint(&ingest.runs(), &ingest.catalog(), 1)
            .unwrap();
        store
            .connection
            .execute(
                "UPDATE run_catalog_checkpoint SET catalog_json = 'not-json' WHERE singleton = 1",
                [],
            )
            .unwrap();
        assert!(store.load_checkpoint().unwrap().is_none());
    }
}
