#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { NdjsonTcpSink } from "../../adapter-runtime/src/index.ts";
import { PiLiveBridge } from "./live-bridge.ts";

interface Options {
  transcript?: string;
  sourceId?: string;
  sessionId?: string;
  statePath?: string;
  token?: string;
  host?: string;
  port?: number;
  command?: string;
  rpcArgs: string[];
  extensions: string[];
  rpcTimeoutMs?: number;
  telemetryPollMs?: number;
  entryCursor: "auto" | "required" | "disabled";
  forwardStdin: boolean;
  allowPartial: boolean;
  help: boolean;
}

const usage = `Usage: orchetrace-pi-live <session.jsonl> [options]

Start a Pi RPC subprocess, replay its persisted active branch, then send live
lifecycle events to an Orchetrace ingest service with ACK backpressure.

Options:
  --source-id <id>      stable source identity
  --session-id <id>     override session identity
  --state <path>        live state file (default: .orchetrace/pi-<hash>.live.json)
  --token <token>       ingest token (default: ORCHETRACE_TOKEN)
  --host <host>         ingest host (default: 127.0.0.1)
  --port <port>         ingest port (default: 43117)
  --pi-command <path>   Pi executable (default: pi)
  --pi-arg <value>      override RPC argument; repeatable; {transcript} is expanded
  --pi-extension <path> append an explicit Pi extension; repeatable
  --rpc-timeout-ms <ms> internal RPC request timeout (default: 5000)
  --require-entry-cursor fail if Pi does not support get_entries(since)
  --disable-entry-cursor skip RPC high-water and use Replay only
  --telemetry-poll-ms <ms> custom telemetry scan interval (default: 500)
  --disable-telemetry-poll disable live custom-entry telemetry scans
  --forward-stdin       proxy caller JSONL stdin to Pi RPC stdin
  --allow-partial       continue despite recoverable session diagnostics
  -h, --help            show this help

Default Pi arguments: --mode rpc --session {transcript}
`;

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  if (!options.transcript) throw new Error(`missing session path\n\n${usage}`);
  const transcript = resolve(options.transcript);
  const token = options.token ?? process.env.ORCHETRACE_TOKEN;
  if (!token) throw new Error("missing --token or ORCHETRACE_TOKEN");
  const statePath = resolve(
    options.statePath ??
      `.orchetrace/pi-${createHash("sha256").update(transcript).digest("hex").slice(0, 16)}.live.json`,
  );
  const report = (item: { level: "warning" | "error"; message: string; code?: string; location?: string }) => {
    process.stderr.write(
      `${item.level.toUpperCase()}${item.code ? ` ${item.code}` : ""}${item.location ? ` ${item.location}` : ""}: ${item.message}\n`,
    );
  };
  const sink = new NdjsonTcpSink({
    token,
    host: options.host,
    port: options.port,
    onDiagnostic: report,
  });
  const bridge = new PiLiveBridge(transcript, sink, {
    sourceId: options.sourceId,
    sessionId: options.sessionId,
    statePath,
    command: options.command,
    args: options.rpcArgs.length > 0 ? options.rpcArgs : undefined,
    extensions: options.extensions,
    rpcTimeoutMs: options.rpcTimeoutMs,
    entryCursor: options.entryCursor,
    telemetryPollMs: options.telemetryPollMs,
    allowPartial: options.allowPartial,
    onRpcResponse: options.forwardStdin
      ? (response) => process.stdout.write(`${JSON.stringify(response)}\n`)
      : undefined,
    onDiagnostic: report,
  });
  const started = await bridge.start();
  process.stderr.write(
    `bridging Pi session ${started.sessionId}; generation ${started.generation}; ` +
      `replayed ${started.replayEvents}; cursor ${started.cursorMode}; caught up ${started.catchUpEvents}; ` +
      `state -> ${statePath}\n`,
  );
  if (options.forwardStdin) {
    process.stdin.on("data", (chunk: Buffer | string) => bridge.writeRaw(chunk));
    process.stdin.resume();
  }
  await Promise.race([waitForSignal(), bridge.waitForExit()]);
  await bridge.stop();
  await sink.close();
}

function parseArguments(args: string[]): Options {
  const options: Options = {
    rpcArgs: [],
    extensions: [],
    entryCursor: "auto",
    forwardStdin: false,
    allowPartial: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--forward-stdin") options.forwardStdin = true;
    else if (argument === "--allow-partial") options.allowPartial = true;
    else if (argument === "--require-entry-cursor") options.entryCursor = cursorPolicy(options, "required", argument);
    else if (argument === "--disable-entry-cursor") options.entryCursor = cursorPolicy(options, "disabled", argument);
    else if (argument === "--disable-telemetry-poll") options.telemetryPollMs = 0;
    else if (argument === "--source-id") options.sourceId = requiredValue(args, ++index, argument);
    else if (argument === "--session-id") options.sessionId = requiredValue(args, ++index, argument);
    else if (argument === "--state") options.statePath = requiredValue(args, ++index, argument);
    else if (argument === "--token") options.token = requiredValue(args, ++index, argument);
    else if (argument === "--host") options.host = requiredValue(args, ++index, argument);
    else if (argument === "--port") options.port = positiveInteger(requiredValue(args, ++index, argument), argument);
    else if (argument === "--pi-command") options.command = requiredValue(args, ++index, argument);
    else if (argument === "--pi-arg") options.rpcArgs.push(requiredValue(args, ++index, argument, false));
    else if (argument === "--pi-extension") options.extensions.push(requiredValue(args, ++index, argument));
    else if (argument === "--rpc-timeout-ms") options.rpcTimeoutMs = positiveInteger(requiredValue(args, ++index, argument), argument);
    else if (argument === "--telemetry-poll-ms") options.telemetryPollMs = positiveInteger(requiredValue(args, ++index, argument), argument);
    else if (argument.startsWith("-")) throw new Error(`unknown option ${argument}`);
    else if (options.transcript) throw new Error(`unexpected positional argument ${argument}`);
    else options.transcript = argument;
  }
  return options;
}

function cursorPolicy(
  options: Options,
  policy: "required" | "disabled",
  option: string,
): "required" | "disabled" {
  if (options.entryCursor !== "auto" && options.entryCursor !== policy) {
    throw new Error(`${option} conflicts with the previously selected entry cursor policy`);
  }
  return policy;
}

function requiredValue(args: string[], index: number, option: string, rejectOption = true): string {
  const value = args[index];
  if (!value || (rejectOption && value.startsWith("-"))) throw new Error(`${option} requires a value`);
  return value;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} requires a positive integer`);
  return parsed;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolveSignal) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolveSignal();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
