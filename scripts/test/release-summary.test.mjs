import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { summarizeReleaseCandidate } from "../summarize-release-candidate.mjs";

test("release candidate summary inventories nested artifacts with hashes", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "orchetrace-release-summary-"));
  try {
    const assets = path.join(temporaryRoot, "assets");
    await mkdir(path.join(assets, "macos"), { recursive: true });
    await writeFile(path.join(assets, "macos", "Orchetrace.dmg"), "candidate");
    const result = await summarizeReleaseCandidate({
      version: "0.1.0-beta.4",
      mode: "preview",
      assetsDir: assets,
      output: path.join(temporaryRoot, "summary"),
    });
    assert.equal(result.summary.artifacts.length, 1);
    assert.equal(result.summary.artifacts[0].path, "macos/Orchetrace.dmg");
    assert.match(result.summary.artifacts[0].sha256, /^[a-f0-9]{64}$/u);
    assert.match(await readFile(result.markdownFile, "utf8"), /Orchetrace preview 0\.1\.0-beta\.4/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
