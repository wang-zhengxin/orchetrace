import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mapDshRecord, type DshRecord } from "./mapper.ts";

const workspaceDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const primaryPath = resolve(workspaceDir, "fixtures/dsh/canonical-events.jsonl");
const outputPath = resolve(workspaceDir, "fixtures/dsh/demo-canonical-events.jsonl");
const primaryAt = Date.parse("2026-08-25T02:00:00Z");
const at = Date.parse("2026-08-25T02:04:00Z");

interface DemoAgent {
  id: string;
  parentId: string;
  label: string;
  role: string;
  depth: number;
  startMs: number;
  durationMs: number;
  prompt: string;
  tool: string;
  outcome?: "succeeded" | "failed";
}

function agentRecords(agent: DemoAgent): DshRecord[] {
  const startedAt = primaryAt + agent.startMs;
  const endedAt = startedAt + agent.durationMs;
  const activationId = `${agent.id}-a1`;
  const callId = `${agent.id}-tool`;
  const failed = agent.outcome === "failed";
  return [
    {
      kind: "session_announced",
      sourceId: "local-demo",
      header: {
        id: agent.id,
        parentSession: agent.parentId,
        cwd: "/workspace/atlas",
        createdAt: startedAt,
        origin: "subagent",
        delegationDepth: agent.depth,
      },
      descriptor: {
        mode: "one-shot",
        label: agent.label,
        role: agent.role,
        provider: "deepseek",
        model: agent.depth > 1 ? "DeepSeek-V4-Flash" : "DeepSeek-V4",
      },
    },
    {
      kind: "activation_started",
      sourceId: "local-demo",
      sessionId: agent.id,
      parentSessionId: agent.parentId,
      sourceSeq: 1000,
      time: startedAt + 30,
      activationId,
    },
    {
      kind: "agent_status",
      sourceId: "local-demo",
      sessionId: agent.id,
      parentSessionId: agent.parentId,
      sourceSeq: 1001,
      time: startedAt + 50,
      status: "running",
    },
    {
      kind: "session_event",
      sourceId: "local-demo",
      sessionId: agent.id,
      parentSessionId: agent.parentId,
      event: { seq: 0, time: startedAt + 80, type: "user/message", data: { content: agent.prompt } },
    },
    {
      kind: "session_event",
      sourceId: "local-demo",
      sessionId: agent.id,
      parentSessionId: agent.parentId,
      event: {
        seq: 1,
        time: startedAt + 220,
        type: "tool/call",
        data: { callId, name: agent.tool, arguments: { target: agent.label } },
      },
    },
    {
      kind: "session_event",
      sourceId: "local-demo",
      sessionId: agent.id,
      parentSessionId: agent.parentId,
      event: {
        seq: 2,
        time: endedAt - 260,
        type: "tool/result",
        data: {
          callId,
          name: agent.tool,
          isError: failed,
          durationMs: Math.max(100, agent.durationMs - 480),
          content: failed ? `${agent.label} found a blocking regression.` : `${agent.label} completed with verified evidence.`,
        },
      },
    },
    {
      kind: "session_event",
      sourceId: "local-demo",
      sessionId: agent.id,
      parentSessionId: agent.parentId,
      event: {
        seq: 3,
        time: endedAt - 180,
        type: "assistant/message",
        data: { content: failed ? "A blocking issue requires follow-up." : "Evidence is ready for the orchestrator." },
      },
    },
    {
      kind: "agent_outcome",
      sourceId: "local-demo",
      sessionId: agent.id,
      parentSessionId: agent.parentId,
      sourceSeq: 1002,
      time: endedAt - 80,
      outcome: agent.outcome ?? "succeeded",
      evidence: failed ? "verification returned a reproducible failure" : "one-shot task returned verified evidence",
    },
    {
      kind: "activation_ended",
      sourceId: "local-demo",
      sessionId: agent.id,
      parentSessionId: agent.parentId,
      sourceSeq: 1003,
      time: endedAt,
      activationId,
      status: "inactive",
    },
  ];
}

const expanded = [
  {
    id: "agent-security",
    parentId: "agent-research",
    label: "security auditor",
    role: "security",
    depth: 2,
    startMs: 2_450,
    durationMs: 2_400,
    prompt: "Audit local ingest authentication and loopback boundaries.",
    tool: "security_scan",
  },
  {
    id: "agent-schema",
    parentId: "agent-research",
    label: "schema reviewer",
    role: "protocol",
    depth: 2,
    startMs: 3_150,
    durationMs: 2_100,
    prompt: "Verify canonical event compatibility across all runtimes.",
    tool: "schema_diff",
  },
  {
    id: "agent-release",
    parentId: "run-root",
    label: "release coordinator",
    role: "release",
    depth: 1,
    startMs: 4_900,
    durationMs: 3_900,
    prompt: "Coordinate release evidence from every active workstream.",
    tool: "release_check",
  },
  {
    id: "agent-accessibility",
    parentId: "agent-ui",
    label: "accessibility reviewer",
    role: "a11y",
    depth: 2,
    startMs: 5_850,
    durationMs: 1_850,
    prompt: "Check terminal contrast, focus, and keyboard navigation.",
    tool: "contrast_audit",
  },
  {
    id: "agent-performance",
    parentId: "agent-builder",
    label: "performance profiler",
    role: "performance",
    depth: 2,
    startMs: 6_050,
    durationMs: 2_550,
    prompt: "Profile replay redraw latency under concurrent Agent activity.",
    tool: "cargo_bench",
    outcome: "failed" as const,
  },
  {
    id: "agent-release-notes",
    parentId: "agent-release",
    label: "release notes writer",
    role: "documentation",
    depth: 2,
    startMs: 6_500,
    durationMs: 2_150,
    prompt: "Summarize verified changes and known limitations.",
    tool: "write_report",
  },
] satisfies DemoAgent[];

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
const expandedLines = expanded.flatMap(agentRecords).flatMap(mapDshRecord).map((event) => JSON.stringify(event));
const secondaryLines = secondary.flatMap(mapDshRecord).map((event) => JSON.stringify(event));
await writeFile(outputPath, `${primary}\n${expandedLines.join("\n")}\n${secondaryLines.join("\n")}\n`);
console.log(`wrote 14-Agent demo with ${expandedLines.length} expanded and ${secondaryLines.length} secondary events`);
