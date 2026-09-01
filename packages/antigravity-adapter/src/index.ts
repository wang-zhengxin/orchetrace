import { defineAdapter } from "../../adapter-runtime/src/index.ts";
import { AntigravityAutoDiscovery } from "./auto-discovery.ts";

export const antigravityAdapter = defineAdapter({
  protocolVersion: 1,
  runtime: "antigravity",
  create: (
    sink,
    options: import("./auto-discovery.ts").AntigravityAutoDiscoveryOptions,
  ) => new AntigravityAutoDiscovery(sink, options),
});

export { AntigravityAutoDiscovery, discoverAntigravityTranscripts } from "./auto-discovery.ts";
export {
  identityFromTranscriptPath,
  loadAntigravitySession,
  parseAntigravityRecords,
  sourceIdForAntigravityRoot,
} from "./loader.ts";
export { mapAntigravityRecords } from "./mapper.ts";
export { AntigravityPassiveObserver } from "./passive-observer.ts";
export {
  ANTIGRAVITY_HOOK_EVENTS,
  antigravityHookResponse,
  buildAntigravityHookCommand,
  installAntigravityHooks,
  readAntigravityHookStatus,
  recordAntigravityHookEvent,
  uninstallAntigravityHooks,
} from "./hook-integration.ts";
export type * from "./types.ts";
