#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  installClaudeHooks,
  readClaudeHookStatus,
  recordClaudeHookEvent,
  uninstallClaudeHooks,
} from "./hook-integration.ts";

const usage = `Usage: orchetrace-claude-hook <install|uninstall|status|emit> [options]

Options:
  --settings <path>      Claude settings file (default: ~/.claude/settings.json)
  --hook-events <path>   lifecycle mailbox (default: ~/.orchetrace/claude-hooks.jsonl)
  -h, --help             show this help
`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(usage);
    return;
  }
  const options = parseOptions(args);
  const common = {
    settingsPath: options.settingsPath,
    hookEventsPath: options.hookEventsPath,
    scriptPath: fileURLToPath(import.meta.url),
  };
  if (command === "emit") {
    const raw = await readFile(0, "utf8");
    const input: unknown = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    await recordClaudeHookEvent(
      input,
      options.hookEventsPath ?? process.env.ORCHETRACE_CLAUDE_HOOK_EVENTS,
    );
    return;
  }
  const status =
    command === "install"
      ? await installClaudeHooks(common)
      : command === "uninstall"
        ? await uninstallClaudeHooks(common)
        : command === "status"
          ? await readClaudeHookStatus(common)
          : undefined;
  if (!status) throw new Error(`unknown command ${command}`);
  process.stdout.write(`${JSON.stringify(status)}\n`);
}

function parseOptions(args: string[]): { settingsPath?: string; hookEventsPath?: string } {
  const options: { settingsPath?: string; hookEventsPath?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--settings") options.settingsPath = requiredValue(args, ++index, argument);
    else if (argument === "--hook-events") options.hookEventsPath = requiredValue(args, ++index, argument);
    else throw new Error(`unknown option ${argument}`);
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
