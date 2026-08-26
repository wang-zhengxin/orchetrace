import type {
  CanonicalEvent,
  CanonicalEventType,
  TerminalOutcome,
} from "../../protocol-ts/src/index.ts";
import type {
  ClaudeAgentSource,
  ClaudeDiagnostic,
  ParsedLine,
  TerminalFact,
} from "./types.ts";

interface SourceBounds {
  first: string;
  last: string;
  model?: string;
}

interface ToolResultFact {
  at: string;
  failed: boolean;
}

export interface ClaudeMapOptions {
  mode?: "replay" | "live";
  eventEpoch?: number;
}

const FALLBACK_TIME = "1970-01-01T00:00:00.000Z";

export function mapClaudeSources(
  sources: ClaudeAgentSource[],
  sourceId: string,
  diagnostics: ClaudeDiagnostic[],
  options: ClaudeMapOptions = {},
): CanonicalEvent[] {
  if (options.mode === "live") {
    const activeIds = new Set(
      sources
        .filter((source) => source.lines.length > 0 && source.kind !== "workflow-group")
        .map((source) => source.id),
    );
    sources = sources.filter(
      (source) =>
        activeIds.has(source.id) ||
        (source.kind === "workflow-group" && sources.some((child) => child.parentId === source.id && activeIds.has(child.id))),
    );
  }
  const byId = new Map(sources.map((source) => [source.id, source]));
  const root = sources.find((source) => source.kind === "root");
  if (!root && options.mode === "live") return [];
  if (!root) throw new Error("Claude session has no root transcript source");
  const bounds = new Map<string, SourceBounds>();
  for (const source of sources) {
    if (source.kind === "workflow-group") continue;
    bounds.set(source.id, sourceBounds(source, diagnostics));
  }
  for (const group of sources.filter((source) => source.kind === "workflow-group")) {
    const childBounds = sources
      .filter((source) => source.parentId === group.id)
      .map((source) => bounds.get(source.id))
      .filter((value): value is SourceBounds => Boolean(value));
    bounds.set(group.id, {
      first: childBounds.map((item) => item.first).sort()[0] ?? bounds.get(root.id)?.first ?? FALLBACK_TIME,
      last: childBounds.map((item) => item.last).sort().at(-1) ?? bounds.get(root.id)?.last ?? FALLBACK_TIME,
    });
  }

  const events: CanonicalEvent[] = [];
  const mainToolResults = new Map<string, ToolResultFact>();
  const terminalFacts = new Map<string, TerminalFact>();
  const toolNames = new Map<string, string>();

  for (const source of sources) {
    const timing = bounds.get(source.id) ?? {
      first: bounds.get(root.id)?.first ?? FALLBACK_TIME,
      last: bounds.get(root.id)?.last ?? FALLBACK_TIME,
    };
    const identity = compact({
      label: source.label,
      role: source.role,
      mode:
        source.kind === "root"
          ? "root"
          : source.kind === "workflow-group"
            ? "remote"
            : source.role === "fork"
              ? "continuable"
              : "one-shot",
      provider: "anthropic",
      model: timing.model,
      detail_level: source.kind === "workflow-group" ? "partial" : "full",
      origin: source.kind,
      workflow_id: source.workflowId,
      spawned_by_tool_use: source.toolUseId,
    });
    events.push(
      canonicalEvent({
        sourceId,
        source,
        at: timing.first,
        sequence: 0,
        suffix: "identity",
        type: "session.discovered",
        data: identity,
        sourceKind: source.kind === "workflow-group" ? "workflow-directory" : "transcript",
        location: `${source.id}#identity`,
      }),
    );
    if (source.parentId) {
      events.push(
        canonicalEvent({
          sourceId,
          source,
          at: timing.first,
          sequence: 1,
          suffix: "spawn",
          type: "agent.spawned",
          data: identity,
          sourceKind: source.kind === "workflow-group" ? "workflow-directory" : "subagent-meta",
          location: `${source.id}#spawn`,
        }),
      );
    }
    events.push(
      canonicalEvent({
        sourceId,
        source,
        at: timing.first,
        sequence: 2,
        suffix: "activation-start",
        type: "agent.activation_started",
        data: { activation_id: `transcript:${source.id}` },
        sourceKind: "transcript",
        location: `${source.id}#start`,
      }),
    );

    if (source.kind !== "workflow-group") {
      for (const line of source.lines) {
        mapLine({
          source,
          rootId: root.id,
          line,
          sourceId,
          events,
          diagnostics,
          mainToolResults,
          terminalFacts,
          toolNames,
          byId,
        });
      }
    }
    if (options.mode !== "live") {
      events.push(
        canonicalEvent({
          sourceId,
          source,
          at: timing.last,
          sequence: 900_000_000,
          suffix: "activation-end",
          type: "agent.activation_ended",
          data: {
            activation_id: `transcript:${source.id}`,
            status: source.kind === "root" ? "idle" : "inactive",
          },
          sourceKind: "transcript",
          location: `${source.id}#end`,
        }),
      );
    }
  }

  for (const source of sources) {
    if (source.kind !== "direct" || !source.toolUseId) continue;
    const result = mainToolResults.get(source.toolUseId);
    const last = bounds.get(source.id)?.last;
    if (!result || !last || result.at < last) continue;
    recordTerminal(terminalFacts, source.id, {
      at: result.at,
      outcome: result.failed ? "failed" : "succeeded",
      evidence: `main transcript tool_result for ${source.toolUseId}`,
      priority: 1,
    });
  }

  for (const group of sources.filter((source) => source.kind === "workflow-group")) {
    for (const line of group.lines) {
      if (line.value.type !== "result") continue;
      const agentId = stringField(line.value, "agentId");
      if (!agentId || !byId.has(agentId)) {
        diagnostics.push({
          level: "warning",
          code: "journal-agent-missing",
          location: line.location,
          message: "workflow journal result does not name a discovered agent",
        });
        continue;
      }
      const result = asRecord(line.value.result);
      const failed = Boolean(result?.error) || result?.status === "failed";
      recordTerminal(terminalFacts, agentId, {
        at: bounds.get(agentId)?.last ?? bounds.get(group.id)?.last ?? FALLBACK_TIME,
        outcome: failed ? "failed" : "succeeded",
        evidence: `workflow journal result in ${group.workflowId ?? group.id}`,
        priority: 2,
      });
    }
  }

  for (const group of sources.filter((source) => source.kind === "workflow-group")) {
    const children = sources.filter((source) => source.parentId === group.id);
    const facts = children.map((child) => terminalFacts.get(child.id));
    if (children.length > 0 && facts.every(Boolean)) {
      recordTerminal(terminalFacts, group.id, {
        at: bounds.get(group.id)?.last ?? FALLBACK_TIME,
        outcome: facts.some((fact) => fact?.outcome === "failed") ? "failed" : "succeeded",
        evidence: "all workflow journal children reached a terminal result",
        priority: 2,
      });
    }
  }

  for (const [agentId, fact] of terminalFacts) {
    const source = byId.get(agentId);
    if (!source) continue;
    events.push(
      canonicalEvent({
        sourceId,
        source,
        at: fact.at,
        sequence: 950_000_000 + fact.priority,
        suffix: `outcome-${fact.priority}-${fact.outcome}-${encodeURIComponent(fact.at)}`,
        type: "agent.outcome_recorded",
        data: { outcome: fact.outcome, evidence: fact.evidence, evidence_priority: fact.priority },
        sourceKind: "completion-evidence",
        location: `${source.id}#outcome`,
      }),
    );
    if (options.mode === "live") {
      events.push(
        canonicalEvent({
          sourceId,
          source,
          at: fact.at,
          sequence: 960_000_000 + fact.priority,
          suffix: `activation-terminal-${fact.priority}-${fact.outcome}-${encodeURIComponent(fact.at)}`,
          type: "agent.activation_ended",
          data: {
            activation_id: `transcript:${source.id}`,
            status: "inactive",
            evidence: fact.evidence,
          },
          sourceKind: "completion-evidence",
          location: `${source.id}#terminal`,
        }),
      );
    }
  }

  if (options.eventEpoch !== undefined) {
    for (const event of events) event.event_id = `${event.event_id}:epoch-${options.eventEpoch}`;
  }

  return events.sort((left, right) =>
    [left.occurred_at ?? left.observed_at, left.source_id, left.session_id, left.source_seq, left.event_id]
      .join("\u0000")
      .localeCompare(
        [right.occurred_at ?? right.observed_at, right.source_id, right.session_id, right.source_seq, right.event_id].join(
          "\u0000",
        ),
      ),
  );
}

