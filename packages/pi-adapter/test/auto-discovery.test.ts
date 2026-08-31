import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";
import { PiAutoDiscovery, discoverPiTranscripts } from "../src/auto-discovery.ts";
import { PiIncrementalSessionCache } from "../src/loader.ts";
import { PiPassiveObserver } from "../src/passive-observer.ts";

class RecordingSink implements AcknowledgedCanonicalEventSink {
  readonly events: CanonicalEvent[] = [];

  write(event: CanonicalEvent): void {
    this.events.push(event);
  }

  async whenIdle(): Promise<void> {}
}

const header = {
  type: "session",
  version: 3,
  id: "pi-passive-session",
  timestamp: "2026-08-28T00:00:00.000Z",
  cwd: "/workspace/pi",
};
const model = {
  type: "model_change",
  id: "model-1",
  parentId: null,
  timestamp: "2026-08-28T00:00:01.000Z",
  provider: "deepseek",
  modelId: "deepseek-chat",
};
const prompt = {
  type: "message",
  id: "prompt-1",
  parentId: "model-1",
  timestamp: "2026-08-28T00:00:02.000Z",
  message: { role: "user", content: "inspect the workspace", timestamp: 1787875202000 },
};
const answer = {
  type: "message",
  id: "answer-1",
  parentId: "prompt-1",
  timestamp: "2026-08-28T00:00:03.000Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    provider: "deepseek",
    model: "deepseek-chat",
    timestamp: 1787875203000,
  },
};

test("incremental session cache parses only appended Pi bytes", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-cache-"));
  const transcript = resolve(directory, "session.jsonl");
  try {
    const initialText = `${[header, model].map(JSON.stringify).join("\n")}\n`;
    await writeFile(transcript, initialText);
    const cache = new PiIncrementalSessionCache(transcript);
    const initial = await cache.load();
    assert.equal(initial.bytesRead, Buffer.byteLength(initialText));
    assert.equal(initial.parsed.entries.length, 1);

    const appendText = `${JSON.stringify(prompt)}\n`;
    await appendFile(transcript, appendText);
    const appended = await cache.load();
    assert.equal(appended.bytesRead, Buffer.byteLength(appendText));
    assert.equal(appended.parsed.entries.length, 2);
    assert.equal(appended.parsed.activePath.at(-1)?.id, prompt.id);

    const unchanged = await cache.load();
    assert.equal(unchanged.bytesRead, 0);
    assert.equal(unchanged.parsed.entries.length, 2);
    assert.strictEqual(unchanged.parsed, appended.parsed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("passively follows Pi file changes and resumes from an ACK cursor", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-passive-"));
  const transcript = resolve(directory, "session.jsonl");
  const statePath = resolve(directory, "state/cursor.json");
  try {
    await writeFile(transcript, `${[header, model, prompt].map(JSON.stringify).join("\n")}\n`);
    const firstSink = new RecordingSink();
    const first = new PiPassiveObserver(transcript, firstSink, {
      sourceId: "pi-project-test",
      statePath,
      pollMs: 60_000,
    });
    const initial = await first.scanOnce();
    assert.equal(initial.sessionId, header.id);
    assert.equal(initial.emittedEvents, 4);

    await appendFile(transcript, `${JSON.stringify(answer)}\n`);
    const changed = await first.scanOnce();
    assert.equal(changed.emittedEvents, 2);
    assert.equal(
      firstSink.events.some(
        (event) => event.type === "assistant.message" && event.data.summary === "done",
      ),
      true,
    );
    await first.stop();

    const resumedSink = new RecordingSink();
    const resumed = new PiPassiveObserver(transcript, resumedSink, {
      sourceId: "pi-project-test",
      statePath,
    });
    const unchanged = await resumed.scanOnce();
    assert.equal(unchanged.changed, false);
    assert.equal(resumedSink.events.length, 0);
    await resumed.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("replays a v1 passive cursor once to backfill derived root lifecycle", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-cursor-v1-"));
  const transcript = resolve(directory, "session.jsonl");
  const statePath = resolve(directory, "cursor.json");
  try {
    await writeFile(transcript, `${[header, model, prompt].map(JSON.stringify).join("\n")}\n`);
    await writeFile(
      statePath,
      `${JSON.stringify({
        schemaVersion: 1,
        transcriptPath: transcript,
        sourceId: "pi-project-test",
        sessionId: header.id,
        eventIds: [],
      })}\n`,
    );
    const sink = new RecordingSink();
    const observer = new PiPassiveObserver(transcript, sink, {
      sourceId: "pi-project-test",
      statePath,
    });

    const result = await observer.scanOnce();
    assert.equal(result.emittedEvents, 4);
    assert.equal(sink.events.some((event) => event.type === "agent.activation_started"), true);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).schemaVersion, 2);
    await observer.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("discovers Pi JSONL sessions below project directories", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-auto-"));
  const sessions = resolve(directory, "sessions");
  const project = resolve(sessions, "--workspace-pi--");
  const transcript = resolve(project, "session.jsonl");
  try {
    await mkdir(project, { recursive: true });
    await writeFile(transcript, `${[header, model].map(JSON.stringify).join("\n")}\n`);
    await writeFile(resolve(project, "ignore.txt"), "ignored\n");
    assert.deepEqual(
      (await discoverPiTranscripts(sessions)).map((item) => item.transcriptPath),
      [transcript],
    );

    const sink = new RecordingSink();
    const discovery = new PiAutoDiscovery(sink, {
      sessionsDir: sessions,
      stateDir: resolve(directory, "state"),
      includeExisting: true,
    });
    const status = await discovery.scanOnce();
    assert.equal(status.discoveredSessions, 1);
    assert.equal(status.observedSessions, 1);
    assert.deepEqual(discovery.observedPaths(), [transcript]);
    assert(sink.events.every((event) => event.runtime === "pi"));
    await discovery.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
