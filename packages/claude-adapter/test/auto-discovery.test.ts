import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";
import { ClaudeAutoDiscovery, discoverClaudeTranscripts } from "../src/auto-discovery.ts";

class RecordingSink implements AcknowledgedCanonicalEventSink {
  readonly events: CanonicalEvent[] = [];

  write(event: CanonicalEvent): void {
    this.events.push(event);
  }

  async whenIdle(): Promise<void> {}
}

const rootLine = JSON.stringify({
  type: "user",
  timestamp: "2026-08-27T00:00:00Z",
  message: { content: "inspect this project" },
});

test("discovers only root transcripts and attaches every eligible Claude session", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-claude-auto-"));
  const projects = resolve(directory, "projects");
  const projectA = resolve(projects, "project-a");
  const transcriptA = resolve(projectA, "session-a.jsonl");
  const nested = resolve(projectA, "session-a/subagents/agent-child.jsonl");
  try {
    await mkdir(resolve(projectA, "session-a/subagents"), { recursive: true });
    await writeFile(transcriptA, `${rootLine}\n`);
    await writeFile(nested, `${rootLine}\n`);

    const candidates = await discoverClaudeTranscripts(projects);
    assert.deepEqual(candidates.map((item) => item.transcriptPath), [transcriptA]);

    const sink = new RecordingSink();
    const discovery = new ClaudeAutoDiscovery(sink, {
      projectsDir: projects,
      stateDir: resolve(directory, "state"),
      hookEventsPath: resolve(directory, "hooks.jsonl"),
      includeExisting: true,
    });
    const status = await discovery.scanOnce();
    assert.equal(status.discoveredSessions, 1);
    assert.equal(status.observedSessions, 1);
    assert.deepEqual(discovery.observedPaths(), [transcriptA]);
    assert(sink.events.some((event) => event.runtime === "claude-code"));
    await discovery.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lifecycle hook attaches an old already-open transcript outside the recency window", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-claude-hook-discovery-"));
  const projects = resolve(directory, "projects");
  const project = resolve(projects, "project-old");
  const transcript = resolve(project, "old-session.jsonl");
  const hookEventsPath = resolve(directory, "hooks.jsonl");
  try {
    await mkdir(project, { recursive: true });
    await writeFile(transcript, `${rootLine}\n`);
    await utimes(transcript, new Date(0), new Date(0));
    await writeFile(
      hookEventsPath,
      `${JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "old-session",
        transcript_path: transcript,
        cwd: "/workspace/project-old",
      })}\n`,
    );

    const sink = new RecordingSink();
    const discovery = new ClaudeAutoDiscovery(sink, {
      projectsDir: projects,
      stateDir: resolve(directory, "state"),
      hookEventsPath,
      activeWithinMs: 1,
    });
    const first = await discovery.scanOnce();
    assert.equal(first.hookEvents, 1);
    assert.equal(first.observedSessions, 1);
    assert.deepEqual(discovery.observedPaths(), [transcript]);

    const second = await discovery.scanOnce();
    assert.equal(second.hookEvents, 0, "hook mailbox is consumed incrementally");
    assert.equal(second.observedSessions, 1);
    await discovery.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