function mapLine(input: {
  source: ClaudeAgentSource;
  rootId: string;
  line: ParsedLine;
  sourceId: string;
  events: CanonicalEvent[];
  diagnostics: ClaudeDiagnostic[];
  mainToolResults: Map<string, ToolResultFact>;
  terminalFacts: Map<string, TerminalFact>;
  toolNames: Map<string, string>;
  byId: Map<string, ClaudeAgentSource>;
}): void {
  const { source, line, sourceId, events, diagnostics } = input;
  const type = stringField(line.value, "type");
  const at = timestamp(line.value);
  const sequenceBase = line.line * 100;
  if (!type) {
    diagnostics.push({
      level: "error",
      code: "entry-type-missing",
      location: line.location,
      message: "Claude transcript line has no string type",
    });
    return;
  }
  if (!at && ["user", "assistant", "system", "attachment"].includes(type)) {
    diagnostics.push({
      level: "warning",
      code: "entry-time-missing",
      location: line.location,
      message: `timed Claude entry ${type} has no valid timestamp`,
    });
  }
  const occurredAt = at ?? FALLBACK_TIME;
  const push = (
    suffix: string,
    offset: number,
    canonicalType: CanonicalEventType,
    data: Record<string, unknown>,
  ) =>
    events.push(
      canonicalEvent({
        sourceId,
        source,
        at: occurredAt,
        sequence: sequenceBase + offset,
        suffix: `${line.line}-${suffix}`,
        type: canonicalType,
        data: compact(data),
        sourceKind: source.kind === "root" ? "main-transcript" : "subagent-transcript",
        location: line.location,
      }),
    );

  if (type === "assistant") {
    const message = asRecord(line.value.message);
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const texts: string[] = [];
    const thoughts: string[] = [];
    let offset = 0;
    for (const blockValue of blocks) {
      const block = asRecord(blockValue);
      const blockType = stringField(block, "type");
      if (blockType === "text") texts.push(stringField(block, "text") ?? "");
      else if (blockType === "thinking") thoughts.push(stringField(block, "thinking") ?? "");
      else if (blockType === "tool_use") {
        const callId = stringField(block, "id");
        const name = stringField(block, "name");
        if (!callId || !name) {
          diagnostics.push({
            level: "error",
            code: "tool-use-invalid",
            location: line.location,
            message: "tool_use block requires string id and name",
          });
          continue;
        }
        push(`tool-${offset}`, 20 + offset, "tool.started", {
          call_id: callId,
          name,
          input_summary: summarizeToolInput(name, block.input),
        });
        input.toolNames.set(`${source.id}\u0000${callId}`, name);
        offset += 1;
      } else if (blockType) {
        diagnostics.push({
          level: "warning",
          code: "content-block-unknown",
          location: line.location,
          message: `unsupported assistant content block ${blockType}`,
        });
      }
    }
    const summary = summarizeText(texts.join(" "));
    if (summary) push("message", 10, "assistant.message", { summary, usage: message?.usage });
    const reasoning = summarizeText(thoughts.join(" "));
    if (reasoning) push("reasoning", 11, "assistant.reasoning_summary", { summary: reasoning });
    return;
  }

  if (type === "user") {
    const message = asRecord(line.value.message);
    const content = message?.content;
    if (typeof content === "string") {
      const notification = parseTaskNotification(content);
      if (notification) {
        const target = input.byId.get(notification.agentId);
        if (target && notification.outcome) {
          recordTerminal(input.terminalFacts, notification.agentId, {
            at: occurredAt,
            outcome: notification.outcome,
            evidence: `Claude task-notification reported ${notification.status}`,
            priority: 3,
          });
        } else if (target) {
          diagnostics.push({
            level: "warning",
            code: "notification-status-unknown",
            location: line.location,
            message: `task-notification has unsupported status ${notification.status}`,
          });
        } else {
          diagnostics.push({
            level: "warning",
            code: "notification-agent-missing",
            location: line.location,
            message: `task-notification references unknown agent ${notification.agentId}`,
          });
        }
      } else {
        const origin = stringField(asRecord(line.value.origin), "kind");
        const human = source.id === input.rootId ? origin === undefined || origin === "human" : true;
        if (human) {
          push("prompt", 10, "prompt.accepted", {
            excerpt: summarizeText(content),
            source: source.id === input.rootId ? "user" : "delegation",
          });
        }
      }
    }
    if (Array.isArray(content)) {
      let offset = 0;
      for (const blockValue of content) {
        const block = asRecord(blockValue);
        if (stringField(block, "type") !== "tool_result") continue;
        const callId = stringField(block, "tool_use_id");
        if (!callId) {
          diagnostics.push({
            level: "error",
            code: "tool-result-invalid",
            location: line.location,
            message: "tool_result block requires tool_use_id",
          });
          continue;
        }
        const failed = block.is_error === true;
        push(`tool-result-${offset}`, 20 + offset, "tool.finished", {
          call_id: callId,
          name: input.toolNames.get(`${source.id}\u0000${callId}`) ?? "tool",
          outcome: failed ? "failed" : "succeeded",
          output_summary: summarizeText(block.content),
        });
        if (source.id === input.rootId) input.mainToolResults.set(callId, { at: occurredAt, failed });
        offset += 1;
      }
    }
    return;
  }

  if (
    ![
      "ai-title",
      "last-prompt",
      "mode",
      "permission-mode",
      "file-history-snapshot",
      "queue-operation",
      "system",
      "attachment",
      "started",
      "result",
      "summary",
    ].includes(type)
  ) {
    diagnostics.push({
      level: "warning",
      code: "entry-type-unknown",
      location: line.location,
      message: `unsupported Claude transcript entry type ${type}`,
    });
  }
}

