#!/usr/bin/env node

import { homedir } from "node:os";
import { resolve } from "node:path";

import { NdjsonTcpSink } from "../../adapter-runtime/src/index.ts";
import { ClaudeAutoDiscovery } from "./auto-discovery.ts";

interface Options {
  projectsDir: string;
  stateDir: string;
  hookEventsPath: string;
  token?: string;
  host: string;
  port: number;
  scanMs: number;
  activeWithinMs: number;
  includeExisting: boolean;
  help: boolean;
}

const usage = `Usage: orchetrace-claude-auto [options]

Automatically discover active Claude Code transcripts and stream them to
an Orchetrace ingest service.

Options:
  --projects-dir <path>    Claude projects directory (default: ~/.claude/projects)
  --state-dir <path>       observer cursor directory (default: .orchetrace/claude-auto)
  --hook-events <path>     lifecycle hook mailbox (default: ~/.orchetrace/claude-hooks.jsonl)
  --token <token>          ingest token (default: ORCHETRACE_TOKEN)
  --host <host>            ingest host (default: 127.0.0.1)
  --port <port>            ingest port (default: 43117)
  --scan-ms <ms>           discovery interval (default: 1000)
  --active-within <ms>     observe existing transcripts updated within this window (default: 21600000)
  --include-existing       observe every existing root transcript
  -h, --help               show this help
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
    process.stderr.write(
      `${item.level.toUpperCase()}${item.code ? ` ${item.code}` : ""}${item.location ? ` ${item.location}` : ""}: ${item.message}\n`,
    );
  };
  let lastStatusLine = "";
  const sink = new NdjsonTcpSink({ token, host: options.host, port: options.port, onDiagnostic: report });
  const discovery = new ClaudeAutoDiscovery(sink, {
    projectsDir: options.projectsDir,
    stateDir: options.stateDir,
    hookEventsPath: options.hookEventsPath,
    scanMs: options.scanMs,
    activeWithinMs: options.activeWithinMs,
    includeExisting: options.includeExisting,
    onDiagnostic: report,
    onStatus: (status) => {
      const line = `claude auto-discovery: ${status.observedSessions} observed / ${status.discoveredSessions} discovered`;
      if (line === lastStatusLine) return;
      lastStatusLine = line;
      process.stderr.write(`${line}\n`);
    },
  });
  const initial = await discovery.start();
  process.stderr.write(
    `watching ${initial.projectsDir}; ${initial.observedSessions} active Claude session(s) attached\n`,
  );
  await waitForSignal();
  await discovery.stop();
  await sink.close();
}

function parseArguments(args: string[]): Options {
  const options: Options = {
    projectsDir: resolve(homedir(), ".claude/projects"),
    stateDir: resolve(".orchetrace/claude-auto"),
    hookEventsPath: resolve(homedir(), ".orchetrace/claude-hooks.jsonl"),
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
    else if (argument === "--projects-dir") options.projectsDir = requiredValue(args, ++index, argument);
    else if (argument === "--state-dir") options.stateDir = requiredValue(args, ++index, argument);
    else if (argument === "--hook-events") options.hookEventsPath = requiredValue(args, ++index, argument);
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
