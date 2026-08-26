import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFile, copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";
import { PiLiveBridge, type PiRpcProcess } from "../src/live-bridge.ts";

const fixture = resolve(import.meta.dirname, "../../../fixtures/pi/demo.jsonl");

class RecordingSink implements AcknowledgedCanonicalEventSink {
  readonly events: CanonicalEvent[] = [];

  write(event: CanonicalEvent): void {
    this.events.push(event);
  }

  async whenIdle(): Promise<void> {
    await new Promise<void>((complete) => setImmediate(complete));
  }
}

class GatedSink extends RecordingSink {
  blocked = false;

  override async whenIdle(): Promise<void> {
    if (this.blocked) throw new Error("ACK unavailable");
    await super.whenIdle();
  }
}

class FakePiProcess extends EventEmitter implements PiRpcProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 4242;
  killed = false;

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.emit("exit", 0, typeof signal === "string" ? signal : null);
    return true;
  }
}

test("bootstrap buffers RPC and suppresses lifecycle already persisted in JSONL", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-live-"));
  const sink = new RecordingSink();
  const child = new FakePiProcess();
  const calls: Array<{ command: string; args: string[] }> = [];
  const bridge = new PiLiveBridge(fixture, sink, {
    statePath: resolve(directory, "state.json"),
    sourceId: "pi-live-test",
    entryCursor: "disabled",
    extensions: ["/tmp/telemetry-extension.ts"],
    processFactory: (command, args) => {
      calls.push({ command, args });
      queueMicrotask(() => {
        const records = [
          { type: "agent_start" },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "The active branch is complete." }],
              timestamp: 1787706007000,
            },
          },
          { type: "tool_execution_start", toolCallId: "call-read", toolName: "read", args: { path: "src/main.ts" } },
          {
            type: "tool_execution_update",
            toolCallId: "call-read",
            toolName: "read",
            partialResult: { content: [{ type: "text", text: "export function main" }] },
          },
          {
            type: "tool_execution_end",
            toolCallId: "call-read",
            toolName: "read",
            result: { content: [{ type: "text", text: "export function main() {}" }] },
            isError: false,
          },
          { type: "agent_settled" },
        ];
        child.stdout.write(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
      });
      return child;
    },
  });

  const result = await bridge.start();
  assert.equal(result.replayEvents, 12);
  assert.equal(result.bufferedRpcRecords, 6);
  assert.equal(result.emittedBufferedEvents, 3);
  assert.equal(calls[0]?.command, "pi");
  assert.deepEqual(calls[0]?.args.slice(0, 3), ["--mode", "rpc", "--session"]);
  assert.deepEqual(calls[0]?.args.slice(-2), ["--extension", "/tmp/telemetry-extension.ts"]);
  assert.equal(sink.events.filter((event) => event.type === "assistant.message" && event.data.summary === "The active branch is complete.").length, 1);
  assert.equal(sink.events.filter((event) => event.type === "tool.started" && event.data.call_id === "call-read").length, 1);
  assert.equal(sink.events.filter((event) => event.type === "tool.finished" && event.data.call_id === "call-read").length, 1);
  assert.equal(sink.events.some((event) => event.type === "tool.progressed"), true);
  assert.equal(sink.events.some((event) => event.type === "agent.activation_ended"), true);
  await bridge.stop();
});

test("generation is reserved before spawn and prevents RPC event id reuse", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-generation-"));
  const statePath = resolve(directory, "state.json");
  const ids: string[] = [];

  for (let run = 1; run <= 2; run += 1) {
    const sink = new RecordingSink();
    const child = new FakePiProcess();
    const bridge = new PiLiveBridge(fixture, sink, {
      statePath,
      sourceId: "stable-source",
      entryCursor: "disabled",
      processFactory: () => child,
    });
    const result = await bridge.start();
    assert.equal(result.generation, run);
    child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    await bridge.stop();
    const event = sink.events.find((candidate) => candidate.type === "agent.activation_started");
    assert.ok(event);
    ids.push(event.event_id);
  }

  assert.notEqual(ids[0], ids[1]);
  assert.match(ids[0] ?? "", /:1:0:agent\.activation_started$/);
  assert.match(ids[1] ?? "", /:2:0:agent\.activation_started$/);
  const state = JSON.parse(await readFile(statePath, "utf8")) as { generation: number; activeLeafId?: string };
  assert.equal(state.generation, 2);
  assert.equal(state.activeLeafId, "e10");
});

