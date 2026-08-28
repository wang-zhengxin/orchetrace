import assert from "node:assert/strict";
import test from "node:test";
import { agentEventsAtTime, snapshotAtTime, timelineBounds } from "./time-travel.js";

const snapshot = {
  root_session_id: "root",
  started_at: "2026-08-25T00:00:00.000Z",
  last_activity_at: "2026-08-25T00:00:10.000Z",
  agents: [
    {
      id: "root",
      parent_id: null,
      status: "idle",
      outcome: null,
      started_at: "2026-08-25T00:00:00.000Z",
      last_activity_at: "2026-08-25T00:00:10.000Z",
      activations: [{ id: "a", started_at: "2026-08-25T00:00:01.000Z", ended_at: "2026-08-25T00:00:09.000Z", end_status: "idle" }],
      tools: [],
    },
    {
      id: "child",
      parent_id: "root",
      status: "inactive",
      outcome: "succeeded",
      outcome_evidence: "result",
      started_at: "2026-08-25T00:00:04.000Z",
      last_activity_at: "2026-08-25T00:00:08.000Z",
      activations: [{ id: "b", started_at: "2026-08-25T00:00:04.100Z", ended_at: "2026-08-25T00:00:08.000Z", end_status: "inactive" }],
      tools: [{ call_id: "t", name: "Read", started_at: "2026-08-25T00:00:05.000Z", ended_at: "2026-08-25T00:00:07.000Z", outcome: "succeeded", duration_ms: 2000, input_summary: "src", output_summary: "ok" }],
    },
  ],
  edges: [{ parent_id: "root", child_id: "child" }],
  timeline: [
    { session_id: "root", at: "2026-08-25T00:00:01.000Z", kind: "activation", label: "activation started", outcome: null },
    { session_id: "child", at: "2026-08-25T00:00:04.000Z", kind: "spawn", label: "child", outcome: null },
    { session_id: "child", at: "2026-08-25T00:00:04.200Z", kind: "prompt", label: "Inspect code", outcome: null },
    { session_id: "child", at: "2026-08-25T00:00:05.000Z", kind: "tool", label: "Read", outcome: null },
    { session_id: "child", at: "2026-08-25T00:00:07.000Z", kind: "tool-result", label: "Read", outcome: "succeeded" },
    { session_id: "child", at: "2026-08-25T00:00:08.000Z", kind: "outcome", label: "agent outcome", outcome: "succeeded" },
  ],
};

test("timeline bounds use actual run timestamps", () => {
  assert.deepEqual(timelineBounds(snapshot), {
    start: Date.parse("2026-08-25T00:00:00.000Z"),
    end: Date.parse("2026-08-25T00:00:10.000Z"),
    span: 10_000,
  });
});

test("future agents and state are absent at the cursor", () => {
  const view = snapshotAtTime(snapshot, Date.parse("2026-08-25T00:00:03.000Z"));
  assert.deepEqual(view.agents.map((agent) => agent.id), ["root"]);
  assert.equal(view.edges.length, 0);
  assert.equal(view.agents[0].status, "running");
});

test("in-flight tools do not leak their future result", () => {
  const view = snapshotAtTime(snapshot, Date.parse("2026-08-25T00:00:06.000Z"));
  const child = view.agents.find((agent) => agent.id === "child");
  assert.equal(child.status, "running");
  assert.equal(child.current_tool, "Read");
  assert.equal(child.last_activity_at, "2026-08-25T00:00:06.000Z");
  assert.equal(child.tools[0].ended_at, null);
  assert.equal(child.tools[0].output_summary, null);
  assert.equal(child.outcome, null);
});

test("settled outcome and tool evidence appear after their event", () => {
  const view = snapshotAtTime(snapshot, Date.parse("2026-08-25T00:00:08.500Z"));
  const child = view.agents.find((agent) => agent.id === "child");
  assert.equal(child.outcome, "succeeded");
  assert.equal(child.tools[0].output_summary, "ok");
  const events = agentEventsAtTime(snapshot, "child", Date.parse("2026-08-25T00:00:08.500Z"));
  assert.equal(events.find((item) => item.kind === "tool").input_summary, "src");
  assert.equal(events.find((item) => item.kind === "tool-result").output_summary, "ok");
});
