import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { loadPiSession } from "../src/loader.ts";

const fixture = resolve(import.meta.dirname, "../../../fixtures/pi/demo.jsonl");
const telemetryFixture = resolve(import.meta.dirname, "../../../fixtures/pi/telemetry.jsonl");
const run = promisify(execFile);

test("selects the final Pi leaf path without turning conversation parents into agents", async () => {
  const result = await loadPiSession(fixture, { sourceId: "fixture-pi" });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.activeLeafId, "e10");
  assert.equal(result.activeEntryCount, 9);
  assert.equal(result.abandonedEntryCount, 1);
  assert.equal(result.events.length, 12);
  assert.equal(result.events.every((event) => event.parent_session_id === undefined), true);
  assert.equal(result.events.filter((event) => event.type === "session.discovered").length, 1);
  assert.equal(result.events.some((event) => JSON.stringify(event).includes("ABANDONED")), false);
});

test("maps persisted tool calls, results, compaction, and active-context markers", async () => {
  const { events } = await loadPiSession(fixture, { sourceId: "fixture-pi" });
  const started = events.find((event) => event.type === "tool.started");
  const finished = events.find((event) => event.type === "tool.finished");
  assert.equal(started?.data.call_id, "call-read");
  assert.equal(finished?.data.call_id, "call-read");
  assert.equal(finished?.data.outcome, "succeeded");
  const compacted = events.find((event) => event.type === "context.compacted");
  assert.equal(compacted?.data.first_kept_entry_id, "e2");
  const preCompaction = events.find((event) => event.attributes?.["pi.entry_id"] === "e1");
  assert.equal(preCompaction?.attributes?.["pi.active_context"], false);
  assert.equal(
    events.filter((event) => event.type === "assistant.message" && event.data.kind === "branch-summary").length,
    1,
  );
});

test("explicit telemetry maps nested Pi extension agents without tool-name inference", async () => {
  const result = await loadPiSession(telemetryFixture, { sourceId: "fixture-pi-telemetry" });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.events.length, 14);
  const discovered = result.events.filter((event) => event.type === "session.discovered");
  assert.equal(discovered.length, 3);
  const worker = "pi-telemetry-demo::pi-agent::worker-1";
  const reviewer = "pi-telemetry-demo::pi-agent::reviewer-1";
  assert.equal(discovered.find((event) => event.session_id === worker)?.parent_session_id, "pi-telemetry-demo");
  assert.equal(discovered.find((event) => event.session_id === reviewer)?.parent_session_id, worker);
  assert.equal(
    result.events.find((event) => event.session_id === reviewer && event.type === "agent.outcome_recorded")?.data.outcome,
    "failed",
  );
  assert.equal(
    result.events.find((event) => event.session_id === worker && event.type === "tool.finished")?.data.call_id,
    "worker-read",
  );
});

test("unknown telemetry schema and kinds are diagnostics, while unrelated custom entries remain opaque", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-telemetry-invalid-"));
  const path = resolve(directory, "session.jsonl");
  try {
    await writeFile(
      path,
      [
        '{"type":"session","version":3,"id":"telemetry-bad","timestamp":"2026-08-26T00:00:00Z","cwd":"/tmp"}',
        '{"type":"custom","id":"a","parentId":null,"timestamp":"2026-08-26T00:00:01Z","customType":"another.extension","data":{"anything":true}}',
        '{"type":"custom","id":"b","parentId":"a","timestamp":"2026-08-26T00:00:02Z","customType":"orchetrace.telemetry","data":{"schema_version":2,"event_id":"future","occurred_at":"2026-08-26T00:00:02Z","kind":"agent.disposed","agent_id":"a"}}',
        '{"type":"custom","id":"c","parentId":"b","timestamp":"2026-08-26T00:00:03Z","customType":"orchetrace.telemetry","data":{"schema_version":1,"event_id":"unknown","occurred_at":"2026-08-26T00:00:03Z","kind":"future.kind","agent_id":"a"}}',
      ].join("\n"),
    );
    const result = await loadPiSession(path);
    assert.deepEqual(result.diagnostics.map((item) => item.code), ["telemetry-version-unsupported", "telemetry-kind-unknown"]);
    assert.equal(result.events.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("duplicate telemetry event ids are rejected before ingest", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-telemetry-duplicate-"));
  const path = resolve(directory, "session.jsonl");
  const envelope = {
    schema_version: 1,
    event_id: "duplicate",
    occurred_at: "2026-08-26T00:00:01Z",
    kind: "agent.discovered",
    agent_id: "worker",
    label: "Worker",
  };
  try {
    await writeFile(
      path,
      [
        '{"type":"session","version":3,"id":"telemetry-duplicate","timestamp":"2026-08-26T00:00:00Z","cwd":"/tmp"}',
        JSON.stringify({ type: "custom", id: "a", parentId: null, timestamp: "2026-08-26T00:00:01Z", customType: "orchetrace.telemetry", data: envelope }),
        JSON.stringify({ type: "custom", id: "b", parentId: "a", timestamp: "2026-08-26T00:00:02Z", customType: "orchetrace.telemetry", data: envelope }),
      ].join("\n"),
    );
    const result = await loadPiSession(path);
    assert.equal(result.diagnostics.filter((item) => item.code === "telemetry-event-id-duplicate").length, 1);
    assert.equal(result.events.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("isolates malformed and unsupported Pi entries as diagnostics", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-invalid-"));
  const path = resolve(directory, "session.jsonl");
  try {
    await writeFile(
      path,
      [
        '{"type":"session","version":3,"id":"bad","timestamp":"2026-08-26T00:00:00Z","cwd":"/tmp"}',
        '{"type":"future_required","id":"a","parentId":null,"timestamp":"2026-08-26T00:00:01Z"}',
        "not-json",
      ].join("\n"),
    );
    const result = await loadPiSession(path);
    assert(result.diagnostics.some((item) => item.code === "line-json-invalid"));
    assert(result.diagnostics.some((item) => item.code === "entry-type-unknown"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates legacy v1 linear ids and compaction indexes defensively", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-v1-"));
  const path = resolve(directory, "session.jsonl");
  try {
    await writeFile(
      path,
      [
        '{"type":"session","id":"legacy","timestamp":"2026-08-26T00:00:00Z","cwd":"/tmp"}',
        '{"type":"message","timestamp":"2026-08-26T00:00:01Z","message":{"role":"user","content":"legacy prompt","timestamp":1787702401000}}',
        '{"type":"compaction","timestamp":"2026-08-26T00:00:02Z","summary":"legacy summary","firstKeptEntryIndex":1,"tokensBefore":100}',
      ].join("\n"),
    );
    const result = await loadPiSession(path, { sourceId: "legacy" });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.activeLeafId, "legacy-3");
    assert.equal(
      result.events.find((event) => event.type === "context.compacted")?.data.first_kept_entry_id,
      "legacy-2",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI emits Canonical Pi JSONL", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-cli-"));
  const output = resolve(directory, "events.jsonl");
  try {
    const cli = resolve(import.meta.dirname, "../src/cli.ts");
    const { stderr } = await run(process.execPath, [
      cli,
      fixture,
      "--source-id",
      "pi-cli-test",
      "--output",
      output,
    ]);
    assert.match(stderr, /mapped 12 events from 9 active entries; ignored 1 abandoned entries/);
    const events = (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 12);
    assert.equal(events.every((event) => event.runtime === "pi"), true);
    assert.equal(events.every((event) => event.source_id === "pi-cli-test"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
