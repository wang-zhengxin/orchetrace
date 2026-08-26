import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mapDshRecord, type DshRecord } from "./mapper.ts";

const workspaceDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const primaryPath = resolve(workspaceDir, "fixtures/dsh/canonical-events.jsonl");
const outputPath = resolve(workspaceDir, "fixtures/dsh/demo-canonical-events.jsonl");
const at = Date.parse("2026-08-25T02:04:00Z");

const secondary: DshRecord[] = [
  {
    kind: "session_announced",
    sourceId: "local-demo",
    header: { id: "run-smoke", cwd: "/workspace/atlas", createdAt: at, delegationDepth: 0 },
    descriptor: {
      mode: "root",
      label: "release smoke",
      role: "qa",
      provider: "deepseek",
      model: "DeepSeek-V4-Flash",
    },
  },
  {
    kind: "activation_started",
    sourceId: "local-demo",
    sessionId: "run-smoke",
    sourceSeq: 1000,
    time: at + 100,
    activationId: "smoke-a1",
  },
  {
    kind: "agent_status",
    sourceId: "local-demo",
    sessionId: "run-smoke",
    sourceSeq: 1001,
    time: at + 120,
    status: "running",
  },
  {
    kind: "session_event",
    sourceId: "local-demo",
    sessionId: "run-smoke",
    event: {
      seq: 0,
      time: at + 180,
      type: "user/message",
      data: { content: "Run the release smoke suite and report only verified failures." },
    },
  },
  {
    kind: "session_event",
    sourceId: "local-demo",
    sessionId: "run-smoke",
    event: {
      seq: 1,
      time: at + 500,
      type: "tool/call",
      data: { callId: "smoke-tests", name: "bash", arguments: "{\"command\":\"cargo test --workspace\"}" },
    },
  },
  {
    kind: "session_event",
    sourceId: "local-demo",
    sessionId: "run-smoke",
    event: {
      seq: 2,
      time: at + 2_400,
      type: "tool/result",
      data: { callId: "smoke-tests", name: "bash", durationMs: 1_900, content: "All checks passed." },
    },
  },
  {
    kind: "agent_outcome",
    sourceId: "local-demo",
    sessionId: "run-smoke",
    sourceSeq: 1002,
    time: at + 2_500,
    outcome: "succeeded",
    evidence: "release smoke command exited with code 0",
  },
  {
    kind: "activation_ended",
    sourceId: "local-demo",
    sessionId: "run-smoke",
    sourceSeq: 1003,
    time: at + 2_550,
    activationId: "smoke-a1",
    status: "inactive",
  },
];

const primary = (await readFile(primaryPath, "utf8")).trim();
const secondaryLines = secondary.flatMap(mapDshRecord).map((event) => JSON.stringify(event));
await writeFile(outputPath, `${primary}\n${secondaryLines.join("\n")}\n`);
console.log(`wrote multi-run demo with ${secondaryLines.length} secondary events`);
