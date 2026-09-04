import assert from "node:assert/strict";
import test from "node:test";

import { homebrewTargetForHost } from "../smoke-homebrew-lifecycle.mjs";

test("Homebrew lifecycle selects the native macOS release artifact", () => {
  assert.equal(homebrewTargetForHost("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(homebrewTargetForHost("darwin", "x64"), "x86_64-apple-darwin");
  assert.throws(() => homebrewTargetForHost("linux", "x64"), /requires macOS/u);
  assert.throws(() => homebrewTargetForHost("darwin", "riscv64"), /does not support/u);
});
