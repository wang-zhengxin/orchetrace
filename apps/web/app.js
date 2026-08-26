import { applyRunSnapshotDelta } from "./run-delta.js";
import {
  readCatalog,
  readDesktopInfo,
  readLegacySnapshot,
  readLiveConfig,
  readManagedIngestStatus,
  readRunDelta,
  readRunSnapshot,
  startManagedIngest,
  stopManagedIngest,
} from "./desktop-bridge.js";

const STATUS = {
  running: { glyph: "●", label: "RUNNING" },
  idle: { glyph: "○", label: "IDLE" },
  waiting: { glyph: "◐", label: "WAITING" },
  ready: { glyph: "◆", label: "READY" },
  inactive: { glyph: "■", label: "INACTIVE" },
  unknown: { glyph: "?", label: "UNKNOWN" },
  succeeded: { glyph: "✓", label: "DONE" },
  failed: { glyph: "✕", label: "FAILED" },
  interrupted: { glyph: "■", label: "STOPPED" },
  cancelled: { glyph: "■", label: "CANCELLED" },
  unavailable: { glyph: "?", label: "UNAVAILABLE" },
};

const state = {
  catalog: null,
  currentRunId: null,
  loadedRunId: null,
  snapshot: null,
  selectedId: null,
  query: "",
  status: "all",
  zoom: 1,
  positions: new Map(),
  graphWidth: 830,
  graphHeight: 400,
  mode: "replay",
  liveTransport: null,
  liveEpoch: 0,
  socket: null,
  pollTimer: null,
  reconnectTimer: null,
  liveRefreshTimer: null,
  pendingDeltaRunIds: new Set(),
  desktopInfo: null,
  managedIngest: null,
  runtimeDrawerOpen: false,
  runtimePollTimer: null,
  runtimeBusy: false,
};

const refs = Object.fromEntries(
  [
    "app",
    "search",
    "status-filter",
    "graph-summary",
    "graph-viewport",
    "graph-spacer",
    "graph-stage",
    "edge-layer",
    "node-layer",
    "zoom-out",
    "zoom-in",
    "zoom-value",
    "fit-graph",
    "inspector-empty",
    "inspector-content",
    "timeline-range",
    "timeline-ruler",
    "timeline-lanes",
    "run-list",
    "active-run-name",
    "source-dsh",
    "source-claude",
    "source-pi",
    "source-count-dsh",
    "source-count-claude",
    "source-count-pi",
    "index-state",
    "fatal-state",
    "fatal-message",
    "connection-health",
    "health-label",
    "brand-channel",
    "drawer-scrim",
    "runtime-drawer",
    "runtime-close",
    "runtime-phase",
    "runtime-summary",
    "runtime-error",
    "managed-ingest-action",
    "runtime-ingest-endpoint",
    "runtime-live-endpoint",
    "runtime-pid",
    "runtime-data-dir",
    "runtime-token-value",
    "runtime-token-copy",
    "runtime-source-dsh",
    "runtime-source-claude",
    "runtime-source-pi",
    "runtime-log-list",
  ].map((id) => [camel(id), document.getElementById(id)]),
);

boot();

async function boot() {
  wireInteractions();
  try {
    await initializeShell();
    await refreshCatalog(true);
    fitGraph();
    refs.app.removeAttribute("aria-busy");
  } catch (error) {
    refs.app.classList.add("is-unavailable");
    refs.fatalState.hidden = false;
    refs.fatalMessage.textContent = `${String(error)}. Generate the fixture snapshot before starting the UI.`;
  }
}

async function initializeShell() {
  const info = await readDesktopInfo();
  state.desktopInfo = info;
  if (!info) {
    renderManagedIngest(null);
    return;
  }
  document.documentElement.dataset.shell = info.shell;
  document.documentElement.dataset.platform = info.platform;
  refs.brandChannel.textContent = "/ DESKTOP";
  refs.brandChannel.title = info.native_catalog
    ? `Native data · ${info.data_dir}`
    : "Packaged demo · native data directory is empty";
  await refreshManagedIngest();
}

