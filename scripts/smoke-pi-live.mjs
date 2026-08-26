#!/usr/bin/env node

import { resolve } from "node:path";

import { PiLiveBridge } from "../packages/pi-adapter/src/live-bridge.ts";

const transcript = process.argv[2];
const statePath = process.argv[3];
const extraPiArgs = process.argv.slice(4);
const hasExplicitExtension = extraPiArgs.some((argument) => argument === "--extension" || argument === "-e");
if (!transcript || !statePath) {
  process.stderr.write("Usage: node scripts/smoke-pi-live.mjs <session.jsonl> <state.json>\n");
  process.exit(2);
}

class ImmediateAckSink {
  events = [];

  write(event) {
    this.events.push(event);
  }

  async whenIdle() {}
}

const sink = new ImmediateAckSink();
let acceptResponse;
let rejectResponse;
let acceptExtensionResponse;
let timeout;
const response = new Promise((resolveResponse, reject) => {
  acceptResponse = resolveResponse;
  rejectResponse = reject;
});
const bridge = new PiLiveBridge(resolve(transcript), sink, {
  statePath: resolve(statePath),
  args: [
    "--mode",
    "rpc",
    "--session",
    "{transcript}",
    "--offline",
    ...(hasExplicitExtension ? [] : ["--no-extensions"]),
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    ...extraPiArgs,
  ],
  onRpcResponse: (value) => {
    if (value.id === "orchetrace-live-smoke") acceptResponse(value);
    if (value.id === "orchetrace-extension-smoke") acceptExtensionResponse?.(value);
  },
  onDiagnostic: (item) => process.stderr.write(`${item.level.toUpperCase()} ${item.code}: ${item.message}\n`),
});

try {
  const started = await bridge.start();
  const extensionCommand = process.env.ORCHETRACE_SMOKE_EXTENSION_COMMAND;
  if (extensionCommand) {
    const extensionResponse = new Promise((complete) => {
      acceptExtensionResponse = complete;
    });
    bridge.writeCommand({
      id: "orchetrace-extension-smoke",
      type: "prompt",
      message: extensionCommand,
    });
    const accepted = await Promise.race([
      extensionResponse,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Pi RPC extension command timed out")), 5_000),
      ),
    ]);
    if (accepted.success !== true) throw new Error(`Pi extension command failed: ${JSON.stringify(accepted)}`);
  }
  const settleMs = Number(process.env.ORCHETRACE_SMOKE_WAIT_MS ?? 0);
  if (Number.isFinite(settleMs) && settleMs > 0) {
    await new Promise((complete) => setTimeout(complete, settleMs));
  }
  timeout = setTimeout(() => rejectResponse(new Error("Pi RPC get_state timed out")), 5_000);
  bridge.writeCommand({ id: "orchetrace-live-smoke", type: "get_state" });
  const rpc = await response;
  process.stdout.write(
    `${JSON.stringify(
      {
        piRpc: rpc.success === true,
        sessionId: started.sessionId,
        generation: started.generation,
        activeLeafId: started.activeLeafId ?? null,
        replayEvents: started.replayEvents,
        cursorMode: started.cursorMode,
        catchUpEvents: started.catchUpEvents,
        deliveredEvents: sink.events.length,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (timeout) clearTimeout(timeout);
  await bridge.stop();
}