test("strict LF parser ignores command responses and reports malformed records", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-framing-"));
  const sink = new RecordingSink();
  const child = new FakePiProcess();
  const diagnostics: string[] = [];
  const responses: Array<Record<string, unknown>> = [];
  const bridge = new PiLiveBridge(fixture, sink, {
    statePath: resolve(directory, "state.json"),
    entryCursor: "disabled",
    processFactory: () => child,
    onRpcResponse: (response) => responses.push(response),
    onDiagnostic: (item) => diagnostics.push(item.code),
  });
  await bridge.start();
  child.stdout.write('{"type":"response","command":"get_state","success":true}\r\n');
  child.stdout.write("not-json\n");
  bridge.writeCommand({ id: "state-1", type: "get_state" });
  await bridge.stop();
  assert.deepEqual(diagnostics, ["rpc-json-invalid"]);
  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.command, "get_state");
  assert.equal(child.stdin.read()?.toString(), '{"id":"state-1","type":"get_state"}\n');
});

test("startup fails clearly when the Pi RPC process cannot be spawned", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-missing-"));
  const sink = new RecordingSink();
  const child = new FakePiProcess();
  const diagnostics: string[] = [];
  const bridge = new PiLiveBridge(fixture, sink, {
    statePath: resolve(directory, "state.json"),
    entryCursor: "disabled",
    processFactory: () => {
      queueMicrotask(() => child.emit("error", new Error("spawn pi ENOENT")));
      return child;
    },
    onDiagnostic: (item) => diagnostics.push(item.code),
  });
  await assert.rejects(() => bridge.start(), /cannot start Pi RPC process: spawn pi ENOENT/);
  assert.deepEqual(diagnostics, ["rpc-process-error"]);
  assert.equal(child.killed, true);
});

test("real subprocess completes a simulated Pi live bridge", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-e2e-"));
  const sink = new RecordingSink();
  const script = [
    { type: "agent_start" },
    {
      type: "tool_execution_update",
      toolCallId: "call-live",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "working" }] },
    },
    { type: "agent_settled" },
  ]
    .map((value) => `process.stdout.write(${JSON.stringify(`${JSON.stringify(value)}\n`)});`)
    .join("") + "setInterval(() => {}, 1000);";
  const bridge = new PiLiveBridge(fixture, sink, {
    statePath: resolve(directory, "state.json"),
    sourceId: "pi-e2e",
    command: process.execPath,
    args: ["-e", script],
    entryCursor: "disabled",
    ackTimeoutMs: 5_000,
  });

  const started = await bridge.start();
  try {
    await waitFor(() => sink.events.length >= 15);
    assert.equal(started.replayEvents, 12);
    assert.equal(sink.events.length, 15);
    assert.equal(sink.events.some((event) => event.type === "tool.progressed" && event.data.call_id === "call-live"), true);
    assert.equal(sink.events.some((event) => event.type === "agent.activation_ended"), true);
  } finally {
    await bridge.stop();
  }
});

