use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::CanonicalEvent;

pub const REDACTED_VALUE: &str = "[REDACTED]";
pub const OMITTED_VALUE: &str = "[OMITTED]";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureMode {
    Standard,
    MetadataOnly,
}

impl CaptureMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::MetadataOnly => "metadata-only",
        }
    }
}

#[derive(Debug, Clone)]
pub struct PrivacyPolicy {
    capture_mode: CaptureMode,
    sensitive_keys: BTreeSet<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SanitizationReport {
    pub redacted_fields: usize,
    pub omitted_fields: usize,
}

impl PrivacyPolicy {
    pub fn standard() -> Self {
        Self::new(CaptureMode::Standard)
    }

    pub fn metadata_only() -> Self {
        Self::new(CaptureMode::MetadataOnly)
    }

    pub fn new(capture_mode: CaptureMode) -> Self {
        Self {
            capture_mode,
            sensitive_keys: default_sensitive_keys(),
        }
    }

    pub fn capture_mode(&self) -> CaptureMode {
        self.capture_mode
    }

    pub fn add_sensitive_key(&mut self, key: impl AsRef<str>) {
        self.sensitive_keys.insert(normalize_key(key.as_ref()));
    }

    pub fn sanitize_event(&self, event: &mut CanonicalEvent) -> SanitizationReport {
        let capture_mode = event
            .attributes
            .get("orchetrace.privacy.capture_mode")
            .and_then(Value::as_str)
            .filter(|mode| *mode == CaptureMode::MetadataOnly.as_str())
            .map_or(self.capture_mode, |_| CaptureMode::MetadataOnly);
        let mut report = SanitizationReport::default();
        sanitize_value(
            &mut event.data,
            capture_mode,
            &self.sensitive_keys,
            &mut report,
        );
        for (key, value) in &mut event.attributes {
            sanitize_field(key, value, capture_mode, &self.sensitive_keys, &mut report);
        }
        if capture_mode == CaptureMode::MetadataOnly
            && let Some(source_ref) = &mut event.source_ref
        {
            source_ref.location = OMITTED_VALUE.into();
            report.omitted_fields += 1;
        }
        event.attributes.insert(
            "orchetrace.privacy.capture_mode".into(),
            Value::String(capture_mode.as_str().into()),
        );
        if report.redacted_fields > 0 {
            event.attributes.insert(
                "orchetrace.privacy.redacted_fields".into(),
                Value::from(report.redacted_fields as u64),
            );
        }
        if report.omitted_fields > 0 {
            event.attributes.insert(
                "orchetrace.privacy.omitted_fields".into(),
                Value::from(report.omitted_fields as u64),
            );
        }
        report
    }
}

impl Default for PrivacyPolicy {
    fn default() -> Self {
        Self::standard()
    }
}

fn sanitize_value(
    value: &mut Value,
    capture_mode: CaptureMode,
    sensitive_keys: &BTreeSet<String>,
    report: &mut SanitizationReport,
) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                sanitize_field(key, value, capture_mode, sensitive_keys, report);
            }
        }
        Value::Array(items) => {
            for item in items {
                sanitize_value(item, capture_mode, sensitive_keys, report);
            }
        }
        Value::String(text) if contains_inline_secret(text) => {
            *text = REDACTED_VALUE.into();
            report.redacted_fields += 1;
        }
        _ => {}
    }
}

fn sanitize_field(
    key: &str,
    value: &mut Value,
    capture_mode: CaptureMode,
    sensitive_keys: &BTreeSet<String>,
    report: &mut SanitizationReport,
) {
    let normalized = normalize_key(key);
    if sensitive_keys.contains(&normalized) {
        *value = Value::String(REDACTED_VALUE.into());
        report.redacted_fields += 1;
    } else if capture_mode == CaptureMode::MetadataOnly && is_content_key(&normalized) {
        *value = Value::String(OMITTED_VALUE.into());
        report.omitted_fields += 1;
    } else {
        sanitize_value(value, capture_mode, sensitive_keys, report);
    }
}

fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn default_sensitive_keys() -> BTreeSet<String> {
    [
        "authorization",
        "proxyauthorization",
        "token",
        "accesstoken",
        "refreshtoken",
        "apikey",
        "password",
        "passwd",
        "secret",
        "clientsecret",
        "cookie",
        "setcookie",
        "privatekey",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

fn is_content_key(key: &str) -> bool {
    matches!(
        key,
        "content"
            | "excerpt"
            | "summary"
            | "message"
            | "reasoning"
            | "thought"
            | "inputsummary"
            | "outputsummary"
            | "arguments"
            | "command"
            | "prompt"
            | "query"
            | "url"
            | "cwd"
            | "filepath"
            | "location"
            | "parentsessionpath"
            | "path"
            | "evidence"
    )
}

fn contains_inline_secret(value: &str) -> bool {
    let lowercase = value.to_ascii_lowercase();
    [
        "authorization:",
        "bearer ",
        "api_key=",
        "apikey=",
        "access_token=",
        "token=",
        "password=",
        "passwd=",
        "secret=",
    ]
    .iter()
    .any(|marker| lowercase.contains(marker))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::*;
    use crate::{EventType, RuntimeKind, SCHEMA_VERSION, SourceRef};

    fn event(data: Value) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: SCHEMA_VERSION,
            event_id: "evt-1".into(),
            runtime: RuntimeKind::ClaudeCode,
            source_id: "local".into(),
            session_id: "root".into(),
            parent_session_id: None,
            source_seq: 1,
            observed_at: "2026-08-29T00:00:00Z".into(),
            occurred_at: None,
            event_type: EventType::ToolStarted,
            data,
            attributes: BTreeMap::new(),
            source_ref: Some(SourceRef {
                kind: "transcript".into(),
                location: "/private/work/session.jsonl#12".into(),
            }),
            supersedes_event_id: None,
            ignorable: false,
        }
    }

    #[test]
    fn standard_mode_recursively_redacts_secret_keys_and_inline_credentials() {
        let mut event = event(json!({
            "name": "bash",
            "arguments": {
                "api_key": "top-secret",
                "nested": [{ "Authorization": "Bearer abc" }],
                "command": "curl -H 'Authorization: Bearer abc' https://example.test"
            },
            "totalTokens": 42
        }));
        let report = PrivacyPolicy::standard().sanitize_event(&mut event);
        assert_eq!(report.redacted_fields, 3);
        assert_eq!(event.data["arguments"]["api_key"], REDACTED_VALUE);
        assert_eq!(
            event.data["arguments"]["nested"][0]["Authorization"],
            REDACTED_VALUE
        );
        assert_eq!(event.data["arguments"]["command"], REDACTED_VALUE);
        assert_eq!(event.data["totalTokens"], 42);
    }

    #[test]
    fn metadata_mode_omits_content_but_preserves_operational_fields() {
        let mut event = event(json!({
            "name": "bash",
            "call_id": "call-1",
            "arguments": { "path": "/private/work" },
            "cwd": "/private/work",
            "parent_session_path": "/private/work/parent.jsonl",
            "duration_ms": 120,
            "is_error": false
        }));
        let report = PrivacyPolicy::metadata_only().sanitize_event(&mut event);
        assert_eq!(event.data["name"], "bash");
        assert_eq!(event.data["call_id"], "call-1");
        assert_eq!(event.data["duration_ms"], 120);
        assert_eq!(event.data["arguments"], OMITTED_VALUE);
        assert_eq!(event.data["cwd"], OMITTED_VALUE);
        assert_eq!(event.data["parent_session_path"], OMITTED_VALUE);
        assert_eq!(event.source_ref.unwrap().location, OMITTED_VALUE);
        assert_eq!(report.omitted_fields, 4);
    }

    #[test]
    fn custom_sensitive_keys_are_normalized() {
        let mut policy = PrivacyPolicy::standard();
        policy.add_sensitive_key("workspace-id");
        let mut event = event(json!({ "workspace_id": "customer-42" }));
        policy.sanitize_event(&mut event);
        assert_eq!(event.data["workspace_id"], REDACTED_VALUE);
    }

    #[test]
    fn metadata_only_events_cannot_be_relabeled_as_standard() {
        let mut event = event(json!({ "summary": "private" }));
        PrivacyPolicy::metadata_only().sanitize_event(&mut event);
        PrivacyPolicy::standard().sanitize_event(&mut event);
        assert_eq!(event.data["summary"], OMITTED_VALUE);
        assert_eq!(
            event.attributes["orchetrace.privacy.capture_mode"],
            "metadata-only"
        );
    }
}
