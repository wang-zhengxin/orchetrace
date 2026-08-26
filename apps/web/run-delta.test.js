import assert from "node:assert/strict";
import test from "node:test";

import { applyRunSnapshotDelta } from "./run-delta.js";

function snapshot() {
  return {
    schema_version: 1,
    root_session_id: "root",
    runtimes: ["deepseek-harness"],
    event_count: 2,
    started_at: "2026-08-25T00:00:00Z",
    last_activity_at: "2026-08-25T00:00:01Z",
    agents: [
      { id: "root", label: "Root", tools: [] },
      { id: "child", label: "Child", tools: [] },
    ],
    edges: [{ parent_id: "root", child_id: "child", relation: "delegate", opaque: false }],
    timeline: [{ session_id: "root", at: "0", kind: "spawn", label: "root" }],
  };
}

function delta() {
  return {
    schema_version: 1,
    run_id: "run",
    base_event_count: 2,
    target_event_count: 3,
    root_session_id: "root",
    runtimes: ["deepseek-harness"],
    started_at: "2026-08-25T00:00:00Z",
    last_activity_at: "2026-08-25T00:00:02Z",
    upserted_agents: [{ id: "child", label: "Child running", tools: [{ call_id: "call-1" }] }],
    removed_agent_ids: [],
    agent_order: null,
    edges: null,
    timeline: {
      replace_from: 1,
      entries: [{ session_id: "child", at: "2", kind: "tool", label: "Read" }],
    },
  };
}

test("applies changed agents and a deterministic timeline suffix", () => {
  const result = applyRunSnapshotDelta(snapshot(), delta());
  assert.equal(result.event_count, 3);
  assert.equal(result.agents[0].label, "Root");
  assert.equal(result.agents[1].label, "Child running");
  assert.equal(result.agents[1].tools[0].call_id, "call-1");
  assert.equal(result.timeline.length, 2);
  assert.equal(result.timeline[1].label, "Read");
});

test("rejects a delta when the browser missed its base revision", () => {
  const stale = snapshot();
  stale.event_count = 1;
  assert.equal(applyRunSnapshotDelta(stale, delta()), null);
});

test("applies topology replacement and removes agents", () => {
  const change = delta();
  change.removed_agent_ids = ["child"];
  change.upserted_agents = [];
  change.agent_order = ["root"];
  change.edges = [];
  const result = applyRunSnapshotDelta(snapshot(), change);
  assert.deepEqual(result.agents.map((agent) => agent.id), ["root"]);
  assert.deepEqual(result.edges, []);
});

test("rejects an invalid agent order instead of corrupting local state", () => {
  const change = delta();
  change.agent_order = ["root", "missing"];
  assert.equal(applyRunSnapshotDelta(snapshot(), change), null);
});
