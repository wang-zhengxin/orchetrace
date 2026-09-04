import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { loadAntigravitySession } from "../src/loader.ts";

const fixture = resolve(
  import.meta.dirname,
  "../../../fixtures/antigravity/root-transcript.jsonl",
);
const canonicalFixture = resolve(
  import.meta.dirname,
  "../../../fixtures/antigravity/canonical-events.jsonl",
);

test("maps an Antigravity transcript into lifecycle, tool, and subagent events", async () => {
  const result = await loadAntigravitySession(fixture, "antigravity-fixture");
  const expected = (await readFile(canonicalFixture, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(result.events, expected);
  assert.equal(result.events.every((event) => event.runtime === "antigravity"), true);
  assert(result.events.some((event) => event.type === "session.discovered"));
  assert(result.events.some((event) => event.type === "prompt.accepted"));
  const started = result.events.find((event) =>
    event.type === "tool.started" && event.data.name === "view_file"
  );
  assert(started);
  assert(result.events.some((event) =>
    event.type === "tool.finished" && event.data.call_id === started.data.call_id
  ));
  const spawned = result.events.find((event) => event.type === "agent.spawned");
  assert.equal(spawned?.session_id, "11111111-2222-4333-8444-555555555555");
  assert.equal(spawned?.parent_session_id, result.identity.sessionId);
  assert(result.events.some((event) =>
    event.type === "agent.activation_ended" && event.data.status === "ready"
  ));
  const writeStarted = result.events.find((event) =>
    event.type === "tool.started" && event.data.name === "write_to_file"
  );
  assert(writeStarted);
  assert(!String(writeStarted.data.input_summary).includes("private generated content"));
  assert(result.events.some((event) =>
    event.type === "tool.finished" && event.data.call_id === writeStarted.data.call_id
  ));
});

test("isolates malformed Antigravity lines as diagnostics", async () => {
  const { parseAntigravityRecords } = await import("../src/loader.ts");
  const diagnostics: import("../src/types.ts").AntigravityDiagnostic[] = [];
  const records = parseAntigravityRecords(
    '{"step_index":0}\nnot-json\n',
    "/tmp/transcript.jsonl",
    1,
    diagnostics,
  );
  assert.equal(records.length, 0);
  assert.equal(diagnostics.length, 2);
});
