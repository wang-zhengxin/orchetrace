import assert from "node:assert/strict";
import test from "node:test";

import { loadTimelinePages } from "./timeline-pages.js";

test("timeline pages retain page order when requests finish out of order", async () => {
  let active = 0;
  let peak = 0;
  const timeline = await loadTimelinePages({
    pageCount: 3,
    totalEntries: 5,
    concurrency: 2,
    readPage: async (page) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, (2 - page) * 2));
      active -= 1;
      return page === 0 ? ["a", "b"] : page === 1 ? ["c", "d"] : ["e"];
    },
  });
  assert.deepEqual(timeline, ["a", "b", "c", "d", "e"]);
  assert.equal(peak, 2);
});

test("timeline pages reject an incomplete revision", async () => {
  await assert.rejects(
    () => loadTimelinePages({
      pageCount: 2,
      totalEntries: 3,
      readPage: async () => ["only-one"],
    }),
    /expected 3 entries, received 2/,
  );
});
