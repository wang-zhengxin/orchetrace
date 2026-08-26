import type { CanonicalEvent, TerminalOutcome } from "../../protocol-ts/src/index.ts";

export interface ClaudeDiagnostic {
  level: "warning" | "error";
  code: string;
  location: string;
  message: string;
}

export interface ClaudeLoadResult {
  events: CanonicalEvent[];
  diagnostics: ClaudeDiagnostic[];
}

export interface ClaudeSessionOptions {
  sourceId?: string;
  sessionId?: string;
  mode?: "replay" | "live";
  eventEpoch?: number;
}

export interface ClaudeSourceLoadResult {
  sources: ClaudeAgentSource[];
  diagnostics: ClaudeDiagnostic[];
}

export interface ParsedLine {
  line: number;
  location: string;
  value: Record<string, unknown>;
}

export interface ClaudeAgentSource {
  id: string;
  parentId?: string;
  kind: "root" | "direct" | "workflow-group" | "workflow-subagent";
  label: string;
  role?: string;
  toolUseId?: string;
  workflowId?: string;
  lines: ParsedLine[];
}

export interface TerminalFact {
  at: string;
  outcome: TerminalOutcome;
  evidence: string;
  priority: number;
}
