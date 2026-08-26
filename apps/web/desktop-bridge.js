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

export function startManagedIngest(options = {}) {
  return invokeDesktop("start_managed_ingest", options);
}

export function stopManagedIngest(options = {}) {
  return invokeDesktop("stop_managed_ingest", options);
}

function invokeDesktop(command, options) {
  const invoke = options.invoke === undefined ? globalInvoke() : options.invoke;
  if (!invoke) return Promise.resolve(null);
  return invoke(command);
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

export function readLiveConfig(options) {
  return nativeFirst("read_live_config", undefined, "/data/live-config.json", options);
}

export function readLegacySnapshot(options) {
  return nativeFirst("read_legacy_snapshot", undefined, "/run-snapshot.json", options);
}

export function hexUtf8(value) {
  return Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
