import assert from "node:assert/strict";
import test from "node:test";

import {
  compareReleaseVersions,
  releaseAssetMatchesTarget,
  selectDesktopBaseline,
} from "../download-desktop-baseline.mjs";

test("desktop baseline asset matching follows the native installer architecture", () => {
  assert.equal(releaseAssetMatchesTarget("Orchetrace_0.1.0_aarch64.dmg", "aarch64-apple-darwin"), true);
  assert.equal(releaseAssetMatchesTarget("Orchetrace_0.1.0_x64.dmg", "aarch64-apple-darwin"), false);
  assert.equal(releaseAssetMatchesTarget("Orchetrace_0.1.0_amd64.deb", "x86_64-unknown-linux-gnu"), true);
  assert.equal(releaseAssetMatchesTarget("Orchetrace_0.1.0_x64_en-US.msi", "x86_64-pc-windows-msvc"), true);
});

test("desktop baseline skips drafts and the current tag", () => {
  const asset = { name: "Orchetrace_0.1.0_aarch64.dmg", url: "asset-api" };
  const selected = selectDesktopBaseline([
    { tag_name: "nightly", draft: false, assets: [asset] },
    { tag_name: "v0.1.0-beta.5", draft: false, assets: [asset] },
    { tag_name: "v0.1.0-beta.4", draft: false, assets: [asset] },
    { tag_name: "v0.1.0-beta.3", draft: false, assets: [asset] },
  ], "v0.1.0-beta.4", "aarch64-apple-darwin");
  assert.equal(selected?.tag, "v0.1.0-beta.3");
});

test("desktop baseline orders stable and prerelease semantic versions", () => {
  assert.ok(compareReleaseVersions("v0.1.0-beta.3", "v0.1.0-beta.4") < 0);
  assert.ok(compareReleaseVersions("v0.1.0-beta.10", "v0.1.0-beta.4") > 0);
  assert.ok(compareReleaseVersions("v0.1.0", "v0.1.0-rc.1") > 0);
  assert.ok(compareReleaseVersions("v0.2.0-alpha.1", "v0.1.9") > 0);
});
