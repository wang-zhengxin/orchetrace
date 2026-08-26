#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

import { loadPiSession } from "./loader.ts";

interface Options {
  input?: string;
  output?: string;
  sourceId?: string;
  sessionId?: string;
  allowPartial: boolean;
  help: boolean;
}

const usage = `Usage: orchetrace-pi <session.jsonl> [options]

Map the active branch of a Pi session tree to Orchetrace Canonical Event JSONL.

Options:
  --output <path>       write JSONL to a file instead of stdout
  --source-id <id>      stable source identity (default: pi-local)
  --session-id <id>     override the Pi session id
  --allow-partial       emit valid events despite input diagnostics
  -h, --help            show this help
`;

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  if (!options.input) throw new Error(`missing Pi session path\n\n${usage}`);
  const result = await loadPiSession(options.input, {
    sourceId: options.sourceId,
    sessionId: options.sessionId,
  });
  for (const item of result.diagnostics) {
    process.stderr.write(`${item.level.toUpperCase()} ${item.code} ${item.location}: ${item.message}\n`);
  }
  if (!options.allowPartial && result.diagnostics.some((item) => item.level === "error")) {
    throw new Error("Pi session contains errors; use --allow-partial to emit recoverable events");
  }
  const jsonl = `${result.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  if (options.output) {
    await writeFile(options.output, jsonl);
    process.stderr.write(
      `mapped ${result.events.length} events from ${result.activeEntryCount} active entries; ignored ${result.abandonedEntryCount} abandoned entries\n`,
    );
  } else {
    process.stdout.write(jsonl);
  }
}

function parseArguments(args: string[]): Options {
  const options: Options = { allowPartial: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--allow-partial") options.allowPartial = true;
    else if (argument === "--output") options.output = requiredValue(args, ++index, argument);
    else if (argument === "--source-id") options.sourceId = requiredValue(args, ++index, argument);
    else if (argument === "--session-id") options.sessionId = requiredValue(args, ++index, argument);
    else if (argument.startsWith("-")) throw new Error(`unknown option ${argument}`);
    else if (options.input) throw new Error(`unexpected positional argument ${argument}`);
    else options.input = argument;
  }
  return options;
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value`);
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