function sourceBounds(source: ClaudeAgentSource, diagnostics: ClaudeDiagnostic[]): SourceBounds {
  const times = source.lines.map((line) => timestamp(line.value)).filter((value): value is string => Boolean(value));
  const models = source.lines
    .map((line) => stringField(asRecord(line.value.message), "model"))
    .filter((value): value is string => Boolean(value));
  if (times.length === 0) {
    diagnostics.push({
      level: "warning",
      code: "source-time-missing",
      location: source.id,
      message: "source has no valid timestamp; deterministic epoch fallback is used",
    });
  }
  times.sort();
  return { first: times[0] ?? FALLBACK_TIME, last: times.at(-1) ?? FALLBACK_TIME, model: models[0] };
}

function canonicalEvent(input: {
  sourceId: string;
  source: ClaudeAgentSource;
  at: string;
  sequence: number;
  suffix: string;
  type: CanonicalEventType;
  data: Record<string, unknown>;
  sourceKind: string;
  location: string;
}): CanonicalEvent {
  return {
    schema_version: 1,
    event_id: `claude:${encodeURIComponent(input.sourceId)}:${encodeURIComponent(input.source.id)}:${input.suffix}`,
    runtime: "claude-code",
    source_id: input.sourceId,
    session_id: input.source.id,
    ...(input.source.parentId ? { parent_session_id: input.source.parentId } : {}),
    source_seq: input.sequence,
    observed_at: input.at,
    occurred_at: input.at,
    type: input.type,
    data: input.data,
    source_ref: { kind: input.sourceKind, location: input.location },
  };
}

