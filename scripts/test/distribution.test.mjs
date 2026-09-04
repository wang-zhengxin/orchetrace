import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  cliArchiveName,
  distributionTarget,
  normalizeVersion,
  npmTarballName,
  renderHomebrewCask,
  renderHomebrewFormula,
} from "../distribution-lib.mjs";

test("release versions and target package names stay deterministic", () => {
  assert.equal(normalizeVersion("v0.1.0-beta.4"), "0.1.0-beta.4");
  assert.throws(() => normalizeVersion("latest"), /invalid release version/);
  assert.equal(distributionTarget("aarch64-apple-darwin").npmPackage, "@orchetrace/cli-darwin-arm64");
  assert.equal(
    npmTarballName("@orchetrace/cli-darwin-arm64", "0.1.0-beta.4"),
    "orchetrace-cli-darwin-arm64-0.1.0-beta.4.tgz",
  );
  assert.equal(
    cliArchiveName("0.1.0-beta.4", "x86_64-unknown-linux-gnu"),
    "orchetrace-cli-v0.1.0-beta.4-x86_64-unknown-linux-gnu.tar.gz",
  );
});

test("Homebrew definitions pin immutable release assets and runtime paths", () => {
  const common = {
    version: "0.1.0-beta.4",
    repository: "wang-zhengxin/orchetrace",
    arm: { name: "orchetrace-cli-v0.1.0-beta.4-aarch64-apple-darwin.tar.gz", sha256: "a".repeat(64) },
    intel: { name: "orchetrace-cli-v0.1.0-beta.4-x86_64-apple-darwin.tar.gz", sha256: "b".repeat(64) },
  };
  const formula = renderHomebrewFormula(common);
  assert.match(formula, /depends_on "node@22"/);
  assert.match(formula, /ORCHETRACE_PROJECT_ROOT/);
  assert.match(formula, /v0\.1\.0-beta\.4\/orchetrace-cli/);

  const cask = renderHomebrewCask({
    ...common,
    arm: { name: "Orchetrace_0.1.0_aarch64.dmg", sha256: "c".repeat(64) },
    intel: { name: "Orchetrace_0.1.0_x64.dmg", sha256: "d".repeat(64) },
  });
  assert.match(cask, /arch arm: "aarch64", intel: "x64"/);
  assert.match(cask, /Orchetrace_0\.1\.0_#\{arch\}\.dmg/);
});

test("CI and release jobs gate the real npm install lifecycle", async () => {
  const [ci, release] = await Promise.all([
    readFile(resolve(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8"),
    readFile(resolve(import.meta.dirname, "../../.github/workflows/release.yml"), "utf8"),
  ]);
  assert.match(
    ci,
    /smoke-install-lifecycle\.mjs --target x86_64-unknown-linux-gnu/u,
  );
  assert.match(
    release,
    /smoke-install-lifecycle\.mjs --target \$\{\{ matrix\.target \}\}/u,
  );
  assert.match(
    release,
    /verify-desktop-artifact\.mjs --target \$\{\{ matrix\.target \}\}/u,
  );
});
