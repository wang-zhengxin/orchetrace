use std::collections::{BTreeMap, BTreeSet};

use orchetrace_core::{
    AgentEdge, AgentSnapshot, FoldError, RunSnapshot, TimelineEntry, fold_events,
};
use orchetrace_protocol::{
    ActivityStatus, CanonicalEvent, RuntimeKind, TerminalOutcome, ValidationError,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default)]
pub struct IngestStore {
    events: BTreeMap<String, StoredEvent>,
    runs: BTreeMap<String, RunState>,
    parents: BTreeMap<SessionKey, SessionKey>,
    session_roots: BTreeMap<SessionKey, Option<SessionKey>>,
    pending_by_source: BTreeMap<SourceKey, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunState {
    pub run_id: String,
    pub source_id: String,
    pub runtime: RuntimeKind,
    pub snapshot: RunSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunCatalog {
    pub schema_version: u16,
    pub pending_event_count: usize,
    pub runs: Vec<RunSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunSummary {
    pub run_id: String,
    pub root_session_id: String,
    pub source_id: String,
    pub runtime: RuntimeKind,
    pub label: String,
    pub status: ActivityStatus,
    pub outcome: Option<TerminalOutcome>,
    pub agent_count: usize,
    pub edge_count: usize,
    pub event_count: usize,
    pub started_at: Option<String>,
    pub last_activity_at: Option<String>,
}

/// Validated event material loaded from durable storage without JSON decoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedEvent {
    pub event_id: String,
    pub runtime: RuntimeKind,
    pub source_id: String,
    pub session_id: String,
    pub parent_session_id: Option<String>,
    pub payload_json: Box<str>,
}

#[derive(Debug, Clone)]
pub struct IngestOutcome {
    pub inserted: bool,
    pub runs: Vec<RunState>,
    pub updated_runs: Vec<RunState>,
    pub run_deltas: Vec<RunSnapshotDelta>,
    pub removed_run_ids: Vec<String>,
    pub pending_event_count: usize,
}

#[derive(Debug, Clone, Default)]
pub struct SessionDeletionOutcome {
    pub deleted_events: usize,
    pub deleted_sessions: usize,
    pub updated_runs: Vec<RunState>,
    pub removed_run_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunSnapshotDelta {
    pub schema_version: u16,
    pub run_id: String,
    pub base_event_count: Option<usize>,
    pub target_event_count: usize,
    pub root_session_id: String,
    pub runtimes: Vec<RuntimeKind>,
    pub started_at: Option<String>,
    pub last_activity_at: Option<String>,
    pub upserted_agents: Vec<AgentSnapshot>,
    pub removed_agent_ids: Vec<String>,
    pub agent_order: Option<Vec<String>>,
    pub edges: Option<Vec<AgentEdge>>,
    pub timeline: Option<TimelineSplice>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TimelineSplice {
    pub replace_from: usize,
    pub entries: Vec<TimelineEntry>,
}

#[derive(Debug)]
pub enum IngestError {
    InvalidEvent {
        event_id: String,
        source: ValidationError,
    },
    ConflictingDuplicate(String),
    ConflictingLineage {
        session_id: String,
        first_parent: String,
        second_parent: String,
    },
    LineageCycle(String),
    InvalidCheckpoint(String),
    EventJson(serde_json::Error),
    Fold(FoldError),
}

impl std::fmt::Display for IngestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidEvent { event_id, source } => {
                write!(f, "invalid event `{event_id}`: {source}")
            }
            Self::ConflictingDuplicate(id) => write!(f, "conflicting duplicate event `{id}`"),
            Self::ConflictingLineage {
                session_id,
                first_parent,
                second_parent,
            } => write!(
                f,
                "session `{session_id}` has conflicting parents `{first_parent}` and `{second_parent}`"
            ),
            Self::LineageCycle(session_id) => {
                write!(f, "session lineage contains a cycle at `{session_id}`")
            }
            Self::InvalidCheckpoint(message) => write!(f, "invalid Run checkpoint: {message}"),
            Self::EventJson(source) => write!(f, "cannot encode or decode cached event: {source}"),
            Self::Fold(source) => write!(f, "cannot fold ingested events: {source}"),
        }
    }
}

impl std::error::Error for IngestError {}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct SessionKey {
    runtime: RuntimeKind,
    source_id: String,
    session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct SourceKey {
    runtime: RuntimeKind,
    source_id: String,
}

#[derive(Debug)]
struct StoredEvent {
    runtime: RuntimeKind,
    source_id: String,
    session_id: String,
    parent_session_id: Option<String>,
    payload_json: Box<str>,
}

impl StoredEvent {
    fn from_event(event: CanonicalEvent) -> Result<Self, IngestError> {
        let payload_json = serde_json::to_string(&event)
            .map_err(IngestError::EventJson)?
            .into_boxed_str();
        Ok(Self {
            runtime: event.runtime,
            source_id: event.source_id,
            session_id: event.session_id,
            parent_session_id: event.parent_session_id,
            payload_json,
        })
    }

