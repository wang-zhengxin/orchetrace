import type {
  ActivityStatus,
  CanonicalEvent,
  TerminalOutcome,
} from "../../protocol-ts/src/index.ts";
import type { PiDiagnostic, PiEntry } from "./types.ts";

export const PI_TELEMETRY_CHANNEL = "orchetrace:telemetry";
export const PI_TELEMETRY_CUSTOM_TYPE = "orchetrace.telemetry";

interface TelemetryBase {
  schema_version: 1;
  event_id: string;
  occurred_at: string;
  agent_id: string;
  parent_agent_id?: string;
}

export type PiTelemetryEnvelope = TelemetryBase &
  (
    | {
        kind: "agent.discovered";
        label: string;
        role?: string;
        mode?: "one-shot" | "continuable" | "remote";
        provider?: string;
        model?: string;
        detail_level?: "full" | "partial" | "opaque";
      }
    | { kind: "activation.started"; activation_id: string }
    | { kind: "status.changed"; status: ActivityStatus; evidence?: string }
    | {
        kind: "activation.ended";
        activation_id: string;
        status: ActivityStatus;
        outcome?: TerminalOutcome;
        evidence?: string;
      }
    | { kind: "agent.disposed" }
    | { kind: "tool.started"; call_id: string; name: string; input_summary?: string }
    | { kind: "tool.progressed"; call_id: string; name: string; output_summary?: string }
    | {
        kind: "tool.finished";
        call_id: string;
        name: string;
        outcome: "succeeded" | "failed" | "cancelled";
        output_summary?: string;
      }
    | { kind: "error.recorded"; message: string; category?: string }
  );

export interface PiTelemetryParseResult {
  envelope?: PiTelemetryEnvelope;
  diagnostic?: PiDiagnostic;
}

export function parsePiTelemetry(value: unknown, location: string): PiTelemetryParseResult {
  if (!isRecord(value)) return invalid("telemetry-invalid", location, "telemetry data must be an object");
  if (value.schema_version !== 1) {
    return invalid(
      "telemetry-version-unsupported",
      location,
      `unsupported Pi telemetry schema version ${String(value.schema_version)}`,
    );
  }
  const eventId = requiredString(value, "event_id");
  const occurredAt = requiredTime(value, "occurred_at");
  const agentId = requiredAgentId(value, "agent_id");
  const parentAgentId = optionalAgentId(value, "parent_agent_id");
  const kind = requiredString(value, "kind");
  if (!eventId || eventId.length > 200 || !occurredAt || !agentId || parentAgentId === null || !kind) {
    return invalid(
      "telemetry-invalid",
      location,
      "telemetry requires valid event_id, occurred_at, kind, agent_id, and optional parent_agent_id",
    );
  }
  if (parentAgentId === agentId) {
    return invalid("telemetry-invalid", location, "telemetry agent cannot be its own parent");
  }
  const base = {
    schema_version: 1 as const,
    event_id: eventId,
    occurred_at: occurredAt,
    agent_id: agentId,
    ...(parentAgentId ? { parent_agent_id: parentAgentId } : {}),
  };
  if (kind === "agent.discovered") {
    const label = requiredString(value, "label");
    const mode = optionalEnum(value, "mode", ["one-shot", "continuable", "remote"] as const);
    const detail = optionalEnum(value, "detail_level", ["full", "partial", "opaque"] as const);
    if (!label || mode === null || detail === null) return invalid("telemetry-invalid", location, "agent.discovered has invalid identity fields");
    return valid({
      ...base,
      kind,
      label,
      role: optionalString(value, "role"),
      mode,
      provider: optionalString(value, "provider"),
      model: optionalString(value, "model"),
      detail_level: detail,
    });
  }
  if (kind === "activation.started") {
    const activationId = requiredString(value, "activation_id");
    return activationId
      ? valid({ ...base, kind, activation_id: activationId })
      : invalid("telemetry-invalid", location, "activation.started requires activation_id");
  }
  if (kind === "status.changed") {
    const status = activityStatus(value.status);
    return status
      ? valid({ ...base, kind, status, evidence: optionalString(value, "evidence") })
      : invalid("telemetry-invalid", location, "status.changed requires a valid status");
  }
  if (kind === "activation.ended") {
    const activationId = requiredString(value, "activation_id");
    const status = activityStatus(value.status);
    const outcome = value.outcome === undefined ? undefined : terminalOutcome(value.outcome);
    if (!activationId || !status || outcome === null) {
      return invalid("telemetry-invalid", location, "activation.ended has invalid activation_id, status, or outcome");
    }
    return valid({
      ...base,
      kind,
      activation_id: activationId,
      status,
      outcome,
      evidence: optionalString(value, "evidence"),
    });
  }
  if (kind === "agent.disposed") return valid({ ...base, kind });
  if (kind === "tool.started" || kind === "tool.progressed" || kind === "tool.finished") {
    const callId = requiredString(value, "call_id");
    const name = requiredString(value, "name");
    if (!callId || !name) return invalid("telemetry-invalid", location, `${kind} requires call_id and name`);
    if (kind === "tool.started") {
      return valid({ ...base, kind, call_id: callId, name, input_summary: optionalString(value, "input_summary") });
    }
    if (kind === "tool.progressed") {
      return valid({ ...base, kind, call_id: callId, name, output_summary: optionalString(value, "output_summary") });
    }
    const outcome = optionalEnum(value, "outcome", ["succeeded", "failed", "cancelled"] as const);
    return outcome
      ? valid({ ...base, kind, call_id: callId, name, outcome, output_summary: optionalString(value, "output_summary") })
      : invalid("telemetry-invalid", location, "tool.finished requires a valid outcome");
  }
  if (kind === "error.recorded") {
    const message = requiredString(value, "message");
    return message
      ? valid({ ...base, kind, message, category: optionalString(value, "category") })
      : invalid("telemetry-invalid", location, "error.recorded requires message");
  }
  return invalid("telemetry-kind-unknown", location, `unsupported Pi telemetry kind ${kind}`);
}

