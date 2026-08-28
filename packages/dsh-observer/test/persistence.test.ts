import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import * as zlib from "node:zlib";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";
import { DshAutoDiscovery, discoverDshPersistence } from "../src/auto-discovery.ts";
import { loadDshPersistence } from "../src/persistence-loader.ts";
import { DshPersistenceObserver } from "../src/persistence-observer.ts";

class RecordingSink implements AcknowledgedCanonicalEventSink {
  readonly events: CanonicalEvent[] = [];

  write(event: CanonicalEvent): void {
    this.events.push(event);
  }

  async whenIdle(): Promise<void> {}
}

const header = {
  type: "session",
  version: 1,
  id: "harness-session",
  createdAt: 1787875200000,
  cwd: "/workspace/harness",
};
const descriptor = {
  type: "subagent/descriptor",
  seq: 0,
  time: 1787875200001,
  data: { label: "main", mode: "continuable", agentProvider: "deepseek", agentModel: "v4" },
};
const turn = {
  type: "turn/start",
  seq: 1,
  time: 1787875200010,
  data: { turn: 1 },
};
const chunks = {
  type: "reasoning-chunks",
  seq0: 2,
  time0: 1787875200020,
  data: { turn: 1, step: 1, index: 0, dt: [1], texts: ["private", "reasoning"] },
};
const tool = {
  type: "tool/call",
  seq: 4,
  time: 1787875200040,
  data: { callId: "call-1", name: "Read", arguments: { path: "src/main.ts" } },
};

test("loads Harness Zstandard persistence while excluding packed model chunks", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-dsh-loader-"));
  const persistencePath = resolve(directory, "session.jsonl.zstd");
  try {
    await writeCompressed(persistencePath, [header, descriptor, turn, chunks, tool]);
    const loaded = await loadDshPersistence(persistencePath);
    assert.equal(loaded.header.id, header.id);
    assert.deepEqual(loaded.sourceEvents.map((event) => event.seq), [0, 1, 4]);
    assert(loaded.events.some((event) => event.type === "tool.started"));
    assert(!JSON.stringify(loaded.events).includes("private reasoning"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistence observer emits only new canonical ids after a compressed rewrite", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-dsh-passive-"));
  const persistencePath = resolve(directory, "session.jsonl.zstd");
  const statePath = resolve(directory, "state/cursor.json");
  try {
    await writeCompressed(persistencePath, [header, descriptor, turn]);
    const sink = new RecordingSink();
    const observer = new DshPersistenceObserver(persistencePath, sink, { statePath });
    const first = await observer.scanOnce();
    assert(first.emittedEvents > 0);
    const initialIds = new Set(sink.events.map((event) => event.event_id));

    await writeCompressed(persistencePath, [header, descriptor, turn, chunks, tool]);
    const second = await observer.scanOnce();
    assert.equal(second.emittedEvents, 1);
    assert.equal(sink.events.at(-1)?.type, "tool.started");
    assert.equal(new Set(sink.events.map((event) => event.event_id)).size, initialIds.size + 1);
    await observer.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("discovers canonical Harness persistence paths and attaches them", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-dsh-auto-"));
  const sessions = resolve(directory, "sessions");
  const sessionDirectory = resolve(sessions, "--workspace--", header.id);
  const persistencePath = resolve(sessionDirectory, "session.jsonl.zstd");
  try {
    await mkdir(sessionDirectory, { recursive: true });
    await writeCompressed(persistencePath, [header, descriptor]);
    await writeFile(`${persistencePath}.backup`, "ignored");
    assert.deepEqual(
      (await discoverDshPersistence(sessions)).map((candidate) => candidate.persistencePath),
      [persistencePath],
    );

    const sink = new RecordingSink();
    const discovery = new DshAutoDiscovery(sink, {
      sessionsDir: sessions,
      stateDir: resolve(directory, "state"),
      includeExisting: true,
    });
    const status = await discovery.scanOnce();
    assert.equal(status.discoveredSessions, 1);
    assert.equal(status.observedSessions, 1);
    assert(sink.events.every((event) => event.runtime === "deepseek-harness"));
    await discovery.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function writeCompressed(path: string, records: unknown[]): Promise<void> {
  const encoder = (zlib as unknown as {
    zstdCompress?: (input: Buffer, callback: (error: Error | null, output: Buffer) => void) => void;
  }).zstdCompress;
  if (!encoder) throw new Error("test requires Node.js Zstandard support");
  const input = Buffer.from(`${records.map(JSON.stringify).join("\n")}\n`);
  return new Promise((resolveWrite, rejectWrite) => {
    encoder(input, (error, output) => {
      if (error) rejectWrite(error);
      else void writeFile(path, output).then(() => resolveWrite(), rejectWrite);
    });
  });
}
