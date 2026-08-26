import assert from "node:assert/strict";
import test from "node:test";

import { mapDshRecord } from "../src/mapper.ts";

test("session-backed child maps to discovery and spawn facts", () => {
  const events = mapDshRecord({
    kind: "session_announced",
    sourceId: "local",
    header: {
      id: "child",
      parentSession: "root",
      cwd: "/workspace/demo",
      createdAt: Date.parse("2026-08-25T08:00:00Z"),
      origin: "subagent",
      delegationDepth: 1,
    },
    descriptor: {
      mode: "continuable",
      label: "researcher",
      provider: "deepseek",
      model: "DeepSeek-V4",
    },
  });

  assert.equal(events.length, 2);
  assert.equal(events[1].type, "agent.spawned");
  assert.equal(events[1].parent_session_id, "root");
  assert.equal(events[1].data.mode, "continuable");
});

test("tool call and result preserve the stable call id", () => {
  const call = mapDshRecord({
    kind: "session_event",
    sourceId: "local",
    sessionId: "child",
    event: {
      seq: 4,
      time: Date.parse("2026-08-25T08:00:01Z"),
      type: "tool/call",
      data: { callId: "call-7", name: "bash", arguments: { command: "cargo test" } },
    },
  })[0];
  const result = mapDshRecord({
    kind: "session_event",
    sourceId: "local",
    sessionId: "child",
    event: {
      seq: 5,
      time: Date.parse("2026-08-25T08:00:02Z"),
      type: "tool/result",
      data: { callId: "call-7", name: "bash", isError: true, content: "failed" },
    },
  })[0];

  assert.equal(call.type, "tool.started");
  assert.equal(result.type, "tool.finished");
  assert.equal(call.data.call_id, result.data.call_id);
  assert.equal(result.data.outcome, "failed");
});

test("unknown required event refuses silent data loss", () => {
  assert.throws(
    () =>
      mapDshRecord({
        kind: "session_event",
        sourceId: "local",
        sessionId: "root",
        event: { seq: 9, time: 0, type: "future/required", data: {} },
      }),
    /unsupported required DSH event/,
  );
});

test("durable subagent descriptor maps to an identity update", () => {
  const [event] = mapDshRecord({
    kind: "session_event",
    sourceId: "local",
    sessionId: "child",
    parentSessionId: "root",
    event: {
      seq: 3,
      time: 1,
      type: "subagent/descriptor",
      data: {
        version: 2,
        mode: "continuable",
        provider: "builtin",
        label: "reviewer",
        agentProvider: "deepseek",
        agentModel: "deepseek-v4",
      },
    },
  });
  assert.equal(event.type, "session.metadata_changed");
  assert.equal(event.data.label, "reviewer");
  assert.equal(event.data.model, "deepseek-v4");
});
