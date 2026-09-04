import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateReleaseSigningPolicy,
  writeReleaseSigningPolicy,
} from "../release-signing-policy.mjs";

const completeEnvironment = {
  APPLE_CERTIFICATE: "certificate",
  APPLE_CERTIFICATE_PASSWORD: "password",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Orchetrace",
  APPLE_ID: "release@example.com",
  APPLE_PASSWORD: "app-password",
  APPLE_TEAM_ID: "TEAM",
  WINDOWS_CERTIFICATE: "certificate",
  WINDOWS_CERTIFICATE_PASSWORD: "password",
};

test("preview is intentionally unsigned even when credentials exist", () => {
  const policy = evaluateReleaseSigningPolicy({
    version: "0.1.0-beta.4",
    mode: "preview",
    signedReleasesEnabled: true,
    environment: completeEnvironment,
  });
  assert.equal(policy.channel, "preview");
  assert.equal(policy.status, "unsigned-allowed");
  assert.equal(policy.signedRelease, false);
  assert.deepEqual(policy.blockers, []);
});

test("prerelease can remain unsigned without weakening stable releases", () => {
  const policy = evaluateReleaseSigningPolicy({
    version: "0.1.0-beta.4",
    mode: "release",
    signedReleasesEnabled: false,
    environment: {},
  });
  assert.equal(policy.channel, "prerelease");
  assert.equal(policy.status, "unsigned-allowed");
  assert.deepEqual(policy.blockers, []);
});

test("explicitly requested prerelease signing fails closed when credentials are incomplete", () => {
  const policy = evaluateReleaseSigningPolicy({
    version: "0.1.0-beta.4",
    mode: "release",
    signedReleasesEnabled: true,
    environment: {},
  });
  assert.equal(policy.status, "blocked");
  assert.ok(policy.blockers.includes("APPLE_CERTIFICATE"));
  assert.ok(policy.blockers.includes("WINDOWS_CERTIFICATE"));
});

test("stable release is blocked until every platform credential is present", () => {
  const policy = evaluateReleaseSigningPolicy({
    version: "1.0.0",
    mode: "release",
    signedReleasesEnabled: true,
    environment: { ...completeEnvironment, WINDOWS_CERTIFICATE: "" },
  });
  assert.equal(policy.channel, "stable");
  assert.equal(policy.status, "blocked");
  assert.deepEqual(policy.blockers, ["WINDOWS_CERTIFICATE"]);
});

test("stable release becomes signed only with an explicit gate and complete credentials", async () => {
  const policy = evaluateReleaseSigningPolicy({
    version: "1.0.0",
    mode: "release",
    signedReleasesEnabled: true,
    environment: completeEnvironment,
  });
  assert.equal(policy.status, "signed");
  assert.equal(policy.signedRelease, true);
  const root = await mkdtemp(path.join(tmpdir(), "orchetrace-signing-policy-"));
  try {
    const report = await writeReleaseSigningPolicy(policy, root);
    assert.match(await readFile(report.markdownFile, "utf8"), /Windows Authenticode ready: `true`/u);
    assert.doesNotMatch(await readFile(report.jsonFile, "utf8"), /release@example\.com/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
