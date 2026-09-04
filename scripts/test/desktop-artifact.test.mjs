import assert from "node:assert/strict";
import test from "node:test";

import {
  installerExtension,
  locateExtractedRuntime,
} from "../verify-desktop-artifact.mjs";

test("desktop installer type follows the release target", () => {
  assert.equal(installerExtension("aarch64-apple-darwin"), ".dmg");
  assert.equal(installerExtension("x86_64-unknown-linux-gnu"), ".deb");
  assert.equal(installerExtension("x86_64-pc-windows-msvc"), ".msi");
});

test("desktop artifact inventory requires the core runtime and all five adapters", () => {
  const root = "/mounted/Orchetrace.app/Contents";
  const files = [
    `${root}/MacOS/orchetrace-desktop`,
    `${root}/MacOS/orchetrace-node`,
    `${root}/MacOS/otrace`,
    ...[
      "claude-adapter",
      "pi-adapter",
      "dsh-observer",
      "codex-adapter",
      "antigravity-adapter",
    ].map((name) => `${root}/Resources/packages/${name}/src/auto-cli.ts`),
  ];
  const runtime = locateExtractedRuntime(files, "aarch64-apple-darwin");
  assert.equal(runtime.desktop, `${root}/MacOS/orchetrace-desktop`);
  assert.equal(Object.keys(runtime.adapters).length, 5);

  assert.throws(
    () => locateExtractedRuntime(files.slice(0, -1), "aarch64-apple-darwin"),
    /antigravity-adapter entrypoint/u,
  );
});
