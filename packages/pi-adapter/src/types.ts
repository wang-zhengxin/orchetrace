import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";

export interface PiDiagnostic {
  level: "warning" | "error";
  code: string;
  location: string;
  message: string;
}

export interface PiSessionOptions {
  sourceId?: string;
  sessionId?: string;
  /** RPC mode already has authoritative lifecycle events and disables this passive derivation. */
  rootLifecycle?: boolean;
}

export interface PiLoadResult {
  events: CanonicalEvent[];
  diagnostics: PiDiagnostic[];
  activeLeafId?: string;
  activeEntryCount: number;
  abandonedEntryCount: number;
}

export interface PiHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd?: string;
  parentSession?: string;
}

export interface PiEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  line: number;
  value: Record<string, unknown>;
}

export interface PiParsedSession {
  header: PiHeader;
  entries: PiEntry[];
  activePath: PiEntry[];
  contextEntryIds: Set<string>;
  diagnostics: PiDiagnostic[];
}