function wireInteractions() {
  refs.search.addEventListener("input", () => {
    state.query = refs.search.value.trim().toLowerCase();
    renderGraph();
  });
  refs.statusFilter.addEventListener("change", () => {
    state.status = refs.statusFilter.value;
    renderGraph();
  });
  refs.zoomIn.addEventListener("click", () => setZoom(state.zoom + 0.1));
  refs.zoomOut.addEventListener("click", () => setZoom(state.zoom - 0.1));
  refs.fitGraph.addEventListener("click", fitGraph);
  refs.connectionHealth.addEventListener("click", openRuntimeDrawer);
  refs.runtimeClose.addEventListener("click", closeRuntimeDrawer);
  refs.drawerScrim.addEventListener("click", closeRuntimeDrawer);
  refs.managedIngestAction.addEventListener("click", () => void toggleManagedIngest());
  refs.runtimeTokenCopy.addEventListener("click", () => void copyManagedToken());
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      refs.search.focus();
    }
    if (event.key === "Escape" && state.runtimeDrawerOpen) closeRuntimeDrawer();
  });
  document.querySelectorAll(".mode-button").forEach((button) => {
    button.addEventListener("click", () => activateMode(button.dataset.mode));
  });
  document.addEventListener("visibilitychange", () => {
    if (state.mode === "live" && !document.hidden) {
      void refreshCatalog(false);
      if (!state.socket && !state.reconnectTimer) scheduleLiveReconnect(state.liveEpoch);
    }
  });
  window.addEventListener("beforeunload", () => {
    stopLiveTransport();
    stopRuntimePolling();
  });
}

function activateMode(mode) {
  document.querySelectorAll(".mode-button").forEach((item) => {
    item.classList.toggle("active", item.dataset.mode === mode);
  });
  setMode(mode);
}

function openRuntimeDrawer() {
  state.runtimeDrawerOpen = true;
  refs.runtimeDrawer.hidden = false;
  refs.drawerScrim.hidden = false;
  refs.connectionHealth.setAttribute("aria-expanded", "true");
  void refreshManagedIngest();
  if (!state.runtimePollTimer) {
    state.runtimePollTimer = setInterval(() => void refreshManagedIngest(), 1500);
  }
}

function closeRuntimeDrawer() {
  state.runtimeDrawerOpen = false;
  refs.runtimeDrawer.hidden = true;
  refs.drawerScrim.hidden = true;
  refs.connectionHealth.setAttribute("aria-expanded", "false");
  stopRuntimePolling();
  refs.connectionHealth.focus();
}

function stopRuntimePolling() {
  if (state.runtimePollTimer) clearInterval(state.runtimePollTimer);
  state.runtimePollTimer = null;
}

async function refreshManagedIngest() {
  if (!state.desktopInfo) {
    renderManagedIngest(null);
    return;
  }
  try {
    const status = await readManagedIngestStatus();
    state.managedIngest = status;
    renderManagedIngest(status);
    setRuntimeError("");
  } catch (error) {
    setRuntimeError(String(error));
  }
}

async function toggleManagedIngest() {
  if (state.runtimeBusy || !state.desktopInfo) return;
  state.runtimeBusy = true;
  refs.managedIngestAction.disabled = true;
  refs.managedIngestAction.textContent = "WORKING…";
  setRuntimeError("");
  try {
    const running = state.managedIngest?.phase === "running";
    const status = running ? await stopManagedIngest() : await startManagedIngest();
    state.managedIngest = status;
    renderManagedIngest(status);
    if (status?.phase === "running") activateMode("live");
    else if (state.mode === "live") activateMode("replay");
  } catch (error) {
    setRuntimeError(String(error));
    await refreshManagedIngest();
  } finally {
    state.runtimeBusy = false;
    renderManagedIngest(state.managedIngest);
  }
}

async function copyManagedToken() {
  const token = state.managedIngest?.connection_token;
  if (!token) return;
  try {
    await navigator.clipboard.writeText(token);
    refs.runtimeTokenCopy.textContent = "COPIED";
    setTimeout(() => {
      refs.runtimeTokenCopy.textContent = "COPY";
    }, 1200);
  } catch (error) {
    setRuntimeError(`Clipboard unavailable: ${String(error)}`);
  }
}