test("get_entries high-water catches a persisted append before live buffer drain", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-cursor-"));
  const transcript = resolve(directory, "session.jsonl");
  const statePath = resolve(directory, "state.json");
  await copyFile(fixture, transcript);
  await writeFile(
    statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      transcriptPath: transcript,
      sourceId: "pi-cursor-test",
      sessionId: "pi-demo",
      generation: 1,
      activeLeafId: "e9",
    })}\n`,
  );
  const sink = new RecordingSink();
  const child = new FakePiProcess();
  let input = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const command = JSON.parse(input.slice(0, newline)) as { id: string; type: string; since?: string };
    input = input.slice(newline + 1);
    if (command.type !== "get_entries") return;
    assert.equal(command.since, "e9");
    const entry = {
      type: "message",
      id: "e11",
      parentId: "e10",
      timestamp: "2026-08-26T01:00:09.000Z",
      message: { role: "user", content: "Caught by entry cursor", timestamp: 1787706009000 },
    };
    void appendFile(transcript, `${JSON.stringify(entry)}\n`).then(() => {
      child.stdout.write(
        `${JSON.stringify({
          id: command.id,
          type: "response",
          command: "get_entries",
          success: true,
          data: { entries: [entry], leafId: "e11" },
        })}\n`,
      );
    });
  });
  const bridge = new PiLiveBridge(transcript, sink, {
    statePath,
    sourceId: "pi-cursor-test",
    processFactory: () => child,
  });

  const started = await bridge.start();
  assert.equal(started.cursorMode, "rpc");
  assert.equal(started.generation, 2);
  assert.equal(started.catchUpEvents, 1);
  assert.equal(started.replayEvents, 13);
  assert.equal(started.activeLeafId, "e11");
  assert.equal(sink.events.filter((event) => event.type === "prompt.accepted" && event.data.excerpt === "Caught by entry cursor").length, 1);
  await bridge.stop();
});

test("older Pi without get_entries falls back to a second file read", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-fallback-"));
  const sink = new RecordingSink();
  const child = new FakePiProcess();
  const diagnostics: string[] = [];
  child.stdin.setEncoding("utf8");
  child.stdin.once("data", () => {
    child.stdout.write(
      `${JSON.stringify({
        type: "response",
        command: "get_entries",
        success: false,
        error: "Unknown command: get_entries",
      })}\n`,
    );
  });
  const bridge = new PiLiveBridge(fixture, sink, {
    statePath: resolve(directory, "state.json"),
    processFactory: () => child,
    onDiagnostic: (item) => diagnostics.push(item.code),
  });

  const started = await bridge.start();
  assert.equal(started.cursorMode, "file-fallback");
  assert.equal(started.catchUpEvents, 0);
  assert.deepEqual(diagnostics, ["rpc-entry-cursor-unsupported"]);
  await bridge.stop();
});

test("a stale saved cursor resets through full get_entries without losing RPC capability", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-cursor-reset-"));
  const statePath = resolve(directory, "state.json");
  await writeFile(
    statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      transcriptPath: fixture,
      sourceId: "pi-reset-test",
      sessionId: "pi-demo",
      generation: 4,
      activeLeafId: "missing-entry",
    })}\n`,
  );
  const sink = new RecordingSink();
  const child = new FakePiProcess();
  const commands: Array<{ id: string; type: string; since?: string }> = [];
  const diagnostics: string[] = [];
  let input = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    input += chunk;
    while (true) {
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const command = JSON.parse(input.slice(0, newline)) as { id: string; type: string; since?: string };
      input = input.slice(newline + 1);
      commands.push(command);
      const response = command.since
        ? { id: command.id, type: "response", command: "get_entries", success: false, error: "Entry not found" }
        : { id: command.id, type: "response", command: "get_entries", success: true, data: { entries: [], leafId: "e10" } };
      child.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
  const bridge = new PiLiveBridge(fixture, sink, {
    statePath,
    sourceId: "pi-reset-test",
    processFactory: () => child,
    onDiagnostic: (item) => diagnostics.push(item.code),
  });

  const started = await bridge.start();
  assert.equal(started.cursorMode, "rpc");
  assert.equal(started.generation, 5);
  assert.deepEqual(commands.map((command) => command.since), ["missing-entry", undefined]);
  assert.deepEqual(diagnostics, ["rpc-entry-cursor-reset"]);
  await bridge.stop();
});

