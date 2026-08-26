import type { CanonicalEvent, CanonicalEventType } from "../../protocol-ts/src/index.ts";
import type { PiEntry, PiParsedSession } from "./types.ts";
import { mapPiTelemetryEntry } from "./telemetry.ts";

export function mapPiSession(session: PiParsedSession, sourceId: string): CanonicalEvent[] {
  const { header, activePath, contextEntryIds, diagnostics } = session;
  const identity = finalIdentity(session);
  const events: CanonicalEvent[] = [
    canonical({
      sourceId,
      sessionId: header.id,
      eventId: "identity",
      sequence: 0,
      at: header.timestamp,
      type: "session.discovered",
      data: {
        label: identity.label ?? header.id,
        role: "coding-agent",
        mode: "continuable",
        provider: identity.provider,
        model: identity.model,
        detail_level: "full",
        cwd: header.cwd,
        parent_session_path: header.parentSession,
        pi_session_version: header.version,
        active_leaf_id: activePath.at(-1)?.id,
      },
      sourceKind: "pi-session-header",
      location: "session#1",
    }),
  ];
  for (const entry of activePath) {
    mapEntry(events, entry, header.id, sourceId, contextEntryIds.has(entry.id), diagnostics);
  }
  return uniqueEvents(events, diagnostics).sort(compareEvents);
}

function mapEntry(
  events: CanonicalEvent[],
  entry: PiEntry,
  sessionId: string,
  sourceId: string,
  inActiveContext: boolean,
  diagnostics: PiParsedSession["diagnostics"],
): void {
  const push = (
    suffix: string,
    offset: number,
    type: CanonicalEventType,
    data: Record<string, unknown>,
  ) =>
    events.push(
      canonical({
        sourceId,
        sessionId,
        eventId: `${entry.id}:${suffix}`,
        sequence: entry.line * 100 + offset,
        at: entryTime(entry),
        type,
        data,
        sourceKind: "pi-session-entry",
        location: `session#${entry.line}`,
        attributes: {
          "pi.entry_id": entry.id,
          "pi.parent_id": entry.parentId,
          "pi.active_branch": true,
          "pi.active_context": inActiveContext,
        },
      }),
    );

  if (entry.type === "message") {
    const message = record(entry.value.message);
    const role = stringField(message, "role");
    if (role === "user") {
      push("prompt", 10, "prompt.accepted", { excerpt: summarize(message?.content), source: "user" });
    } else if (role === "assistant") {
      const blocks = Array.isArray(message?.content) ? message.content : [];
      const texts: string[] = [];
      const thoughts: string[] = [];
      let toolOffset = 0;
      for (const value of blocks) {
        const block = record(value);
        if (block?.type === "text") texts.push(stringField(block, "text") ?? "");
        else if (block?.type === "thinking") thoughts.push(stringField(block, "thinking") ?? "");
        else if (block?.type === "toolCall") {
          const callId = stringField(block, "id");
          const name = stringField(block, "name");
          if (!callId || !name) {
            diagnostics.push({
              level: "error",
              code: "tool-call-invalid",
              location: `session#${entry.line}`,
              message: "Pi toolCall block requires id and name",
            });
            continue;
          }
          push(`tool-${toolOffset}`, 30 + toolOffset, "tool.started", {
            call_id: callId,
            name,
            input_summary: summarizeToolInput(name, block.arguments),
          });
          toolOffset += 1;
        }
      }
      const text = summarize(texts.join(" "));
      if (text) push("assistant", 10, "assistant.message", { summary: text, usage: message?.usage });
      const thinking = summarize(thoughts.join(" "));
      if (thinking) push("thinking", 11, "assistant.reasoning_summary", { summary: thinking });
      const stopReason = stringField(message, "stopReason");
      if (stopReason === "error" || stopReason === "aborted") {
        push("error", 90, "error.recorded", {
          message: stringField(message, "errorMessage") ?? `Pi assistant stopped with ${stopReason}`,
          category: stopReason,
        });
      }
    } else if (role === "toolResult") {
      const callId = stringField(message, "toolCallId");
      const name = stringField(message, "toolName");
      if (!callId || !name) {
        diagnostics.push({
          level: "error",
          code: "tool-result-invalid",
          location: `session#${entry.line}`,
          message: "Pi toolResult message requires toolCallId and toolName",
        });
      } else {
        push("tool-result", 20, "tool.finished", {
          call_id: callId,
          name,
          outcome: message?.isError === true ? "failed" : "succeeded",
          output_summary: summarize(message?.content),
        });
      }
    } else if (role === "hookMessage" || role === "custom") {
      push("custom-message", 10, "prompt.accepted", {
        excerpt: summarize(message?.content),
        source: "extension",
        custom_type: message?.customType ?? "legacy-hook-message",
      });
    } else {
      diagnostics.push({
        level: "warning",
        code: "message-role-unknown",
        location: `session#${entry.line}`,
        message: `unsupported Pi message role ${String(role)}`,
      });
    }
    return;
  }

  if (entry.type === "compaction") {
    push("compaction", 10, "context.compacted", {
      summary: summarize(entry.value.summary),
      first_kept_entry_id: entry.value.firstKeptEntryId,
      tokens_before: entry.value.tokensBefore,
      from_hook: entry.value.fromHook === true,
    });
  } else if (entry.type === "branch_summary") {
    push("branch-summary", 10, "assistant.message", {
      summary: summarize(entry.value.summary),
      kind: "branch-summary",
      from_entry_id: entry.value.fromId,
      from_hook: entry.value.fromHook === true,
    });
  } else if (entry.type === "model_change") {
    push("model", 10, "session.metadata_changed", {
      provider: entry.value.provider,
      model: entry.value.modelId,
    });
  } else if (entry.type === "thinking_level_change") {
    push("thinking-level", 10, "session.metadata_changed", {
      thinking_level: entry.value.thinkingLevel,
    });
  } else if (entry.type === "session_info") {
    push("session-info", 10, "session.metadata_changed", { label: entry.value.name });
  } else if (entry.type === "custom_message") {
    if (entry.value.display === true) {
      push("custom-message", 10, "prompt.accepted", {
        excerpt: summarize(entry.value.content),
        source: "extension",
        custom_type: entry.value.customType,
      });
    }
  } else if (entry.type === "custom") {
    events.push(...mapPiTelemetryEntry(entry, sessionId, sourceId, diagnostics));
  } else if (entry.type !== "label") {
    diagnostics.push({
      level: "error",
      code: "entry-type-unknown",
      location: `session#${entry.line}`,
      message: `unsupported Pi session entry type ${entry.type}`,
    });
  }
}

