use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

mod generated_runtime_registry;
mod privacy;

pub use generated_runtime_registry::{REGISTERED_RUNTIMES, runtime_descriptor};
pub use privacy::{CaptureMode, OMITTED_VALUE, PrivacyPolicy, REDACTED_VALUE, SanitizationReport};

pub const SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeObserverDescriptor {
    pub package: &'static str,
    pub entrypoint: &'static str,
    pub script_env: &'static str,
    pub sessions_env: &'static str,
    pub directory_flag: &'static str,
    pub state_directory: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeDescriptor {
    pub id: &'static str,
    pub label: &'static str,
    pub short_label: &'static str,
    pub accent: &'static str,
    pub aliases: &'static [&'static str],
    pub session_directory: &'static str,
    pub capabilities: &'static [&'static str],
    pub observer: RuntimeObserverDescriptor,
}

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
        if !valid_runtime_identifier(self.runtime.as_str()) {
            return Err(ValidationError::InvalidRuntime(
                self.runtime.as_str().to_owned(),
            ));
        }
        if !self.data.is_object() {
            return Err(ValidationError::DataMustBeObject);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum RuntimeKind {
    ClaudeCode,
    Pi,
    DeepSeekHarness,
    Codex,
    Other(String),
}

impl RuntimeKind {
    pub fn from_slug(value: impl Into<String>) -> Self {
        let value = value.into();
        let canonical = runtime_descriptor(&value)
            .map(|descriptor| descriptor.id)
            .unwrap_or(value.as_str());
        match canonical {
            "claude-code" | "claude" => Self::ClaudeCode,
            "pi" => Self::Pi,
            "deepseek-harness" | "harness" | "deepseek" => Self::DeepSeekHarness,
            "codex" | "openai-codex" => Self::Codex,
            _ => Self::Other(canonical.to_owned()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Pi => "pi",
            Self::DeepSeekHarness => "deepseek-harness",
            Self::Codex => "codex",
            Self::Other(value) => value,
        }
    }
}

impl Serialize for RuntimeKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for RuntimeKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self::from_slug)
    }
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
    InvalidRuntime(String),
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedSchema(version) => {
                write!(f, "unsupported canonical event schema version {version}")
            }
            Self::EmptyField(field) => write!(f, "required field `{field}` is empty"),
            Self::DataMustBeObject => write!(f, "event data must be a JSON object"),
            Self::InvalidRuntime(runtime) => write!(f, "invalid runtime identifier `{runtime}`"),
        }
    }
}

impl std::error::Error for ValidationError {}

fn valid_runtime_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric() || (index > 0 && matches!(character, '-' | '_'))
        })
}

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

    #[test]
    fn runtime_kind_preserves_registered_and_external_identifiers() {
        assert_eq!(
            serde_json::to_string(&RuntimeKind::Codex).unwrap(),
            "\"codex\""
        );
        assert_eq!(
            serde_json::from_str::<RuntimeKind>("\"gemini-cli\"").unwrap(),
            RuntimeKind::Other("gemini-cli".into())
        );
        assert_eq!(RuntimeKind::from_slug("claude"), RuntimeKind::ClaudeCode);
    }

    #[test]
    fn rejects_invalid_external_runtime_identifier() {
        let mut event = CanonicalEvent {
            schema_version: SCHEMA_VERSION,
            event_id: "evt-1".into(),
            runtime: RuntimeKind::Other("bad runtime".into()),
            source_id: "source".into(),
            session_id: "session".into(),
            parent_session_id: None,
            source_seq: 1,
            observed_at: "2026-08-30T00:00:00Z".into(),
            occurred_at: None,
            event_type: EventType::SessionDiscovered,
            data: serde_json::json!({}),
            attributes: BTreeMap::new(),
            source_ref: None,
            supersedes_event_id: None,
            ignorable: false,
        };
        assert_eq!(
            event.validate(),
            Err(ValidationError::InvalidRuntime("bad runtime".into()))
        );
        event.runtime = RuntimeKind::Other("gemini-cli".into());
        assert_eq!(event.validate(), Ok(()));
    }
}
