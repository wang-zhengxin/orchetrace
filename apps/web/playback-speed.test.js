import assert from "node:assert/strict";
import test from "node:test";

import { nextPlaybackRate, scalePlaybackElapsed } from "./playback-speed.js";

test("replay rates move through bounded presets", () => {
  assert.equal(nextPlaybackRate(1, 1), 2);
  assert.equal(nextPlaybackRate(1, -1), 0.5);
  assert.equal(nextPlaybackRate(8, 1), 8);
  assert.equal(nextPlaybackRate(0.25, -1), 0.25);
});

test("replay elapsed time follows the selected rate", () => {
  assert.equal(scalePlaybackElapsed(1_000, 0.25), 250);
  assert.equal(scalePlaybackElapsed(1_000, 1), 1_000);
  assert.equal(scalePlaybackElapsed(1_000, 8), 8_000);
  assert.equal(scalePlaybackElapsed(-1, 2), 0);
});
