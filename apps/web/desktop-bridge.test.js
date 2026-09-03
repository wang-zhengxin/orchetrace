import assert from "node:assert/strict";
import test from "node:test";

import {
  disableClaudeHooks,
  deleteSession,
  enableClaudeHooks,
  hexUtf8,
  readCatalog,
  readClaudeIntegrationStatus,
  readDesktopInfo,
  readManagedIngestStatus,
  readStorageDiagnostics,
  readPiIntegrationStatus,
  readHarnessIntegrationStatus,
  readCodexIntegrationStatus,
  readRuntimeIntegrationStatus,
  readRunSnapshot,
  readRunTimelinePage,
  renameSession,
  startManagedIngest,
  startPiAuto,
  startHarnessAuto,
  startCodexAuto,
  startRuntimeAuto,
  startClaudeAuto,
  stopClaudeAuto,
  stopManagedIngest,
  stopPiAuto,
  stopHarnessAuto,
  stopCodexAuto,
  stopRuntimeAuto,
} from "./desktop-bridge.js";

test("native catalog IPC is preferred without issuing an HTTP request", async () => {
  const calls = [];
  const catalog = { schema_version: 1, runs: [] };
  const value = await readCatalog({
    invoke: async (command, args) => {
      calls.push([command, args]);
      return catalog;
    },
    fetcher: async () => {
      throw new Error("HTTP should not be used");
    },
  });

  assert.equal(value, catalog);
  assert.deepEqual(calls, [["read_catalog", undefined]]);
});

test("Pi, Harness, and Codex passive observers use fixed lifecycle commands", async () => {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    return { phase: command.startsWith("stop_") ? "stopped" : "running" };
  };

  assert.equal((await readPiIntegrationStatus({ invoke })).phase, "running");
  assert.equal((await startPiAuto({ invoke })).phase, "running");
  assert.equal((await stopPiAuto({ invoke })).phase, "stopped");
  assert.equal((await readHarnessIntegrationStatus({ invoke })).phase, "running");
  assert.equal((await startHarnessAuto({ invoke })).phase, "running");
  assert.equal((await stopHarnessAuto({ invoke })).phase, "stopped");
  assert.equal((await readCodexIntegrationStatus({ invoke })).phase, "running");
  assert.equal((await startCodexAuto({ invoke })).phase, "running");
  assert.equal((await stopCodexAuto({ invoke })).phase, "stopped");
  assert.deepEqual(calls, [
    ["pi_integration_status", undefined],
    ["start_pi_auto", undefined],
    ["stop_pi_auto", undefined],
    ["harness_integration_status", undefined],
    ["start_harness_auto", undefined],
    ["stop_harness_auto", undefined],
    ["codex_integration_status", undefined],
    ["start_codex_auto", undefined],
    ["stop_codex_auto", undefined],
  ]);
});

test("external runtime observers use the generic registry lifecycle commands", async () => {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    return { runtime: args.runtime, phase: command.startsWith("stop_") ? "stopped" : "running" };
  };
  assert.equal((await readRuntimeIntegrationStatus("gemini-cli", { invoke })).runtime, "gemini-cli");
  assert.equal((await startRuntimeAuto("gemini-cli", { invoke })).phase, "running");
  assert.equal((await stopRuntimeAuto("gemini-cli", { invoke })).phase, "stopped");
  assert.deepEqual(calls, [
    ["runtime_integration_status", { runtime: "gemini-cli" }],
    ["start_runtime_auto", { runtime: "gemini-cli" }],
    ["stop_runtime_auto", { runtime: "gemini-cli" }],
  ]);
});

test("missing native data falls back to the packaged HTTP asset", async () => {
  const requests = [];
  const value = await readCatalog({
    invoke: async () => {
      throw new Error("catalog not initialized");
    },
    fetcher: async (url, init) => {
      requests.push([url, init]);
      return { ok: true, json: async () => ({ schema_version: 1, runs: [{ run_id: "demo" }] }) };
    },
  });

  assert.equal(value.runs[0].run_id, "demo");
  assert.match(requests[0][0], /^\/data\/run-catalog\.json\?t=\d+$/);
  assert.deepEqual(requests[0][1], { cache: "no-store" });
});

