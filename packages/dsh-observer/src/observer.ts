import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";
import type {
  HarnessAgent,
  HarnessContextLike,
  HarnessSession,
  HarnessSessionEvent,
} from "./harness-types.ts";
import { mapDshRecord } from "./mapper.ts";

export interface CanonicalEventSink {
  write(event: CanonicalEvent): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface ObserverDiagnostic {
  level: "warning" | "error";
  message: string;
  sessionId?: string;
  cause?: unknown;
}

export interface DshObserverOptions {
  sourceId?: string;
  onDiagnostic?: (diagnostic: ObserverDiagnostic) => void;
}

type PendingFact =
  | { kind: "session"; session: HarnessSession }
  | { kind: "event"; session: HarnessSession; event: HarnessSessionEvent }
  | { kind: "status"; agent: HarnessAgent; status: "idle" | "running" }
  | { kind: "disposed"; agent: HarnessAgent };

/**
 * Race-free DeepSeek Harness observer. Listeners are attached before live history
 * is adopted, then a per-session cursor deduplicates the bootstrap/live overlap.
 */
export class DshObserver {
  readonly sourceId: string;
  private readonly cursor = new Map<string, number>();
  private readonly announced = new Set<string>();
  private readonly blocked = new Set<string>();
  private readonly disposers: Array<() => void> = [];
  private readonly pending: PendingFact[] = [];
  private delivery = Promise.resolve();
  private bootstrapping = true;
  private stopped = false;
  private runtimeCounter = 0;
  private readonly ctx: HarnessContextLike;
  private readonly sink: CanonicalEventSink;
  private readonly options: DshObserverOptions;

  constructor(
    ctx: HarnessContextLike,
    sink: CanonicalEventSink,
    options: DshObserverOptions = {},
  ) {
    this.ctx = ctx;
    this.sink = sink;
    this.options = options;
    this.sourceId = options.sourceId ?? `dsh-${process.pid}`;
  }

  async start(): Promise<void> {
    this.attachListeners();

    const sessions = this.ctx.sessions.list();
    const liveIds = new Set(sessions.map((session) => session.id));
    for (const session of sessions) {
      await this.announce(session);
      // A child's leading seed belongs to its parent. Root/resumed history is
      // safe to replay because canonical ids are stable and the Rust store dedups.
      const ownStart = session.header.seedLength ?? 0;
      for (const event of session.events) {
        if (event.seq >= ownStart) await this.acceptSessionEvent(session, event);
      }
      this.cursor.set(session.id, Math.max(this.cursor.get(session.id) ?? 0, session.seq));
    }

    if (this.ctx.sessionPersistence) {
      try {
        const headers = await this.ctx.sessionPersistence.list();
        for (const header of headers) {
          if (liveIds.has(header.id)) continue;
          try {
            const stored = await this.ctx.sessionPersistence.readFrom(header.id, 0);
            const cold: HarnessSession = {
              id: stored.meta.id,
              header: stored.meta,
              events: stored.events,
              firstLiveSeq: stored.events.length,
              seq: stored.events.length,
            };
            await this.announce(cold);
            const ownStart = cold.header.seedLength ?? 0;
            for (const event of cold.events) {
              if (event.seq >= ownStart) await this.acceptSessionEvent(cold, event);
            }
            this.cursor.set(cold.id, cold.seq);
          } catch (cause: unknown) {
            this.diagnostic("warning", "cold session adoption failed", header.id, cause);
          }
        }
      } catch (cause: unknown) {
        this.diagnostic("warning", "persistence listing failed; observing live sessions only", undefined, cause);
      }
    }

    for (const agent of this.ctx.agents?.list() ?? []) {
      await this.announce(agent.session, agent);
      await this.emitStatus(agent, agent.status);
    }

    this.bootstrapping = false;
    const pending = this.pending.splice(0);
    for (const fact of pending) await this.acceptPending(fact);
    await this.delivery;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
    await this.delivery;
    await this.sink.close?.();
  }

  private attachListeners(): void {
    this.disposers.push(
      this.ctx.on("session/created", (session) => this.receive({ kind: "session", session })),
      this.ctx.on("session/event", (session, event) =>
        this.receive({ kind: "event", session, event }),
      ),
      this.ctx.on("agent/created", ({ agent }) =>
        this.receive({ kind: "status", agent, status: agent.status }),
      ),
      this.ctx.on("agent/status", ({ agent, status }) =>
        this.receive({ kind: "status", agent, status: status ?? agent.status }),
      ),
      this.ctx.on("agent/disposed", ({ agent }) => this.receive({ kind: "disposed", agent })),
    );
  }