test("required entry cursor fails instead of silently degrading on timeout", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-cursor-timeout-"));
  const sink = new RecordingSink();
  const child = new FakePiProcess();
  const bridge = new PiLiveBridge(fixture, sink, {
    statePath: resolve(directory, "state.json"),
    processFactory: () => child,
    entryCursor: "required",
    rpcTimeoutMs: 20,
  });
  await assert.rejects(() => bridge.start(), /get_entries timed out/);
  assert.equal(child.killed, true);
});

test("live telemetry scan emits only explicit custom telemetry entries", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-telemetry-live-"));
  const transcript = resolve(directory, "session.jsonl");
  const statePath = resolve(directory, "state.json");
  await copyFile(fixture, transcript);
  const sink = new RecordingSink();
  const child = new FakePiProcess();
  const bridge = new PiLiveBridge(transcript, sink, {
    statePath,
    sourceId: "pi-telemetry-live",
    processFactory: () => child,
    entryCursor: "disabled",
    telemetryPollMs: 0,
  });
  await bridge.start();
  await appendFile(
    transcript,
    [
      JSON.stringify({
        type: "message",
        id: "e11",
        parentId: "e10",
        timestamp: "2026-08-26T01:00:09.000Z",
        message: { role: "user", content: "ordinary persisted message", timestamp: 1787706009000 },
      }),
      JSON.stringify({
        type: "custom",
        id: "e12",
        parentId: "e11",
        timestamp: "2026-08-26T01:00:10.000Z",
        customType: "orchetrace.telemetry",
        data: {
          schema_version: 1,
          event_id: "live-worker:discover",
          occurred_at: "2026-08-26T01:00:10.000Z",
          kind: "agent.discovered",
          agent_id: "live-worker",
          label: "Live worker",
        },
      }),
    ].join("\n") + "\n",
  );

  assert.equal(await bridge.scanTelemetryOnce(), 2);
  assert.equal(sink.events.length, 14);
  assert.equal(sink.events.some((event) => event.data.excerpt === "ordinary persisted message"), false);
  assert.equal(
    sink.events.filter(
      (event) => event.session_id.endsWith("::pi-agent::live-worker") && event.type === "agent.spawned",
    ).length,
    1,
  );
  const state = JSON.parse(await readFile(statePath, "utf8")) as { activeLeafId?: string };
  assert.equal(state.activeLeafId, "e12");
  await bridge.stop();
});

test("telemetry ACK timeout retains one pending batch without enqueueing duplicates", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-pi-telemetry-ack-"));
  const transcript = resolve(directory, "session.jsonl");
  const statePath = resolve(directory, "state.json");
  await copyFile(fixture, transcript);
  const sink = new GatedSink();
  const child = new FakePiProcess();
  const bridge = new PiLiveBridge(transcript, sink, {
    statePath,
    processFactory: () => child,
    entryCursor: "disabled",
    telemetryPollMs: 0,
  });
  await bridge.start();
  await appendFile(
    transcript,
    `${JSON.stringify({
      type: "custom",
      id: "e11",
      parentId: "e10",
      timestamp: "2026-08-26T01:00:10.000Z",
      customType: "orchetrace.telemetry",
      data: {
        schema_version: 1,
        event_id: "ack-worker:discover",
        occurred_at: "2026-08-26T01:00:10.000Z",
        kind: "agent.discovered",
        agent_id: "ack-worker",
        label: "ACK worker",
      },
    })}\n`,
  );
  sink.blocked = true;
  await assert.rejects(() => bridge.scanTelemetryOnce(), /ACK unavailable/);
  assert.equal(sink.events.length, 14);
  await assert.rejects(() => bridge.scanTelemetryOnce(), /ACK unavailable/);
  assert.equal(sink.events.length, 14);
  sink.blocked = false;
  assert.equal(await bridge.scanTelemetryOnce(), 0);
  assert.equal(sink.events.length, 14);
  const state = JSON.parse(await readFile(statePath, "utf8")) as { activeLeafId?: string };
  assert.equal(state.activeLeafId, "e11");
  await bridge.stop();
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for simulated Pi RPC events");
    await new Promise<void>((complete) => setTimeout(complete, 10));
  }
}
