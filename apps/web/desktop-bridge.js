function globalInvoke() {
  return globalThis.window?.__TAURI__?.core?.invoke ?? null;
}

function globalFetch() {
  return globalThis.fetch?.bind(globalThis);
}

async function nativeFirst(command, args, assetPath, options = {}) {
  const invoke = options.invoke === undefined ? globalInvoke() : options.invoke;
  if (invoke) {
    try {
      return await invoke(command, args);
    } catch {
      // A new desktop install may not have a native catalog yet. The packaged
      // fixture remains a useful, deterministic first-run experience.
    }
  }

  const fetcher = options.fetcher ?? globalFetch();
  if (!fetcher) throw new Error(`No transport is available for ${assetPath}`);
  const separator = assetPath.includes("?") ? "&" : "?";
  const response = await fetcher(`${assetPath}${separator}t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${assetPath} HTTP ${response.status}`);
  return response.json();
}

export async function readDesktopInfo(options = {}) {
  const invoke = options.invoke === undefined ? globalInvoke() : options.invoke;
  if (!invoke) return null;
  try {
    return await invoke("desktop_info");
  } catch {
    return null;
  }
}

export function readManagedIngestStatus(options = {}) {
  return invokeDesktop("managed_ingest_status", options);
}

export function readStorageDiagnostics(options = {}) {
  return invokeDesktop("storage_diagnostics", options);
}

export function startManagedIngest(options = {}) {
  return invokeDesktop("start_managed_ingest", options);
}

export function stopManagedIngest(options = {}) {
  return invokeDesktop("stop_managed_ingest", options);
}

export function renameSession(run, label, options = {}) {
  return invokeDesktop("rename_session", options, {
    runtime: run.runtime,
    sourceId: run.source_id,
    sessionId: run.root_session_id,
    label,
  });
}

export function deleteSession(run, options = {}) {
  return invokeDesktop("delete_session", options, {
    runtime: run.runtime,
    sourceId: run.source_id,
    sessionId: run.root_session_id,
  });
}

export function readClaudeIntegrationStatus(options = {}) {
  return invokeDesktop("claude_integration_status", options);
}

export function startClaudeAuto(options = {}) {
  return invokeDesktop("start_claude_auto", options);
}

export function stopClaudeAuto(options = {}) {
  return invokeDesktop("stop_claude_auto", options);
}

export function enableClaudeHooks(options = {}) {
  return invokeDesktop("enable_claude_hooks", options);
}

export function disableClaudeHooks(options = {}) {
  return invokeDesktop("disable_claude_hooks", options);
}

export function readPiIntegrationStatus(options = {}) {
  return invokeDesktop("pi_integration_status", options);
}

export function startPiAuto(options = {}) {
  return invokeDesktop("start_pi_auto", options);
}

export function stopPiAuto(options = {}) {
  return invokeDesktop("stop_pi_auto", options);
}

export function readHarnessIntegrationStatus(options = {}) {
  return invokeDesktop("harness_integration_status", options);
}

export function startHarnessAuto(options = {}) {
  return invokeDesktop("start_harness_auto", options);
}

export function stopHarnessAuto(options = {}) {
  return invokeDesktop("stop_harness_auto", options);
}

export function readCodexIntegrationStatus(options = {}) {
  return invokeDesktop("codex_integration_status", options);
}

export function startCodexAuto(options = {}) {
  return invokeDesktop("start_codex_auto", options);
}

export function stopCodexAuto(options = {}) {
  return invokeDesktop("stop_codex_auto", options);
}

export function readRuntimeIntegrationStatus(runtime, options = {}) {
  return invokeDesktop("runtime_integration_status", options, { runtime });
}

export function startRuntimeAuto(runtime, options = {}) {
  return invokeDesktop("start_runtime_auto", options, { runtime });
}

export function stopRuntimeAuto(runtime, options = {}) {
  return invokeDesktop("stop_runtime_auto", options, { runtime });
}

function invokeDesktop(command, options, args) {
  const invoke = options.invoke === undefined ? globalInvoke() : options.invoke;
  if (!invoke) return Promise.resolve(null);
  return invoke(command, args);
}

export function readCatalog(options) {
  return nativeFirst("read_catalog", undefined, "/data/run-catalog.json", options);
}

export function readRunSnapshot(runId, options) {
  return nativeFirst(
    "read_run_snapshot",
    { runId },
    `/data/runs/run-${hexUtf8(runId)}.json`,
    options,
  );
}

export function readRunDelta(runId, options) {
  return nativeFirst(
    "read_run_delta",
    { runId },
    `/data/deltas/run-${hexUtf8(runId)}.json`,
    options,
  );
}

export function readRunTimelinePage(runId, page, options) {
  const pageName = String(page).padStart(6, "0");
  return nativeFirst(
    "read_run_timeline_page",
    { runId, page },
    `/data/timelines/run-${hexUtf8(runId)}/page-${pageName}.json`,
    options,
  );
}

export function readLiveConfig(options) {
  return nativeFirst("read_live_config", undefined, "/data/live-config.json", options);
}

export function readLegacySnapshot(options) {
  return nativeFirst("read_legacy_snapshot", undefined, "/run-snapshot.json", options);
}

export function hexUtf8(value) {
  return Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
