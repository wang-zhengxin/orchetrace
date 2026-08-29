import assert from "node:assert/strict";
import test from "node:test";

import { registeredRuntimeDescriptors, runtimeDescriptor } from "./runtime-registry.js";

test("registry exposes Codex and stable descriptors for known runtimes", () => {
  assert(registeredRuntimeDescriptors().some((runtime) => runtime.id === "codex"));
  assert.equal(runtimeDescriptor("codex").shortLabel, "CODEX");
});

test("unknown adapter runtimes remain displayable without a UI release", () => {
  const descriptor = runtimeDescriptor("gemini-cli");
  assert.equal(descriptor.label, "GEMINI CLI");
  assert.equal(descriptor.shortLabel, "GEMINI CLI");
});
