import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  cliArchiveName,
  distributionTarget,
  executableInvocation,
  normalizeVersion,
  npmInvocation,
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

test("npm invocation bypasses Windows cmd shim resolution", () => {
  assert.deepEqual(npmInvocation(["pack", "package"], {
    platform: "win32",
    execPath: "C:\\node\\node.exe",
    environment: {},
  }), {
    command: "C:\\node\\node.exe",
    args: ["C:\\node\\node_modules\\npm\\bin\\npm-cli.js", "pack", "package"],
  });
  assert.deepEqual(npmInvocation(["pack"], {
    platform: "linux",
    execPath: "/usr/bin/node",
    environment: {},
  }), { command: "npm", args: ["pack"] });
});

test("Windows npm command shims retain quoted paths", () => {
  assert.deepEqual(executableInvocation(
    "C:\\Users\\Runner Admin\\prefix\\orche.cmd",
    ["--help"],
    { platform: "win32", comSpec: "C:\\Windows\\System32\\cmd.exe" },
  ), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      'call "C:\\Users\\Runner Admin\\prefix\\orche.cmd" "--help"',
    ],
    options: { windowsVerbatimArguments: true },
  });
  assert.deepEqual(executableInvocation("/tmp/orche", ["--help"], { platform: "linux" }), {
    command: "/tmp/orche",
    args: ["--help"],
  });
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
  assert.match(formula, /formula_opt_bin\("node@22"\)/);
  assert.match(formula, /v0\.1\.0-beta\.4\/orchetrace-cli/);

  const cask = renderHomebrewCask({
    ...common,
    arm: { name: "Orchetrace_0.1.0_aarch64.dmg", sha256: "c".repeat(64) },
    intel: { name: "Orchetrace_0.1.0_x64.dmg", sha256: "d".repeat(64) },
  });
  assert.match(cask, /arch arm: "aarch64", intel: "x64"/);
  assert.match(cask, /depends_on :macos/);
  assert.match(cask, /Orchetrace_0\.1\.0_#\{arch\}\.dmg/);

  const localFormula = renderHomebrewFormula({
    ...common,
    arm: { ...common.arm, url: "file:///tmp/orchetrace-arm.tar.gz" },
    intel: { ...common.intel, url: "file:///tmp/orchetrace-intel.tar.gz" },
  });
  assert.match(localFormula, /url "file:\/\/\/tmp\/orchetrace-arm\.tar\.gz"/);
  assert.match(localFormula, /url "file:\/\/\/tmp\/orchetrace-intel\.tar\.gz"/);

  const localCask = renderHomebrewCask({
    ...common,
    arm: { name: "Orchetrace_0.1.0_aarch64.dmg", sha256: "c".repeat(64) },
    intel: { name: "Orchetrace_0.1.0_x64.dmg", sha256: "d".repeat(64) },
    url: "file:///tmp/Orchetrace.dmg",
  });
  assert.match(localCask, /url "file:\/\/\/tmp\/Orchetrace\.dmg"/);
  assert.doesNotMatch(localCask, /verified:/);
});

test("CI and release jobs gate the real npm install lifecycle", async () => {
  const [ci, release, homebrewLifecycle] = await Promise.all([
    readFile(resolve(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8"),
    readFile(resolve(import.meta.dirname, "../../.github/workflows/release.yml"), "utf8"),
    readFile(resolve(import.meta.dirname, "../smoke-homebrew-lifecycle.mjs"), "utf8"),
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
  assert.match(
    release,
    /smoke-desktop-launch\.mjs --target \$\{\{ matrix\.target \}\}/u,
  );
  assert.doesNotMatch(
    release,
    /Verify isolated macOS desktop launch/u,
  );
  assert.match(release, /xauth/u);
  assert.match(release, /xvfb/u);
  assert.match(release, /name: Homebrew installation lifecycle/u);
  assert.match(release, /smoke-homebrew-lifecycle\.mjs/u);
  assert.match(homebrewLifecycle, /brew\(\["tap-new", tapName, "--no-git"\]/u);
  assert.match(homebrewLifecycle, /brew\(\["untap", "--force", tapName\]/u);
  assert.match(release, /--baseline-root dist\/homebrew-baseline/u);
  assert.match(release, /pattern: installer-\*-apple-darwin/u);
  assert.doesNotMatch(release, /gh release download/u);
  assert.match(release, /desktop-version-lifecycle:/u);
  assert.match(release, /download-desktop-baseline\.mjs/u);
  assert.match(release, /--minimum-tag v0\.1\.0-beta\.4/u);
  assert.doesNotMatch(release, /--current-tag "\$ORCHETRACE_CURRENT_TAG"/u);
  assert.match(release, /smoke-desktop-version-lifecycle\.mjs/u);
  assert.match(release, /needs: \[release-policy, desktop, homebrew, desktop-version-lifecycle\]/u);
  assert.match(release, /Build preview installers without creating a release/u);
  assert.match(release, /ORCHETRACE_PREVIEW_VERSION: \$\{\{ inputs\.version \}\}/u);
  assert.match(release, /release-context\.mjs/u);
  assert.match(release, /release-signing-policy\.mjs/u);
  assert.match(release, /SIGNED_RELEASES_ENABLED/u);
  assert.match(release, /import-windows-certificate\.ps1/u);
  assert.match(release, /--require-trusted-signature/u);
  assert.match(release, /--signing-policy dist\/release-policy\/release-signing-policy\.json/u);
  assert.match(release, /summarize-release-candidate\.mjs/u);
  assert.match(release, /name: release-candidate-\$\{\{ github\.run_id \}\}/u);
  assert.match(release, /if: github\.ref_type == 'tag' && vars\.NPM_PUBLISH == 'true'/u);
  assert.match(release, /if: github\.ref_type == 'tag' && vars\.HOMEBREW_PUBLISH == 'true'/u);
});
