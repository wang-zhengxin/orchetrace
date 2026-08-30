import { applyRunSnapshotDelta } from "./run-delta.js";
import { agentEventsAtTime, snapshotAtTime, timelineBounds } from "./time-travel.js";
import { compactTimelineMarkers, indexTimelineBySession } from "./timeline-index.js";
import { loadTimelinePages } from "./timeline-pages.js";
import { runtimeDescriptor, registeredRuntimeDescriptors } from "./runtime-registry.js";
import {
  aggregateRuntimeDiagnostics,
  diagnosticSuffix,
  runtimeVisualState,
} from "./runtime-diagnostics.js";
import {
  disableClaudeHooks,
  enableClaudeHooks,
  readCatalog,
  readClaudeIntegrationStatus,
  readDesktopInfo,
  readLegacySnapshot,
  readLiveConfig,
  readHarnessIntegrationStatus,
  readCodexIntegrationStatus,
  readManagedIngestStatus,
  readPiIntegrationStatus,
  readRunDelta,
  readRunSnapshot,
  readRunTimelinePage,
  startManagedIngest,
  startHarnessAuto,
  startCodexAuto,
  startPiAuto,
  startClaudeAuto,
  stopClaudeAuto,
  stopHarnessAuto,
  stopCodexAuto,
  stopManagedIngest,
  stopPiAuto,
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
  graphLayout: "horizontal",
  nodeWidth: 184,
  nodeHeight: 96,
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
  claudeIntegration: null,
  piIntegration: null,
  harnessIntegration: null,
  codexIntegration: null,
  runtimeDrawerOpen: false,
  runtimePollTimer: null,
  runtimeBusy: false,
  timeCursorMs: null,
  cursorPinned: false,
  detailOpen: false,
  playbackFrame: null,
  playbackLastFrame: null,
  playbackLastRender: null,
  timelinePromise: null,
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
    "layout-horizontal",
    "layout-vertical",
    "inspector-empty",
    "inspector-content",
    "timeline-range",
    "timeline-scroll",
    "timeline-ruler",
    "timeline-lanes",
    "timeline-scrubber",
    "timeline-cursor",
    "timeline-event-title",
    "timeline-play",
    "timeline-date",
    "footer-stats",
    "cursor-state",
    "graph-minimap",
    "detail-close",
    "run-list",
    "active-run-name",
    "source-dsh",
    "source-claude",
    "source-pi",
    "source-count-dsh",
    "source-count-claude",
    "source-count-pi",
    "source-codex",
    "source-count-codex",
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
    "claude-auto-phase",
    "claude-auto-summary",
    "claude-auto-projects",
    "claude-auto-action",
    "claude-hooks-action",
    "pi-auto-phase",
    "pi-auto-summary",
    "pi-auto-sessions",
    "pi-auto-action",
    "harness-auto-phase",
    "harness-auto-summary",
    "harness-auto-sessions",
    "harness-auto-action",
    "codex-auto-phase",
    "codex-auto-summary",
    "codex-auto-sessions",
    "codex-auto-action",
    "runtime-ingest-endpoint",
    "runtime-live-endpoint",
    "runtime-pid",
    "runtime-data-dir",
    "runtime-token-value",
    "runtime-token-copy",
    "runtime-source-grid",
    "runtime-diagnostic-count",
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
    renderClaudeIntegration(null);
    renderPassiveIntegration("pi", null);
    renderPassiveIntegration("harness", null);
    renderPassiveIntegration("codex", null);
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
  refs.layoutHorizontal.addEventListener("click", () => setGraphLayout("horizontal"));
  refs.layoutVertical.addEventListener("click", () => setGraphLayout("vertical"));
  refs.connectionHealth.addEventListener("click", openRuntimeDrawer);
  refs.runtimeClose.addEventListener("click", closeRuntimeDrawer);
  refs.drawerScrim.addEventListener("click", closeRuntimeDrawer);
  refs.managedIngestAction.addEventListener("click", () => void toggleManagedIngest());
  refs.claudeAutoAction.addEventListener("click", () => void toggleClaudeAuto());
  refs.claudeHooksAction.addEventListener("click", () => void toggleClaudeHooks());
  refs.piAutoAction.addEventListener("click", () => void togglePassiveObserver("pi"));
  refs.harnessAutoAction.addEventListener("click", () => void togglePassiveObserver("harness"));
  refs.codexAutoAction.addEventListener("click", () => void togglePassiveObserver("codex"));
  refs.runtimeTokenCopy.addEventListener("click", () => void copyManagedToken());
  refs.timelineScrubber.addEventListener("input", () => {
    if (!state.snapshot) return;
    stopPlayback();
    const bounds = timelineBounds(state.snapshot);
    state.timeCursorMs = bounds.start + (Number(refs.timelineScrubber.value) / 1000) * bounds.span;
    state.cursorPinned = state.timeCursorMs < bounds.end - 1;
    render();
    void ensureFullTimeline();
  });
  refs.timelineScrubber.addEventListener("pointerdown", () => void ensureFullTimeline());
  refs.timelinePlay.addEventListener("click", () => void beginPlayback());
  refs.detailClose.addEventListener("click", closeAgentDetail);
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      refs.search.focus();
    }
    if (event.key === "Escape" && state.runtimeDrawerOpen) closeRuntimeDrawer();
    else if (event.key === "Escape" && state.detailOpen) closeAgentDetail();
    if (event.code === "Space" && !["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(document.activeElement?.tagName)) {
      event.preventDefault();
      void beginPlayback();
    }
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
    stopPlayback();
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
    renderClaudeIntegration(null);
    renderPassiveIntegration("pi", null);
    renderPassiveIntegration("harness", null);
    renderPassiveIntegration("codex", null);
    return;
  }
  try {
    const [status, claude, pi, harness, codex] = await Promise.all([
      readManagedIngestStatus(),
      readClaudeIntegrationStatus(),
      readPiIntegrationStatus(),
      readHarnessIntegrationStatus(),
      readCodexIntegrationStatus(),
    ]);
    state.managedIngest = status;
    state.claudeIntegration = claude;
    state.piIntegration = pi;
    state.harnessIntegration = harness;
    state.codexIntegration = codex;
    renderManagedIngest(status);
    renderClaudeIntegration(claude);
    renderPassiveIntegration("pi", pi);
    renderPassiveIntegration("harness", harness);
    renderPassiveIntegration("codex", codex);
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
    const [claude, pi, harness, codex] = await Promise.all([
      readClaudeIntegrationStatus(),
      readPiIntegrationStatus(),
      readHarnessIntegrationStatus(),
      readCodexIntegrationStatus(),
    ]);
    state.claudeIntegration = claude;
    state.piIntegration = pi;
    state.harnessIntegration = harness;
    state.codexIntegration = codex;
    renderAllIntegrations();
    if (status?.phase === "running") activateMode("live");
    else if (state.mode === "live") activateMode("replay");
  } catch (error) {
    setRuntimeError(String(error));
    await refreshManagedIngest();
  } finally {
    state.runtimeBusy = false;
    renderManagedIngest(state.managedIngest);
    renderAllIntegrations();
  }
}

