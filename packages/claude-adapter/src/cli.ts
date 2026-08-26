#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

import { loadClaudeSession } from "./loader.ts";

interface CliOptions {
  transcript?: string;
  output?: string;
  sourceId?: string;
  sessionId?: string;
  allowPartial: boolean;
  help: boolean;
}

const usage = `Usage: orchetrace-claude <transcript.jsonl> [options]

Map a Claude Code transcript and its sibling subagent/workflow files to
Orchetrace Canonical Event JSONL.

Options:
  --output <path>       write JSONL to a file instead of stdout
  --source-id <id>      stable source identity (default: claude-local)
  --session-id <id>     override the root session identity
  --allow-partial       emit valid events even when input diagnostics contain errors
  -h, --help            show this help
`;

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  if (!options.transcript) throw new Error(`missing transcript path\n\n${usage}`);

  const result = await loadClaudeSession(options.transcript, {
    sourceId: options.sourceId,
    sessionId: options.sessionId,
  });
  for (const diagnostic of result.diagnostics) {
    process.stderr.write(
      `${diagnostic.level.toUpperCase()} ${diagnostic.code} ${diagnostic.location}: ${diagnostic.message}\n`,
    );
  }
  const hasErrors = result.diagnostics.some((diagnostic) => diagnostic.level === "error");
  if (hasErrors && !options.allowPartial) {
    throw new Error("Claude source contains errors; use --allow-partial to emit recoverable events");
  }

  const jsonl = `${result.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  if (options.output) {
    await writeFile(options.output, jsonl);
    process.stderr.write(`mapped ${result.events.length} events to ${options.output}\n`);
  } else {
    process.stdout.write(jsonl);
  }
}

function parseArguments(args: string[]): CliOptions {
  const options: CliOptions = { allowPartial: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-h" || argument === "--help") {
      options.help = true;
    } else if (argument === "--allow-partial") {
      options.allowPartial = true;
    } else if (argument === "--output") {
      options.output = requiredValue(args, ++index, argument);
    } else if (argument === "--source-id") {
      options.sourceId = requiredValue(args, ++index, argument);
    } else if (argument === "--session-id") {
      options.sessionId = requiredValue(args, ++index, argument);
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown option ${argument}`);
    } else if (options.transcript) {
      throw new Error(`unexpected positional argument ${argument}`);
    } else {
      options.transcript = argument;
    }
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
