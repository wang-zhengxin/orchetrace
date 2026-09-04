import assert from "node:assert/strict";
import test from "node:test";

import {
  homebrewCaskCommand,
  homebrewTargetForHost,
} from "../smoke-homebrew-lifecycle.mjs";

test("Homebrew lifecycle selects the native macOS release artifact", () => {
  assert.equal(homebrewTargetForHost("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(homebrewTargetForHost("darwin", "x64"), "x86_64-apple-darwin");
  assert.throws(() => homebrewTargetForHost("linux", "x64"), /requires macOS/u);
  assert.throws(() => homebrewTargetForHost("darwin", "riscv64"), /does not support/u);
});

test("Homebrew Cask lifecycle quarantines only through the initial install contract", () => {
  assert.deepEqual(homebrewCaskCommand("install", "/tmp/candidate.rb", "/tmp/Applications"), [
    "install",
    "--cask",
    "--no-quarantine",
    "--appdir=/tmp/Applications",
    "/tmp/candidate.rb",
  ]);
  assert.deepEqual(homebrewCaskCommand("upgrade", "/tmp/candidate.rb", "/tmp/Applications"), [
    "upgrade",
    "--cask",
    "--appdir=/tmp/Applications",
    "/tmp/candidate.rb",
  ]);
});
