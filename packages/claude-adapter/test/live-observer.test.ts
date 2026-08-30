import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";
import { ClaudeIncrementalSourceCache } from "../src/loader.ts";
import { ClaudeLiveObserver } from "../src/live-observer.ts";

class RecordingSink implements AcknowledgedCanonicalEventSink {
  readonly events: CanonicalEvent[] = [];
  idleFailures = 0;

  write(event: CanonicalEvent): void {
    this.events.push(event);
  }

  async whenIdle(): Promise<void> {
    if (this.idleFailures > 0) {
      this.idleFailures -= 1;
      throw new Error("simulated ACK timeout");
    }
  }
}

const userLine = (content: string, timestamp: string) =>
  JSON.stringify({ type: "user", timestamp, message: { content } });
const assistantLine = (content: string, timestamp: string) =>
  JSON.stringify({
    type: "assistant",
    timestamp,
    message: { model: "claude-sonnet-4", content: [{ type: "text", text: content }] },
  });

test("incremental source cache reads only appended Claude bytes", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-claude-cache-"));
  const transcript = resolve(directory, "session.jsonl");
  try {
    const initialText = `${userLine("x".repeat(16_384), "2026-08-26T00:00:00Z")}\n`;
    await writeFile(transcript, initialText);
    const cache = new ClaudeIncrementalSourceCache(transcript);
    const initial = await cache.load({ sourceId: "cache-test" });
    assert.equal(initial.bytesRead, Buffer.byteLength(initialText));
    assert.equal(initial.sources[0].lines.length, 1);

    const appendText = `${assistantLine("small append", "2026-08-26T00:00:01Z")}\n`;
    await appendFile(transcript, appendText);
    const appended = await cache.load({ sourceId: "cache-test" });
    assert.equal(appended.bytesRead, Buffer.byteLength(appendText));
    assert.equal(appended.sources[0].lines.length, 2);

    const unchanged = await cache.load({ sourceId: "cache-test" });
    assert.equal(unchanged.bytesRead, 0);
    assert.equal(unchanged.sources[0].lines.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("append emits only new facts and restart resumes from the persisted cursor", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-claude-live-"));
  const transcript = resolve(directory, "session.jsonl");
  const statePath = resolve(directory, "cursor.json");
  try {
    await writeFile(transcript, `${userLine("first", "2026-08-26T00:00:00Z")}\n`);
    const sink = new RecordingSink();
    const observer = new ClaudeLiveObserver(transcript, sink, { statePath, sourceId: "live-test" });
    const initial = await observer.scanOnce();
    assert(initial.emittedEvents >= 3);
    const initialCount = sink.events.length;

    await appendFile(transcript, `${assistantLine("second", "2026-08-26T00:00:01Z")}\n`);
    const appended = await observer.scanOnce();
    assert.equal(appended.emittedEvents, 1);
    assert.equal(sink.events.length, initialCount + 1);
    assert.equal(sink.events.at(-1)?.type, "assistant.message");

    const resumedSink = new RecordingSink();
    const resumed = new ClaudeLiveObserver(transcript, resumedSink, { statePath, sourceId: "live-test" });
    assert.deepEqual(await resumed.scanOnce(), {
      changed: false,
      emittedEvents: 0,
      generation: 0,
      diagnostics: [],
    });
    assert.equal(resumedSink.events.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a late subagent meta file emits a metadata revision without replaying its transcript", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-claude-meta-"));
  const transcript = resolve(directory, "session.jsonl");
  const statePath = resolve(directory, "cursor.json");
  const subagents = resolve(directory, "session/subagents");
  try {
    await mkdir(subagents, { recursive: true });
    await writeFile(transcript, `${userLine("root", "2026-08-26T00:00:00Z")}\n`);
    await writeFile(
      resolve(subagents, "agent-child.jsonl"),
      `${assistantLine("working", "2026-08-26T00:00:01Z")}\n`,
    );
    const sink = new RecordingSink();
    const observer = new ClaudeLiveObserver(transcript, sink, { statePath, sourceId: "meta-test" });
    await observer.scanOnce();
    const before = sink.events.length;

    await writeFile(
      resolve(subagents, "agent-child.meta.json"),
      JSON.stringify({ agentType: "reviewer", description: "late reviewer", toolUseId: "task-1" }),
    );
    const result = await observer.scanOnce();
    assert.equal(result.emittedEvents, 1);
    assert.equal(sink.events.length, before + 1);
    const metadata = sink.events.at(-1);
    assert.equal(metadata?.type, "session.metadata_changed");
    assert.equal(metadata?.session_id, "child");
    assert.equal(metadata?.data.label, "late reviewer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("truncate advances the generation and reuses line numbers without event-id conflicts", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-claude-rotate-"));
  const transcript = resolve(directory, "session.jsonl");
  const statePath = resolve(directory, "cursor.json");
  try {
    await writeFile(
      transcript,
      `${userLine("a deliberately long original prompt", "2026-08-26T00:00:00Z")}\n`,
    );
    const sink = new RecordingSink();
    const observer = new ClaudeLiveObserver(transcript, sink, { statePath, sourceId: "rotate-test" });
    await observer.scanOnce();
    const oldIds = new Set(sink.events.map((event) => event.event_id));

    await writeFile(transcript, `${userLine("new", "2026-08-26T00:00:02Z")}\n`);
    const rotated = await observer.scanOnce();
    assert.equal(rotated.generation, 1);
    const newEvents = sink.events.filter((event) => !oldIds.has(event.event_id));
    assert(newEvents.some((event) => event.type === "prompt.accepted"));
    assert(newEvents.every((event) => event.event_id.endsWith(":epoch-1")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an ACK timeout keeps one pending batch and commits it without enqueueing duplicates", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-claude-ack-"));
  const transcript = resolve(directory, "session.jsonl");
  const statePath = resolve(directory, "cursor.json");
  try {
    await writeFile(transcript, `${userLine("pending", "2026-08-26T00:00:00Z")}\n`);
    const sink = new RecordingSink();
    sink.idleFailures = 1;
    const observer = new ClaudeLiveObserver(transcript, sink, { statePath, sourceId: "ack-test" });
    await assert.rejects(observer.scanOnce(), /ACK timeout/);
    const queued = sink.events.length;
    assert(queued > 0);

    const recovered = await observer.scanOnce();
    assert.equal(recovered.emittedEvents, 0);
    assert.equal(sink.events.length, queued);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.sourceId, "ack-test");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
