use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

use orchetrace_ingest::{CachedEvent, IngestError, IngestStore, RunCatalog, RunState};
use orchetrace_protocol::{CanonicalEvent, PrivacyPolicy, RuntimeKind, ValidationError};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Serialize;

const SCHEMA_VERSION: i64 = 4;
const PRIVACY_POLICY_KEY: &str = "privacy-policy-fingerprint";
const MAX_DIAGNOSTIC_ISSUES: usize = 100;

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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DeleteOutcome {
    pub deleted_events: usize,
    pub deleted_sessions: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RetentionPolicy {
    /// RFC 3339 UTC timestamp. Runs whose newest observation is older are deleted as a unit.
    pub observed_before: Option<String>,
    /// Hard event limit. Oldest complete runs are deleted until the store fits.
    pub max_events: Option<usize>,
}

impl RetentionPolicy {
    pub fn is_configured(&self) -> bool {
        self.observed_before.is_some() || self.max_events.is_some()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RetentionOutcome {
    pub deleted_events: usize,
    pub deleted_runs: usize,
    pub remaining_events: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ScrubOutcome {
    pub updated_events: usize,
    pub redacted_fields: usize,
    pub omitted_fields: usize,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticSeverity {
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CheckpointStatus {
    NotRequired,
    Healthy,
    Missing,
    Stale,
    Corrupt,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StorageDiagnosticIssue {
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub location: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StorageDiagnostics {
    pub schema_version: i64,
    pub event_count: usize,
    pub integrity_ok: bool,
    pub foreign_key_violations: usize,
    pub invalid_event_payloads: usize,
    pub indexed_field_mismatches: usize,
    pub checkpoint_status: CheckpointStatus,
    pub checkpoint_event_count: Option<usize>,
    pub checkpoint_run_count: usize,
    pub issues: Vec<StorageDiagnosticIssue>,
    pub truncated_issue_count: usize,
}

impl StorageDiagnostics {
    pub fn has_errors(&self) -> bool {
        !self.integrity_ok
            || self.foreign_key_violations > 0
            || self.invalid_event_payloads > 0
            || self.indexed_field_mismatches > 0
            || self
                .issues
                .iter()
                .any(|issue| issue.severity == DiagnosticSeverity::Error)
    }

    pub fn is_repairable(&self) -> bool {
        !self.has_errors()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Default, PartialEq, Eq)]
pub struct RepairOutcome {
    pub event_count: usize,
    pub run_count: usize,
    pub checkpoint_rebuilt: bool,
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
    Projection(IngestError),
    Unrepairable(String),
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
            Self::Projection(source) => write!(formatter, "projection rebuild failed: {source}"),
            Self::Unrepairable(message) => {
                write!(formatter, "storage is not safely repairable: {message}")
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

impl From<IngestError> for StorageError {
    fn from(source: IngestError) -> Self {
        Self::Projection(source)
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
        if version <= 2 {
            connection.execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS storage_metadata (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL
                 ) WITHOUT ROWID;
                 PRAGMA user_version = 3;
                 COMMIT;",
            )?;
        }
        if version <= 3 {
            connection.execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE INDEX IF NOT EXISTS canonical_events_parent_session
                    ON canonical_events(runtime, source_id, parent_session_id, session_id);
                 PRAGMA user_version = 4;
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

    pub fn load_cached_events(&self) -> Result<Vec<CachedEvent>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT event_id, runtime, source_id, session_id, parent_session_id, payload_json
             FROM canonical_events
             ORDER BY event_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(CachedEvent {
                event_id: row.get(0)?,
                runtime: RuntimeKind::from_slug(row.get::<_, String>(1)?),
                source_id: row.get(2)?,
                session_id: row.get(3)?,
                parent_session_id: row.get(4)?,
                payload_json: row.get::<_, String>(5)?.into_boxed_str(),
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn event_count(&self) -> Result<usize, StorageError> {
        let count: i64 =
            self.connection
                .query_row("SELECT COUNT(*) FROM canonical_events", [], |row| {
                    row.get(0)
                })?;
        Ok(usize::try_from(count).expect("SQLite COUNT(*) cannot be negative"))
    }

    /// Inspect durable facts and derived checkpoints without changing either.
    pub fn diagnose(&self) -> Result<StorageDiagnostics, StorageError> {
        let schema_version = self
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))?;
        let event_count = self.event_count()?;
        let mut diagnostics = StorageDiagnostics {
            schema_version,
            event_count,
            integrity_ok: true,
            foreign_key_violations: 0,
            invalid_event_payloads: 0,
            indexed_field_mismatches: 0,
            checkpoint_status: CheckpointStatus::NotRequired,
            checkpoint_event_count: None,
            checkpoint_run_count: 0,
            issues: Vec::new(),
            truncated_issue_count: 0,
        };

        let mut integrity_statement = self.connection.prepare("PRAGMA integrity_check")?;
        let integrity_rows = integrity_statement.query_map([], |row| row.get::<_, String>(0))?;
        for result in integrity_rows {
            let message = result?;
            if message != "ok" {
                diagnostics.integrity_ok = false;
                push_diagnostic_issue(
                    &mut diagnostics,
                    DiagnosticSeverity::Error,
                    "sqlite-integrity",
                    "database",
                    message,
                );
            }
        }

        let mut foreign_key_statement = self.connection.prepare("PRAGMA foreign_key_check")?;
        let violations = foreign_key_statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;
        for violation in violations {
            let (table, row_id, parent, foreign_key) = violation?;
            diagnostics.foreign_key_violations += 1;
            push_diagnostic_issue(
                &mut diagnostics,
                DiagnosticSeverity::Error,
                "foreign-key-violation",
                table,
                format!(
                    "row {} does not satisfy {} foreign key {foreign_key}",
                    row_id.map_or_else(|| "unknown".to_owned(), |value| value.to_string()),
                    parent
                ),
            );
        }

        self.diagnose_event_payloads(&mut diagnostics)?;
        self.diagnose_checkpoint(&mut diagnostics)?;
        Ok(diagnostics)
    }

    /// Rebuild disposable projections only. Canonical events are never rewritten.
    pub fn repair_derived_state(&mut self) -> Result<RepairOutcome, StorageError> {
        let diagnostics = self.diagnose()?;
        if !diagnostics.is_repairable() {
            return Err(StorageError::Unrepairable(format!(
                "{} invalid payloads, {} index mismatches, {} foreign-key violations",
                diagnostics.invalid_event_payloads,
                diagnostics.indexed_field_mismatches,
                diagnostics.foreign_key_violations
            )));
        }
        let events = self.load_events()?;
        let event_count = events.len();
        let ingest = IngestStore::from_events(events)?;
        let runs = ingest.runs();
        let catalog = ingest.catalog();
        self.save_checkpoint(&runs, &catalog, event_count)?;
        self.connection
            .execute_batch("PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE);")?;
        Ok(RepairOutcome {
            event_count,
            run_count: runs.len(),
            checkpoint_rebuilt: true,
        })
    }

    pub fn scrub(&mut self, policy: &PrivacyPolicy) -> Result<ScrubOutcome, StorageError> {
        let fingerprint = policy.fingerprint();
        let stored_fingerprint: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM storage_metadata WHERE key = ?1",
                [PRIVACY_POLICY_KEY],
                |row| row.get(0),
            )
            .optional()?;
        if stored_fingerprint.as_deref() == Some(fingerprint.as_str()) {
            return Ok(ScrubOutcome::default());
        }
        let events = self.load_events()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut outcome = ScrubOutcome::default();
        for mut event in events {
            let original = serde_json::to_string(&event)?;
            let report = policy.sanitize_event(&mut event);
            let sanitized = serde_json::to_string(&event)?;
            outcome.redacted_fields += report.redacted_fields;
            outcome.omitted_fields += report.omitted_fields;
            if original != sanitized {
                transaction.execute(
                    "UPDATE canonical_events SET payload_json = ?1 WHERE event_id = ?2",
                    params![sanitized, event.event_id],
                )?;
                outcome.updated_events += 1;
            }
        }
        if outcome.updated_events > 0 {
            invalidate_checkpoint(&transaction)?;
        }
        transaction.execute(
            "INSERT INTO storage_metadata (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![PRIVACY_POLICY_KEY, fingerprint],
        )?;
        transaction.commit()?;
        Ok(outcome)
    }

    pub fn delete_session_tree(
        &mut self,
        runtime: &RuntimeKind,
        source_id: &str,
        session_id: &str,
    ) -> Result<DeleteOutcome, StorageError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let runtime = runtime.as_str();
        let deleted_sessions = transaction.query_row(
            "WITH RECURSIVE session_tree(session_id) AS (
                 SELECT ?1
                 UNION
                 SELECT event.session_id
                   FROM canonical_events AS event
                   JOIN session_tree AS parent
                     ON event.parent_session_id = parent.session_id
                  WHERE event.runtime = ?2 AND event.source_id = ?3
             )
             SELECT COUNT(DISTINCT event.session_id)
               FROM canonical_events AS event
               JOIN session_tree AS selected
                 ON event.session_id = selected.session_id
              WHERE event.runtime = ?2 AND event.source_id = ?3",
            params![session_id, runtime, source_id],
            |row| row.get::<_, i64>(0),
        )?;
        let deleted_sessions = usize::try_from(deleted_sessions)
            .expect("SQLite COUNT(DISTINCT) is non-negative and fits usize");
        let deleted_events = transaction.execute(
            "WITH RECURSIVE session_tree(session_id) AS (
                 SELECT ?1
                 UNION
                 SELECT event.session_id
                   FROM canonical_events AS event
                   JOIN session_tree AS parent
                     ON event.parent_session_id = parent.session_id
                  WHERE event.runtime = ?2 AND event.source_id = ?3
             )
             DELETE FROM canonical_events
              WHERE runtime = ?2
                AND source_id = ?3
                AND session_id IN (SELECT session_id FROM session_tree)",
            params![session_id, runtime, source_id],
        )?;
        if deleted_events > 0 {
            // Preserve unaffected per-run snapshots so the server can update only the
            // source partition touched by this deletion. Removing the catalog row
            // still makes an interrupted delete fail closed and rebuild on restart.
            invalidate_catalog_checkpoint(&transaction)?;
        }
        transaction.commit()?;
        Ok(DeleteOutcome {
            deleted_events,
            deleted_sessions,
        })
    }

    pub fn apply_retention(
        &mut self,
        policy: &RetentionPolicy,
    ) -> Result<RetentionOutcome, StorageError> {
        if !policy.is_configured() {
            return Ok(RetentionOutcome {
                remaining_events: self.event_count()?,
                ..RetentionOutcome::default()
            });
        }
        let events = self.load_events()?;
        if events.is_empty() {
            return Ok(RetentionOutcome::default());
        }
        let groups = group_events_by_run(&events);
        let mut ordered = groups.values().collect::<Vec<_>>();
        ordered.sort_by(|left, right| {
            (&left.last_observed_at, &left.root).cmp(&(&right.last_observed_at, &right.root))
        });
        let mut deleted_roots = BTreeSet::new();
        let mut remaining_events = events.len();
        if let Some(cutoff) = policy.observed_before.as_deref() {
            for group in &ordered {
                if group.last_observed_at.as_str() < cutoff {
                    deleted_roots.insert(group.root.clone());
                    remaining_events = remaining_events.saturating_sub(group.event_ids.len());
                }
            }
        }
        if let Some(max_events) = policy.max_events {
            for group in &ordered {
                if remaining_events <= max_events {
                    break;
                }
                if deleted_roots.insert(group.root.clone()) {
                    remaining_events = remaining_events.saturating_sub(group.event_ids.len());
                }
            }
        }
        let event_ids = deleted_roots
            .iter()
            .flat_map(|root| groups[root].event_ids.iter())
            .collect::<Vec<_>>();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for event_id in &event_ids {
            transaction.execute(
                "DELETE FROM canonical_events WHERE event_id = ?1",
                [event_id],
            )?;
        }
        if !event_ids.is_empty() {
            invalidate_checkpoint(&transaction)?;
        }
        transaction.commit()?;
        Ok(RetentionOutcome {
            deleted_events: event_ids.len(),
            deleted_runs: deleted_roots.len(),
            remaining_events,
        })
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
        // Keep unchanged snapshots aligned with the catalog's global durable count.
        // This matters especially after deletion, when the count moves backwards.
        transaction.execute(
            "UPDATE run_snapshots SET checkpoint_event_count = ?1",
            [event_count],
        )?;
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

    fn diagnose_event_payloads(
        &self,
        diagnostics: &mut StorageDiagnostics,
    ) -> Result<(), StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT event_id, runtime, source_id, session_id, parent_session_id,
                    source_seq, observed_at, occurred_at, event_type, payload_json
             FROM canonical_events ORDER BY event_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
            ))
        })?;
        for row in rows {
            let (
                event_id,
                runtime,
                source_id,
                session_id,
                parent_session_id,
                source_seq,
                observed_at,
                occurred_at,
                event_type,
                payload,
            ) = row?;
            let event = match serde_json::from_str::<CanonicalEvent>(&payload) {
                Ok(event) => event,
                Err(error) => {
                    diagnostics.invalid_event_payloads += 1;
                    push_diagnostic_issue(
                        diagnostics,
                        DiagnosticSeverity::Error,
                        "invalid-event-json",
                        event_id,
                        error.to_string(),
                    );
                    continue;
                }
            };
            if let Err(error) = event.validate() {
                diagnostics.invalid_event_payloads += 1;
                push_diagnostic_issue(
                    diagnostics,
                    DiagnosticSeverity::Error,
                    "invalid-canonical-event",
                    event_id.clone(),
                    error.to_string(),
                );
                continue;
            }
            let payload_type = serde_json::to_string(&event.event_type)?;
            let payload_type = payload_type.trim_matches('"');
            let indexed_fields_match = event.event_id == event_id
                && event.runtime.as_str() == runtime
                && event.source_id == source_id
                && event.session_id == session_id
                && event.parent_session_id == parent_session_id
                && i64::try_from(event.source_seq).ok() == Some(source_seq)
                && event.observed_at == observed_at
                && event.occurred_at == occurred_at
                && payload_type == event_type;
            if !indexed_fields_match {
                diagnostics.indexed_field_mismatches += 1;
                push_diagnostic_issue(
                    diagnostics,
                    DiagnosticSeverity::Error,
                    "event-index-mismatch",
                    event_id,
                    "indexed columns disagree with the canonical payload",
                );
            }
        }
        Ok(())
    }

    fn diagnose_checkpoint(
        &self,
        diagnostics: &mut StorageDiagnostics,
    ) -> Result<(), StorageError> {
        let catalog_event_count: Option<i64> = self
            .connection
            .query_row(
                "SELECT checkpoint_event_count FROM run_catalog_checkpoint WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let snapshot_count: i64 =
            self.connection
                .query_row("SELECT COUNT(*) FROM run_snapshots", [], |row| row.get(0))?;
        diagnostics.checkpoint_event_count =
            catalog_event_count.and_then(|count| usize::try_from(count).ok());
        diagnostics.checkpoint_run_count =
            usize::try_from(snapshot_count).expect("SQLite COUNT(*) cannot be negative");
        if catalog_event_count.is_none() && snapshot_count == 0 {
            diagnostics.checkpoint_status = if diagnostics.event_count == 0 {
                CheckpointStatus::NotRequired
            } else {
                push_diagnostic_issue(
                    diagnostics,
                    DiagnosticSeverity::Warning,
                    "checkpoint-missing",
                    "derived-state",
                    "canonical events are valid but no projection checkpoint exists",
                );
                CheckpointStatus::Missing
            };
            return Ok(());
        }
        match self.load_checkpoint()? {
            Some(checkpoint) if checkpoint.event_count == diagnostics.event_count => {
                diagnostics.checkpoint_status = CheckpointStatus::Healthy;
            }
            Some(_) => {
                diagnostics.checkpoint_status = CheckpointStatus::Stale;
                push_diagnostic_issue(
                    diagnostics,
                    DiagnosticSeverity::Warning,
                    "checkpoint-stale",
                    "derived-state",
                    "projection checkpoint does not cover the current event count",
                );
            }
            None => {
                diagnostics.checkpoint_status = CheckpointStatus::Corrupt;
                push_diagnostic_issue(
                    diagnostics,
                    DiagnosticSeverity::Warning,
                    "checkpoint-corrupt",
                    "derived-state",
                    "projection checkpoint cannot be decoded or has inconsistent run identities",
                );
            }
        }
        Ok(())
    }

    #[cfg(test)]
    fn open_in_memory() -> Result<Self, StorageError> {
        Self::from_connection(Connection::open_in_memory()?)
    }
}

fn push_diagnostic_issue(
    diagnostics: &mut StorageDiagnostics,
    severity: DiagnosticSeverity,
    code: impl Into<String>,
    location: impl Into<String>,
    message: impl Into<String>,
) {
    if diagnostics.issues.len() < MAX_DIAGNOSTIC_ISSUES {
        diagnostics.issues.push(StorageDiagnosticIssue {
            severity,
            code: code.into(),
            location: location.into(),
            message: message.into(),
        });
    } else {
        diagnostics.truncated_issue_count += 1;
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
    let runtime = event.runtime.as_str();
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

fn invalidate_checkpoint(transaction: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    transaction.execute("DELETE FROM run_snapshots", [])?;
    transaction.execute("DELETE FROM run_catalog_checkpoint", [])?;
    Ok(())
}

fn invalidate_catalog_checkpoint(transaction: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    transaction.execute("DELETE FROM run_catalog_checkpoint", [])?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct SessionIdentity {
    runtime: RuntimeKind,
    source_id: String,
    session_id: String,
}

impl SessionIdentity {
    fn of(event: &CanonicalEvent) -> Self {
        Self {
            runtime: event.runtime.clone(),
            source_id: event.source_id.clone(),
            session_id: event.session_id.clone(),
        }
    }

    fn parent(&self, parent_session_id: &str) -> Self {
        Self {
            runtime: self.runtime.clone(),
            source_id: self.source_id.clone(),
            session_id: parent_session_id.to_owned(),
        }
    }
}

struct StoredRunGroup {
    root: SessionIdentity,
    event_ids: Vec<String>,
    last_observed_at: String,
}

fn group_events_by_run(events: &[CanonicalEvent]) -> BTreeMap<SessionIdentity, StoredRunGroup> {
    let sessions = events
        .iter()
        .map(SessionIdentity::of)
        .collect::<BTreeSet<_>>();
    let parents = events
        .iter()
        .filter_map(|event| {
            let session = SessionIdentity::of(event);
            event
                .parent_session_id
                .as_deref()
                .map(|parent| (session.clone(), session.parent(parent)))
        })
        .collect::<BTreeMap<_, _>>();
    let mut groups = BTreeMap::<SessionIdentity, StoredRunGroup>::new();
    for event in events {
        let root = resolve_root(SessionIdentity::of(event), &sessions, &parents);
        let group = groups
            .entry(root.clone())
            .or_insert_with(|| StoredRunGroup {
                root,
                event_ids: Vec::new(),
                last_observed_at: event.observed_at.clone(),
            });
        group.event_ids.push(event.event_id.clone());
        if event.observed_at > group.last_observed_at {
            group.last_observed_at.clone_from(&event.observed_at);
        }
    }
    groups
}

fn resolve_root(
    mut session: SessionIdentity,
    sessions: &BTreeSet<SessionIdentity>,
    parents: &BTreeMap<SessionIdentity, SessionIdentity>,
) -> SessionIdentity {
    let mut visited = BTreeSet::new();
    while visited.insert(session.clone()) {
        let Some(parent) = parents.get(&session) else {
            break;
        };
        if !sessions.contains(parent) {
            break;
        }
        session = parent.clone();
    }
    session
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

    fn session_event(
        id: &str,
        session_id: &str,
        parent_session_id: Option<&str>,
        sequence: u64,
        observed_at: &str,
    ) -> CanonicalEvent {
        let mut event = event(id, sequence, session_id);
        event.session_id = session_id.into();
        event.parent_session_id = parent_session_id.map(str::to_owned);
        event.observed_at = observed_at.into();
        event
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
        let cached = store.load_cached_events().unwrap();
        assert_eq!(cached.len(), 1);
        assert_eq!(cached[0].event_id, "evt-1");
        assert_eq!(cached[0].runtime, RuntimeKind::DeepSeekHarness);
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
        let events = [first, second];
        let ingest = orchetrace_ingest::IngestStore::from_events(events.clone()).unwrap();
        let runs = ingest.runs();
        let catalog = ingest.catalog();
        let mut store = EventStore::open_in_memory().unwrap();
        store.insert_events(&events).unwrap();
        store.save_checkpoint(&runs, &catalog, 2).unwrap();
        let checkpoint = store.load_checkpoint().unwrap().unwrap();
        assert_eq!(checkpoint.event_count, 2);
        assert_eq!(checkpoint.runs, runs);
        assert_eq!(checkpoint.catalog, catalog);
        let restored = orchetrace_ingest::IngestStore::from_cached_events_with_runs(
            store.load_cached_events().unwrap(),
            checkpoint.runs.clone(),
        )
        .unwrap();
        assert_eq!(restored.catalog(), checkpoint.catalog);

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
        assert_eq!(version, 4);
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

    #[test]
    fn scrub_rewrites_existing_payloads_and_invalidates_checkpoints() {
        let mut event = event("evt-secret", 1, "root");
        event.data = json!({
            "name": "bash",
            "arguments": { "token": "secret", "command": "deploy" }
        });
        let ingest = orchetrace_ingest::IngestStore::from_events([event.clone()]).unwrap();
        let mut store = EventStore::open_in_memory().unwrap();
        store.insert_event(&event).unwrap();
        store
            .save_checkpoint(&ingest.runs(), &ingest.catalog(), 1)
            .unwrap();

        let outcome = store.scrub(&PrivacyPolicy::metadata_only()).unwrap();
        assert_eq!(outcome.updated_events, 1);
        assert_eq!(outcome.redacted_fields, 0);
        assert_eq!(outcome.omitted_fields, 1);
        let scrubbed = store.load_events().unwrap().remove(0);
        assert_eq!(scrubbed.data["arguments"], "[OMITTED]");
        assert_eq!(
            scrubbed.attributes["orchetrace.privacy.capture_mode"],
            "metadata-only"
        );
        assert!(store.load_checkpoint().unwrap().is_none());
        assert_eq!(
            store.scrub(&PrivacyPolicy::metadata_only()).unwrap(),
            ScrubOutcome::default()
        );
    }

    #[test]
    fn deleting_a_session_cascades_to_descendants_only() {
        let events = [
            session_event("root-1", "root", None, 1, "2026-08-25T00:00:01Z"),
            session_event("child-1", "child", Some("root"), 2, "2026-08-25T00:00:02Z"),
            session_event(
                "grandchild-1",
                "grandchild",
                Some("child"),
                3,
                "2026-08-25T00:00:03Z",
            ),
            session_event("other-1", "other", None, 4, "2026-08-25T00:00:04Z"),
        ];
        let mut ingest = orchetrace_ingest::IngestStore::from_events(events.clone()).unwrap();
        let mut store = EventStore::open_in_memory().unwrap();
        store.insert_events(&events).unwrap();
        store
            .save_checkpoint(&ingest.runs(), &ingest.catalog(), events.len())
            .unwrap();

        let outcome = store
            .delete_session_tree(&RuntimeKind::DeepSeekHarness, "local", "child")
            .unwrap();
        assert_eq!(outcome.deleted_events, 2);
        assert_eq!(outcome.deleted_sessions, 2);
        let remaining = store.load_events().unwrap();
        assert_eq!(
            remaining
                .iter()
                .map(|event| event.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["root-1", "other-1"]
        );
        assert!(store.load_checkpoint().unwrap().is_none());

        let projection = ingest
            .delete_session_tree(&RuntimeKind::DeepSeekHarness, "local", "child")
            .unwrap();
        let catalog = ingest.catalog();
        store
            .save_checkpoint(&projection.updated_runs, &catalog, ingest.len())
            .unwrap();
        let checkpoint = store.load_checkpoint().unwrap().unwrap();
        assert_eq!(checkpoint.catalog, catalog);
        assert_eq!(checkpoint.runs, ingest.runs());
    }

    #[test]
    fn retention_deletes_complete_oldest_runs() {
        let events = [
            session_event("old-root", "old", None, 1, "2026-08-20T00:00:00Z"),
            session_event(
                "old-child",
                "old-child",
                Some("old"),
                2,
                "2026-08-20T00:00:01Z",
            ),
            session_event("middle-1", "middle", None, 3, "2026-08-25T00:00:00Z"),
            session_event("new-1", "new", None, 4, "2026-08-29T00:00:00Z"),
            session_event("new-2", "new", None, 5, "2026-08-29T00:00:01Z"),
        ];
        let mut store = EventStore::open_in_memory().unwrap();
        store.insert_events(&events).unwrap();

        let outcome = store
            .apply_retention(&RetentionPolicy {
                observed_before: Some("2026-08-22T00:00:00Z".into()),
                max_events: Some(2),
            })
            .unwrap();
        assert_eq!(outcome.deleted_runs, 2);
        assert_eq!(outcome.deleted_events, 3);
        assert_eq!(outcome.remaining_events, 2);
        assert!(
            store
                .load_events()
                .unwrap()
                .iter()
                .all(|event| event.session_id == "new")
        );
    }

    #[test]
    fn diagnostics_distinguish_canonical_facts_from_repairable_checkpoints() {
        let event = event("doctor-1", 1, "doctor");
        let mut store = EventStore::open_in_memory().unwrap();
        store.insert_event(&event).unwrap();

        let missing = store.diagnose().unwrap();
        assert!(missing.integrity_ok);
        assert!(missing.is_repairable());
        assert_eq!(missing.checkpoint_status, CheckpointStatus::Missing);

        let outcome = store.repair_derived_state().unwrap();
        assert_eq!(outcome.event_count, 1);
        assert_eq!(outcome.run_count, 1);
        let healthy = store.diagnose().unwrap();
        assert_eq!(healthy.checkpoint_status, CheckpointStatus::Healthy);
        assert!(!healthy.has_errors());
    }

    #[test]
    fn repair_refuses_to_rewrite_inconsistent_canonical_facts() {
        let event = event("mismatch-1", 1, "mismatch");
        let mut store = EventStore::open_in_memory().unwrap();
        store.insert_event(&event).unwrap();
        store
            .connection
            .execute(
                "UPDATE canonical_events SET source_id = 'different' WHERE event_id = 'mismatch-1'",
                [],
            )
            .unwrap();

        let diagnostics = store.diagnose().unwrap();
        assert_eq!(diagnostics.indexed_field_mismatches, 1);
        assert!(diagnostics.has_errors());
        assert!(matches!(
            store.repair_derived_state(),
            Err(StorageError::Unrepairable(_))
        ));
        assert_eq!(store.event_count().unwrap(), 1);
    }
}