function finalIdentity(session: PiParsedSession): { label?: string; provider?: string; model?: string } {
  let label: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  for (const entry of session.activePath) {
    if (entry.type === "session_info") label = stringField(entry.value, "name") ?? label;
    else if (entry.type === "model_change") {
      provider = stringField(entry.value, "provider") ?? provider;
      model = stringField(entry.value, "modelId") ?? model;
    } else if (entry.type === "message") {
      const message = record(entry.value.message);
      if (message?.role === "assistant") {
        provider = stringField(message, "provider") ?? provider;
        model = stringField(message, "model") ?? model;
      }
    }
  }
  return { label, provider, model };
}

function entryTime(entry: PiEntry): string {
  const message = record(entry.value.message);
  const millis = message?.timestamp;
  if (typeof millis === "number" && Number.isFinite(millis)) return new Date(millis).toISOString();
  return entry.timestamp;
}

function canonical(input: {
  sourceId: string;
  sessionId: string;
  eventId: string;
  sequence: number;
  at: string;
  type: CanonicalEventType;
  data: Record<string, unknown>;
  sourceKind: string;
  location: string;
  attributes?: Record<string, unknown>;
}): CanonicalEvent {
  return {
    schema_version: 1,
    event_id: `pi:${encodeURIComponent(input.sourceId)}:${encodeURIComponent(input.sessionId)}:${encodeURIComponent(input.eventId)}`,
    runtime: "pi",
    source_id: input.sourceId,
    session_id: input.sessionId,
    source_seq: input.sequence,
    observed_at: input.at,
    occurred_at: input.at,
    type: input.type,
    data: compact(input.data),
    attributes: input.attributes,
    source_ref: { kind: input.sourceKind, location: input.location },
  };
}

function compareEvents(left: CanonicalEvent, right: CanonicalEvent): number {
  return [left.occurred_at ?? left.observed_at, left.source_seq, left.event_id]
    .join("\0")
    .localeCompare([right.occurred_at ?? right.observed_at, right.source_seq, right.event_id].join("\0"));
}

function uniqueEvents(events: CanonicalEvent[], diagnostics: PiParsedSession["diagnostics"]): CanonicalEvent[] {
  const seen = new Set<string>();
  const telemetryOrigins = new Map<string, string>();
  const rejectedTelemetryLocations = new Set<string>();
  return events.filter((event) => {
    const telemetryId = event.attributes?.["pi.telemetry_event_id"];
    const location = event.source_ref?.location ?? event.event_id;
    if (typeof telemetryId === "string") {
      const firstLocation = telemetryOrigins.get(telemetryId);
      if (firstLocation && firstLocation !== location) {
        if (!rejectedTelemetryLocations.has(location)) {
          rejectedTelemetryLocations.add(location);
          diagnostics.push({
            level: "error",
            code: "telemetry-event-id-duplicate",
            location,
            message: `duplicate Pi telemetry event_id ${telemetryId}`,
          });
        }
        return false;
      }
      telemetryOrigins.set(telemetryId, location);
    }
    if (!seen.has(event.event_id)) {
      seen.add(event.event_id);
      return true;
    }
    diagnostics.push({
      level: "error",
      code: "canonical-event-id-duplicate",
      location: event.source_ref?.location ?? event.event_id,
      message: `duplicate Canonical Event id ${event.event_id}`,
    });
    return false;
  });
}

function summarizeToolInput(name: string, value: unknown): string {
  const input = record(value);
  if (!input) return summarize(value);
  const keys = name === "bash" ? ["command", "description"] : ["path", "file_path", "query", "prompt", "url"];
  for (const key of keys) if (key in input) return summarize(input[key]);
  return summarize(JSON.stringify(input));
}

function summarize(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.map((item) => summarize(record(item)?.text ?? item)).join(" ")
        : value === undefined || value === null
          ? ""
          : JSON.stringify(value);
  return raw.replace(/\s+/g, " ").trim().slice(0, 500);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  return typeof value?.[key] === "string" ? value[key] : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
