import test from "node:test";
import assert from "node:assert/strict";

import { emptyCatalogPresentation, preferredRunId } from "./catalog-state.js";

test("an empty catalog is a waiting state rather than an error", () => {
  assert.equal(preferredRunId({ schema_version: 1, runs: [] }, "deleted"), null);
  assert.deepEqual(emptyCatalogPresentation(2), {
    activeRunName: "Waiting for Agent activity",
    graphSummary: "0 agents · 0 links · 0 observed events",
    cursorState: "WAITING FOR SESSION",
    timelineRange: "+0ms / 0ms",
    timelineCursor: "—",
    timelineEventTitle: "A new Session will appear automatically",
    timelineDate: "—",
    timelinePlay: "▶ PLAY 2×",
    footerStats: "0 agents · 0 tools · 0 tokens",
  });
});

test("catalog selection preserves a live run and recovers after deletion", () => {
  const catalog = {
    runs: [
      { run_id: "claude", source_id: "claude-local", agent_count: 2, event_count: 10 },
      { run_id: "demo-small", source_id: "local-demo", agent_count: 3, event_count: 30 },
      { run_id: "demo-large", source_id: "local-demo", agent_count: 14, event_count: 90 },
    ],
  };

  assert.equal(preferredRunId(catalog, "claude"), "claude");
  assert.equal(preferredRunId(catalog, "deleted"), "demo-large");
  assert.equal(preferredRunId({ runs: [catalog.runs[0]] }, null), "claude");
});

test("malformed catalogs fail explicitly", () => {
  assert.throws(() => preferredRunId({}), /runs array/);
});
