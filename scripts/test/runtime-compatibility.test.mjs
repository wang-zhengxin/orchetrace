import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { validateRuntimeCompatibility } from "../check-runtime-compatibility.mjs";

const rootDir = resolve(import.meta.dirname, "../..");

async function fixtures() {
  const [compatibility, registry, packageJson] = await Promise.all([
    readFile(resolve(rootDir, "runtimes/compatibility.json"), "utf8").then(JSON.parse),
    readFile(resolve(rootDir, "runtimes/registry.json"), "utf8").then(JSON.parse),
    readFile(resolve(rootDir, "package.json"), "utf8").then(JSON.parse),
  ]);
  return { compatibility, registry, packageJson };
}

function clone(value) {
  return structuredClone(value);
}

test("runtime compatibility matrix covers every registered runtime with repository evidence", async () => {
  const documents = await fixtures();
  const result = await validateRuntimeCompatibility({ rootDir, ...documents });
  assert.deepEqual(result, { runtimeCount: 5, formatCount: 10, evidenceCount: 30 });
});

test("runtime compatibility matrix rejects a missing registered runtime", async () => {
  const documents = await fixtures();
  const compatibility = clone(documents.compatibility);
  compatibility.runtimes.pop();
  await assert.rejects(
    validateRuntimeCompatibility({ rootDir, ...documents, compatibility }),
    /missing registered runtime: antigravity/u,
  );
});

test("runtime compatibility matrix rejects missing evidence", async () => {
  const documents = await fixtures();
  const compatibility = clone(documents.compatibility);
  compatibility.runtimes[0].formats[0].evidence[0].path = "fixtures/claude/missing.jsonl";
  await assert.rejects(
    validateRuntimeCompatibility({ rootDir, ...documents, compatibility }),
    /evidence file does not exist/u,
  );
});

test("runtime compatibility matrix rejects canonical fixture runtime drift", async () => {
  const documents = await fixtures();
  const compatibility = clone(documents.compatibility);
  compatibility.runtimes[0].formats[0].evidence[1].path =
    "fixtures/codex/canonical-events.jsonl";
  await assert.rejects(
    validateRuntimeCompatibility({ rootDir, ...documents, compatibility }),
    /declares runtime codex/u,
  );
});

test("runtime compatibility matrix rejects unknown npm test scripts", async () => {
  const documents = await fixtures();
  const compatibility = clone(documents.compatibility);
  compatibility.runtimes[0].test_scripts.push("test:missing-runtime");
  await assert.rejects(
    validateRuntimeCompatibility({ rootDir, ...documents, compatibility }),
    /unknown npm test script test:missing-runtime/u,
  );
});
