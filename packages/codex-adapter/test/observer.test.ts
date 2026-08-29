import assert from "node:assert/strict";
import { appendFile, cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";
import { CodexAutoDiscovery, discoverCodexTranscripts } from "../src/auto-discovery.ts";
import { CodexPassiveObserver } from "../src/passive-observer.ts";

const fixture = resolve(import.meta.dirname, "../../../fixtures/codex/root-rollout.jsonl");

class MemorySink implements AcknowledgedCanonicalEventSink {
  readonly events: CanonicalEvent[] = [];
  write(event: CanonicalEvent): void { this.events.push(event); }
  async whenIdle(): Promise<void> {}
}

test("incremental observer advances only complete lines and does not replay committed events", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-codex-observer-"));
  const transcript = resolve(directory, "rollout-test.jsonl");
  await cp(fixture, transcript);
  const sink = new MemorySink();
  const observer = new CodexPassiveObserver(transcript, sink, {
    statePath: resolve(directory, "cursor.json"),
    sourceId: "codex-test",
  });
  const initial = await observer.scanOnce();
  assert(initial.emittedEvents > 0);
  assert.equal((await observer.scanOnce()).emittedEvents, 0);
  const before = sink.events.length;
  await appendFile(transcript, `${JSON.stringify({
    timestamp: "2026-08-30T01:00:03.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "A later update." },
  })}\n`);
  assert.equal((await observer.scanOnce()).emittedEvents, 1);
  assert.equal(sink.events.length, before + 1);
});

test("auto discovery finds nested Codex rollout files and attaches observers", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-codex-discovery-"));
  const sessions = resolve(directory, "sessions");
  const nested = resolve(sessions, "2026/08/30");
  await mkdir(nested, { recursive: true });
  await cp(fixture, resolve(nested, "rollout-test.jsonl"));
  assert.equal((await discoverCodexTranscripts(sessions)).length, 1);
  const discovery = new CodexAutoDiscovery(new MemorySink(), {
    sessionsDir: sessions,
    stateDir: resolve(directory, "state"),
    includeExisting: true,
  });
  const status = await discovery.scanOnce();
  assert.equal(status.observedSessions, 1);
  await discovery.stop();
});