function renderManagedIngest(status) {
  const phase = status?.phase ?? "browser";
  const labels = {
    running: "RUNNING",
    stopped: "STOPPED",
    exited: "EXITED",
    unavailable: "UNAVAILABLE",
    browser: "BROWSER MODE",
  };
  refs.runtimePhase.className = `runtime-phase ${phase}`;
  refs.runtimePhase.querySelector("b").textContent = labels[phase] ?? phase.toUpperCase();

  const summaries = {
    running: "Local ingest owns the loopback fact and live-update endpoints.",
    stopped: "The local service is ready to start with a fresh adapter token.",
    exited: `The managed process exited${status?.last_exit_code == null ? "" : ` with code ${status.last_exit_code}`}.`,
    unavailable: "Build the otrace sidecar or configure ORCHETRACE_CLI_PATH.",
    browser: "Runtime lifecycle controls are available in the Tauri desktop shell.",
  };
  refs.runtimeSummary.textContent = summaries[phase] ?? "Runtime state is unavailable.";

  const running = phase === "running";
  refs.managedIngestAction.hidden = phase === "browser";
  refs.managedIngestAction.disabled = state.runtimeBusy || phase === "unavailable";
  refs.managedIngestAction.textContent = state.runtimeBusy
    ? "WORKING…"
    : running
      ? "STOP INGEST"
      : "START INGEST";
  refs.runtimeIngestEndpoint.textContent = status?.ingest_endpoint ?? "—";
  refs.runtimeLiveEndpoint.textContent = status?.live_endpoint ?? "—";
  refs.runtimePid.textContent = status?.pid ? `${status.pid} · LOCAL` : "—";
  refs.runtimeDataDir.textContent = status?.data_dir ?? state.desktopInfo?.data_dir ?? "—";
  refs.runtimeDataDir.title = refs.runtimeDataDir.textContent;

  const token = status?.connection_token;
  refs.runtimeTokenValue.textContent = token ? `•••••••••••• · ${token.slice(-8)}` : "NOT ISSUED";
  refs.runtimeTokenCopy.disabled = !token;
  renderRuntimeSources();
  renderRuntimeLogs(status?.logs ?? []);
}

function renderRuntimeSources() {
  const counts = { "deepseek-harness": new Set(), "claude-code": new Set(), pi: new Set() };
  for (const run of state.catalog?.runs ?? []) {
    counts[run.runtime]?.add(run.source_id);
  }
  refs.runtimeSourceDsh.textContent = String(counts["deepseek-harness"].size);
  refs.runtimeSourceClaude.textContent = String(counts["claude-code"].size);
  refs.runtimeSourcePi.textContent = String(counts.pi.size);
}

function renderRuntimeLogs(logs) {
  refs.runtimeLogList.replaceChildren();
  if (logs.length === 0) {
    const empty = document.createElement("li");
    empty.className = "runtime-log-empty";
    empty.textContent = "No managed process activity.";
    refs.runtimeLogList.append(empty);
    return;
  }
  for (const log of logs.slice().reverse()) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = formatClock(Number(log.at_ms));
    const stream = document.createElement("b");
    stream.textContent = log.stream;
    const message = document.createElement("span");
    message.textContent = log.message;
    item.append(time, stream, message);
    refs.runtimeLogList.append(item);
  }
}

function setRuntimeError(message) {
  refs.runtimeError.hidden = !message;
  refs.runtimeError.textContent = message;
}

function setMode(mode) {
  state.mode = mode === "live" ? "live" : "replay";
  stopLiveTransport();
  if (state.mode === "live") {
    setHealth("syncing", "SYNCING");
    const epoch = state.liveEpoch;
    void startLiveTransport(epoch);
  } else {
    setHealth("replay", "REPLAY");
  }
}

function stopLiveTransport() {
  state.liveEpoch += 1;
  state.liveTransport = null;
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  if (state.liveRefreshTimer) clearTimeout(state.liveRefreshTimer);
  state.pollTimer = null;
  state.reconnectTimer = null;
  state.liveRefreshTimer = null;
  state.pendingDeltaRunIds.clear();
  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
    state.socket = null;
  }
}

async function startLiveTransport(epoch) {
  await refreshCatalog(false);
  if (state.mode !== "live" || epoch !== state.liveEpoch) return;
  try {
    const config = await readLiveConfig();
    if (!config.enabled || !config.websocket_url || !config.token) {
      throw new Error("live WebSocket is disabled");
    }
    connectLiveSocket(config, epoch);
  } catch {
    enablePollingFallback(epoch);
  }
}

function connectLiveSocket(config, epoch) {
  if (state.mode !== "live" || epoch !== state.liveEpoch) return;
  const socket = new WebSocket(config.websocket_url);
  state.socket = socket;
  socket.addEventListener("open", () => {
    if (socket !== state.socket || epoch !== state.liveEpoch) return;
    socket.send(JSON.stringify({ kind: "hello", protocol: 1, token: config.token }));
  });
  socket.addEventListener("message", (event) => {
    if (socket !== state.socket || epoch !== state.liveEpoch) return;
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      socket.close(1002, "invalid JSON frame");
      return;
    }
    if (frame.kind === "ready" && frame.protocol === 1) {
      state.liveTransport = "websocket";
      if (state.pollTimer) clearInterval(state.pollTimer);
      state.pollTimer = null;
      setHealth("live", "STREAMING");
      void refreshCatalog(false);
    } else if (frame.kind === "catalog.updated") {
      scheduleCatalogRefresh(frame);
    } else if (frame.kind === "error") {
      socket.close(1008, "server rejected live session");
    }
  });
  socket.addEventListener("close", () => {
    if (socket !== state.socket || epoch !== state.liveEpoch) return;
    state.socket = null;
    enablePollingFallback(epoch);
    scheduleLiveReconnect(epoch);
  });
  socket.addEventListener("error", () => {
    if (socket === state.socket) setHealth("degraded", "RETRYING");
  });
}

