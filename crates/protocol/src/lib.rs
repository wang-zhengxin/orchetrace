use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

mod privacy;

pub use privacy::{CaptureMode, OMITTED_VALUE, PrivacyPolicy, REDACTED_VALUE, SanitizationReport};

pub const SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CanonicalEvent {
    pub schema_version: u16,
    pub event_id: String,
    pub runtime: RuntimeKind,
    pub source_id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    pub source_seq: u64,
    pub observed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<String>,
    #[serde(rename = "type")]
    pub event_type: EventType,
    #[serde(default)]
    pub data: Value,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attributes: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<SourceRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes_event_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ignorable: bool,
}

impl CanonicalEvent {
    pub fn effective_time(&self) -> &str {
        self.occurred_at.as_deref().unwrap_or(&self.observed_at)
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(ValidationError::UnsupportedSchema(self.schema_version));
        }
        for (field, value) in [
            ("event_id", self.event_id.as_str()),
            ("source_id", self.source_id.as_str()),
            ("session_id", self.session_id.as_str()),
            ("observed_at", self.observed_at.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(ValidationError::EmptyField(field));
            }
        }
        if !self.data.is_object() {
            return Err(ValidationError::DataMustBeObject);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum RuntimeKind {
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "pi")]
    Pi,
    #[serde(rename = "deepseek-harness")]
    DeepSeekHarness,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum EventType {
    #[serde(rename = "session.discovered")]
    SessionDiscovered,
    #[serde(rename = "session.metadata_changed")]
    SessionMetadataChanged,
    #[serde(rename = "agent.spawned")]
    AgentSpawned,
    #[serde(rename = "agent.activation_started")]
    AgentActivationStarted,
    #[serde(rename = "agent.status_changed")]
    AgentStatusChanged,
    #[serde(rename = "agent.activation_ended")]
    AgentActivationEnded,
    #[serde(rename = "agent.outcome_recorded")]
    AgentOutcomeRecorded,
    #[serde(rename = "agent.disposed")]
    AgentDisposed,
    #[serde(rename = "prompt.accepted")]
    PromptAccepted,
    #[serde(rename = "turn.started")]
    TurnStarted,
    #[serde(rename = "turn.ended")]
    TurnEnded,
    #[serde(rename = "step.started")]
    StepStarted,
    #[serde(rename = "step.ended")]
    StepEnded,
    #[serde(rename = "assistant.message")]
    AssistantMessage,
    #[serde(rename = "assistant.reasoning_summary")]
    AssistantReasoningSummary,
    #[serde(rename = "tool.started")]
    ToolStarted,
    #[serde(rename = "tool.progressed")]
    ToolProgressed,
    #[serde(rename = "tool.finished")]
    ToolFinished,
    #[serde(rename = "context.compacted")]
    ContextCompacted,
    #[serde(rename = "error.recorded")]
    ErrorRecorded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityStatus {
    Running,
    Idle,
    Waiting,
    Ready,
    Inactive,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalOutcome {
    Succeeded,
    Failed,
    Interrupted,
    Cancelled,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceRef {
    pub kind: String,
    pub location: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    UnsupportedSchema(u16),
    EmptyField(&'static str),
    DataMustBeObject,
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedSchema(version) => {
                write!(f, "unsupported canonical event schema version {version}")
            }
            Self::EmptyField(field) => write!(f, "required field `{field}` is empty"),
            Self::DataMustBeObject => write!(f, "event data must be a JSON object"),
        }
    }
}

impl std::error::Error for ValidationError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_object_data() {
        let event = CanonicalEvent {
            schema_version: SCHEMA_VERSION,
            event_id: "evt-1".into(),
            runtime: RuntimeKind::DeepSeekHarness,
            source_id: "local".into(),
            session_id: "root".into(),
            parent_session_id: None,
            source_seq: 0,
            observed_at: "2026-08-25T00:00:00Z".into(),
            occurred_at: None,
            event_type: EventType::SessionDiscovered,
            data: Value::Null,
            attributes: BTreeMap::new(),
            source_ref: None,
            supersedes_event_id: None,
            ignorable: false,
        };
        assert_eq!(event.validate(), Err(ValidationError::DataMustBeObject));
    }
}
