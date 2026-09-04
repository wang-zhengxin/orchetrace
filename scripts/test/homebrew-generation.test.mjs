import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("Homebrew generation discovers verified artifacts in nested download directories", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "orchetrace-homebrew-generation-"));
  const assets = path.join(temporaryRoot, "assets");
  const output = path.join(temporaryRoot, "output");
  try {
    const cli = path.join(assets, "cli", "artifacts");
    const installers = path.join(assets, "dmg");
    await mkdir(cli, { recursive: true });
    await mkdir(installers, { recursive: true });
    await Promise.all([
      writeFile(path.join(cli, "orchetrace-cli-v0.1.0-beta.4-aarch64-apple-darwin.tar.gz"), "arm"),
      writeFile(path.join(cli, "orchetrace-cli-v0.1.0-beta.4-x86_64-apple-darwin.tar.gz"), "intel"),
      writeFile(path.join(installers, "Orchetrace_0.1.0_aarch64.dmg"), "arm dmg"),
      writeFile(path.join(installers, "Orchetrace_0.1.0_x64.dmg"), "intel dmg"),
    ]);

    await execute(process.execPath, [
      path.resolve(import.meta.dirname, "../generate-homebrew.mjs"),
      "--version",
      "0.1.0-beta.4",
      "--assets-dir",
      assets,
      "--output",
      output,
      "--require-cask",
    ]);

    const [formula, cask] = await Promise.all([
      readFile(path.join(output, "Formula", "orchetrace.rb"), "utf8"),
      readFile(path.join(output, "Casks", "orchetrace.rb"), "utf8"),
    ]);
    assert.match(formula, /orchetrace-cli-v0\.1\.0-beta\.4-aarch64-apple-darwin\.tar\.gz/u);
    assert.match(cask, /Orchetrace_0\.1\.0_#\{arch\}\.dmg/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