function scheduleCatalogRefresh(frame) {
  if (frame?.delta_schema_version === 1 && Array.isArray(frame.updated_run_ids)) {
    for (const runId of frame.updated_run_ids) state.pendingDeltaRunIds.add(runId);
  }
  if (state.liveRefreshTimer) return;
  state.liveRefreshTimer = setTimeout(() => {
    state.liveRefreshTimer = null;
    const deltaRunIds = new Set(state.pendingDeltaRunIds);
    state.pendingDeltaRunIds.clear();
    if (state.mode === "live" && !document.hidden) void refreshCatalog(false, deltaRunIds);
  }, 75);
}

function enablePollingFallback(epoch) {
  if (state.mode !== "live" || epoch !== state.liveEpoch) return;
  state.liveTransport = "polling";
  setHealth("polling", "POLLING");
  if (!state.pollTimer) {
    state.pollTimer = setInterval(() => {
      if (!document.hidden) void refreshCatalog(false);
    }, 5000);
  }
  scheduleLiveReconnect(epoch);
}

function scheduleLiveReconnect(epoch) {
  if (state.mode !== "live" || epoch !== state.liveEpoch || state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.mode === "live" && epoch === state.liveEpoch && !state.socket) {
      void startLiveTransport(epoch);
    }
  }, 5000);
}

function restoreLiveHealth() {
  if (state.mode !== "live") return;
  if (state.liveTransport === "websocket") setHealth("live", "STREAMING");
  else if (state.liveTransport === "polling") setHealth("polling", "POLLING");
  else setHealth("syncing", "SYNCING");
}

async function refreshCatalog(initial, deltaRunIds = null) {
  try {
    let catalog;
    try {
      catalog = await readCatalog();
    } catch (error) {
      if (initial) return loadLegacySnapshot();
      throw error;
    }
    if (!Array.isArray(catalog.runs) || catalog.runs.length === 0) {
      throw new Error("Run catalog is empty");
    }
    state.catalog = catalog;
    if (!catalog.runs.some((run) => run.run_id === state.currentRunId)) {
      state.currentRunId = catalog.runs[0].run_id;
    }
    const summary = currentRunSummary();
    const changed =
      state.loadedRunId !== state.currentRunId ||
      !state.snapshot ||
      summary.event_count !== state.snapshot.event_count ||
      summary.last_activity_at !== state.snapshot.last_activity_at;
    if (changed) {
      const deltaApplied =
        !initial &&
        state.loadedRunId === state.currentRunId &&
        deltaRunIds?.has(state.currentRunId) &&
        (await loadRunDelta(state.currentRunId, summary.event_count));
      if (!deltaApplied) await loadRunSnapshot(state.currentRunId, !initial);
    }
    else renderRunRail();
    restoreLiveHealth();
    refs.fatalState.hidden = true;
  } catch (error) {
    if (state.mode === "live") setHealth("degraded", "STALE");
    if (initial) throw error;
  }
}

async function loadLegacySnapshot() {
  const snapshot = await readLegacySnapshot();
  const root = snapshot.agents.find((agent) => agent.id === snapshot.root_session_id);
  state.currentRunId = "legacy";
  state.catalog = {
    schema_version: 1,
    runs: [
      {
        run_id: "legacy",
        root_session_id: snapshot.root_session_id,
        source_id: "fixture",
        runtime: snapshot.runtimes[0],
        label: root?.label ?? snapshot.root_session_id,
        status: root?.status ?? "unknown",
        outcome: root?.outcome,
        agent_count: snapshot.agents.length,
        edge_count: snapshot.edges.length,
        event_count: snapshot.event_count,
        started_at: snapshot.started_at,
        last_activity_at: snapshot.last_activity_at,
      },
    ],
  };
  applySnapshot(snapshot, "legacy", false);
}

async function loadRunSnapshot(runId, highlight) {
  applySnapshot(await readRunSnapshot(runId), runId, highlight);
}

