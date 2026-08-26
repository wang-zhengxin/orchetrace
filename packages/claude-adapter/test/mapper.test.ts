import assert from "node:assert/strict";
import test from "node:test";

import { mapClaudeSources } from "../src/mapper.ts";
import type { ClaudeAgentSource, ParsedLine } from "../src/types.ts";

function line(lineNumber: number, value: Record<string, unknown>): ParsedLine {
  return { line: lineNumber, location: `fixture#${lineNumber}`, value };
}

function sources(notification?: string, resultAt = "2026-08-25T00:00:01Z"): ClaudeAgentSource[] {
  const rootLines = [
    line(1, {
      type: "assistant",
      timestamp: "2026-08-25T00:00:00Z",
      message: {
        model: "claude-opus-4-1",
        content: [{ type: "tool_use", id: "spawn", name: "Task", input: {} }],
      },
    }),
    line(2, {
      type: "user",
      timestamp: resultAt,
      message: { content: [{ type: "tool_result", tool_use_id: "spawn", content: "ack" }] },
    }),
  ];
  if (notification) {
    rootLines.push(
      line(3, {
        type: "user",
        timestamp: "2026-08-25T00:00:04Z",
        message: { content: notification },
      }),
    );
  }
  return [
    { id: "root", kind: "root", label: "Root", lines: rootLines },
    {
      id: "child",
      parentId: "root",
      kind: "direct",
      label: "Child",
      toolUseId: "spawn",
      lines: [
        line(1, {
          type: "assistant",
          timestamp: "2026-08-25T00:00:02Z",
          message: { model: "claude-sonnet-4", content: [{ type: "text", text: "working" }] },
        }),
      ],
    },
  ];
}

test("does not treat an immediate spawn ack as child completion", () => {
  const events = mapClaudeSources(sources(), "fixture", []);
  assert.equal(
    events.some(
      (event) => event.session_id === "child" && event.type === "agent.outcome_recorded",
    ),
    false,
  );
});

test("task notification terminal evidence outranks a later successful tool result", () => {
  const notification = `<task-notification>
<task-id>child</task-id>
<status>stopped</status>
</task-notification>`;
  const events = mapClaudeSources(sources(notification, "2026-08-25T00:00:05Z"), "fixture", []);
  const outcome = events.find(
    (event) => event.session_id === "child" && event.type === "agent.outcome_recorded",
  );
  assert.equal(outcome?.data.outcome, "interrupted");
  assert.match(String(outcome?.data.evidence), /task-notification/);
});

test("live terminal revisions have distinct ids and explicit evidence priorities", () => {
  const weak = mapClaudeSources(sources(undefined, "2026-08-25T00:00:05Z"), "fixture", [], {
    mode: "live",
    eventEpoch: 0,
  }).find((event) => event.session_id === "child" && event.type === "agent.outcome_recorded");
  const notification = `<task-notification>
<task-id>child</task-id>
<status>stopped</status>
</task-notification>`;
  const strong = mapClaudeSources(sources(notification, "2026-08-25T00:00:05Z"), "fixture", [], {
    mode: "live",
    eventEpoch: 0,
  }).find((event) => event.session_id === "child" && event.type === "agent.outcome_recorded");
  assert.equal(weak?.data.evidence_priority, 1);
  assert.equal(strong?.data.evidence_priority, 3);
  assert.notEqual(weak?.event_id, strong?.event_id);
});