function recordTerminal(facts: Map<string, TerminalFact>, agentId: string, fact: TerminalFact): void {
  const existing = facts.get(agentId);
  if (!existing || fact.priority > existing.priority || (fact.priority === existing.priority && fact.at > existing.at)) {
    facts.set(agentId, fact);
  }
}

function parseTaskNotification(
  text: string,
): { agentId: string; status: string; outcome?: TerminalOutcome } | undefined {
  if (!text.trimStart().startsWith("<task-notification>")) return undefined;
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
  const agentId = tag("task-id");
  const status = tag("status");
  if (!agentId || !status) return undefined;
  const outcome: TerminalOutcome | undefined =
    status === "completed"
      ? "succeeded"
      : status === "stopped"
        ? "interrupted"
        : status === "failed" || status === "error"
          ? "failed"
          : undefined;
  return { agentId, status, outcome };
}

function timestamp(value: Record<string, unknown>): string | undefined {
  const raw = stringField(value, "timestamp");
  if (!raw || !Number.isFinite(Date.parse(raw))) return undefined;
  return new Date(raw).toISOString();
}

function summarizeToolInput(name: string, value: unknown): string {
  const input = asRecord(value);
  if (!input) return summarizeText(value);
  const keys =
    name === "Bash"
      ? ["command", "description"]
      : ["description", "file_path", "path", "query", "prompt", "url"];
  for (const key of keys) {
    if (key in input) return summarizeText(input[key]);
  }
  return summarizeText(JSON.stringify(input));
}

function summarizeText(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.map((item) => summarizeText(asRecord(item)?.text ?? item)).join(" ")
        : value === undefined || value === null
          ? ""
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
  const flattened = raw.replace(/\s+/g, " ").trim();
  return flattened.length > 200 ? `${flattened.slice(0, 199)}…` : flattened;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const item = value?.[key];
  return typeof item === "string" ? item : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