async function togglePassiveObserver(runtime) {
  if (state.runtimeBusy || !state.desktopInfo) return;
  const config = {
    pi: { key: "piIntegration", start: startPiAuto, stop: stopPiAuto },
    harness: { key: "harnessIntegration", start: startHarnessAuto, stop: stopHarnessAuto },
    codex: { key: "codexIntegration", start: startCodexAuto, stop: stopCodexAuto },
  }[runtime];
  if (!config) return;
  state.runtimeBusy = true;
  renderAllIntegrations();
  setRuntimeError("");
  try {
    const running = state[config.key]?.phase === "running";
    state[config.key] = running ? await config.stop() : await config.start();
    renderPassiveIntegration(runtime, state[config.key]);
  } catch (error) {
    setRuntimeError(String(error));
    await refreshManagedIngest();
  } finally {
    state.runtimeBusy = false;
    renderManagedIngest(state.managedIngest);
    renderAllIntegrations();
  }
}

async function toggleClaudeAuto() {
  if (state.runtimeBusy || !state.desktopInfo) return;
  state.runtimeBusy = true;
  renderClaudeIntegration(state.claudeIntegration);
  setRuntimeError("");
  try {
    const running = state.claudeIntegration?.phase === "running";
    state.claudeIntegration = running ? await stopClaudeAuto() : await startClaudeAuto();
    renderClaudeIntegration(state.claudeIntegration);
  } catch (error) {
    setRuntimeError(String(error));
    await refreshManagedIngest();
  } finally {
    state.runtimeBusy = false;
    renderManagedIngest(state.managedIngest);
    renderClaudeIntegration(state.claudeIntegration);
  }
}