async function loadRunDelta(runId, targetEventCount) {
  try {
    const delta = await readRunDelta(runId);
    if (delta.run_id !== runId || delta.target_event_count !== targetEventCount) return false;
    const snapshot = applyRunSnapshotDelta(state.snapshot, delta);
    if (!snapshot) return false;
    applySnapshot(snapshot, runId, true, "delta");
    return true;
  } catch {
    return false;
  }
}

function applySnapshot(snapshot, runId, highlight, delivery = "snapshot") {
    const hadSnapshot = Boolean(state.snapshot);
    state.snapshot = snapshot;
    state.loadedRunId = runId;
    refs.app.dataset.delivery = delivery;
  if (!snapshot.agents.some((agent) => agent.id === state.selectedId)) {
    state.selectedId = snapshot.root_session_id;
  }
  layoutGraph();
  render();
  if (highlight && hadSnapshot) refs.graphViewport.classList.add("snapshot-updated");
  setTimeout(() => refs.graphViewport.classList.remove("snapshot-updated"), 420);
}

async function selectRun(runId) {
  if (runId === state.currentRunId && runId === state.loadedRunId) return;
  state.currentRunId = runId;
  renderRunRail();
  try {
    await loadRunSnapshot(runId, true);
    fitGraph();
    restoreLiveHealth();
  } catch (error) {
    setHealth("degraded", "STALE");
    refs.fatalState.hidden = false;
    refs.fatalMessage.textContent = `Unable to open run: ${String(error)}`;
  }
}

function setHealth(stateName, label) {
  refs.connectionHealth.className = `connection-health ${stateName}`;
  refs.healthLabel.textContent = label;
}

function render() {
  const { snapshot } = state;
  renderRunRail();
  refs.graphSummary.textContent = `${snapshot.agents.length} agents · ${snapshot.edges.length} delegations · ${snapshot.event_count} canonical events`;
  renderGraph();
  renderInspector();
  renderTimeline();
}

function renderRunRail() {
  if (!state.catalog) return;
  refs.runList.replaceChildren();
  const current = currentRunSummary();
  refs.activeRunName.textContent = `${runtimeLabel(current.runtime)} / ${current.label}`;
  for (const run of state.catalog.runs) {
    const visualState = run.outcome ?? run.status ?? "unknown";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "run-entry";
    if (run.run_id === state.currentRunId) button.classList.add("active");
    button.setAttribute("aria-pressed", String(run.run_id === state.currentRunId));

    const line = document.createElement("span");
    line.className = "run-entry-line";
    const pin = document.createElement("i");
    pin.className = `status-pin ${visualState}`;
    const title = document.createElement("strong");
    title.textContent = run.label;
    line.append(pin, title);

    const meta = document.createElement("span");
    meta.className = "run-entry-meta";
    const runtime = document.createElement("span");
    runtime.textContent = runtimeLabel(run.runtime);
    const time = document.createElement("time");
    time.textContent = run.last_activity_at ? formatClock(Date.parse(run.last_activity_at)) : "—";
    meta.append(runtime, time);

    const stats = document.createElement("span");
    stats.className = "run-entry-stats";
    const agents = document.createElement("b");
    agents.textContent = `${run.agent_count} agents`;
    const events = document.createElement("b");
    events.textContent = `${run.event_count} events`;
    stats.append(agents, events);

    button.append(line, meta, stats);
    button.addEventListener("click", () => void selectRun(run.run_id));
    refs.runList.append(button);
  }
  renderSources();
}

function renderSources() {
  const sourceIds = new Map([
    ["deepseek-harness", new Set()],
    ["claude-code", new Set()],
    ["pi", new Set()],
  ]);
  for (const run of state.catalog.runs) {
    if (sourceIds.has(run.runtime)) sourceIds.get(run.runtime).add(run.source_id);
  }
  const values = [
    [refs.sourceDsh, refs.sourceCountDsh, sourceIds.get("deepseek-harness").size],
    [refs.sourceClaude, refs.sourceCountClaude, sourceIds.get("claude-code").size],
    [refs.sourcePi, refs.sourceCountPi, sourceIds.get("pi").size],
  ];
  for (const [row, countElement, count] of values) {
    countElement.textContent = String(count);
    row.classList.toggle("muted", count === 0);
  }
  const pending = state.catalog.pending_event_count ?? 0;
  refs.indexState.textContent = pending ? `${pending} PENDING` : "LOCAL ONLY";
  refs.indexState.classList.toggle("warning", pending > 0);
  renderRuntimeSources();
}

