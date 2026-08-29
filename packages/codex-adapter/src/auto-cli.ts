#!/usr/bin/env node

import { homedir } from "node:os";
import { resolve } from "node:path";

import { NdjsonTcpSink } from "../../adapter-runtime/src/index.ts";
import { CodexAutoDiscovery } from "./auto-discovery.ts";

interface Options {
  sessionsDir: string;
  stateDir: string;
  token?: string;
  host: string;
  port: number;
  scanMs: number;
  activeWithinMs: number;
  includeExisting: boolean;
  help: boolean;
}

const usage = `Usage: orchetrace-codex-auto [options]

Passively discover active Codex rollout JSONL files and stream their events to
Orchetrace. This command never launches, resumes, or controls a Codex process.

Options:
  --sessions-dir <path>  Codex sessions directory (default: ~/.codex/sessions)
  --state-dir <path>     ACK cursor directory (default: .orchetrace/codex-auto)
  --token <token>        ingest token (default: ORCHETRACE_TOKEN)
  --host <host>          ingest host (default: 127.0.0.1)
  --port <port>          ingest port (default: 43117)
  --scan-ms <ms>         discovery interval (default: 1000)
  --active-within <ms>   active session window (default: 21600000)
  --include-existing     observe every existing Codex session
  -h, --help             show this help
`;

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  const token = options.token ?? process.env.ORCHETRACE_TOKEN;
  if (!token) throw new Error("missing --token or ORCHETRACE_TOKEN");
  const report = (item: { level: "warning" | "error"; message: string; code?: string; location?: string }) => {
    process.stderr.write(`${item.level.toUpperCase()}${item.code ? ` ${item.code}` : ""}${item.location ? ` ${item.location}` : ""}: ${item.message}\n`);
  };
  const sink = new NdjsonTcpSink({ token, host: options.host, port: options.port, onDiagnostic: report });
  let lastStatus = "";
  const discovery = new CodexAutoDiscovery(sink, {
    sessionsDir: options.sessionsDir,
    stateDir: options.stateDir,
    scanMs: options.scanMs,
    activeWithinMs: options.activeWithinMs,
    includeExisting: options.includeExisting,
    onDiagnostic: report,
    onStatus: (status) => {
      const line = `codex auto-discovery: ${status.observedSessions} observed / ${status.discoveredSessions} discovered`;
      if (line !== lastStatus) process.stderr.write(`${line}\n`);
      lastStatus = line;
    },
  });
  const initial = await discovery.start();
  process.stderr.write(`watching ${initial.sessionsDir}; ${initial.observedSessions} active Codex session(s) attached\n`);
  await waitForSignal();
  await discovery.stop();
  await sink.close();
}

function parseArguments(args: string[]): Options {
  const options: Options = {
    sessionsDir: resolve(homedir(), ".codex/sessions"),
    stateDir: resolve(".orchetrace/codex-auto"),
    host: "127.0.0.1",
    port: 43117,
    scanMs: 1_000,
    activeWithinMs: 6 * 60 * 60 * 1_000,
    includeExisting: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--include-existing") options.includeExisting = true;
    else if (argument === "--sessions-dir") options.sessionsDir = requiredValue(args, ++index, argument);
    else if (argument === "--state-dir") options.stateDir = requiredValue(args, ++index, argument);
    else if (argument === "--token") options.token = requiredValue(args, ++index, argument);
    else if (argument === "--host") options.host = requiredValue(args, ++index, argument);
    else if (argument === "--port") options.port = positiveInteger(requiredValue(args, ++index, argument), argument);
    else if (argument === "--scan-ms") options.scanMs = positiveInteger(requiredValue(args, ++index, argument), argument);
    else if (argument === "--active-within") options.activeWithinMs = positiveInteger(requiredValue(args, ++index, argument), argument);
    else throw new Error(`unknown option ${argument}`);
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
