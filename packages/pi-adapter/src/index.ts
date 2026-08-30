import { defineAdapter } from "../../adapter-runtime/src/index.ts";
import { PiAutoDiscovery } from "./auto-discovery.ts";

export const piAdapter = defineAdapter({
  protocolVersion: 1,
  runtime: "pi",
  create: (sink, options: import("./auto-discovery.ts").PiAutoDiscoveryOptions) =>
    new PiAutoDiscovery(sink, options),
});

export { loadPiSession, parsePiSession } from "./loader.ts";
export { mapPiSession } from "./mapper.ts";
export { PiRpcMapper } from "./rpc-mapper.ts";
export { PiLiveBridge } from "./live-bridge.ts";
export { PiPassiveObserver } from "./passive-observer.ts";
export { PiAutoDiscovery };
export { discoverPiTranscripts } from "./auto-discovery.ts";
export {
  mapPiTelemetryEntry,
  parsePiTelemetry,
  PI_TELEMETRY_CHANNEL,
  PI_TELEMETRY_CUSTOM_TYPE,
  telemetrySessionId,
} from "./telemetry.ts";
export type {
  PiDiagnostic,
  PiEntry,
  PiHeader,
  PiLoadResult,
  PiParsedSession,
  PiSessionOptions,
} from "./types.ts";
export type { PiRpcMapperOptions } from "./rpc-mapper.ts";
export type {
  PiLiveBridgeOptions,
  PiLiveStartResult,
  PiRpcProcess,
  PiRpcProcessFactory,
} from "./live-bridge.ts";
export type { PiPassiveObserverOptions, PiPassiveScanResult } from "./passive-observer.ts";
export type {
  PiAutoDiscoveryOptions,
  PiAutoDiscoveryStatus,
  PiTranscriptCandidate,
} from "./auto-discovery.ts";
export type { PiTelemetryEnvelope, PiTelemetryParseResult } from "./telemetry.ts";
