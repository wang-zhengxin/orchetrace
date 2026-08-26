import {
  parsePiTelemetry,
  PI_TELEMETRY_CHANNEL,
  PI_TELEMETRY_CUSTOM_TYPE,
  type PiTelemetryEnvelope,
} from "../../pi-adapter/src/telemetry.ts";

interface PiExtensionApi {
  events: {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
  };
  appendEntry(customType: string, data?: unknown): void;
  on(event: "session_shutdown", handler: () => void): void;
}

/** Producer helper for subagent extensions; the telemetry extension persists the envelope. */
export function emitPiAgentTelemetry(pi: Pick<PiExtensionApi, "events">, envelope: PiTelemetryEnvelope): void {
  const parsed = parsePiTelemetry(envelope, "extension:emit");
  if (!parsed.envelope) throw new Error(parsed.diagnostic?.message ?? "invalid Pi telemetry envelope");
  pi.events.emit(PI_TELEMETRY_CHANNEL, parsed.envelope);
}

/** Pi extension entrypoint: validates shared-bus telemetry and persists it outside LLM context. */
export default function orchetracePiTelemetryExtension(pi: PiExtensionApi): void {
  const unsubscribe = pi.events.on(PI_TELEMETRY_CHANNEL, (value) => {
    const parsed = parsePiTelemetry(value, "extension:event-bus");
    if (!parsed.envelope) {
      process.stderr.write(
        `Orchetrace telemetry rejected: ${parsed.diagnostic?.message ?? "invalid envelope"}\n`,
      );
      return;
    }
    pi.appendEntry(PI_TELEMETRY_CUSTOM_TYPE, parsed.envelope);
  });
  pi.on("session_shutdown", unsubscribe);
}
