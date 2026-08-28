import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";
import { PiAutoDiscovery, discoverPiTranscripts } from "../src/auto-discovery.ts";
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
    assert.equal(initial.emittedEvents, 3);

    await appendFile(transcript, `${JSON.stringify(answer)}\n`);
    const changed = await first.scanOnce();
    assert.equal(changed.emittedEvents, 1);
    assert.equal(firstSink.events.at(-1)?.type, "assistant.message");
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
