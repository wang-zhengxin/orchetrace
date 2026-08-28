use std::collections::{BTreeMap, BTreeSet};

use orchetrace_protocol::{
    ActivityStatus, CanonicalEvent, EventType, RuntimeKind, TerminalOutcome, ValidationError,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunSnapshot {
    pub schema_version: u16,
    pub root_session_id: String,
    pub runtimes: Vec<RuntimeKind>,
    pub event_count: usize,
    pub started_at: Option<String>,
    pub last_activity_at: Option<String>,
    pub agents: Vec<AgentSnapshot>,
    pub edges: Vec<AgentEdge>,
    pub timeline: Vec<TimelineEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentSnapshot {
    pub id: String,
    pub parent_id: Option<String>,
    pub label: String,
    pub role: Option<String>,
    pub mode: AgentMode,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub detail_level: DetailLevel,
    pub status: ActivityStatus,
    pub outcome: Option<TerminalOutcome>,
    pub outcome_evidence: Option<String>,
    pub current_tool: Option<String>,
    pub tool_count: usize,
    pub failed_tool_count: usize,
    pub started_at: Option<String>,
    pub last_activity_at: Option<String>,
    pub activations: Vec<ActivationSnapshot>,
    pub tools: Vec<ToolSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum AgentMode {
    #[default]
    Root,
    OneShot,
    Continuable,
    Remote,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum DetailLevel {
    #[default]
    Full,
    Opaque,
    Partial,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActivationSnapshot {
    pub id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub end_status: Option<ActivityStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolSnapshot {
    pub call_id: String,
    pub name: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub outcome: Option<TerminalOutcome>,
    pub duration_ms: Option<u64>,
    pub input_summary: Option<String>,
    pub output_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentEdge {
    pub parent_id: String,
    pub child_id: String,
    pub relation: String,
    pub opaque: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TimelineEntry {
    pub session_id: String,
    pub at: String,
    pub kind: String,
    pub label: String,
    pub outcome: Option<TerminalOutcome>,
}

#[derive(Debug)]
pub enum FoldError {
    InvalidEvent {
        event_id: String,
        source: ValidationError,
    },
    ConflictingDuplicate(String),
    MissingRoot,
    InvalidData {
        event_id: String,
        message: String,
    },
}

impl std::fmt::Display for FoldError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidEvent { event_id, source } => {
                write!(f, "invalid event `{event_id}`: {source}")
            }
            Self::ConflictingDuplicate(id) => write!(f, "conflicting duplicate event `{id}`"),
            Self::MissingRoot => write!(f, "event set has no root session"),
            Self::InvalidData { event_id, message } => {
                write!(f, "invalid data for event `{event_id}`: {message}")
            }
        }
    }
}

impl std::error::Error for FoldError {}

#[derive(Debug, Default)]
struct AgentAccumulator {
    id: String,
    parent_id: Option<String>,
    label: Option<String>,
    role: Option<String>,
    mode: AgentMode,
    provider: Option<String>,
    model: Option<String>,
    detail_level: DetailLevel,
    status: Option<ActivityStatus>,
    outcome: Option<TerminalOutcome>,
    outcome_evidence: Option<String>,
    outcome_evidence_priority: u64,
    started_at: Option<String>,
    last_activity_at: Option<String>,
    activations: BTreeMap<String, ActivationSnapshot>,
    tools: BTreeMap<String, ToolSnapshot>,
}

impl AgentAccumulator {
    fn new(id: &str) -> Self {
        Self {
            id: id.to_owned(),
            ..Self::default()
        }
    }

    fn touch(&mut self, at: &str) {
        set_min(&mut self.started_at, at);
        set_max(&mut self.last_activity_at, at);
    }

    fn finish(self) -> AgentSnapshot {
        let tools: Vec<_> = self.tools.into_values().collect();
        let current_tool = tools
            .iter()
            .rev()
            .find(|tool| tool.ended_at.is_none())
            .map(|tool| tool.name.clone());
        let failed_tool_count = tools
            .iter()
            .filter(|tool| tool.outcome == Some(TerminalOutcome::Failed))
            .count();
        AgentSnapshot {
            id: self.id.clone(),
            parent_id: self.parent_id,
            label: self.label.unwrap_or(self.id),
            role: self.role,
            mode: self.mode,
            provider: self.provider,
            model: self.model,
            detail_level: self.detail_level,
            status: self.status.unwrap_or(ActivityStatus::Unknown),
            outcome: self.outcome,
            outcome_evidence: self.outcome_evidence,
            current_tool,
            tool_count: tools.len(),
            failed_tool_count,
            started_at: self.started_at,
            last_activity_at: self.last_activity_at,
            activations: self.activations.into_values().collect(),
            tools,
        }
    }
}

pub fn fold_events(
    events: impl IntoIterator<Item = CanonicalEvent>,
) -> Result<RunSnapshot, FoldError> {
    let mut unique = BTreeMap::<String, CanonicalEvent>::new();
    for event in events {
        event.validate().map_err(|source| FoldError::InvalidEvent {
            event_id: event.event_id.clone(),
            source,
        })?;
        match unique.get(&event.event_id) {
            Some(existing) if existing != &event => {
                return Err(FoldError::ConflictingDuplicate(event.event_id));
            }
            Some(_) => continue,
            None => {
                unique.insert(event.event_id.clone(), event);
            }
        }
    }

    let mut ordered: Vec<_> = unique.into_values().collect();
    ordered.sort_by(|a, b| {
        (
            a.effective_time(),
            &a.source_id,
            &a.session_id,
            a.source_seq,
            &a.event_id,
        )
            .cmp(&(
                b.effective_time(),
                &b.source_id,
                &b.session_id,
                b.source_seq,
                &b.event_id,
            ))
    });

    let mut agents = BTreeMap::<String, AgentAccumulator>::new();
    let mut runtimes = BTreeSet::new();
    let mut timeline = Vec::new();
    let mut started_at = None;
    let mut last_activity_at = None;

    for event in &ordered {
        runtimes.insert(event.runtime.clone());
        let at = event.effective_time();
        set_min(&mut started_at, at);
        set_max(&mut last_activity_at, at);

        let agent = agents
            .entry(event.session_id.clone())
            .or_insert_with(|| AgentAccumulator::new(&event.session_id));
        agent.touch(at);
        if agent.parent_id.is_none() {
            agent.parent_id.clone_from(&event.parent_session_id);
        }

        apply_event(agent, event, &mut timeline)?;
    }

    let root_session_id = agents
        .values()
        .filter(|agent| agent.parent_id.is_none())
        .min_by_key(|agent| (&agent.started_at, &agent.id))
        .map(|agent| agent.id.clone())
        .ok_or(FoldError::MissingRoot)?;

    let mut snapshots: Vec<_> = agents.into_values().map(AgentAccumulator::finish).collect();
    let parent_map: BTreeMap<_, _> = snapshots
        .iter()
        .map(|agent| (agent.id.clone(), agent.parent_id.clone()))
        .collect();
    snapshots.sort_by_key(|agent| {
        (
            depth_of(agent, &parent_map),
            agent.started_at.clone(),
            agent.id.clone(),
        )
    });

    let mut edges: Vec<_> = snapshots
        .iter()
        .filter_map(|agent| {
            agent.parent_id.as_ref().map(|parent_id| AgentEdge {
                parent_id: parent_id.clone(),
                child_id: agent.id.clone(),
                relation: if agent.mode == AgentMode::Remote {
                    "remote".into()
                } else {
                    "delegate".into()
                },
                opaque: agent.detail_level == DetailLevel::Opaque,
            })
        })
        .collect();
    edges.sort_by_key(|edge| (edge.parent_id.clone(), edge.child_id.clone()));
    timeline.sort_by_key(|item| (item.at.clone(), item.session_id.clone(), item.kind.clone()));

    Ok(RunSnapshot {
        schema_version: 1,
        root_session_id,
        runtimes: runtimes.into_iter().collect(),
        event_count: ordered.len(),
        started_at,
        last_activity_at,
        agents: snapshots,
        edges,
        timeline,
    })
}

fn apply_event(
    agent: &mut AgentAccumulator,
    event: &CanonicalEvent,
    timeline: &mut Vec<TimelineEntry>,
) -> Result<(), FoldError> {
    let at = event.effective_time();
    match event.event_type {
        EventType::SessionDiscovered | EventType::SessionMetadataChanged => {
            apply_identity(agent, &event.data);
            if agent.parent_id.is_none() {
                agent.mode = AgentMode::Root;
            }
        }
        EventType::AgentSpawned => {
            apply_identity(agent, &event.data);
            agent.parent_id.clone_from(&event.parent_session_id);
            push_timeline(
                timeline,
                event,
                "spawn",
                agent.label.as_deref().unwrap_or("agent spawned"),
                None,
            );
        }
        EventType::AgentActivationStarted => {
            let id = required_string(event, "activation_id")?;
            agent
                .activations
                .entry(id.clone())
                .or_insert_with(|| ActivationSnapshot {
                    id,
                    started_at: at.to_owned(),
                    ended_at: None,
                    end_status: None,
                });
            agent.status = Some(ActivityStatus::Running);
            push_timeline(timeline, event, "activation", "activation started", None);
        }
        EventType::AgentStatusChanged => {
            agent.status = Some(required_status(event)?);
        }
        EventType::AgentActivationEnded => {
            let id = required_string(event, "activation_id")?;
            let status = optional_status(&event.data)
                .transpose()?
                .unwrap_or(ActivityStatus::Inactive);
            let activation =
                agent
                    .activations
                    .entry(id.clone())
                    .or_insert_with(|| ActivationSnapshot {
                        id,
                        started_at: at.to_owned(),
                        ended_at: None,
                        end_status: None,
                    });
            activation.ended_at = Some(at.to_owned());
            activation.end_status = Some(status.clone());
            agent.status = Some(status);
        }
        EventType::AgentOutcomeRecorded => {
            let outcome = required_outcome(event)?;
            let evidence_priority = event
                .data
                .get("evidence_priority")
                .and_then(Value::as_u64)
                .unwrap_or_default();
            if evidence_priority >= agent.outcome_evidence_priority {
                agent.outcome = Some(outcome.clone());
                agent.outcome_evidence = data_string(&event.data, "evidence");
                agent.outcome_evidence_priority = evidence_priority;
            }
            push_timeline(timeline, event, "outcome", "agent outcome", Some(outcome));
        }
        EventType::AgentDisposed => {
            if agent.status == Some(ActivityStatus::Running) {
                agent.status = Some(ActivityStatus::Inactive);
            }
        }
        EventType::PromptAccepted => {
            let label =
                data_string(&event.data, "excerpt").unwrap_or_else(|| "prompt accepted".into());
            push_timeline(timeline, event, "prompt", &label, None);
        }
        EventType::TurnStarted => push_timeline(timeline, event, "turn", "turn started", None),
        EventType::TurnEnded => push_timeline(timeline, event, "turn", "turn ended", None),
        EventType::StepStarted | EventType::StepEnded => {}
        EventType::AssistantMessage => {
            let label =
                data_string(&event.data, "summary").unwrap_or_else(|| "assistant response".into());
            push_timeline(timeline, event, "message", &label, None);
        }
        EventType::AssistantReasoningSummary => {
            let label = data_string(&event.data, "summary")
                .unwrap_or_else(|| "reasoning summary available".into());
            push_timeline(timeline, event, "reasoning", &label, None);
        }
        EventType::ToolStarted => {
            let call_id = required_string(event, "call_id")?;
            let name = required_string(event, "name")?;
            let tool = agent
                .tools
                .entry(call_id.clone())
                .or_insert_with(|| ToolSnapshot {
                    call_id,
                    name: name.clone(),
                    started_at: None,
                    ended_at: None,
                    outcome: None,
                    duration_ms: None,
                    input_summary: None,
                    output_summary: None,
                });
            tool.name = name.clone();
            tool.started_at = Some(at.to_owned());
            tool.input_summary = data_string(&event.data, "input_summary");
            push_timeline(timeline, event, "tool", &name, None);
        }
        EventType::ToolProgressed => {}
        EventType::ToolFinished => {
            let call_id = required_string(event, "call_id")?;
            let name = data_string(&event.data, "name").unwrap_or_else(|| "tool".into());
            let outcome = required_outcome(event)?;
            let tool = agent
                .tools
                .entry(call_id.clone())
                .or_insert_with(|| ToolSnapshot {
                    call_id,
                    name: name.clone(),
                    started_at: None,
                    ended_at: None,
                    outcome: None,
                    duration_ms: None,
                    input_summary: None,
                    output_summary: None,
                });
            tool.name = name.clone();
            tool.ended_at = Some(at.to_owned());
            tool.outcome = Some(outcome.clone());
            tool.duration_ms = event.data.get("duration_ms").and_then(Value::as_u64);
            tool.output_summary = data_string(&event.data, "output_summary");
            push_timeline(timeline, event, "tool-result", &name, Some(outcome));
        }
        EventType::ContextCompacted => {
            push_timeline(timeline, event, "compaction", "context compacted", None);
        }
        EventType::ErrorRecorded => {
            let label =
                data_string(&event.data, "message").unwrap_or_else(|| "runtime error".into());
            push_timeline(
                timeline,
                event,
                "error",
                &label,
                Some(TerminalOutcome::Failed),
            );
        }
    }
    Ok(())
}

fn apply_identity(agent: &mut AgentAccumulator, data: &Value) {
    if let Some(value) = data_string(data, "label") {
        agent.label = Some(value);
    }
    if let Some(value) = data_string(data, "role") {
        agent.role = Some(value);
    }
    if let Some(value) = data_string(data, "provider") {
        agent.provider = Some(value);
    }
    if let Some(value) = data_string(data, "model") {
        agent.model = Some(value);
    }
    if let Some(value) = data_string(data, "mode") {
        agent.mode = match value.as_str() {
            "root" => AgentMode::Root,
            "one-shot" => AgentMode::OneShot,
            "continuable" => AgentMode::Continuable,
            "remote" => AgentMode::Remote,
            _ => AgentMode::Unknown,
        };
    }
    if let Some(value) = data_string(data, "detail_level") {
        agent.detail_level = match value.as_str() {
            "opaque" => DetailLevel::Opaque,
            "partial" => DetailLevel::Partial,
            _ => DetailLevel::Full,
        };
    }
}

fn push_timeline(
    timeline: &mut Vec<TimelineEntry>,
    event: &CanonicalEvent,
    kind: &str,
    label: &str,
    outcome: Option<TerminalOutcome>,
) {
    timeline.push(TimelineEntry {
        session_id: event.session_id.clone(),
        at: event.effective_time().to_owned(),
        kind: kind.to_owned(),
        label: label.to_owned(),
        outcome,
    });
}

fn required_string(event: &CanonicalEvent, key: &str) -> Result<String, FoldError> {
    data_string(&event.data, key).ok_or_else(|| FoldError::InvalidData {
        event_id: event.event_id.clone(),
        message: format!("missing string `{key}`"),
    })
}

fn required_status(event: &CanonicalEvent) -> Result<ActivityStatus, FoldError> {
    optional_status(&event.data)
        .transpose()?
        .ok_or_else(|| FoldError::InvalidData {
            event_id: event.event_id.clone(),
            message: "missing activity status".into(),
        })
}

fn optional_status(data: &Value) -> Option<Result<ActivityStatus, FoldError>> {
    data.get("status").and_then(Value::as_str).map(|value| {
        serde_json::from_value(Value::String(value.into())).map_err(|error| {
            FoldError::InvalidData {
                event_id: "status".into(),
                message: error.to_string(),
            }
        })
    })
}

fn required_outcome(event: &CanonicalEvent) -> Result<TerminalOutcome, FoldError> {
    let value = event
        .data
        .get("outcome")
        .and_then(Value::as_str)
        .ok_or_else(|| FoldError::InvalidData {
            event_id: event.event_id.clone(),
            message: "missing terminal outcome".into(),
        })?;
    serde_json::from_value(Value::String(value.into())).map_err(|error| FoldError::InvalidData {
        event_id: event.event_id.clone(),
        message: error.to_string(),
    })
}

fn data_string(data: &Value, key: &str) -> Option<String> {
    data.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn set_min(target: &mut Option<String>, candidate: &str) {
    if target.as_deref().is_none_or(|current| candidate < current) {
        *target = Some(candidate.to_owned());
    }
}

fn set_max(target: &mut Option<String>, candidate: &str) {
    if target.as_deref().is_none_or(|current| candidate > current) {
        *target = Some(candidate.to_owned());
    }
}

fn depth_of(agent: &AgentSnapshot, parents: &BTreeMap<String, Option<String>>) -> usize {
    let mut depth = 0;
    let mut current = agent.parent_id.as_deref();
    let mut seen = BTreeSet::new();
    while let Some(parent) = current {
        if !seen.insert(parent) {
            break;
        }
        depth += 1;
        current = parents.get(parent).and_then(Option::as_deref);
    }
    depth
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use orchetrace_protocol::{EventType, SourceRef};
    use serde_json::json;

    use super::*;

    fn event(
        id: &str,
        session: &str,
        parent: Option<&str>,
        seq: u64,
        at: &str,
        kind: EventType,
        data: Value,
    ) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            event_id: id.into(),
            runtime: RuntimeKind::DeepSeekHarness,
            source_id: "test".into(),
            session_id: session.into(),
            parent_session_id: parent.map(str::to_owned),
            source_seq: seq,
            observed_at: at.into(),
            occurred_at: Some(at.into()),
            event_type: kind,
            data,
            attributes: BTreeMap::new(),
            source_ref: Some(SourceRef {
                kind: "test".into(),
                location: id.into(),
            }),
            supersedes_event_id: None,
            ignorable: false,
        }
    }

    #[test]
    fn fold_is_independent_of_arrival_order() {
        let events = vec![
            event(
                "root",
                "root",
                None,
                0,
                "2026-08-25T00:00:00Z",
                EventType::SessionDiscovered,
                json!({"label":"root","mode":"root"}),
            ),
            event(
                "child",
                "child",
                Some("root"),
                0,
                "2026-08-25T00:00:01Z",
                EventType::AgentSpawned,
                json!({"label":"researcher","mode":"one-shot"}),
            ),
            event(
                "tool-end",
                "child",
                Some("root"),
                2,
                "2026-08-25T00:00:03Z",
                EventType::ToolFinished,
                json!({"call_id":"c1","name":"search","outcome":"succeeded"}),
            ),
            event(
                "tool-start",
                "child",
                Some("root"),
                1,
                "2026-08-25T00:00:02Z",
                EventType::ToolStarted,
                json!({"call_id":"c1","name":"search"}),
            ),
        ];
        let forward = fold_events(events.clone()).unwrap();
        let reverse = fold_events(events.into_iter().rev()).unwrap();
        assert_eq!(forward, reverse);
        assert_eq!(forward.edges.len(), 1);
        assert_eq!(forward.agents[1].tool_count, 1);
    }

    #[test]
    fn idle_is_not_a_terminal_outcome() {
        let snapshot = fold_events(vec![
            event(
                "root",
                "root",
                None,
                0,
                "2026-08-25T00:00:00Z",
                EventType::SessionDiscovered,
                json!({"label":"root"}),
            ),
            event(
                "idle",
                "root",
                None,
                1,
                "2026-08-25T00:00:01Z",
                EventType::AgentStatusChanged,
                json!({"status":"idle"}),
            ),
        ])
        .unwrap();
        assert_eq!(snapshot.agents[0].status, ActivityStatus::Idle);
        assert_eq!(snapshot.agents[0].outcome, None);
    }

    #[test]
    fn stronger_terminal_evidence_wins_even_when_it_occurred_earlier() {
        let snapshot = fold_events(vec![
            event(
                "root",
                "root",
                None,
                0,
                "2026-08-25T00:00:00Z",
                EventType::SessionDiscovered,
                json!({"label":"root"}),
            ),
            event(
                "strong",
                "root",
                None,
                1,
                "2026-08-25T00:00:01Z",
                EventType::AgentOutcomeRecorded,
                json!({"outcome":"interrupted","evidence":"notification","evidence_priority":3}),
            ),
            event(
                "weak-late",
                "root",
                None,
                2,
                "2026-08-25T00:00:02Z",
                EventType::AgentOutcomeRecorded,
                json!({"outcome":"succeeded","evidence":"task result","evidence_priority":1}),
            ),
        ])
        .unwrap();
        assert_eq!(
            snapshot.agents[0].outcome,
            Some(TerminalOutcome::Interrupted)
        );
        assert_eq!(
            snapshot.agents[0].outcome_evidence.as_deref(),
            Some("notification")
        );
    }

    #[test]
    fn conflicting_duplicates_are_rejected() {
        let first = event(
            "same",
            "root",
            None,
            0,
            "2026-08-25T00:00:00Z",
            EventType::SessionDiscovered,
            json!({"label":"a"}),
        );
        let mut second = first.clone();
        second.data = json!({"label":"b"});
        assert!(matches!(
            fold_events(vec![first, second]),
            Err(FoldError::ConflictingDuplicate(_))
        ));
    }

    #[test]
    fn claude_fixture_preserves_nested_agents_tools_and_terminal_evidence() {
        let events = include_str!("../../../fixtures/claude/canonical-events.jsonl")
            .lines()
            .map(serde_json::from_str::<CanonicalEvent>)
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let snapshot = fold_events(events).unwrap();
        let agents = snapshot
            .agents
            .iter()
            .map(|agent| (agent.id.as_str(), agent))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(snapshot.runtimes, vec![RuntimeKind::ClaudeCode]);
        assert_eq!(snapshot.event_count, 42);
        assert_eq!(agents.len(), 4);
        assert_eq!(snapshot.edges.len(), 3);
        assert_eq!(agents["demo"].outcome, None);
        assert_eq!(agents["direct-1"].parent_id.as_deref(), Some("demo"));
        assert_eq!(agents["direct-1"].outcome, Some(TerminalOutcome::Succeeded));
        assert_eq!(agents["direct-1"].failed_tool_count, 1);
        assert_eq!(
            agents["workflow:wf-review"].parent_id.as_deref(),
            Some("demo")
        );
        assert_eq!(
            agents["review-1"].parent_id.as_deref(),
            Some("workflow:wf-review")
        );
        assert_eq!(agents["review-1"].outcome, Some(TerminalOutcome::Succeeded));
    }

    #[test]
    fn pi_fixture_folds_one_conversation_tree_into_one_agent() {
        let events = include_str!("../../../fixtures/pi/canonical-events.jsonl")
            .lines()
            .map(serde_json::from_str::<CanonicalEvent>)
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let snapshot = fold_events(events).unwrap();

        assert_eq!(snapshot.runtimes, vec![RuntimeKind::Pi]);
        assert_eq!(snapshot.root_session_id, "pi-demo");
        assert_eq!(snapshot.event_count, 12);
        assert_eq!(snapshot.agents.len(), 1);
        assert!(snapshot.edges.is_empty());
        let agent = &snapshot.agents[0];
        assert_eq!(agent.label, "Renamed Pi run");
        assert_eq!(agent.status, ActivityStatus::Unknown);
        assert_eq!(agent.outcome, None);
        assert_eq!(agent.tool_count, 1);
        assert_eq!(agent.failed_tool_count, 0);
        assert!(
            snapshot
                .timeline
                .iter()
                .any(|entry| entry.kind == "compaction")
        );
    }

    #[test]
    fn pi_telemetry_fixture_folds_explicit_nested_extension_agents() {
        let events = include_str!("../../../fixtures/pi/telemetry-canonical-events.jsonl")
            .lines()
            .map(serde_json::from_str::<CanonicalEvent>)
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let snapshot = fold_events(events).unwrap();
        let agents = snapshot
            .agents
            .iter()
            .map(|agent| (agent.id.as_str(), agent))
            .collect::<BTreeMap<_, _>>();
        let worker = "pi-telemetry-demo::pi-agent::worker-1";
        let reviewer = "pi-telemetry-demo::pi-agent::reviewer-1";

        assert_eq!(snapshot.runtimes, vec![RuntimeKind::Pi]);
        assert_eq!(snapshot.event_count, 14);
        assert_eq!(agents.len(), 3);
        assert_eq!(snapshot.edges.len(), 2);
        assert_eq!(
            agents[worker].parent_id.as_deref(),
            Some("pi-telemetry-demo")
        );
        assert_eq!(agents[worker].outcome, Some(TerminalOutcome::Succeeded));
        assert_eq!(agents[worker].tool_count, 1);
        assert_eq!(agents[reviewer].parent_id.as_deref(), Some(worker));
        assert_eq!(agents[reviewer].outcome, Some(TerminalOutcome::Failed));
    }

    #[test]
    fn reasoning_summary_is_available_as_redacted_timeline_evidence() {
        let snapshot = fold_events([event(
            "reasoning",
            "root",
            None,
            0,
            "2026-08-25T00:00:00Z",
            EventType::AssistantReasoningSummary,
            json!({"summary":"Verified the dependency boundary."}),
        )])
        .unwrap();

        assert!(snapshot.timeline.iter().any(|entry| {
            entry.kind == "reasoning" && entry.label == "Verified the dependency boundary."
        }));
    }
}
