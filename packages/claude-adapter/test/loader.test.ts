import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { loadClaudeSession } from "../src/loader.ts";

const fixture = resolve(import.meta.dirname, "../../../fixtures/claude/demo.jsonl");
const run = promisify(execFile);

test("loads root, direct agent, workflow group, and workflow child", async () => {
  const result = await loadClaudeSession(fixture, { sourceId: "fixture-claude" });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.events.length, 42);
  const spawns = result.events.filter((event) => event.type === "agent.spawned");
  assert.deepEqual(
    new Map(spawns.map((event) => [event.session_id, event.parent_session_id])),
    new Map([
      ["direct-1", "demo"],
      ["workflow:wf-review", "demo"],
      ["review-1", "workflow:wf-review"],
    ]),
  );
});

test("pairs tool results with their original names and preserves failure evidence", async () => {
  const { events } = await loadClaudeSession(fixture, { sourceId: "fixture-claude" });
  const failed = events.find(
    (event) => event.type === "tool.finished" && event.data.call_id === "direct-test",
  );
  assert.equal(failed?.data.name, "Bash");
  assert.equal(failed?.data.outcome, "failed");
  const outcomes = new Map(
    events
      .filter((event) => event.type === "agent.outcome_recorded")
      .map((event) => [event.session_id, event.data.outcome]),
  );
  assert.equal(outcomes.get("direct-1"), "succeeded");
  assert.equal(outcomes.get("review-1"), "succeeded");
  assert.equal(outcomes.get("workflow:wf-review"), "succeeded");
  assert.equal(outcomes.has("demo"), false, "main transcript silence is not terminal evidence");
});

test("isolates malformed and unknown lines as diagnostics", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-claude-test-"));
  const path = resolve(directory, "session.jsonl");
  try {
    await writeFile(
      path,
      [
        '{"type":"user","timestamp":"2026-08-25T00:00:00Z","message":{"content":"hi"}}',
        "not-json",
        '{"type":"future-required","timestamp":"2026-08-25T00:00:01Z"}',
      ].join("\n"),
    );
    const result = await loadClaudeSession(path);
    assert(result.events.some((event) => event.type === "prompt.accepted"));
    assert(result.diagnostics.some((item) => item.code === "line-json-invalid"));
    assert(result.diagnostics.some((item) => item.code === "entry-type-unknown"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI emits Canonical JSONL that can be handed to the Rust Core", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-claude-cli-"));
  const output = resolve(directory, "events.jsonl");
  try {
    const cli = resolve(import.meta.dirname, "../src/cli.ts");
    const { stderr } = await run(process.execPath, [
      cli,
      fixture,
      "--source-id",
      "cli-test",
      "--output",
      output,
    ]);
    assert.match(stderr, /mapped 42 events/);
    const events = (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 42);
    assert.equal(events[0].source_id, "cli-test");
    assert.equal(events.every((event) => event.runtime === "claude-code"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
