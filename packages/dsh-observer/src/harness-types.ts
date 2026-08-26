export interface HarnessSessionHeader {
  readonly version: number;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly seedLength?: number;
  readonly origin?: "subagent";
  readonly delegationDepth?: number;
  readonly agentPreset?: string;
}

export interface HarnessSessionEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: Record<string, unknown>;
  readonly ignorable?: true;
}

export interface HarnessSession {
  readonly id: string;
  readonly header: HarnessSessionHeader;
  readonly events: readonly HarnessSessionEvent[];
  readonly firstLiveSeq: number;
  readonly seq: number;
}

export interface HarnessAgent {
  readonly id: string;
  readonly session: HarnessSession;
  readonly status: "idle" | "running";
  readonly options: {
    readonly provider?: string;
    readonly model?: string;
  };
}

export interface HarnessSessionPersistence {
  list(signal?: AbortSignal): Promise<HarnessSessionHeader[]>;
  readFrom(
    id: string,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: HarnessSessionHeader; events: HarnessSessionEvent[] }>;
}

export type HarnessEventName =
  | "session/created"
  | "session/event"
  | "agent/created"
  | "agent/status"
  | "agent/disposed";

export interface HarnessContextLike {
  readonly sessions: {
    list(): HarnessSession[];
  };
  readonly agents?: {
    list(): HarnessAgent[];
  };
  readonly sessionPersistence?: HarnessSessionPersistence;
  on(name: "session/created", listener: (session: HarnessSession) => void): () => void;
  on(
    name: "session/event",
    listener: (session: HarnessSession, event: HarnessSessionEvent) => void,
  ): () => void;
  on(
    name: "agent/created" | "agent/status",
    listener: (payload: { agent: HarnessAgent; status?: "idle" | "running" }) => void,
  ): () => void;
  on(name: "agent/disposed", listener: (payload: { agent: HarnessAgent }) => void): () => void;
}