async function toggleClaudeHooks() {
  if (state.runtimeBusy || !state.desktopInfo) return;
  state.runtimeBusy = true;
  renderClaudeIntegration(state.claudeIntegration);
  setRuntimeError("");
  try {
    const installed = Boolean(state.claudeIntegration?.hooks_installed);
    state.claudeIntegration = installed ? await disableClaudeHooks() : await enableClaudeHooks();
    renderClaudeIntegration(state.claudeIntegration);
  } catch (error) {
    setRuntimeError(String(error));
    await refreshManagedIngest();
  } finally {
    state.runtimeBusy = false;
    renderClaudeIntegration(state.claudeIntegration);
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
  const { phase, visual } = runtimeVisualState(status);
  const labels = {
    running: "RUNNING",
    warning: "WARNING",
    degraded: "DEGRADED",
    stopped: "STOPPED",
    exited: "EXITED",
    unavailable: "UNAVAILABLE",
    browser: "BROWSER MODE",
  };
  refs.runtimePhase.className = `runtime-phase ${visual}`;
  refs.runtimePhase.querySelector("b").textContent = labels[visual] ?? visual.toUpperCase();

  const summaries = {
    running: "Local ingest owns the loopback fact and live-update endpoints.",
    stopped: "The local service is ready to start with a fresh adapter token.",
    exited: `The managed process exited${status?.last_exit_code == null ? "" : ` with code ${status.last_exit_code}`}.`,
    unavailable: "Build the otrace sidecar or configure ORCHETRACE_CLI_PATH.",
    browser: "Runtime lifecycle controls are available in the Tauri desktop shell.",
  };
  refs.runtimeSummary.textContent = `${summaries[phase] ?? "Runtime state is unavailable."}${diagnosticSuffix(status)}`;

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
  renderRuntimeLogs(mergedRuntimeLogs());
}

function renderClaudeIntegration(status) {
  const { phase, visual } = runtimeVisualState(status);
  const labels = {
    running: "WATCHING",
    warning: "WARNING",
    degraded: "DEGRADED",
    stopped: "STOPPED",
    exited: "EXITED",
    unavailable: "UNAVAILABLE",
    browser: "DESKTOP ONLY",
  };
  refs.claudeAutoPhase.className = `runtime-mini-phase ${visual}`;
  refs.claudeAutoPhase.querySelector("b").textContent = labels[visual] ?? visual.toUpperCase();
  const summaries = {
    running: status?.hooks_installed
      ? "Active sessions and lifecycle hooks are being observed."
      : "Recent transcripts are watched; enable hooks for exact lifecycle registration.",
    stopped: "Starts automatically with managed ingest, or can be controlled independently.",
    exited: "The watcher exited; inspect the process log before restarting.",
    unavailable: "Node.js or the Claude adapter sidecar is unavailable.",
    browser: "Claude auto-discovery is managed by the Tauri desktop shell.",
  };
  refs.claudeAutoSummary.textContent = `${summaries[phase] ?? "Claude integration status is unavailable."}${diagnosticSuffix(status)}`;
  refs.claudeAutoProjects.textContent = status?.projects_dir ?? "~/.claude/projects";
  refs.claudeAutoProjects.title = refs.claudeAutoProjects.textContent;
  refs.claudeAutoAction.hidden = phase === "browser";
  refs.claudeHooksAction.hidden = phase === "browser";
  refs.claudeAutoAction.disabled =
    state.runtimeBusy || phase === "unavailable" || state.managedIngest?.phase !== "running";
  refs.claudeHooksAction.disabled = state.runtimeBusy || phase === "unavailable";
  refs.claudeAutoAction.textContent = phase === "running" ? "STOP WATCHER" : "START WATCHER";
  refs.claudeHooksAction.textContent = status?.hooks_installed ? "DISABLE HOOKS" : "ENABLE HOOKS";
  renderRuntimeLogs(mergedRuntimeLogs());
}

function renderPassiveIntegration(runtime, status) {
  const refsByRuntime = {
    pi: {
      phase: refs.piAutoPhase,
      summary: refs.piAutoSummary,
      sessions: refs.piAutoSessions,
      action: refs.piAutoAction,
    },
    harness: {
      phase: refs.harnessAutoPhase,
      summary: refs.harnessAutoSummary,
      sessions: refs.harnessAutoSessions,
      action: refs.harnessAutoAction,
    },
    codex: {
      phase: refs.codexAutoPhase,
      summary: refs.codexAutoSummary,
      sessions: refs.codexAutoSessions,
      action: refs.codexAutoAction,
    },
  }[runtime];
  if (!refsByRuntime) return;
  const { phase, visual } = runtimeVisualState(status);
  const labels = {
    running: "WATCHING",
    warning: "WARNING",
    degraded: "DEGRADED",
    stopped: "STOPPED",
    exited: "EXITED",
    unavailable: "UNAVAILABLE",
    browser: "DESKTOP ONLY",
  };
  refsByRuntime.phase.className = `runtime-mini-phase ${visual}`;
  refsByRuntime.phase.querySelector("b").textContent = labels[visual] ?? visual.toUpperCase();
  const descriptor = runtimeDescriptor(runtime === "harness" ? "deepseek-harness" : runtime);
  const name = descriptor.label;
  const summaries = {
    running: runtime === "pi"
      ? "Open Pi sessions are being tailed passively; no second agent process is launched."
      : runtime === "codex"
        ? "Codex rollout files and spawned subagents are synchronized with ACK-backed byte cursors."
        : "Harness persistence is being decoded and synchronized with stable session cursors.",
    stopped: "Starts automatically with managed ingest, or can be controlled independently.",
    exited: `The ${name} watcher exited; inspect the merged process log before restarting.`,
    unavailable: `Node.js or the ${name} adapter sidecar is unavailable.`,
    browser: `${name} auto-discovery is managed by the Tauri desktop shell.`,
  };
  refsByRuntime.summary.textContent = `${summaries[phase] ?? `${name} integration status is unavailable.`}${diagnosticSuffix(status)}`;
  refsByRuntime.sessions.textContent = status?.sessions_dir ?? descriptor.sessions;
  refsByRuntime.sessions.title = refsByRuntime.sessions.textContent;
  refsByRuntime.action.hidden = phase === "browser";
  refsByRuntime.action.disabled =
    state.runtimeBusy || phase === "unavailable" || state.managedIngest?.phase !== "running";
  refsByRuntime.action.textContent = phase === "running" ? "STOP WATCHER" : "START WATCHER";
  renderRuntimeLogs(mergedRuntimeLogs());
}

function renderAllIntegrations() {
  renderClaudeIntegration(state.claudeIntegration);
  renderPassiveIntegration("pi", state.piIntegration);
  renderPassiveIntegration("harness", state.harnessIntegration);
  renderPassiveIntegration("codex", state.codexIntegration);
}

function mergedRuntimeLogs() {
  return [
    ...(state.managedIngest?.logs ?? []),
    ...(state.claudeIntegration?.logs ?? []),
    ...(state.piIntegration?.logs ?? []),
    ...(state.harnessIntegration?.logs ?? []),
    ...(state.codexIntegration?.logs ?? []),
  ]
    .sort((left, right) => Number(left.at_ms) - Number(right.at_ms))
    .slice(-160);
}

function renderRuntimeSources() {
  const descriptors = new Map(registeredRuntimeDescriptors().map((descriptor) => [descriptor.id, descriptor]));
  const counts = new Map([...descriptors.keys()].map((runtime) => [runtime, new Set()]));
  for (const run of state.catalog?.runs ?? []) {
    if (!descriptors.has(run.runtime)) descriptors.set(run.runtime, runtimeDescriptor(run.runtime));
    if (!counts.has(run.runtime)) counts.set(run.runtime, new Set());
    counts.get(run.runtime).add(run.source_id);
  }
  refs.runtimeSourceGrid.replaceChildren();
  for (const descriptor of descriptors.values()) {
    const item = document.createElement("div");
    const glyph = document.createElement("span");
    glyph.className = "source-glyph";
    glyph.textContent = descriptor.shortLabel.slice(0, 2);
    glyph.style.color = descriptor.accent;
    const label = document.createElement("strong");
    label.textContent = descriptor.label;
    const count = document.createElement("b");
    count.textContent = String(counts.get(descriptor.id)?.size ?? 0);
    item.append(glyph, label, count);
    refs.runtimeSourceGrid.append(item);
  }
}

function renderRuntimeLogs(logs) {
  refs.runtimeLogList.replaceChildren();
  const totals = aggregateRuntimeDiagnostics([
    state.managedIngest,
    state.claudeIntegration,
    state.piIntegration,
    state.harnessIntegration,
    state.codexIntegration,
  ]);
  refs.runtimeDiagnosticCount.textContent = totals.errorCount > 0
    ? `${totals.errorCount} ERR · ${totals.warningCount} WARN`
    : totals.warningCount > 0
      ? `${totals.warningCount} WARN`
      : "HEALTHY";
  refs.runtimeDiagnosticCount.className = totals.errorCount > 0
    ? "severity-error"
    : totals.warningCount > 0
      ? "severity-warning"
      : "severity-healthy";
  if (logs.length === 0) {
    const empty = document.createElement("li");
    empty.className = "runtime-log-empty";
    empty.textContent = "No managed process activity.";
    refs.runtimeLogList.append(empty);
    return;
  }
  for (const log of logs.slice().reverse()) {
    const item = document.createElement("li");
    item.className = `severity-${log.severity ?? "info"}`;
    const time = document.createElement("time");
    time.textContent = formatClock(Number(log.at_ms));
    const stream = document.createElement("b");
    stream.textContent = log.code ?? log.stream;
    stream.title = [log.stream, log.location].filter(Boolean).join(" · ");
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
  refs.app.dataset.mode = state.mode;
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
      const showcase = catalog.runs
        .filter((run) => run.source_id === "local-demo")
        .sort((left, right) => right.agent_count - left.agent_count || right.event_count - left.event_count)[0];
      state.currentRunId = (showcase ?? catalog.runs[0]).run_id;
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
    if (state.snapshot?.timeline_paging?.complete === false) return false;
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
    state.timelinePromise = null;
    refs.app.dataset.delivery = delivery;
  const bounds = timelineBounds(snapshot);
  if (!state.cursorPinned || !Number.isFinite(state.timeCursorMs)) state.timeCursorMs = bounds.end;
  else state.timeCursorMs = clamp(state.timeCursorMs, bounds.start, bounds.end);
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
  stopPlayback();
  state.cursorPinned = false;
  state.detailOpen = false;
  state.currentRunId = runId;
  document.querySelector(".run-picker")?.removeAttribute("open");
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
  const view = currentView();
  refs.app.classList.toggle("dense-topology", view.agents.length > 6);
  renderRunRail();
  const timelineSummary = snapshot.timeline_paging?.complete === false
    ? `${view.timeline.length}/${snapshot.timeline_paging.total_entries} timeline events loaded`
    : `${view.timeline.length} observed events`;
  refs.graphSummary.textContent = `${view.agents.length}/${snapshot.agents.length} agents · ${view.edges.length} links · ${timelineSummary}`;
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
  const sourceIds = new Map(registeredRuntimeDescriptors().map(({ id }) => [id, new Set()]));
  for (const run of state.catalog.runs) {
    if (sourceIds.has(run.runtime)) sourceIds.get(run.runtime).add(run.source_id);
  }
  const values = [
    [refs.sourceDsh, refs.sourceCountDsh, sourceIds.get("deepseek-harness").size],
    [refs.sourceClaude, refs.sourceCountClaude, sourceIds.get("claude-code").size],
    [refs.sourcePi, refs.sourceCountPi, sourceIds.get("pi").size],
    [refs.sourceCodex, refs.sourceCountCodex, sourceIds.get("codex").size],
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

  const cardWidth = state.nodeWidth;
  const cardHeight = state.nodeHeight;
  let leaf = 0;
  let maxDepth = 0;
  const positions = new Map();
  const place = (id, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    const childIds = children.get(id) ?? [];
    let unit;
    if (childIds.length === 0) {
      unit = leaf;
      leaf += 1;
    } else {
      const childUnits = childIds.map((child) => place(child, depth + 1));
      unit = childUnits.reduce((sum, value) => sum + value, 0) / childUnits.length;
    }
    positions.set(id, { unit, depth });
    return unit;
  };
  place(snapshot.root_session_id, 0);
  for (const agent of snapshot.agents) {
    if (!positions.has(agent.id)) place(agent.id, 0);
  }

  const leafCount = Math.max(leaf, 1);
  const viewportWidth = Math.max(760, refs.graphViewport?.clientWidth ?? 0);
  const viewportHeight = Math.max(440, refs.graphViewport?.clientHeight ?? 0);

  if (state.graphLayout === "horizontal") {
    const leafStep = 214;
    const depthStep = 132;
    const contentWidth = cardWidth + Math.max(0, leafCount - 1) * leafStep;
    const contentHeight = cardHeight + maxDepth * depthStep;
    const leftInset = Math.max(48, (viewportWidth - contentWidth) / 2);
    const topInset = Math.max(40, (viewportHeight - contentHeight) / 2);
    for (const [id, position] of positions) {
      positions.set(id, {
        x: leftInset + position.unit * leafStep,
        y: topInset + position.depth * depthStep,
        depth: position.depth,
      });
    }
    state.graphWidth = Math.max(viewportWidth, leftInset * 2 + contentWidth);
    state.graphHeight = Math.max(viewportHeight, topInset * 2 + contentHeight);
  } else {
    const depthStep = 278;
    const leafStep = 112;
    const contentWidth = cardWidth + maxDepth * depthStep;
    const contentHeight = cardHeight + Math.max(0, leafCount - 1) * leafStep;
    const leftInset = 52;
    const topInset = Math.max(38, (viewportHeight - contentHeight) / 2);
    for (const [id, position] of positions) {
      positions.set(id, {
        x: leftInset + position.depth * depthStep,
        y: topInset + position.unit * leafStep,
        depth: position.depth,
      });
    }
    state.graphWidth = Math.max(viewportWidth, leftInset * 2 + contentWidth);
    state.graphHeight = Math.max(viewportHeight, topInset * 2 + contentHeight);
  }
  state.positions = positions;
}

function renderGraph() {
  if (!state.snapshot) return;
  const snapshot = currentView();
  refs.nodeLayer.replaceChildren();
  refs.edgeLayer.replaceChildren();
  refs.edgeLayer.setAttribute("viewBox", `0 0 ${state.graphWidth} ${state.graphHeight}`);
  refs.edgeLayer.setAttribute("width", state.graphWidth);
  refs.edgeLayer.setAttribute("height", state.graphHeight);
  refs.graphStage.style.width = `${state.graphWidth}px`;
  refs.graphStage.style.height = `${state.graphHeight}px`;
  applyZoom();

  const selected = snapshot.agents.find((agent) => agent.id === state.selectedId);
  const related = selected ? lineageSet(selected.id) : new Set();

  for (const [edgeIndex, edge] of snapshot.edges.entries()) {
    const from = state.positions.get(edge.parent_id);
    const to = state.positions.get(edge.child_id);
    if (!from || !to) continue;
    let pathData;
    if (state.graphLayout === "horizontal") {
      const x1 = from.x + state.nodeWidth / 2;
      const y1 = from.y + state.nodeHeight;
      const x2 = to.x + state.nodeWidth / 2;
      const y2 = to.y;
      const bend = Math.max(28, (y2 - y1) * 0.5);
      pathData = `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
    } else {
      const x1 = from.x + state.nodeWidth;
      const y1 = from.y + state.nodeHeight / 2;
      const x2 = to.x;
      const y2 = to.y + state.nodeHeight / 2;
      const bend = Math.max(32, (x2 - x1) * 0.5);
      pathData = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
    }
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    path.classList.add("agent-edge");
    path.style.setProperty("--edge-order", edgeIndex);
    if (edge.opaque) path.classList.add("opaque");
    if (related.has(edge.parent_id) && related.has(edge.child_id)) path.classList.add("selected-path");
    const target = snapshot.agents.find((agent) => agent.id === edge.child_id);
    if (target?.status === "running") path.classList.add("active-flow");
    refs.edgeLayer.append(path);

    if (target?.status === "running" || (related.has(edge.parent_id) && related.has(edge.child_id))) {
      const packet = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      packet.setAttribute("r", target?.status === "running" ? "3.5" : "2.6");
      packet.classList.add("edge-packet");
      const motion = document.createElementNS("http://www.w3.org/2000/svg", "animateMotion");
      motion.setAttribute("dur", target?.status === "running" ? "1.8s" : "3.2s");
      motion.setAttribute("begin", `${edgeIndex * 0.22}s`);
      motion.setAttribute("repeatCount", "indefinite");
      motion.setAttribute("path", pathData);
      packet.append(motion);
      refs.edgeLayer.append(packet);
    }
  }

  for (const [agentIndex, agent] of snapshot.agents.entries()) {
    const position = state.positions.get(agent.id);
    const visualState = primaryState(agent);
    const meta = STATUS[visualState] ?? STATUS.unknown;
    const matches = matchesFilter(agent);
    const node = document.createElement("button");
    node.type = "button";
    node.className = `agent-node state-${visualState}`;
    node.style.setProperty("--node-order", agentIndex);
    if (agent.id === state.selectedId) node.classList.add("selected");
    if (agent.id === snapshot.root_session_id) node.classList.add("root-agent");
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
    provider.textContent = `${shortRuntime(snapshot.runtimes[0])} · ${agent.model ?? agent.provider ?? "unknown"}`;
    const activity = document.createElement("span");
    activity.className = "node-activity";
    activity.textContent = agent.role ?? agent.mode;
    const count = document.createElement("span");
    count.className = "node-count";
    count.textContent = agent.failed_tool_count
      ? `${agent.failed_tool_count} failed`
      : `${agent.tool_count} calls`;
    const evidence = document.createElement("span");
    evidence.className = "node-state-label";
    evidence.textContent = meta.label;

    const toolTrail = document.createElement("span");
    toolTrail.className = "node-tool-trail";
    const recentTools = [...agent.tools].slice(-2).reverse();
    if (recentTools.length === 0) {
      const emptyTool = document.createElement("span");
      emptyTool.className = "node-tool-row empty";
      emptyTool.textContent = "· awaiting tool activity";
      toolTrail.append(emptyTool);
    } else {
      for (const tool of recentTools) {
        const toolState = tool.outcome ?? (tool.ended_at ? "succeeded" : "running");
        const toolMeta = STATUS[toolState] ?? STATUS.unknown;
        const row = document.createElement("span");
        row.className = `node-tool-row state-${toolState}`;
        const glyph = document.createElement("i");
        glyph.textContent = toolMeta.glyph;
        const name = document.createElement("b");
        name.textContent = tool.name;
        const time = document.createElement("time");
        time.textContent = tool.duration_ms ? formatMillis(tool.duration_ms) : "LIVE";
        row.append(glyph, name, time);
        toolTrail.append(row);
      }
    }

    node.append(status, title, duration, provider, activity, count, evidence, toolTrail);
    node.addEventListener("click", async () => {
      state.selectedId = agent.id;
      state.detailOpen = true;
      renderGraph();
      renderInspector();
      await ensureFullTimeline();
    });
    refs.nodeLayer.append(node);
  }
  renderMinimap(snapshot);
}

function renderInspector() {
  if (!state.snapshot || !state.selectedId || !state.detailOpen) {
    refs.app.classList.remove("inspector-visible");
    refs.inspectorContent.closest(".inspector")?.setAttribute("aria-hidden", "true");
    refs.inspectorContent.hidden = true;
    return;
  }
  const view = currentView();
  const agent = view.agents.find((item) => item.id === state.selectedId);
  if (!agent) {
    closeAgentDetail();
    return;
  }
  refs.app.classList.add("inspector-visible");
  refs.inspectorContent.closest(".inspector")?.setAttribute("aria-hidden", "false");
  refs.inspectorEmpty.hidden = true;
  refs.inspectorContent.hidden = false;
  const visualState = primaryState(agent);
  const meta = STATUS[visualState] ?? STATUS.unknown;
  const events = agentEventsAtTime(state.snapshot, agent.id, state.timeCursorMs);
  const contextEvents = events.filter((event) => ["prompt", "reasoning", "message", "error"].includes(event.kind));
  const toolEvents = events.filter((event) => event.kind === "tool" || event.kind === "tool-result");
  const parent = view.agents.find((item) => item.id === agent.parent_id);

  refs.inspectorContent.innerHTML = `
    <div class="inspector-header">
      <h1>${escapeHtml(agent.label)}</h1>
      <div class="inspector-state state-${escapeHtml(visualState)}">
        <strong>${meta.label.toLowerCase()}</strong>
        <span>${escapeHtml(agent.model ?? agent.provider ?? "model unknown")}</span>
      </div>
      <div class="detail-metrics"><span>◷ ${formatDuration(agent.started_at, agent.last_activity_at)}</span><span>${agent.tool_count} tools</span><span>${agent.detail_level} evidence</span><span>parent ${escapeHtml(parent?.label ?? "root")}</span></div>
    </div>
    <section class="detail-stream">
      <div class="stream-divider"><span>triggered by</span></div>
      ${contextEvents.length ? contextEvents.map(detailEventRow).join("") : `<p class="empty-copy">No prompt or response summary was captured before this time.</p>`}
      <div class="stream-divider"><span>tool calls</span></div>
      ${toolEvents.length ? toolEvents.map(detailEventRow).join("") : `<p class="empty-copy">No tool calls had started at this point.</p>`}
    </section>
    <section class="detail-evidence">
      <span>status evidence</span>
      <p>${escapeHtml(agent.outcome_evidence ?? `Observed ${agent.status} activity at ${formatClock(state.timeCursorMs)}; no terminal outcome was present at this time.`)}</p>
      <code>${escapeHtml(agent.id)}</code>
    </section>
  `;
}

function renderTimeline() {
  if (!state.snapshot) return;
  refs.timelineLanes.replaceChildren();
  refs.timelineRuler.replaceChildren();
  const bounds = timelineBounds(state.snapshot);
  const cursor = clamp(state.timeCursorMs, bounds.start, bounds.end);
  const cursorPercent = ((cursor - bounds.start) / bounds.span) * 100;
  const view = currentView();
  refs.timelineScroll.style.setProperty("--cursor-position", `${cursorPercent}%`);
  refs.timelineRange.textContent = `+${formatMillis(cursor - bounds.start)} / ${formatMillis(bounds.span)}`;
  refs.timelineCursor.textContent = formatClock(cursor);
  refs.timelineDate.textContent = formatDate(cursor);
  refs.timelineScrubber.value = String(Math.round((cursorPercent / 100) * 1000));
  refs.cursorState.textContent = cursor >= bounds.end - 1 ? "LATEST STATE" : `HISTORY · ${formatClock(cursor)}`;
  refs.footerStats.textContent = `${view.agents.length} agents · ${view.agents.reduce((sum, agent) => sum + agent.tool_count, 0)} tools`;
  refs.timelinePlay.textContent = state.playbackFrame ? "Ⅱ PAUSE" : cursor >= bounds.end - 1 ? "↤ REPLAY" : "▶ PLAY";

  let latest;
  for (let index = state.snapshot.timeline.length - 1; index >= 0; index -= 1) {
    const candidate = state.snapshot.timeline[index];
    if (Date.parse(candidate.at) <= cursor) {
      latest = candidate;
      break;
    }
  }
  refs.timelineEventTitle.textContent = latest
    ? `${eventGlyph(latest.kind)} ${latest.label}`
    : "Before the first observed agent event";

  for (let index = 0; index <= 5; index += 1) {
    const tick = document.createElement("span");
    tick.style.left = `${index * 20}%`;
    const value = bounds.start + (bounds.span * index) / 5;
    tick.innerHTML = `<b>${formatClock(value)}</b><small>+${formatMillis(value - bounds.start)}</small>`;
    refs.timelineRuler.append(tick);
  }

  const eventsBySession = indexTimelineBySession(state.snapshot.timeline);
  const markerBudget = Math.max(120, Math.floor(refs.timelineLanes.clientWidth / 2));
  for (const agent of state.snapshot.agents) {
    const lane = document.createElement("div");
    lane.className = "timeline-agent-lane";
    if (!view.agents.some((item) => item.id === agent.id)) lane.classList.add("future");
    if (agent.id === state.selectedId) lane.classList.add("selected");

    const label = document.createElement("button");
    label.type = "button";
    label.className = "timeline-agent-label";
    label.textContent = agent.label;
    label.title = agent.label;
    label.addEventListener("click", async () => {
      if (!view.agents.some((item) => item.id === agent.id)) return;
      state.selectedId = agent.id;
      state.detailOpen = true;
      renderGraph();
      renderInspector();
      renderTimeline();
      await ensureFullTimeline();
    });

    const track = document.createElement("div");
    track.className = "timeline-event-track";
    for (const activation of agent.activations) {
      const block = intervalBlock(
        activation.started_at,
        activation.ended_at ?? state.snapshot.last_activity_at,
        bounds.start,
        bounds.span,
        `activity-range ${Date.parse(activation.started_at) <= cursor ? "elapsed" : "future"}`,
      );
      track.append(block);
    }
    for (const tool of agent.tools) {
      const block = intervalBlock(
        tool.started_at ?? tool.ended_at ?? agent.started_at,
        tool.ended_at ?? state.snapshot.last_activity_at,
        bounds.start,
        bounds.span,
        `tool-range ${tool.outcome === "failed" ? "failed" : ""} ${Date.parse(tool.started_at ?? tool.ended_at) <= cursor ? "elapsed" : "future"}`,
      );
      block.title = `${tool.name} · ${tool.outcome ?? "running"}`;
      track.append(block);
    }
    const markers = compactTimelineMarkers(
      eventsBySession.get(agent.id) ?? [],
      bounds.start,
      bounds.span,
      markerBudget,
    );
    for (const summary of markers) {
      const event = summary.event;
      const eventTime = Date.parse(event.at);
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = `timeline-event ${event.kind} ${eventTime <= cursor ? "elapsed" : "future"} ${summary.count > 1 ? "compacted" : ""}`;
      marker.style.left = `${clamp(((eventTime - bounds.start) / bounds.span) * 100, 0, 100)}%`;
      marker.textContent = eventGlyph(event.kind);
      marker.title = summary.count > 1
        ? `${summary.count} events · ${formatClock(Date.parse(summary.from))}–${formatClock(Date.parse(summary.to))} · ${event.label}`
        : `${formatClock(eventTime)} · ${event.label}`;
      marker.addEventListener("click", async () => {
        stopPlayback();
        state.timeCursorMs = eventTime;
        state.cursorPinned = eventTime < bounds.end - 1;
        state.selectedId = event.session_id;
        state.detailOpen = true;
        render();
        await ensureFullTimeline();
      });
      track.append(marker);
    }
    const laneCursor = document.createElement("i");
    laneCursor.className = "timeline-lane-cursor";
    laneCursor.style.left = `${cursorPercent}%`;
    track.append(laneCursor);
    lane.append(label, track);
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

function currentView() {
  return snapshotAtTime(state.snapshot, state.timeCursorMs);
}

function closeAgentDetail() {
  state.detailOpen = false;
  refs.app.classList.remove("inspector-visible");
  refs.inspectorContent.closest(".inspector")?.setAttribute("aria-hidden", "true");
  refs.inspectorContent.hidden = true;
  renderGraph();
}

function detailEventRow(event) {
  const summary = event.input_summary ?? event.output_summary ?? event.label;
  const kindLabel = event.kind === "reasoning" ? "thought summary" : event.kind.replace("-", " ");
  const outcome = event.outcome ? `<em class="event-outcome ${escapeHtml(event.outcome)}">${escapeHtml(event.outcome)}</em>` : "";
  const duration = event.duration_ms ? `<span>${formatMillis(event.duration_ms)}</span>` : "";
  return `<article class="detail-event kind-${escapeHtml(event.kind)}">
    <i>${eventGlyph(event.kind)}</i>
    <b>${escapeHtml(kindLabel)}</b>
    <p>${escapeHtml(summary)}</p>
    ${outcome}${duration}<time>${formatClock(Date.parse(event.at))}</time>
  </article>`;
}

function eventGlyph(kind) {
  return kind === "prompt"
    ? "↳"
    : kind === "reasoning"
      ? "↳"
      : kind === "tool"
        ? "⌛"
        : kind === "tool-result"
          ? "↳"
          : kind === "outcome"
            ? "✓"
            : kind === "error"
              ? "×"
              : kind === "spawn"
                ? "◆"
                : "·";
}

function renderMinimap(snapshot) {
  refs.graphMinimap.replaceChildren();
  const frame = document.createElement("div");
  frame.className = "minimap-frame";
  for (const agent of snapshot.agents) {
    const position = state.positions.get(agent.id);
    if (!position) continue;
    const dot = document.createElement("i");
    dot.className = `mini-node state-${primaryState(agent)}`;
    dot.style.left = `${clamp((position.x / state.graphWidth) * 100, 1, 96)}%`;
    dot.style.top = `${clamp((position.y / state.graphHeight) * 100, 4, 92)}%`;
    frame.append(dot);
  }
  const viewport = document.createElement("span");
  viewport.className = "mini-viewport";
  frame.append(viewport);
  refs.graphMinimap.append(frame);
}

function togglePlayback() {
  if (!state.snapshot) return;
  if (state.playbackFrame) {
    stopPlayback();
    render();
    return;
  }
  const bounds = timelineBounds(state.snapshot);
  if (state.timeCursorMs >= bounds.end - 1) state.timeCursorMs = bounds.start;
  state.cursorPinned = true;
  state.playbackLastFrame = null;
  state.playbackLastRender = null;
  refs.app.classList.add("is-playing");
  state.playbackFrame = requestAnimationFrame(playbackStep);
  renderTimeline();
}

async function beginPlayback() {
  await ensureFullTimeline();
  if (state.snapshot?.timeline_paging?.complete === false) return;
  togglePlayback();
}

async function ensureFullTimeline() {
  const snapshot = state.snapshot;
  const paging = snapshot?.timeline_paging;
  if (!paging || paging.complete !== false) return;
  if (state.timelinePromise) return state.timelinePromise;
  const runId = state.loadedRunId;
  const eventCount = snapshot.event_count;
  const pageCount = Number(paging.page_count);
  const totalEntries = Number(paging.total_entries);
  if (!runId || !Number.isSafeInteger(pageCount) || pageCount <= 0) return;

  const operation = (async () => {
    const timeline = await loadTimelinePages({
      pageCount,
      totalEntries,
      readPage: (page) => readRunTimelinePage(runId, page),
    });
    if (state.loadedRunId !== runId || state.snapshot?.event_count !== eventCount) return;
    state.snapshot = {
      ...state.snapshot,
      timeline,
      timeline_paging: { ...state.snapshot.timeline_paging, complete: true },
    };
    render();
  })().catch((error) => {
    setHealth("degraded", "TIMELINE RETRY");
    console.warn("Unable to load complete timeline", error);
  }).finally(() => {
    if (state.timelinePromise === operation) state.timelinePromise = null;
  });
  state.timelinePromise = operation;
  refs.timelineEventTitle.textContent = `Loading ${pageCount} timeline pages…`;
  return operation;
}

function playbackStep(now) {
  if (!state.snapshot || !state.playbackFrame) return;
  const bounds = timelineBounds(state.snapshot);
  const elapsed = state.playbackLastFrame == null ? 0 : now - state.playbackLastFrame;
  state.playbackLastFrame = now;
  state.timeCursorMs = Math.min(bounds.end, state.timeCursorMs + elapsed);
  if (state.playbackLastRender == null || now - state.playbackLastRender >= 45) {
    state.playbackLastRender = now;
    render();
  }
  if (state.timeCursorMs >= bounds.end) {
    state.cursorPinned = false;
    stopPlayback();
    render();
    return;
  }
  state.playbackFrame = requestAnimationFrame(playbackStep);
}

function stopPlayback() {
  if (state.playbackFrame) cancelAnimationFrame(state.playbackFrame);
  state.playbackFrame = null;
  state.playbackLastFrame = null;
  state.playbackLastRender = null;
  refs.app.classList.remove("is-playing");
}

function lineageSet(id) {
  const set = new Set([id]);
  const byId = new Map(state.snapshot.agents.map((agent) => [agent.id, agent]));
  let current = byId.get(id);
  while (current?.parent_id) {
    set.add(current.parent_id);
    current = byId.get(current.parent_id);
  }
  const addDescendants = (parentId) => {
    for (const agent of state.snapshot.agents) {
      if (agent.parent_id !== parentId || set.has(agent.id)) continue;
      set.add(agent.id);
      addDescendants(agent.id);
    }
  };
  addDescendants(id);
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

function setGraphLayout(layout) {
  state.graphLayout = layout === "vertical" ? "vertical" : "horizontal";
  refs.app.dataset.graphLayout = state.graphLayout;
  const horizontal = state.graphLayout === "horizontal";
  refs.layoutHorizontal.classList.toggle("active", horizontal);
  refs.layoutHorizontal.setAttribute("aria-pressed", String(horizontal));
  refs.layoutVertical.classList.toggle("active", !horizontal);
  refs.layoutVertical.setAttribute("aria-pressed", String(!horizontal));
  if (!state.snapshot) return;
  layoutGraph();
  renderGraph();
  renderInspector();
  fitGraph();
}

function applyZoom() {
  refs.graphStage.style.transform = `scale(${state.zoom})`;
  refs.graphSpacer.style.width = `${state.graphWidth * state.zoom}px`;
  refs.graphSpacer.style.height = `${state.graphHeight * state.zoom}px`;
  refs.zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;
}

function fitGraph() {
  const widthRatio = (refs.graphViewport.clientWidth - 40) / state.graphWidth;
  const heightRatio = (refs.graphViewport.clientHeight - 30) / state.graphHeight;
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
  return runtimeDescriptor(runtime).shortLabel;
}

function runtimeLabel(runtime) {
  return runtimeDescriptor(runtime).label;
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

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
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
