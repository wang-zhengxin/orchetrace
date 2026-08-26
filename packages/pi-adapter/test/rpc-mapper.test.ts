import assert from "node:assert/strict";
import test from "node:test";

import { PiRpcMapper } from "../src/rpc-mapper.ts";

const at = (second: number) => `2026-08-26T02:00:0${second}.000Z`;

test("agent_end does not settle an activation; agent_settled does", () => {
  const mapper = new PiRpcMapper({ sourceId: "rpc", sessionId: "pi-session" });
  const started = mapper.map({ type: "agent_start" }, at(0));
  const lowLevelEnd = mapper.map({ type: "agent_end", messages: [], willRetry: true }, at(1));
  const settled = mapper.map({ type: "agent_settled" }, at(2));
  assert.equal(started[0]?.type, "agent.activation_started");
  assert.equal(lowLevelEnd[0]?.type, "agent.status_changed");
  assert.equal(lowLevelEnd[0]?.data.status, "waiting");
  assert.equal(settled[0]?.type, "agent.activation_ended");
  assert.equal(settled[0]?.data.status, "idle");
  assert.equal([...started, ...lowLevelEnd, ...settled].some((event) => event.type === "agent.outcome_recorded"), false);
});

test("RPC tool lifecycle preserves toolCallId and authoritative failure", () => {
  const mapper = new PiRpcMapper({ sourceId: "rpc", sessionId: "pi-session" });
  const started = mapper.map(
    { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "false" } },
    at(0),
  );
  const progressed = mapper.map(
    {
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "running" }] },
    },
    at(1),
  );
  const ended = mapper.map(
    {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "exit 1" }] },
      isError: true,
    },
    at(2),
  );
  assert.deepEqual(
    [started[0]?.type, progressed[0]?.type, ended[0]?.type],
    ["tool.started", "tool.progressed", "tool.finished"],
  );
  assert.equal(ended[0]?.data.call_id, "call-1");
  assert.equal(ended[0]?.data.outcome, "failed");
});

test("aborted RPC compaction does not claim context was compacted", () => {
  const mapper = new PiRpcMapper({ sourceId: "rpc", sessionId: "pi-session" });
  assert.deepEqual(mapper.map({ type: "compaction_end", reason: "manual", aborted: true }, at(0)), []);
  const completed = mapper.map(
    {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      result: { summary: "summary", firstKeptEntryId: "e2", tokensBefore: 150000 },
    },
    at(1),
  );
  assert.equal(completed[0]?.type, "context.compacted");
  assert.equal(completed[0]?.data.first_kept_entry_id, "e2");
});
