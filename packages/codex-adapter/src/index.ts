import { defineAdapter } from "../../adapter-runtime/src/index.ts";
import { CodexAutoDiscovery } from "./auto-discovery.ts";

export const codexAdapter = defineAdapter({
  protocolVersion: 1,
  runtime: "codex",
  create: (sink, options: import("./auto-discovery.ts").CodexAutoDiscoveryOptions) =>
    new CodexAutoDiscovery(sink, options),
});

export { CodexAutoDiscovery };
export { discoverCodexTranscripts } from "./auto-discovery.ts";
export { loadCodexSession, parseCodexRecords, sourceIdFor } from "./loader.ts";
export { identityFromSessionMeta, mapCodexRecord } from "./mapper.ts";
export { CodexPassiveObserver } from "./passive-observer.ts";
export type * from "./types.ts";
