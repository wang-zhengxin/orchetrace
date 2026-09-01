import assert from "node:assert/strict";
import { appendFile, cp, mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";
import {
  AntigravityAutoDiscovery,
  discoverAntigravityTranscripts,
} from "../src/auto-discovery.ts";
import { AntigravityPassiveObserver } from "../src/passive-observer.ts";

const fixture = resolve(
  import.meta.dirname,
  "../../../fixtures/antigravity/root-transcript.jsonl",
);

class MemorySink implements AcknowledgedCanonicalEventSink {
  readonly events: CanonicalEvent[] = [];
  write(event: CanonicalEvent): void { this.events.push(event); }
  async whenIdle(): Promise<void> {}
}

test("incremental observer commits an ACK cursor and preserves pending tool correlation", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-antigravity-observer-"));
  const conversation = resolve(directory, "agy-session-12345678");
  const logs = resolve(conversation, ".system_generated/logs");
  await mkdir(logs, { recursive: true });
  const transcript = resolve(logs, "transcript.jsonl");
  await cp(fixture, transcript);
  const sink = new MemorySink();
  const observer = new AntigravityPassiveObserver(transcript, sink, {
    statePath: resolve(directory, "cursor.json"),
    sourceId: "antigravity-test",
  });
  assert((await observer.scanOnce()).emittedEvents > 0);
  assert.equal((await observer.scanOnce()).emittedEvents, 0);
  const before = sink.events.length;
  await appendFile(transcript, `${JSON.stringify({
    step_index: 7,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-08-31T06:00:08Z",
    content: "A later result.",
  })}\n`);
  assert((await observer.scanOnce()).emittedEvents > 0);
  assert(sink.events.length > before);
});

test("auto discovery finds only documented Antigravity transcript paths", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-antigravity-discovery-"));
  const brain = resolve(directory, "brain");
  const logs = resolve(brain, "agy-session-12345678/.system_generated/logs");
  await mkdir(logs, { recursive: true });
  await cp(fixture, resolve(logs, "transcript.jsonl"));
  assert.equal((await discoverAntigravityTranscripts(brain)).length, 1);
  const discovery = new AntigravityAutoDiscovery(new MemorySink(), {
    sessionsDir: brain,
    stateDir: resolve(directory, "state"),
    includeExisting: true,
  });
  const status = await discovery.scanOnce();
  assert.equal(status.observedSessions, 1);
  await discovery.stop();
});

test("a hook immediately attaches an old transcript outside the recency window", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-antigravity-hook-discovery-"));
  const brain = resolve(directory, "brain");
  const transcript = resolve(brain, "conversation-old/.system_generated/logs/transcript.jsonl");
  const hookEventsPath = resolve(directory, "hooks.jsonl");
  await mkdir(resolve(brain, "conversation-old/.system_generated/logs"), { recursive: true });
  await writeFile(transcript, `${JSON.stringify({
    step_index: 0,
    type: "USER_INPUT",
    status: "DONE",
    created_at: "2026-08-31T00:00:00Z",
    content: "old session",
  })}\n`);
  await utimes(transcript, new Date(0), new Date(0));
  await writeFile(hookEventsPath, `${JSON.stringify({
    hook_event_name: "PreInvocation",
    conversation_id: "conversation-old",
    transcript_path: transcript,
  })}\n`);

  const discovery = new AntigravityAutoDiscovery(new MemorySink(), {
    sessionsDir: brain,
    stateDir: resolve(directory, "state"),
    hookEventsPath,
    activeWithinMs: 1,
  });
  const first = await discovery.scanOnce();
  assert.equal(first.hookEvents, 1);
  assert.equal(first.observedSessions, 1);
  assert.deepEqual(discovery.observedPaths(), [transcript]);
  assert.equal((await discovery.scanOnce()).hookEvents, 0);
  await discovery.stop();
});
