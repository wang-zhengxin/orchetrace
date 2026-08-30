export function runtimeVisualState(status, fallback = "browser") {
  const phase = status?.phase ?? fallback;
  const health = status?.diagnostics?.health;
  const visual = phase === "running" && ["warning", "degraded"].includes(health)
    ? health
    : phase;
  return {
    phase,
    visual,
    warningCount: Number(status?.diagnostics?.warning_count ?? 0),
    errorCount: Number(status?.diagnostics?.error_count ?? 0),
    lastDiagnostic: status?.diagnostics?.last_diagnostic ?? null,
  };
}

export function aggregateRuntimeDiagnostics(statuses) {
  let warningCount = 0;
  let errorCount = 0;
  for (const status of statuses) {
    warningCount += Number(status?.diagnostics?.warning_count ?? 0);
    errorCount += Number(status?.diagnostics?.error_count ?? 0);
  }
  return { warningCount, errorCount };
}

export function diagnosticSuffix(status) {
  const { warningCount, errorCount } = runtimeVisualState(status);
  if (errorCount > 0) return ` · ${errorCount} error${errorCount === 1 ? "" : "s"}`;
  if (warningCount > 0) return ` · ${warningCount} warning${warningCount === 1 ? "" : "s"}`;
  return "";
}