function currentRunSummary() {
  return state.catalog.runs.find((run) => run.run_id === state.currentRunId) ?? state.catalog.runs[0];
}

function layoutGraph() {
  const { snapshot } = state;
  const byId = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const children = new Map(snapshot.agents.map((agent) => [agent.id, []]));
  for (const agent of snapshot.agents) {
    if (agent.parent_id && children.has(agent.parent_id)) children.get(agent.parent_id).push(agent.id);
  }
  for (const list of children.values()) {
    list.sort((a, b) => {
      const left = byId.get(a);
      const right = byId.get(b);
      return `${left.started_at ?? ""}${left.id}`.localeCompare(`${right.started_at ?? ""}${right.id}`);
    });
  }

  let leaf = 0;
  let maxDepth = 0;
  const positions = new Map();
  const place = (id, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    const childIds = children.get(id) ?? [];
    let y;
    if (childIds.length === 0) {
      y = 76 + leaf * 148;
      leaf += 1;
    } else {
      const childYs = childIds.map((child) => place(child, depth + 1));
      y = childYs.reduce((sum, value) => sum + value, 0) / childYs.length;
    }
    positions.set(id, { x: 62 + depth * 250, y, depth });
    return y;
  };
  place(snapshot.root_session_id, 0);
  for (const agent of snapshot.agents) {
    if (!positions.has(agent.id)) place(agent.id, 0);
  }
  state.positions = positions;
  state.graphWidth = Math.max(760, 80 + (maxDepth + 1) * 250);
  state.graphHeight = Math.max(400, 92 + Math.max(leaf, 1) * 148);
}

function renderGraph() {
  if (!state.snapshot) return;
  refs.nodeLayer.replaceChildren();
  refs.edgeLayer.replaceChildren();
  refs.edgeLayer.setAttribute("viewBox", `0 0 ${state.graphWidth} ${state.graphHeight}`);
  refs.edgeLayer.setAttribute("width", state.graphWidth);
  refs.edgeLayer.setAttribute("height", state.graphHeight);
  refs.graphStage.style.width = `${state.graphWidth}px`;
  refs.graphStage.style.height = `${state.graphHeight}px`;
  applyZoom();

  const selected = state.snapshot.agents.find((agent) => agent.id === state.selectedId);
  const related = selected ? lineageSet(selected.id) : new Set();

  for (const edge of state.snapshot.edges) {
    const from = state.positions.get(edge.parent_id);
    const to = state.positions.get(edge.child_id);
    if (!from || !to) continue;
    const x1 = from.x + 224;
    const y1 = from.y + 46;
    const x2 = to.x;
    const y2 = to.y + 46;
    const bend = Math.max(52, (x2 - x1) * 0.48);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.classList.add("agent-edge");
    if (edge.opaque) path.classList.add("opaque");
    if (related.has(edge.parent_id) && related.has(edge.child_id)) path.classList.add("selected-path");
    const target = state.snapshot.agents.find((agent) => agent.id === edge.child_id);
    if (target?.status === "running") path.classList.add("active-flow");
    refs.edgeLayer.append(path);
  }

  for (const agent of state.snapshot.agents) {
    const position = state.positions.get(agent.id);
    const visualState = primaryState(agent);
    const meta = STATUS[visualState] ?? STATUS.unknown;
    const matches = matchesFilter(agent);
    const node = document.createElement("button");
    node.type = "button";
    node.className = `agent-node state-${visualState}`;
    if (agent.id === state.selectedId) node.classList.add("selected");
    if (!matches) node.classList.add("filtered-out");
    if (agent.detail_level === "opaque") node.classList.add("opaque");
    node.style.left = `${position.x}px`;
    node.style.top = `${position.y}px`;
    node.setAttribute(
      "aria-label",
      `${agent.label}, ${meta.label.toLowerCase()}, ${agent.tool_count} tool calls`,
    );

    const status = document.createElement("span");
    status.className = `node-status status-symbol ${visualState}`;
    status.textContent = meta.glyph;
    const title = document.createElement("strong");
    title.className = "node-title";
    title.textContent = agent.label;
    const duration = document.createElement("time");
    duration.className = "node-duration";
    duration.textContent = formatDuration(agent.started_at, agent.last_activity_at);
    const provider = document.createElement("span");
    provider.className = "node-provider";
    provider.textContent = `${shortRuntime(state.snapshot.runtimes[0])} · ${agent.model ?? agent.provider ?? "unknown"}`;
    const activity = document.createElement("span");
    activity.className = "node-activity";
    activity.textContent = agent.current_tool ?? lastTool(agent)?.name ?? agent.role ?? agent.mode;
    const count = document.createElement("span");
    count.className = "node-count";
    count.textContent = agent.failed_tool_count
      ? `${agent.failed_tool_count} failed`
      : `${agent.tool_count} calls`;
    const evidence = document.createElement("span");
    evidence.className = "node-state-label";
    evidence.textContent = meta.label;

    node.append(status, title, duration, provider, activity, count, evidence);
    node.addEventListener("click", () => {
      state.selectedId = agent.id;
      renderGraph();
      renderInspector();
    });
    refs.nodeLayer.append(node);
  }
}

