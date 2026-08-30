import assert from "node:assert/strict";
import test from "node:test";

import { MemoryCanonicalEventSink, verifyAdapterConformance } from "../src/index.ts";
import { syntheticAdapter } from "../../synthetic-adapter/src/index.ts";
import { claudeAdapter } from "../../claude-adapter/src/index.ts";
import { codexAdapter } from "../../codex-adapter/src/index.ts";
import { deepSeekHarnessAdapter } from "../../dsh-observer/src/index.ts";
import { piAdapter } from "../../pi-adapter/src/index.ts";

test("built-in adapters derive identity and capabilities from the central registry", () => {
  const plugins = [claudeAdapter, piAdapter, deepSeekHarnessAdapter, codexAdapter];
  assert.deepEqual(plugins.map((plugin) => plugin.runtime), [
    "claude-code",
    "pi",
    "deepseek-harness",
    "codex",
  ]);
  assert(plugins.every((plugin) => plugin.descriptor.capabilities.includes("tools")));
});

test("external adapter can attach without changing the core runtime registry", async () => {
  const sink = new MemoryCanonicalEventSink();
  const observer = syntheticAdapter.create(sink, {});
  const result = await observer.start();
  assert.deepEqual(result, { emitted: 4 });

  const report = verifyAdapterConformance(syntheticAdapter, sink.events);
  assert.deepEqual(report, {
    runtime: "synthetic-runtime",
    eventCount: 4,
    sessionCount: 2,
    sourceCount: 1,
    eventTypes: ["agent.spawned", "session.discovered", "tool.started"],
  });
});

test("conformance rejects duplicate identities and non-monotonic source sequences", () => {
  const sink = new MemoryCanonicalEventSink();
  const base = {
    schema_version: 1,
    event_id: "duplicate",
    runtime: "synthetic-runtime",
    source_id: "fixture",
    session_id: "root",
    source_seq: 1,
    observed_at: "2026-01-01T00:00:00.000Z",
    type: "session.discovered",
    data: {},
  } as const;
  sink.write(base);
  sink.write({ ...base });
  assert.throws(() => verifyAdapterConformance(syntheticAdapter, sink.events), /duplicate event_id/);
});