export function mapPiTelemetryEntry(
  entry: PiEntry,
  rootSessionId: string,
  sourceId: string,
  diagnostics: PiDiagnostic[],
): CanonicalEvent[] {
  if (entry.type !== "custom" || entry.value.customType !== PI_TELEMETRY_CUSTOM_TYPE) return [];
  const parsed = parsePiTelemetry(entry.value.data, `session#${entry.line}`);
  if (!parsed.envelope) {
    if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
    return [];
  }
  const envelope = parsed.envelope;
  const sessionId = telemetrySessionId(rootSessionId, envelope.agent_id);
  const parentSessionId = envelope.parent_agent_id
    ? telemetrySessionId(rootSessionId, envelope.parent_agent_id)
    : rootSessionId;
  const event = (
    suffix: string,
    offset: number,
    type: CanonicalEvent["type"],
    data: Record<string, unknown>,
  ): CanonicalEvent => ({
    schema_version: 1,
    event_id: `pi-telemetry:${encodeURIComponent(sourceId)}:${encodeURIComponent(rootSessionId)}:${encodeURIComponent(envelope.event_id)}:${suffix}`,
    runtime: "pi",
    source_id: sourceId,
    session_id: sessionId,
    parent_session_id: parentSessionId,
    source_seq: entry.line * 100 + offset,
    observed_at: entry.timestamp,
    occurred_at: envelope.occurred_at,
    type,
    data: compact(data),
    attributes: {
      "pi.telemetry_schema": 1,
      "pi.telemetry_event_id": envelope.event_id,
      "pi.agent_id": envelope.agent_id,
      ...(envelope.parent_agent_id ? { "pi.parent_agent_id": envelope.parent_agent_id } : {}),
    },
    source_ref: { kind: "pi-telemetry-entry", location: `session#${entry.line}` },
  });
  if (envelope.kind === "agent.discovered") {
    const identity = {
      label: envelope.label,
      role: envelope.role ?? "subagent",
      mode: envelope.mode ?? "one-shot",
      provider: envelope.provider,
      model: envelope.model,
      detail_level: envelope.detail_level ?? "full",
      origin: "pi-extension",
    };
    return [
      event("discovered", 10, "session.discovered", identity),
      event("spawned", 11, "agent.spawned", identity),
    ];
  }
  if (envelope.kind === "activation.started") {
    return [event("activation-started", 10, "agent.activation_started", { activation_id: envelope.activation_id })];
  }
  if (envelope.kind === "status.changed") {
    return [event("status", 10, "agent.status_changed", { status: envelope.status, evidence: envelope.evidence })];
  }
  if (envelope.kind === "activation.ended") {
    const events = [
      event("activation-ended", 10, "agent.activation_ended", {
        activation_id: envelope.activation_id,
        status: envelope.status,
        evidence: envelope.evidence,
      }),
    ];
    if (envelope.outcome) {
      events.push(
        event("outcome", 11, "agent.outcome_recorded", {
          outcome: envelope.outcome,
          evidence: envelope.evidence ?? "Pi extension telemetry activation.ended",
        }),
      );
    }
    return events;
  }
  if (envelope.kind === "agent.disposed") return [event("disposed", 10, "agent.disposed", {})];
  if (envelope.kind === "tool.started") {
    return [event("tool-started", 10, "tool.started", { call_id: envelope.call_id, name: envelope.name, input_summary: envelope.input_summary })];
  }
  if (envelope.kind === "tool.progressed") {
    return [event("tool-progressed", 10, "tool.progressed", { call_id: envelope.call_id, name: envelope.name, output_summary: envelope.output_summary })];
  }
  if (envelope.kind === "tool.finished") {
    return [event("tool-finished", 10, "tool.finished", { call_id: envelope.call_id, name: envelope.name, outcome: envelope.outcome, output_summary: envelope.output_summary })];
  }
  return [event("error", 10, "error.recorded", { message: envelope.message, category: envelope.category ?? "subagent" })];
}

