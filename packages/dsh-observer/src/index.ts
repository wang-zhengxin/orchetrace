import type { Context } from "@deepseek-ai/cordis";

import type { HarnessContextLike, HarnessSessionPersistence } from "./harness-types.ts";
import { NdjsonTcpSink } from "./ndjson-sink.ts";
import { DshObserver } from "./observer.ts";

export const name = "orchetrace-observer";
export const inject = ["sessions", "agents"];

export { DshAutoDiscovery, discoverDshPersistence } from "./auto-discovery.ts";
export { loadDshPersistence } from "./persistence-loader.ts";
export { DshPersistenceObserver } from "./persistence-observer.ts";
export type {
  DshAutoDiscoveryOptions,
  DshAutoDiscoveryStatus,
  DshPersistenceCandidate,
} from "./auto-discovery.ts";
export type { DshPersistenceDiagnostic, DshPersistenceLoadResult } from "./persistence-loader.ts";
export type {
  DshPersistenceObserverOptions,
  DshPersistenceScanResult,
} from "./persistence-observer.ts";

export interface Config {
  sourceId?: string;
  host?: string;
  port?: number;
  token?: string;
}

export function apply(ctx: Context, config: Config = {}): void {
  const token = config.token ?? process.env.ORCHETRACE_TOKEN;
  if (!token) throw new Error("orchetrace-observer requires config.token or ORCHETRACE_TOKEN");
  const report = (diagnostic: { level: "warning" | "error"; message: string; cause?: unknown }) => {
    const detail = diagnostic.cause ? `: ${String(diagnostic.cause)}` : "";
    ctx.logger[diagnostic.level === "error" ? "error" : "warn"](
      `[orchetrace] ${diagnostic.message}${detail}`,
    );
  };
  ctx.effect(() => {
    const sink = new NdjsonTcpSink({
      token,
      host: config.host,
      port: config.port,
      onDiagnostic: report,
    });
    const harnessContext: HarnessContextLike = {
      sessions: ctx.sessions,
      agents: ctx.agents,
      sessionPersistence: ctx.get("sessionPersistence") as HarnessSessionPersistence | undefined,
      on: ctx.on.bind(ctx) as HarnessContextLike["on"],
    };
    const observer = new DshObserver(harnessContext, sink, {
      sourceId: config.sourceId ?? "dsh-local",
      onDiagnostic: report,
    });
    void observer.start().catch((cause: unknown) =>
      report({ level: "error", message: "observer bootstrap failed", cause }),
    );
    return () => observer.stop();
  });
}
