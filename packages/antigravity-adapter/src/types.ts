import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";

export interface AntigravityDiagnostic {
  level: "warning" | "error";
  code: string;
  location: string;
  message: string;
}

export interface AntigravityToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface AntigravityTranscriptRecord {
  line: number;
  stepIndex: number;
  source: string;
  type: string;
  status: string;
  createdAt: string;
  content?: string;
  thinking?: string;
  toolCalls: AntigravityToolCall[];
}

export interface AntigravitySessionIdentity {
  sessionId: string;
  parentSessionId?: string;
  label: string;
  role: string;
  model?: string;
  workspace?: string;
  depth: number;
}

export interface PendingAntigravityTool {
  callId: string;
  name: string;
  startedAt: string;
}

export interface AntigravityMapContext {
  sourceId: string;
  identity: AntigravitySessionIdentity;
  pendingTools?: PendingAntigravityTool[];
  activeActivationId?: string;
}

export interface AntigravityMapResult {
  events: CanonicalEvent[];
  pendingTools: PendingAntigravityTool[];
  activeActivationId?: string;
}

export interface AntigravityLoadResult extends AntigravityMapResult {
  identity: AntigravitySessionIdentity;
  diagnostics: AntigravityDiagnostic[];
}
