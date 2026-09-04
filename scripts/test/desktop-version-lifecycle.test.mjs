import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { smokeDesktopVersionLifecycle } from "../smoke-desktop-version-lifecycle.mjs";

test("desktop version lifecycle treats a missing baseline as the first release", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "orchetrace-first-release-"));
  const baseline = path.join(temporaryRoot, "baseline");
  try {
    await mkdir(baseline, { recursive: true });
    await writeFile(path.join(baseline, ".no-baseline"), "v0.1.0-beta.1\n");
    const result = await smokeDesktopVersionLifecycle({
      target: "aarch64-apple-darwin",
      baselineRoot: baseline,
      candidateRoot: path.join(temporaryRoot, "unused-candidate"),
    });
    assert.deepEqual(result, { skipped: true });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
