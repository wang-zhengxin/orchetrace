#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { NdjsonTcpSink } from "../../adapter-runtime/src/index.ts";
import { ClaudeLiveObserver } from "./live-observer.ts";

interface Options {
  transcript?: string;
  sourceId?: string;
  sessionId?: string;
  statePath?: string;
  token?: string;
  host?: string;
  port?: number;
  pollMs?: number;
  allowPartial: boolean;
  help: boolean;
}

const usage = `Usage: orchetrace-claude-live <transcript.jsonl> [options]

Tail a Claude Code transcript tree and send ACK-gated Canonical Events to
an Orchetrace ingest service.

Options:
  --source-id <id>      stable source identity
  --session-id <id>     override root session identity
  --state <path>        cursor state file (default: .orchetrace/claude-<hash>.cursor.json)
  --token <token>       ingest token (default: ORCHETRACE_TOKEN)
  --host <host>         ingest host (default: 127.0.0.1)
  --port <port>         ingest port (default: 43117)
  --poll-ms <ms>        scan interval (default: 500)
  --allow-partial       advance past recoverable malformed input
  -h, --help            show this help
`;

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  if (!options.transcript) throw new Error(`missing transcript path\n\n${usage}`);
  const transcript = resolve(options.transcript);
  const token = options.token ?? process.env.ORCHETRACE_TOKEN;
  if (!token) throw new Error("missing --token or ORCHETRACE_TOKEN");
  const statePath = resolve(
    options.statePath ?? `.orchetrace/claude-${createHash("sha256").update(transcript).digest("hex").slice(0, 16)}.cursor.json`,
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
  const observer = new ClaudeLiveObserver(transcript, sink, {
    sourceId: options.sourceId,
    sessionId: options.sessionId,
    statePath,
    pollMs: options.pollMs,
    allowPartial: options.allowPartial,
    onDiagnostic: report,
  });
  await observer.start();
  process.stderr.write(`observing ${transcript}; cursor -> ${statePath}\n`);
  await waitForSignal();
  await observer.stop();
  await sink.close();
}

function parseArguments(args: string[]): Options {
  const options: Options = { allowPartial: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--allow-partial") options.allowPartial = true;
    else if (argument === "--source-id") options.sourceId = requiredValue(args, ++index, argument);
    else if (argument === "--session-id") options.sessionId = requiredValue(args, ++index, argument);
    else if (argument === "--state") options.statePath = requiredValue(args, ++index, argument);
    else if (argument === "--token") options.token = requiredValue(args, ++index, argument);
    else if (argument === "--host") options.host = requiredValue(args, ++index, argument);
    else if (argument === "--port") options.port = positiveInteger(requiredValue(args, ++index, argument), argument);
    else if (argument === "--poll-ms") options.pollMs = positiveInteger(requiredValue(args, ++index, argument), argument);
    else if (argument.startsWith("-")) throw new Error(`unknown option ${argument}`);
    else if (options.transcript) throw new Error(`unexpected positional argument ${argument}`);
    else options.transcript = argument;
  }
  return options;
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value`);
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