function renderInspector() {
  if (!state.snapshot || !state.selectedId) return;
  const agent = state.snapshot.agents.find((item) => item.id === state.selectedId);
  if (!agent) return;
  refs.inspectorEmpty.hidden = true;
  refs.inspectorContent.hidden = false;
  const visualState = primaryState(agent);
  const meta = STATUS[visualState] ?? STATUS.unknown;
  const parent = state.snapshot.agents.find((item) => item.id === agent.parent_id);
  const recentTools = [...agent.tools].reverse().slice(0, 4);

  refs.inspectorContent.innerHTML = `
    <div class="inspector-header">
      <span class="eyebrow">AGENT INSPECTOR</span>
      <span class="detail-badge">${escapeHtml(agent.detail_level)}</span>
      <h1>${escapeHtml(agent.label)}</h1>
      <div class="inspector-state state-${escapeHtml(visualState)}">
        <i class="status-symbol ${escapeHtml(visualState)}">${meta.glyph}</i>
        <strong>${meta.label}</strong>
        <span>${escapeHtml(agent.mode)}</span>
        ${agent.outcome && agent.outcome !== visualState ? `<span>LAST ${escapeHtml(agent.outcome)}</span>` : ""}
      </div>
    </div>
    <dl class="fact-grid">
      <div><dt>ROLE</dt><dd>${escapeHtml(agent.role ?? "—")}</dd></div>
      <div><dt>MODEL</dt><dd>${escapeHtml(agent.model ?? "—")}</dd></div>
      <div><dt>PARENT</dt><dd>${escapeHtml(parent?.label ?? "ROOT")}</dd></div>
      <div><dt>ACTIVATIONS</dt><dd>${agent.activations.length}</dd></div>
      <div><dt>TOOL CALLS</dt><dd>${agent.tool_count}</dd></div>
      <div><dt>FAILURES</dt><dd class="${agent.failed_tool_count ? "danger" : ""}">${agent.failed_tool_count}</dd></div>
    </dl>
    <section class="evidence-block">
      <div class="section-title"><span>STATUS EVIDENCE</span><b>${agent.outcome ? "OUTCOME RECORDED" : "ACTIVITY ONLY"}</b></div>
      <p>${escapeHtml(agent.outcome_evidence ?? `Latest runtime activity state is ${agent.status}; no terminal outcome was inferred.`)}</p>
    </section>
    <section class="tool-list">
      <div class="section-title"><span>RECENT TOOLS</span><b>${agent.tools.length}</b></div>
      ${
        recentTools.length
          ? recentTools
              .map((tool) => {
                const toolState = tool.outcome ?? (tool.ended_at ? "succeeded" : "running");
                const toolMeta = STATUS[toolState] ?? STATUS.unknown;
                return `<article class="tool-row">
                  <i class="status-symbol ${toolState}">${toolMeta.glyph}</i>
                  <div><strong>${escapeHtml(tool.name)}</strong><span>${escapeHtml(tool.input_summary ?? tool.output_summary ?? "No summary")}</span></div>
                  <time>${tool.duration_ms ? formatMillis(tool.duration_ms) : "—"}</time>
                </article>`;
              })
              .join("")
          : `<p class="empty-copy">No tool calls recorded.</p>`
      }
    </section>
    <section class="source-block">
      <div class="section-title"><span>SOURCE IDENTITY</span></div>
      <code>${escapeHtml(agent.id)}</code>
    </section>
  `;
}

