import assert from "node:assert/strict";
import test from "node:test";

import {
  hexUtf8,
  readCatalog,
  readDesktopInfo,
  readManagedIngestStatus,
  readRunSnapshot,
  startManagedIngest,
  stopManagedIngest,
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

test("managed ingest controls remain unavailable in a regular browser", async () => {
  assert.equal(await readManagedIngestStatus({ invoke: null }), null);
  assert.equal(await startManagedIngest({ invoke: null }), null);
  assert.equal(await stopManagedIngest({ invoke: null }), null);
});