test("run snapshot uses camelCase IPC arguments and UTF-8 hex asset names", async () => {
  const calls = [];
  await readRunSnapshot("pi/根", {
    invoke: async (command, args) => {
      calls.push([command, args]);
      return { root_session_id: "pi/根" };
    },
  });

  assert.deepEqual(calls, [["read_run_snapshot", { runId: "pi/根" }]]);
  assert.equal(hexUtf8("pi/根"), "70692fe6a0b9");
});

test("timeline pages use bounded numeric page names", async () => {
  const calls = [];
  await readRunTimelinePage("pi/根", 7, {
    invoke: async (command, args) => {
      calls.push([command, args]);
      return [];
    },
  });
  assert.deepEqual(calls, [["read_run_timeline_page", { runId: "pi/根", page: 7 }]]);
});

test("desktop info is optional outside Tauri and resilient to command failure", async () => {
  assert.equal(await readDesktopInfo({ invoke: null }), null);
  assert.equal(await readDesktopInfo({ invoke: async () => { throw new Error("not ready"); } }), null);
  assert.deepEqual(
    await readDesktopInfo({ invoke: async () => ({ shell: "tauri", platform: "macos" }) }),
    { shell: "tauri", platform: "macos" },
  );
});

test("managed ingest lifecycle uses fixed no-argument desktop commands", async () => {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    return { phase: command === "stop_managed_ingest" ? "stopped" : "running" };
  };

  assert.equal((await readManagedIngestStatus({ invoke })).phase, "running");
  assert.equal((await startManagedIngest({ invoke })).phase, "running");
  assert.equal((await stopManagedIngest({ invoke })).phase, "stopped");
  assert.deepEqual(calls, [
    ["managed_ingest_status", undefined],
    ["start_managed_ingest", undefined],
    ["stop_managed_ingest", undefined],
  ]);
});

test("storage doctor remains a read-only desktop command", async () => {
  const calls = [];
  const status = await readStorageDiagnostics({
    invoke: async (command, args) => {
      calls.push([command, args]);
      return { phase: "healthy", diagnostics: { event_count: 12 } };
    },
  });
  assert.equal(status.diagnostics.event_count, 12);
  assert.deepEqual(calls, [["storage_diagnostics", undefined]]);
  assert.equal(await readStorageDiagnostics({ invoke: null }), null);
});

test("session controls keep provider identity and credentials inside Tauri", async () => {
  const calls = [];
  const run = { runtime: "pi", source_id: "pi-local", root_session_id: "session-1" };
  const invoke = async (command, args) => {
    calls.push([command, args]);
    return { kind: command === "rename_session" ? "session.renamed" : "session.deleted" };
  };
  await renameSession(run, "Research run", { invoke });
  await deleteSession(run, { invoke });
  assert.deepEqual(calls, [
    ["rename_session", { runtime: "pi", sourceId: "pi-local", sessionId: "session-1", label: "Research run" }],
    ["delete_session", { runtime: "pi", sourceId: "pi-local", sessionId: "session-1" }],
  ]);
});

test("managed ingest controls remain unavailable in a regular browser", async () => {
  assert.equal(await readManagedIngestStatus({ invoke: null }), null);
  assert.equal(await startManagedIngest({ invoke: null }), null);
  assert.equal(await stopManagedIngest({ invoke: null }), null);
});

test("Claude integration lifecycle uses fixed no-argument desktop commands", async () => {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    return { phase: command === "stop_claude_auto" ? "stopped" : "running" };
  };

  assert.equal((await readClaudeIntegrationStatus({ invoke })).phase, "running");
  assert.equal((await startClaudeAuto({ invoke })).phase, "running");
  assert.equal((await stopClaudeAuto({ invoke })).phase, "stopped");
  assert.equal((await enableClaudeHooks({ invoke })).phase, "running");
  assert.equal((await disableClaudeHooks({ invoke })).phase, "running");
  assert.deepEqual(calls, [
    ["claude_integration_status", undefined],
    ["start_claude_auto", undefined],
    ["stop_claude_auto", undefined],
    ["enable_claude_hooks", undefined],
    ["disable_claude_hooks", undefined],
  ]);
});