export function telemetrySessionId(rootSessionId: string, agentId: string): string {
  return `${rootSessionId}::pi-agent::${encodeURIComponent(agentId)}`;
}

function valid(envelope: PiTelemetryEnvelope): PiTelemetryParseResult {
  return { envelope };
}

function invalid(code: string, location: string, message: string): PiTelemetryParseResult {
  return { diagnostic: { level: "error", code, location, message } };
}

function requiredString(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  return typeof item === "string" && item.trim() ? item : undefined;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  return value[key] === undefined ? undefined : requiredString(value, key);
}

function requiredTime(value: Record<string, unknown>, key: string): string | undefined {
  const item = requiredString(value, key);
  return item && Number.isFinite(Date.parse(item)) ? new Date(item).toISOString() : undefined;
}

function requiredAgentId(value: Record<string, unknown>, key: string): string | undefined {
  const item = requiredString(value, key);
  return item && /^[A-Za-z0-9._:-]{1,128}$/.test(item) ? item : undefined;
}

function optionalAgentId(value: Record<string, unknown>, key: string): string | undefined | null {
  if (value[key] === undefined) return undefined;
  return requiredAgentId(value, key) ?? null;
}

function optionalEnum<const T extends readonly string[]>(
  value: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] | undefined | null {
  if (value[key] === undefined) return undefined;
  return typeof value[key] === "string" && allowed.includes(value[key] as T[number])
    ? (value[key] as T[number])
    : null;
}

function activityStatus(value: unknown): ActivityStatus | undefined {
  return ["running", "idle", "waiting", "ready", "inactive", "unknown"].includes(String(value))
    ? (value as ActivityStatus)
    : undefined;
}

function terminalOutcome(value: unknown): TerminalOutcome | null {
  return ["succeeded", "failed", "interrupted", "cancelled", "unavailable"].includes(String(value))
    ? (value as TerminalOutcome)
    : null;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
