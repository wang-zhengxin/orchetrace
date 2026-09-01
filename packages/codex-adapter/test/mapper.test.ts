import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { loadCodexSession } from "../src/loader.ts";

const rootFixture = resolve(import.meta.dirname, "../../../fixtures/codex/root-rollout.jsonl");
const childFixture = resolve(import.meta.dirname, "../../../fixtures/codex/subagent-rollout.jsonl");

test("maps a Codex rollout into canonical task, tool, and terminal events", async () => {
  const result = await loadCodexSession(rootFixture, "codex-fixture");
  assert.equal(result.identity.sessionId, "codex-root");
  assert.equal(result.events.every((event) => event.runtime === "codex"), true);
  assert(result.events.some((event) => event.type === "session.discovered"));
  assert(result.events.some((event) => event.type === "tool.started" && event.data.call_id === "call-1"));
  assert(result.events.some((event) => event.type === "tool.finished" && event.data.call_id === "call-1"));
  assert(result.events.some((event) => event.type === "agent.outcome_recorded"));
  assert.deepEqual(
    result.events.find((event) => event.event_id.endsWith(":usage"))?.data.usage,
    {
      input_tokens: 1250,
      cached_input_tokens: 900,
      output_tokens: 75,
      reasoning_output_tokens: 15,
      total_tokens: 1325,
    },
  );
  assert.equal(result.events.filter((event) => event.type === "session.discovered").length, 1);
});

test("maps Codex thread_spawn metadata to a child Agent", async () => {
  const result = await loadCodexSession(childFixture, "codex-fixture");
  assert.equal(result.identity.sessionId, "codex-child");
  assert.equal(result.identity.parentSessionId, "codex-root");
  assert.equal(result.identity.label, "Ada");
  const spawned = result.events.find((event) => event.type === "agent.spawned");
  assert.equal(spawned?.parent_session_id, "codex-root");
  assert.equal(spawned?.data.role, "reviewer");
});