    fn to_event(&self) -> Result<CanonicalEvent, IngestError> {
        serde_json::from_str(&self.payload_json).map_err(IngestError::EventJson)
    }

    fn from_cached(event: CachedEvent) -> Self {
        Self {
            runtime: event.runtime,
            source_id: event.source_id,
            session_id: event.session_id,
            parent_session_id: event.parent_session_id,
            payload_json: event.payload_json,
        }
    }
}

impl SourceKey {
    fn of(event: &StoredEvent) -> Self {
        Self {
            runtime: event.runtime.clone(),
            source_id: event.source_id.clone(),
        }
    }

    fn contains(&self, session: &SessionKey) -> bool {
        self.runtime == session.runtime && self.source_id == session.source_id
    }
}

struct SourcePartition<'a> {
    parents: BTreeMap<SessionKey, SessionKey>,
    roots: BTreeMap<SessionKey, Option<SessionKey>>,
    groups: BTreeMap<SessionKey, Vec<&'a StoredEvent>>,
    pending_event_count: usize,
}

impl SessionKey {
    fn of(event: &StoredEvent) -> Self {
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

impl IngestStore {
    pub fn from_events(
        events: impl IntoIterator<Item = CanonicalEvent>,
    ) -> Result<Self, IngestError> {
        let mut store = Self {
            events: collect_events(events)?,
            ..Self::default()
        };
        store.rebuild_all()?;
        Ok(store)
    }

    pub fn from_events_with_runs(
        events: impl IntoIterator<Item = CanonicalEvent>,
        runs: impl IntoIterator<Item = RunState>,
    ) -> Result<Self, IngestError> {
        let mut store = Self {
            events: collect_events(events)?,
            ..Self::default()
        };
        store.restore_runs(runs)?;
        Ok(store)
    }

    pub fn from_cached_events_with_runs(
        events: impl IntoIterator<Item = CachedEvent>,
        runs: impl IntoIterator<Item = RunState>,
    ) -> Result<Self, IngestError> {
        let mut collected = BTreeMap::new();
        for event in events {
            let event_id = event.event_id.clone();
            if collected
                .insert(event_id.clone(), StoredEvent::from_cached(event))
                .is_some()
            {
                return Err(IngestError::ConflictingDuplicate(event_id));
            }
        }
        let mut store = Self {
            events: collected,
            ..Self::default()
        };
        store.restore_runs(runs)?;
        Ok(store)
    }

    pub fn ingest(&mut self, event: CanonicalEvent) -> Result<IngestOutcome, IngestError> {
        event
            .validate()
            .map_err(|source| IngestError::InvalidEvent {
                event_id: event.event_id.clone(),
                source,
            })?;
        let event_id = event.event_id.clone();
        let stored_event = StoredEvent::from_event(event)?;
        match self.events.get(&event_id) {
            Some(existing) if existing.payload_json != stored_event.payload_json => {
                return Err(IngestError::ConflictingDuplicate(event_id));
            }
            Some(_) => {
                return Ok(IngestOutcome {
                    inserted: false,
                    runs: self.runs(),
                    updated_runs: Vec::new(),
                    run_deltas: Vec::new(),
                    removed_run_ids: Vec::new(),
                    pending_event_count: self.pending_event_count(),
                });
            }
            None => {}
        }

        let session = SessionKey::of(&stored_event);
        let source = SourceKey::of(&stored_event);
        let incoming_parent = stored_event
            .parent_session_id
            .as_deref()
            .map(|parent| session.parent(parent));
        if let (Some(existing), Some(incoming)) =
            (self.parents.get(&session), incoming_parent.as_ref())
            && existing != incoming
        {
            return Err(IngestError::ConflictingLineage {
                session_id: session.session_id,
                first_parent: existing.session_id.clone(),
                second_parent: incoming.session_id.clone(),
            });
        }
        let topology_changed = !self.session_roots.contains_key(&session)
            || incoming_parent
                .as_ref()
                .is_some_and(|parent| self.parents.get(&session) != Some(parent));

        let previous_affected_runs: BTreeMap<_, _> = if topology_changed {
            self.runs
                .iter()
                .filter(|(_, run)| {
                    run.runtime == source.runtime && run.source_id == source.source_id
                })
                .map(|(run_id, run)| (run_id.clone(), run.snapshot.clone()))
                .collect()
        } else {
            self.session_roots
                .get(&session)
                .and_then(Clone::clone)
                .and_then(|root| {
                    let run_id = make_run_id(&root.runtime, &root.source_id, &root.session_id);
                    self.runs
                        .get(&run_id)
                        .map(|run| (run_id, run.snapshot.clone()))
                })
                .into_iter()
                .collect()
        };

        let previous_run_ids: BTreeSet<_> = self.runs.keys().cloned().collect();
        self.events.insert(event_id.clone(), stored_event);
        let update = if topology_changed {
            self.repartition_source(&source, &session)
        } else {
            self.rebuild_session_run(&source, &session)
        };
        match update {
            Ok(updated_runs) => {
                let current_run_ids: BTreeSet<_> = self.runs.keys().cloned().collect();
                let run_deltas = updated_runs
                    .iter()
                    .map(|run| {
                        snapshot_delta(
                            &run.run_id,
                            previous_affected_runs.get(&run.run_id),
                            &run.snapshot,
                        )
                    })
                    .collect();
                Ok(IngestOutcome {
                    inserted: true,
                    runs: self.runs(),
                    updated_runs,
                    run_deltas,
                    removed_run_ids: previous_run_ids
                        .difference(&current_run_ids)
                        .cloned()
                        .collect(),
                    pending_event_count: self.pending_event_count(),
                })
            }
            Err(error) => {
                self.events.remove(&event_id);
                Err(error)
            }
        }
    }

    pub fn runs(&self) -> Vec<RunState> {
        self.runs.values().cloned().collect()
    }

    pub fn catalog(&self) -> RunCatalog {
        catalog_from_runs(self.runs.values(), self.pending_event_count())
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn delete_session_tree(
        &mut self,
        runtime: &RuntimeKind,
        source_id: &str,
        session_id: &str,
    ) -> Result<SessionDeletionOutcome, IngestError> {
        let source = SourceKey {
            runtime: runtime.clone(),
            source_id: source_id.to_owned(),
        };
        let mut sessions = BTreeSet::from([session_id.to_owned()]);
        loop {
            let previous_len = sessions.len();
            for event in self.events.values() {
                if event.runtime == source.runtime
                    && event.source_id == source.source_id
                    && event
                        .parent_session_id
                        .as_ref()
                        .is_some_and(|parent| sessions.contains(parent))
                {
                    sessions.insert(event.session_id.clone());
                }
            }
            if sessions.len() == previous_len {
                break;
            }
        }
        let event_ids = self
            .events
            .iter()
            .filter(|(_, event)| {
                event.runtime == source.runtime
                    && event.source_id == source.source_id
                    && sessions.contains(&event.session_id)
            })
            .map(|(event_id, _)| event_id.clone())
            .collect::<Vec<_>>();
        if event_ids.is_empty() {
            return Ok(SessionDeletionOutcome::default());
        }
        let deleted_sessions = event_ids
            .iter()
            .filter_map(|event_id| self.events.get(event_id))
            .map(|event| event.session_id.as_str())
            .collect::<BTreeSet<_>>()
            .len();
        let previous_run_ids = self
            .runs
            .values()
            .filter(|run| run.runtime == source.runtime && run.source_id == source.source_id)
            .map(|run| run.run_id.clone())
            .collect::<BTreeSet<_>>();
        let removed_events = event_ids
            .iter()
            .filter_map(|event_id| {
                self.events
                    .remove(event_id)
                    .map(|event| (event_id.clone(), event))
            })
            .collect::<Vec<_>>();

        let rebuilt = (|| {
            let partition = build_source_partition(self.events.values(), &source)?;
            let updated_runs = partition
                .groups
                .iter()
                .map(|(root, events)| fold_run(root, events))
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, IngestError>((
                partition.parents,
                partition.roots,
                partition.pending_event_count,
                updated_runs,
            ))
        })();
        let (parents, roots, pending_event_count, updated_runs) = match rebuilt {
            Ok(rebuilt) => rebuilt,
            Err(error) => {
                self.events.extend(removed_events);
                return Err(error);
            }
        };

        self.runs
            .retain(|_, run| run.runtime != source.runtime || run.source_id != source.source_id);
        for run in &updated_runs {
            self.runs.insert(run.run_id.clone(), run.clone());
        }
        self.parents.retain(|session, _| !source.contains(session));
        self.session_roots
            .retain(|session, _| !source.contains(session));
        self.parents.extend(parents);
        self.session_roots.extend(roots);
        if updated_runs.is_empty() && pending_event_count == 0 {
            self.pending_by_source.remove(&source);
        } else {
            self.pending_by_source
                .insert(source.clone(), pending_event_count);
        }
        let current_run_ids = updated_runs
            .iter()
            .map(|run| run.run_id.clone())
            .collect::<BTreeSet<_>>();

        Ok(SessionDeletionOutcome {
            deleted_events: event_ids.len(),
            deleted_sessions,
            updated_runs,
            removed_run_ids: previous_run_ids
                .difference(&current_run_ids)
                .cloned()
                .collect(),
        })
    }

    fn pending_event_count(&self) -> usize {
        self.pending_by_source.values().sum()
    }

    fn rebuild_all(&mut self) -> Result<(), IngestError> {
        let sources: BTreeSet<_> = self.events.values().map(SourceKey::of).collect();
        let mut runs = BTreeMap::new();
        let mut parents = BTreeMap::new();
        let mut session_roots = BTreeMap::new();
        let mut pending_by_source = BTreeMap::new();
        for source in sources {
            let partition = build_source_partition(self.events.values(), &source)?;
            for (root, events) in &partition.groups {
                let run = fold_run(root, events)?;
                runs.insert(run.run_id.clone(), run);
            }
            parents.extend(partition.parents);
            session_roots.extend(partition.roots);
            pending_by_source.insert(source, partition.pending_event_count);
        }
        self.runs = runs;
        self.parents = parents;
        self.session_roots = session_roots;
        self.pending_by_source = pending_by_source;
        Ok(())
    }

    fn restore_runs(
        &mut self,
        runs: impl IntoIterator<Item = RunState>,
    ) -> Result<(), IngestError> {
        let mut checkpoint_runs = BTreeMap::new();
        for run in runs {
            if checkpoint_runs.insert(run.run_id.clone(), run).is_some() {
                return Err(IngestError::InvalidCheckpoint(
                    "contains duplicate run IDs".into(),
                ));
            }
        }
        let sources: BTreeSet<_> = self.events.values().map(SourceKey::of).collect();
        let mut parents = BTreeMap::new();
        let mut session_roots = BTreeMap::new();
        let mut pending_by_source = BTreeMap::new();
        let mut restored = BTreeMap::new();
        for source in sources {
            let partition = build_source_partition(self.events.values(), &source)?;
            for (root, events) in &partition.groups {
                let run_id = make_run_id(&root.runtime, &root.source_id, &root.session_id);
                let run = checkpoint_runs.remove(&run_id).ok_or_else(|| {
                    IngestError::InvalidCheckpoint(format!("is missing run `{run_id}`"))
                })?;
                if run.runtime != root.runtime
                    || run.source_id != root.source_id
                    || run.snapshot.root_session_id != root.session_id
                    || run.snapshot.event_count != events.len()
                {
                    return Err(IngestError::InvalidCheckpoint(format!(
                        "run `{run_id}` does not match current event topology"
                    )));
                }
                restored.insert(run_id, run);
            }
            parents.extend(partition.parents);
            session_roots.extend(partition.roots);
            pending_by_source.insert(source, partition.pending_event_count);
        }
        if let Some(extra) = checkpoint_runs.keys().next() {
            return Err(IngestError::InvalidCheckpoint(format!(
                "contains stale run `{extra}`"
            )));
        }
        self.runs = restored;
        self.parents = parents;
        self.session_roots = session_roots;
        self.pending_by_source = pending_by_source;
        Ok(())
    }

    fn rebuild_session_run(
        &mut self,
        source: &SourceKey,
        session: &SessionKey,
    ) -> Result<Vec<RunState>, IngestError> {
        let Some(root) = self.session_roots.get(session).and_then(Clone::clone) else {
            *self.pending_by_source.entry(source.clone()).or_default() += 1;
            return Ok(Vec::new());
        };
        let events = self.events_for_root(source, &root);
        let run = fold_run(&root, &events)?;
        self.runs.insert(run.run_id.clone(), run.clone());
        Ok(vec![run])
    }

    fn repartition_source(
        &mut self,
        source: &SourceKey,
        inserted_session: &SessionKey,
    ) -> Result<Vec<RunState>, IngestError> {
        let partition = build_source_partition(self.events.values(), source)?;
        let old_roots: BTreeMap<_, _> = self
            .session_roots
            .iter()
            .filter(|(session, _)| source.contains(session))
            .map(|(session, root)| (session.clone(), root.clone()))
            .collect();
        let mut affected_roots = BTreeSet::new();
        for session in old_roots.keys().chain(partition.roots.keys()) {
            let old = old_roots.get(session).and_then(Clone::clone);
            let new = partition.roots.get(session).and_then(Clone::clone);
            if old != new {
                affected_roots.extend(old);
                affected_roots.extend(new);
            }
        }
        affected_roots.extend(partition.roots.get(inserted_session).and_then(Clone::clone));

        let mut updated_runs = Vec::new();
        for root in &affected_roots {
            if let Some(events) = partition.groups.get(root) {
                updated_runs.push(fold_run(root, events)?);
            }
        }

        self.parents.retain(|session, _| !source.contains(session));
        self.session_roots
            .retain(|session, _| !source.contains(session));
        for root in &affected_roots {
            self.runs.remove(&make_run_id(
                &root.runtime,
                &root.source_id,
                &root.session_id,
            ));
        }
        for run in &updated_runs {
            self.runs.insert(run.run_id.clone(), run.clone());
        }
        self.parents.extend(partition.parents);
        self.session_roots.extend(partition.roots);
        self.pending_by_source
            .insert(source.clone(), partition.pending_event_count);
        Ok(updated_runs)
    }

    fn events_for_root<'a>(
        &'a self,
        source: &SourceKey,
        root: &SessionKey,
    ) -> Vec<&'a StoredEvent> {
        self.events
            .values()
            .filter(|event| {
                let session = SessionKey::of(event);
                source.contains(&session)
                    && self.session_roots.get(&session).and_then(Clone::clone) == Some(root.clone())
            })
            .collect()
    }
}

fn snapshot_delta(
    run_id: &str,
    previous: Option<&RunSnapshot>,
    current: &RunSnapshot,
) -> RunSnapshotDelta {
    let previous_agents: BTreeMap<_, _> = previous
        .into_iter()
        .flat_map(|snapshot| &snapshot.agents)
        .map(|agent| (agent.id.as_str(), agent))
        .collect();
    let current_agents: BTreeMap<_, _> = current
        .agents
        .iter()
        .map(|agent| (agent.id.as_str(), agent))
        .collect();
    let upserted_agents = current
        .agents
        .iter()
        .filter(|agent| previous_agents.get(agent.id.as_str()).copied() != Some(*agent))
        .cloned()
        .collect();
    let removed_agent_ids = previous_agents
        .keys()
        .filter(|agent_id| !current_agents.contains_key(**agent_id))
        .map(|agent_id| (*agent_id).to_owned())
        .collect();
    let previous_order = previous.map(|snapshot| {
        snapshot
            .agents
            .iter()
            .map(|agent| agent.id.as_str())
            .collect::<Vec<_>>()
    });
    let current_order = current
        .agents
        .iter()
        .map(|agent| agent.id.as_str())
        .collect::<Vec<_>>();
    let agent_order = (previous_order.as_ref() != Some(&current_order))
        .then(|| current_order.into_iter().map(str::to_owned).collect());
    let edges = (previous.map(|snapshot| &snapshot.edges) != Some(&current.edges))
        .then(|| current.edges.clone());
    let timeline = match previous {
        Some(previous) if previous.timeline == current.timeline => None,
        Some(previous) => {
            let replace_from = previous
                .timeline
                .iter()
                .zip(&current.timeline)
                .take_while(|(left, right)| left == right)
                .count();
            Some(TimelineSplice {
                replace_from,
                entries: current.timeline[replace_from..].to_vec(),
            })
        }
        None => Some(TimelineSplice {
            replace_from: 0,
            entries: current.timeline.clone(),
        }),
    };

    RunSnapshotDelta {
        schema_version: 1,
        run_id: run_id.to_owned(),
        base_event_count: previous.map(|snapshot| snapshot.event_count),
        target_event_count: current.event_count,
        root_session_id: current.root_session_id.clone(),
        runtimes: current.runtimes.clone(),
        started_at: current.started_at.clone(),
        last_activity_at: current.last_activity_at.clone(),
        upserted_agents,
        removed_agent_ids,
        agent_order,
        edges,
        timeline,
    }
}

fn collect_events(
    events: impl IntoIterator<Item = CanonicalEvent>,
) -> Result<BTreeMap<String, StoredEvent>, IngestError> {
    let mut collected = BTreeMap::<String, StoredEvent>::new();
    for event in events {
        event
            .validate()
            .map_err(|source| IngestError::InvalidEvent {
                event_id: event.event_id.clone(),
                source,
            })?;
        let event_id = event.event_id.clone();
        let stored_event = StoredEvent::from_event(event)?;
        match collected.get(&event_id) {
            Some(existing) if existing.payload_json != stored_event.payload_json => {
                return Err(IngestError::ConflictingDuplicate(event_id));
            }
            Some(_) => {}
            None => {
                collected.insert(event_id, stored_event);
            }
        }
    }
    Ok(collected)
}

fn build_source_partition<'a>(
    events: impl IntoIterator<Item = &'a StoredEvent>,
    source: &SourceKey,
) -> Result<SourcePartition<'a>, IngestError> {
    let events: Vec<_> = events
        .into_iter()
        .filter(|event| event.runtime == source.runtime && event.source_id == source.source_id)
        .collect();
    let sessions: BTreeSet<_> = events.iter().map(|event| SessionKey::of(event)).collect();
    let mut parents = BTreeMap::<SessionKey, SessionKey>::new();
    for event in &events {
        let Some(parent_session_id) = &event.parent_session_id else {
            continue;
        };
        let child = SessionKey::of(event);
        let parent = child.parent(parent_session_id);
        if let Some(existing) = parents.get(&child) {
            if existing != &parent {
                return Err(IngestError::ConflictingLineage {
                    session_id: child.session_id,
                    first_parent: existing.session_id.clone(),
                    second_parent: parent.session_id,
                });
            }
        } else {
            parents.insert(child, parent);
        }
    }

