import { defineAdapter } from "../../adapter-runtime/src/index.ts";
import { ClaudeAutoDiscovery } from "./auto-discovery.ts";

export const claudeAdapter = defineAdapter({
  protocolVersion: 1,
  runtime: "claude-code",
  create: (sink, options: import("./auto-discovery.ts").ClaudeAutoDiscoveryOptions) =>
    new ClaudeAutoDiscovery(sink, options),
});

export { loadClaudeSession, loadClaudeSources } from "./loader.ts";
export { ClaudeLiveObserver } from "./live-observer.ts";
export { ClaudeAutoDiscovery };
export { discoverClaudeTranscripts } from "./auto-discovery.ts";
export {
  buildClaudeHookCommand,
  installClaudeHooks,
  readClaudeHookStatus,
  recordClaudeHookEvent,
  uninstallClaudeHooks,
} from "./hook-integration.ts";
export type {
  ClaudeDiagnostic,
  ClaudeLoadResult,
  ClaudeSessionOptions,
  ClaudeSourceLoadResult,
} from "./types.ts";
export type { ClaudeLiveObserverOptions, ClaudeScanResult } from "./live-observer.ts";
export type {
  ClaudeAutoDiscoveryOptions,
  ClaudeAutoDiscoveryStatus,
  ClaudeTranscriptCandidate,
} from "./auto-discovery.ts";