function renderTimeline() {
  if (!state.snapshot) return;
  refs.timelineLanes.replaceChildren();
  refs.timelineRuler.replaceChildren();
  const start = Date.parse(state.snapshot.started_at);
  const end = Date.parse(state.snapshot.last_activity_at);
  const span = Math.max(1, end - start);
  refs.timelineRange.textContent = `${formatClock(start)} — ${formatClock(end)} · ${formatMillis(span)}`;

  for (let index = 0; index <= 4; index += 1) {
    const tick = document.createElement("span");
    tick.style.left = `${index * 25}%`;
    tick.textContent = `+${formatMillis((span * index) / 4)}`;
    refs.timelineRuler.append(tick);
  }

  for (const agent of state.snapshot.agents) {
    const lane = document.createElement("button");
    lane.type = "button";
    lane.className = "timeline-lane";
    if (agent.id === state.selectedId) lane.classList.add("selected");
    const label = document.createElement("span");
    label.className = "lane-label";
    label.textContent = agent.label;
    const track = document.createElement("span");
    track.className = "lane-track";

    for (const activation of agent.activations) {
      const block = intervalBlock(
        activation.started_at,
        activation.ended_at ?? state.snapshot.last_activity_at,
        start,
        span,
        "activation-block",
      );
      track.append(block);
    }
    for (const tool of agent.tools) {
      const block = intervalBlock(
        tool.started_at ?? tool.ended_at ?? agent.started_at,
        tool.ended_at ?? state.snapshot.last_activity_at,
        start,
        span,
        `tool-block ${tool.outcome === "failed" ? "failed" : ""}`,
      );
      block.title = `${tool.name} · ${tool.outcome ?? "running"}`;
      track.append(block);
    }
    lane.append(label, track);
    lane.addEventListener("click", () => {
      state.selectedId = agent.id;
      renderGraph();
      renderInspector();
      renderTimeline();
    });
    refs.timelineLanes.append(lane);
  }
}

function intervalBlock(from, to, start, span, className) {
  const block = document.createElement("i");
  block.className = className;
  const left = clamp(((Date.parse(from) - start) / span) * 100, 0, 100);
  const width = clamp(((Date.parse(to) - Date.parse(from)) / span) * 100, 0.8, 100 - left);
  block.style.left = `${left}%`;
  block.style.width = `${width}%`;
  return block;
}

function lineageSet(id) {
  const set = new Set([id]);
  const byId = new Map(state.snapshot.agents.map((agent) => [agent.id, agent]));
  let current = byId.get(id);
  while (current?.parent_id) {
    set.add(current.parent_id);
    current = byId.get(current.parent_id);
  }
  return set;
}

function matchesFilter(agent) {
  const visualState = primaryState(agent);
  if (state.status !== "all" && visualState !== state.status && agent.outcome !== state.status) return false;
  if (!state.query) return true;
  const haystack = [
    agent.label,
    agent.role,
    agent.model,
    agent.provider,
    ...agent.tools.flatMap((tool) => [tool.name, tool.input_summary, tool.output_summary]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(state.query);
}

function setZoom(value) {
  state.zoom = clamp(Math.round(value * 10) / 10, 0.6, 1.5);
  applyZoom();
}

function applyZoom() {
  refs.graphStage.style.transform = `scale(${state.zoom})`;
  refs.graphSpacer.style.width = `${state.graphWidth * state.zoom}px`;
  refs.graphSpacer.style.height = `${state.graphHeight * state.zoom}px`;
  refs.zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;
}

function fitGraph() {
  const widthRatio = (refs.graphViewport.clientWidth - 64) / state.graphWidth;
  const heightRatio = (refs.graphViewport.clientHeight - 64) / state.graphHeight;
  setZoom(Math.min(widthRatio, heightRatio, 1.2));
  refs.graphViewport.scrollTo({ left: 0, top: 0, behavior: "smooth" });
}

function lastTool(agent) {
  return [...agent.tools].sort((a, b) =>
    `${a.started_at ?? a.ended_at ?? ""}${a.call_id}`.localeCompare(
      `${b.started_at ?? b.ended_at ?? ""}${b.call_id}`,
    ),
  ).at(-1);
}

function primaryState(agent) {
  const resumableActivity = new Set(["running", "idle", "waiting", "ready"]);
  if (agent.mode === "continuable" && resumableActivity.has(agent.status)) return agent.status;
  return agent.outcome ?? agent.status;
}

function shortRuntime(runtime) {
  return runtime === "deepseek-harness" ? "DSH" : runtime === "claude-code" ? "CLAUDE" : "PI";
}

function runtimeLabel(runtime) {
  return runtime === "deepseek-harness"
    ? "DEEPSEEK HARNESS"
    : runtime === "claude-code"
      ? "CLAUDE CODE"
      : "PI";
}

function formatDuration(from, to) {
  if (!from || !to) return "—";
  return formatMillis(Math.max(0, Date.parse(to) - Date.parse(from)));
}

function formatMillis(value) {
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatClock(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function camel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