    let mut roots = BTreeMap::<SessionKey, Option<SessionKey>>::new();
    for session in &sessions {
        roots.insert(session.clone(), resolve_root(session, &sessions, &parents)?);
    }

    let mut grouped = BTreeMap::<SessionKey, Vec<&StoredEvent>>::new();
    let mut pending_event_count = 0;
    for event in events {
        let session = SessionKey::of(event);
        match roots.get(&session).and_then(Clone::clone) {
            Some(root) => grouped.entry(root).or_default().push(event),
            None => pending_event_count += 1,
        }
    }

    Ok(SourcePartition {
        parents,
        roots,
        groups: grouped,
        pending_event_count,
    })
}

fn fold_run(root: &SessionKey, events: &[&StoredEvent]) -> Result<RunState, IngestError> {
    let events = events
        .iter()
        .map(|event| event.to_event())
        .collect::<Result<Vec<_>, _>>()?;
    let snapshot = fold_events(events).map_err(IngestError::Fold)?;
    let run_id = make_run_id(&root.runtime, &root.source_id, &root.session_id);
    Ok(RunState {
        run_id,
        source_id: root.source_id.clone(),
        runtime: root.runtime.clone(),
        snapshot,
    })
}

fn resolve_root(
    session: &SessionKey,
    sessions: &BTreeSet<SessionKey>,
    parents: &BTreeMap<SessionKey, SessionKey>,
) -> Result<Option<SessionKey>, IngestError> {
    let mut current = session.clone();
    let mut visited = BTreeSet::new();
    loop {
        if !visited.insert(current.clone()) {
            return Err(IngestError::LineageCycle(current.session_id));
        }
        let Some(parent) = parents.get(&current) else {
            return Ok(Some(current));
        };
        if !sessions.contains(parent) {
            return Ok(None);
        }
        current = parent.clone();
    }
}

