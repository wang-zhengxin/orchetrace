import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  MemoryCanonicalEventSink,
  assertCanonicalLifecycleContract,
  verifyAdapterConformance,
} from "../src/index.ts";
import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";
import { syntheticAdapter } from "../../synthetic-adapter/src/index.ts";
import { claudeAdapter } from "../../claude-adapter/src/index.ts";
import { codexAdapter } from "../../codex-adapter/src/index.ts";
import { deepSeekHarnessAdapter } from "../../dsh-observer/src/index.ts";
import { piAdapter } from "../../pi-adapter/src/index.ts";
import { antigravityAdapter } from "../../antigravity-adapter/src/index.ts";

test("built-in adapters derive identity and capabilities from the central registry", () => {
  const plugins = [claudeAdapter, piAdapter, deepSeekHarnessAdapter, codexAdapter, antigravityAdapter];
  assert.deepEqual(plugins.map((plugin) => plugin.runtime), [
    "claude-code",
    "pi",
    "deepseek-harness",
    "codex",
    "antigravity",
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
    eventTypes: ["agent.spawned", "agent.status_changed", "session.discovered", "tool.started"],
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

  const decreasing = [
    { ...base, event_id: "sequence-2", source_seq: 2 },
    { ...base, event_id: "sequence-1", source_seq: 1 },
  ];
  assert.throws(() => verifyAdapterConformance(syntheticAdapter, decreasing), /must not decrease/);
});

test("lifecycle conformance rejects ambiguous terminal state", () => {
  const event = {
    schema_version: 1,
    event_id: "terminal-without-evidence",
    runtime: "synthetic-runtime",
    source_id: "fixture",
    session_id: "root",
    source_seq: 1,
    observed_at: "2026-01-01T00:00:00.000Z",
    type: "agent.outcome_recorded",
    data: { outcome: "succeeded" },
  } satisfies CanonicalEvent;
  assert.throws(() => assertCanonicalLifecycleContract(event), /data\.evidence/);
  assert.throws(
    () => assertCanonicalLifecycleContract({
      ...event,
      event_id: "invalid-status",
      type: "agent.status_changed",
      data: { status: "done" },
    }),
    /invalid activity status/,
  );
});

test("all built-in adapter fixtures satisfy the shared lifecycle contract", () => {
  const fixtures = [
    [claudeAdapter, "claude"],
    [piAdapter, "pi"],
    [deepSeekHarnessAdapter, "dsh"],
    [codexAdapter, "codex"],
    [antigravityAdapter, "antigravity"],
  ] as const;
  for (const [plugin, directory] of fixtures) {
    const path = resolve(import.meta.dirname, `../../../fixtures/${directory}/canonical-events.jsonl`);
    const events = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CanonicalEvent);
    const report = verifyAdapterConformance(plugin, events);
    assert(report.eventCount > 0, `${plugin.runtime} fixture must contain canonical events`);
    assert(report.sessionCount > 0, `${plugin.runtime} fixture must contain a session`);
  }
});