  private receive(fact: PendingFact): void {
    if (this.stopped) return;
    if (this.bootstrapping) {
      this.pending.push(fact);
      return;
    }
    this.delivery = this.delivery
      .then(() => this.acceptPending(fact))
      .catch((cause: unknown) => this.diagnostic("error", "live delivery failed", undefined, cause));
  }

  private async acceptPending(fact: PendingFact): Promise<void> {
    switch (fact.kind) {
      case "session":
        await this.announce(fact.session);
        return;
      case "event":
        await this.acceptSessionEvent(fact.session, fact.event);
        return;
      case "status":
        await this.announce(fact.agent.session, fact.agent);
        await this.emitStatus(fact.agent, fact.status);
        return;
      case "disposed":
        await this.emitRuntime(fact.agent, "agent_disposed");
    }
  }

  private async announce(session: HarnessSession, agent?: HarnessAgent): Promise<void> {
    if (this.announced.has(session.id)) return;
    this.announced.add(session.id);
    const descriptorEvent = session.events.find((event) => event.type === "subagent/descriptor");
    const descriptor = descriptorEvent?.data;
    const isChild = session.header.parentSession !== undefined;
    await this.emitMapped({
      kind: "session_announced",
      sourceId: this.sourceId,
      header: session.header,
      descriptor: {
        mode: isChild
          ? descriptor?.mode === "continuable"
            ? "continuable"
            : "one-shot"
          : "root",
        label:
          typeof descriptor?.label === "string"
            ? descriptor.label
            : isChild
              ? `agent ${session.id.slice(0, 8)}`
              : "root agent",
        provider:
          typeof descriptor?.agentProvider === "string"
            ? descriptor.agentProvider
            : agent?.options.provider,
        model:
          typeof descriptor?.agentModel === "string" ? descriptor.agentModel : agent?.options.model,
        detailLevel: "full",
      },
    });
  }

  private async acceptSessionEvent(
    session: HarnessSession,
    event: HarnessSessionEvent,
  ): Promise<void> {
    if (this.blocked.has(session.id)) return;
    await this.announce(session);
    const next = this.cursor.get(session.id) ?? (session.header.seedLength ?? 0);
    if (event.seq < next) return;
    if (event.seq > next) {
      const missing = session.events.filter((item) => item.seq >= next && item.seq < event.seq);
      if (missing.length !== event.seq - next) {
        this.blockSession(session.id, `event gap: expected seq ${next}, received ${event.seq}`);
        return;
      }
      for (const item of missing) await this.acceptSessionEvent(session, item);
    }
    try {
      await this.emitMapped({
        kind: "session_event",
        sourceId: this.sourceId,
        sessionId: session.id,
        parentSessionId: session.header.parentSession,
        event,
      });
      this.cursor.set(session.id, event.seq + 1);
    } catch (cause: unknown) {
      this.blockSession(session.id, `cannot map required event ${event.type} at seq ${event.seq}`, cause);
    }
  }

  private async emitStatus(agent: HarnessAgent, status: "idle" | "running"): Promise<void> {
    await this.emitRuntime(agent, "agent_status", status);
  }

  private async emitRuntime(
    agent: HarnessAgent,
    kind: "agent_status" | "agent_disposed",
    status?: "idle" | "running",
  ): Promise<void> {
    const now = Date.now();
    const record = {
      kind,
      sourceId: this.sourceId,
      sessionId: agent.id,
      parentSessionId: agent.session.header.parentSession,
      sourceSeq: now * 1000 + (this.runtimeCounter++ % 1000),
      time: now,
      ...(status ? { status } : {}),
    } as const;
    await this.emitMapped(record);
  }

  private async emitMapped(record: Parameters<typeof mapDshRecord>[0]): Promise<void> {
    for (const event of mapDshRecord(record)) await this.sink.write(event);
  }

  private blockSession(sessionId: string, message: string, cause?: unknown): void {
    this.blocked.add(sessionId);
    this.diagnostic("error", message, sessionId, cause);
  }

  private diagnostic(
    level: ObserverDiagnostic["level"],
    message: string,
    sessionId?: string,
    cause?: unknown,
  ): void {
    this.options.onDiagnostic?.({ level, message, sessionId, cause });
  }
}
