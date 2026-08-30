import assert from "node:assert/strict";
import test from "node:test";

import { compactTimelineMarkers, indexTimelineBySession } from "./timeline-index.js";

test("timeline indexing groups events in source order", () => {
  const timeline = [
    event("root", "prompt", 0),
    event("child", "spawn", 1),
    event("root", "tool", 2),
  ];
  const indexed = indexTimelineBySession(timeline);
  assert.deepEqual(indexed.get("root"), [timeline[0], timeline[2]]);
  assert.deepEqual(indexed.get("child"), [timeline[1]]);
});

test("dense marker compaction preserves time range and significant failures", () => {
  const events = [
    event("root", "tool", 0),
    event("root", "tool-result", 1, "completed"),
    event("root", "error", 2, "failed"),
    event("root", "prompt", 9),
  ];
  const markers = compactTimelineMarkers(events, 0, 10, 2);
  assert.equal(markers.length, 2);
  assert.equal(markers[0].count, 3);
  assert.equal(markers[0].event.kind, "error");
  assert.equal(markers[0].from, new Date(0).toISOString());
  assert.equal(markers[0].to, new Date(2).toISOString());
  assert.equal(markers[1].count, 1);
});

function event(sessionId, kind, timestamp, outcome) {
  return {
    session_id: sessionId,
    kind,
    at: new Date(timestamp).toISOString(),
    label: `${kind}-${timestamp}`,
    outcome,
  };
}
