const DESCRIPTORS = new Map([
  ["claude-code", { id: "claude-code", label: "CLAUDE CODE", shortLabel: "CLAUDE", accent: "#d6a56f", sessions: "~/.claude/projects" }],
  ["pi", { id: "pi", label: "PI", shortLabel: "PI", accent: "#e4c400", sessions: "~/.pi/agent/sessions" }],
  ["deepseek-harness", { id: "deepseek-harness", label: "DEEPSEEK HARNESS", shortLabel: "DSH", accent: "#6aa9ff", sessions: "~/.dsh/sessions" }],
  ["codex", { id: "codex", label: "CODEX", shortLabel: "CODEX", accent: "#72d6a0", sessions: "~/.codex/sessions" }],
]);

export function runtimeDescriptor(runtime) {
  if (DESCRIPTORS.has(runtime)) return DESCRIPTORS.get(runtime);
  const label = String(runtime ?? "unknown").replace(/[-_]+/g, " ").trim().toUpperCase() || "UNKNOWN";
  return { id: runtime, label, shortLabel: label.slice(0, 12), accent: "#8f9490", sessions: "—" };
}

export function registeredRuntimeDescriptors() {
  return [...DESCRIPTORS.values()];
}