fn make_run_id(runtime: &RuntimeKind, source_id: &str, root_session_id: &str) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        runtime.as_str(),
        source_id.len(),
        source_id,
        root_session_id.len(),
        root_session_id
    )
}

fn catalog_from_runs<'a>(
    runs: impl IntoIterator<Item = &'a RunState>,
    pending_event_count: usize,
) -> RunCatalog {
    let mut summaries: Vec<_> = runs
        .into_iter()
        .map(|run| {
            let root = run
                .snapshot
                .agents
                .iter()
                .find(|agent| agent.id == run.snapshot.root_session_id);
            RunSummary {
                run_id: run.run_id.clone(),
                root_session_id: run.snapshot.root_session_id.clone(),
                source_id: run.source_id.clone(),
                runtime: run.runtime.clone(),
                label: root
                    .map(|agent| agent.label.clone())
                    .unwrap_or_else(|| run.snapshot.root_session_id.clone()),
                status: root
                    .map(|agent| agent.status.clone())
                    .unwrap_or(ActivityStatus::Unknown),
                outcome: root.and_then(|agent| agent.outcome.clone()),
                agent_count: run.snapshot.agents.len(),
                edge_count: run.snapshot.edges.len(),
                event_count: run.snapshot.event_count,
                started_at: run.snapshot.started_at.clone(),
                last_activity_at: run.snapshot.last_activity_at.clone(),
            }
        })
        .collect();
    summaries
        .sort_by(|a, b| (&b.last_activity_at, &b.run_id).cmp(&(&a.last_activity_at, &a.run_id)));
    RunCatalog {
        schema_version: 1,
        pending_event_count,
        runs: summaries,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use orchetrace_protocol::EventType;
    use serde_json::json;

    use super::*;

    fn discovered(source: &str, id: &str, parent: Option<&str>, label: &str) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            event_id: format!("event-{source}-{id}"),
            runtime: RuntimeKind::DeepSeekHarness,
            source_id: source.into(),
            session_id: id.into(),
            parent_session_id: parent.map(str::to_owned),
            source_seq: 0,
            observed_at: "2026-08-25T00:00:00Z".into(),
            occurred_at: None,
            event_type: EventType::SessionDiscovered,
            data: json!({ "label": label, "mode": if parent.is_some() { "one-shot" } else { "root" } }),
            attributes: BTreeMap::new(),
            source_ref: None,
            supersedes_event_id: None,
            ignorable: false,
        }
    }

    #[test]
    fn identical_reconnect_replay_is_idempotent() {
        let mut store = IngestStore::default();
        assert!(
            store
                .ingest(discovered("a", "root", None, "one"))
                .unwrap()
                .inserted
        );
        let second = store.ingest(discovered("a", "root", None, "one")).unwrap();
        assert!(!second.inserted);
        assert_eq!(second.runs[0].snapshot.event_count, 1);
    }

    #[test]
    fn conflicting_duplicate_is_rejected() {
        let mut store = IngestStore::default();
        store.ingest(discovered("a", "root", None, "one")).unwrap();
        let error = store
            .ingest(discovered("a", "root", None, "changed"))
            .unwrap_err();
        assert!(matches!(error, IngestError::ConflictingDuplicate(_)));
    }

    #[test]
    fn child_waits_for_late_root_without_blocking_other_runs() {
        let mut store = IngestStore::default();
        let pending = store
            .ingest(discovered("a", "child", Some("root"), "child"))
            .unwrap();
        assert_eq!(pending.pending_event_count, 1);
        assert!(pending.runs.is_empty());

        let other = store
            .ingest(discovered("a", "other-root", None, "other"))
            .unwrap();
        assert_eq!(other.runs.len(), 1);
        assert_eq!(other.pending_event_count, 1);
        assert_eq!(store.catalog().pending_event_count, 1);

        let materialized = store.ingest(discovered("a", "root", None, "root")).unwrap();
        assert_eq!(materialized.runs.len(), 2);
        assert_eq!(materialized.pending_event_count, 0);
        assert_eq!(store.catalog().pending_event_count, 0);
        assert!(
            materialized
                .runs
                .iter()
                .any(|run| run.snapshot.agents.len() == 2)
        );
    }

    #[test]
    fn same_session_ids_from_different_sources_are_separate_runs() {
        let store = IngestStore::from_events([
            discovered("machine-a", "root", None, "A"),
            discovered("machine-b", "root", None, "B"),
        ])
        .unwrap();
        let catalog = store.catalog();
        assert_eq!(catalog.runs.len(), 2);
        assert_ne!(catalog.runs[0].run_id, catalog.runs[1].run_id);
    }

    #[test]
    fn conflicting_parentage_rolls_back_the_event() {
        let first = discovered("a", "child", Some("root-a"), "child");
        let mut second = discovered("a", "child", Some("root-b"), "child");
        second.event_id = "event-second-parent".into();
        let mut store = IngestStore::default();
        store.ingest(first.clone()).unwrap();
        let error = store.ingest(second).unwrap_err();
        assert!(matches!(error, IngestError::ConflictingLineage { .. }));
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn lineage_cycle_is_rejected() {
        let mut store = IngestStore::default();
        store.ingest(discovered("a", "a", Some("b"), "a")).unwrap();
        let error = store
            .ingest(discovered("a", "b", Some("a"), "b"))
            .unwrap_err();
        assert!(matches!(error, IngestError::LineageCycle(_)));
    }

    #[test]
    fn ordinary_event_only_rebuilds_its_run() {
        let mut store = IngestStore::from_events([
            discovered("a", "root-a", None, "A"),
            discovered("a", "root-b", None, "B"),
        ])
        .unwrap();
        let mut update = discovered("a", "root-a", None, "A updated");
        update.event_id = "event-a-root-a-update".into();
        update.source_seq = 1;
        let outcome = store.ingest(update).unwrap();
        assert_eq!(outcome.runs.len(), 2);
        assert_eq!(outcome.updated_runs.len(), 1);
        assert_eq!(outcome.updated_runs[0].snapshot.root_session_id, "root-a");
        assert_eq!(outcome.updated_runs[0].snapshot.event_count, 2);
        assert_eq!(outcome.run_deltas.len(), 1);
        assert_eq!(outcome.run_deltas[0].base_event_count, Some(1));
        assert_eq!(outcome.run_deltas[0].target_event_count, 2);
        assert_eq!(outcome.run_deltas[0].upserted_agents.len(), 1);
        assert_eq!(outcome.run_deltas[0].upserted_agents[0].id, "root-a");
        assert!(outcome.run_deltas[0].agent_order.is_none());
        assert!(outcome.run_deltas[0].edges.is_none());
        assert!(outcome.run_deltas[0].timeline.is_none());
    }

    #[test]
    fn tool_event_delta_contains_the_changed_agent_and_timeline_suffix() {
        let mut store = IngestStore::from_events([discovered("a", "root", None, "Root")]).unwrap();
        let mut tool = discovered("a", "root", None, "Root");
        tool.event_id = "event-a-root-tool".into();
        tool.source_seq = 1;
        tool.event_type = EventType::ToolStarted;
        tool.data = json!({ "call_id": "call-1", "name": "Read", "input_summary": "README.md" });

        let outcome = store.ingest(tool).unwrap();
        let delta = &outcome.run_deltas[0];
        assert_eq!(delta.base_event_count, Some(1));
        assert_eq!(delta.target_event_count, 2);
        assert_eq!(delta.upserted_agents.len(), 1);
        assert_eq!(delta.upserted_agents[0].tools[0].call_id, "call-1");
        let timeline = delta.timeline.as_ref().unwrap();
        assert_eq!(timeline.replace_from, 0);
        assert_eq!(timeline.entries[0].kind, "tool");
    }

    #[test]
    fn a_late_parent_relation_merges_the_old_root_into_the_parent_run() {
        let mut store = IngestStore::from_events([
            discovered("a", "root", None, "root"),
            discovered("a", "child", None, "child"),
        ])
        .unwrap();
        assert_eq!(store.runs().len(), 2);
        let mut relation = discovered("a", "child", Some("root"), "child");
        relation.event_id = "event-a-child-parent".into();
        relation.source_seq = 1;
        let outcome = store.ingest(relation).unwrap();
        assert_eq!(outcome.runs.len(), 1);
        assert_eq!(outcome.updated_runs.len(), 1);
        assert_eq!(outcome.removed_run_ids.len(), 1);
        assert_eq!(outcome.updated_runs[0].snapshot.agents.len(), 2);
        assert_eq!(outcome.updated_runs[0].snapshot.event_count, 3);
        let delta = &outcome.run_deltas[0];
        assert_eq!(delta.base_event_count, Some(1));
        assert_eq!(delta.target_event_count, 3);
        assert_eq!(delta.upserted_agents.len(), 1);
        assert_eq!(delta.upserted_agents[0].id, "child");
        assert_eq!(delta.agent_order.as_ref().map(Vec::len), Some(2));
        assert_eq!(delta.edges.as_ref().map(Vec::len), Some(1));
    }

    #[test]
    fn deleting_a_session_tree_only_rebuilds_its_source_partition() {
        let mut store = IngestStore::from_events([
            discovered("a", "root", None, "root"),
            discovered("a", "child", Some("root"), "child"),
            discovered("a", "sibling", Some("root"), "sibling"),
            discovered("b", "other", None, "other"),
        ])
        .unwrap();

        let child = store
            .delete_session_tree(&RuntimeKind::DeepSeekHarness, "a", "child")
            .unwrap();
        assert_eq!(child.deleted_events, 1);
        assert_eq!(child.deleted_sessions, 1);
        assert!(child.removed_run_ids.is_empty());
        assert_eq!(child.updated_runs.len(), 1);
        assert_eq!(child.updated_runs[0].snapshot.event_count, 2);
        assert_eq!(store.len(), 3);
        assert_eq!(store.runs().len(), 2);

        let root = store
            .delete_session_tree(&RuntimeKind::DeepSeekHarness, "a", "root")
            .unwrap();
        assert_eq!(root.deleted_events, 2);
        assert_eq!(root.deleted_sessions, 2);
        assert!(root.updated_runs.is_empty());
        assert_eq!(root.removed_run_ids.len(), 1);
        assert_eq!(store.len(), 1);
        assert_eq!(store.runs()[0].source_id, "b");
    }

    #[test]
    fn a_valid_checkpoint_restores_without_folding_and_stale_counts_are_rejected() {
        let events = vec![
            discovered("a", "root-a", None, "A"),
            discovered("a", "root-b", None, "B"),
        ];
        let baseline = IngestStore::from_events(events.clone()).unwrap();
        let restored = IngestStore::from_events_with_runs(events.clone(), baseline.runs()).unwrap();
        assert_eq!(restored.catalog(), baseline.catalog());

        let mut stale_runs = baseline.runs();
        stale_runs[0].snapshot.event_count += 1;
        let error = IngestStore::from_events_with_runs(events, stale_runs).unwrap_err();
        assert!(matches!(error, IngestError::InvalidCheckpoint(_)));
    }
}
