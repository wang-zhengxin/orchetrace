import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateRuntimeDiagnostics,
  diagnosticSuffix,
  runtimeVisualState,
} from "./runtime-diagnostics.js";

test("running observer exposes degraded diagnostic health", () => {
  const status = {
    phase: "running",
    diagnostics: { health: "degraded", warning_count: 2, error_count: 1 },
  };
  assert.deepEqual(runtimeVisualState(status), {
    phase: "running",
    visual: "degraded",
    warningCount: 2,
    errorCount: 1,
    lastDiagnostic: null,
  });
  assert.equal(diagnosticSuffix(status), " · 1 error");
});

test("diagnostic totals aggregate all managed processes", () => {
  assert.deepEqual(aggregateRuntimeDiagnostics([
    { diagnostics: { warning_count: 2, error_count: 0 } },
    { diagnostics: { warning_count: 1, error_count: 3 } },
    null,
  ]), { warningCount: 3, errorCount: 3 });
});
