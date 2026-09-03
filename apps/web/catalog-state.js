export function preferredRunId(catalog, currentRunId = null) {
  if (!catalog || !Array.isArray(catalog.runs)) {
    throw new TypeError("Run catalog must contain a runs array");
  }
  if (catalog.runs.length === 0) return null;
  if (currentRunId && catalog.runs.some((run) => run.run_id === currentRunId)) {
    return currentRunId;
  }
  const showcase = catalog.runs
    .filter((run) => run.source_id === "local-demo")
    .sort((left, right) => right.agent_count - left.agent_count || right.event_count - left.event_count)[0];
  return (showcase ?? catalog.runs[0]).run_id;
}

export function emptyCatalogPresentation(playbackRate = 1) {
  return {
    activeRunName: "Waiting for Agent activity",
    graphSummary: "0 agents · 0 links · 0 observed events",
    cursorState: "WAITING FOR SESSION",
    timelineRange: "+0ms / 0ms",
    timelineCursor: "—",
    timelineEventTitle: "A new Session will appear automatically",
    timelineDate: "—",
    timelinePlay: `▶ PLAY ${playbackRate}×`,
    footerStats: "0 agents · 0 tools · 0 tokens",
  };
}
