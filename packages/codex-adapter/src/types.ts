import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";

export interface CodexDiagnostic {
  level: "warning" | "error";
  code: string;
  location: string;
  message: string;
}

export interface CodexRolloutRecord {
  line: number;
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface CodexSessionIdentity {
  sessionId: string;
  parentSessionId?: string;
  label: string;
  role?: string;
  model?: string;
  provider?: string;
  cwd?: string;
  depth: number;
  origin: "root" | "subagent";
}

export interface CodexMapContext {
  sourceId: string;
  identity: CodexSessionIdentity;
  headerLine?: number;
}

export interface CodexLoadResult {
  identity: CodexSessionIdentity;
  events: CanonicalEvent[];
  diagnostics: CodexDiagnostic[];
}
