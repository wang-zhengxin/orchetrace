import assert from "node:assert/strict";
import test from "node:test";

import { exposeReleaseContext, resolveReleaseContext } from "../release-context.mjs";

test("release context derives immutable versions from tags", async () => {
  const context = resolveReleaseContext({ refType: "tag", refName: "v0.1.0-beta.4" });
  assert.deepEqual(context, {
    mode: "release",
    version: "0.1.0-beta.4",
    currentTag: "v0.1.0-beta.4",
  });
  assert.match(await exposeReleaseContext(context), /ORCHETRACE_RELEASE_MODE=release/u);
});

test("preview context requires a semantic version without creating a tag", () => {
  assert.deepEqual(resolveReleaseContext({
    refType: "branch",
    refName: "main",
    previewVersion: "0.1.0-beta.4",
  }), {
    mode: "preview",
    version: "0.1.0-beta.4",
    currentTag: "v0.1.0-beta.4",
  });
  assert.throws(() => resolveReleaseContext({ refType: "branch", previewVersion: "latest" }), /invalid/u);
});
