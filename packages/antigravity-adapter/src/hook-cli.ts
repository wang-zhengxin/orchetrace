#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  ANTIGRAVITY_HOOK_EVENTS,
  antigravityHookResponse,
  installAntigravityHooks,
  readAntigravityHookStatus,
  recordAntigravityHookEvent,
  uninstallAntigravityHooks,
  type AntigravityHookEventName,
} from "./hook-integration.ts";

const usage = `Usage: orchetrace-antigravity-hook <install|uninstall|status|emit> [options]

Options:
  --hooks <path>         Antigravity hooks file (default: ~/.gemini/config/hooks.json)
  --hook-events <path>   lifecycle mailbox (default: ~/.orchetrace/antigravity-hooks.jsonl)
  --event <name>         internal emit event name
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
    hooksPath: options.hooksPath,
    hookEventsPath: options.hookEventsPath,
    scriptPath: fileURLToPath(import.meta.url),
  };
  if (command === "emit") {
    if (!options.event) throw new Error("emit requires --event");
    const raw = await readFile(0, "utf8");
    const input: unknown = JSON.parse(raw);
    if (input && typeof input === "object" && !Array.isArray(input)) {
      await recordAntigravityHookEvent(
        options.event,
        input,
        options.hookEventsPath ?? process.env.ORCHETRACE_ANTIGRAVITY_HOOK_EVENTS,
      );
    }
    process.stdout.write(`${JSON.stringify(antigravityHookResponse(options.event))}\n`);
    return;
  }
  const status = command === "install"
    ? await installAntigravityHooks(common)
    : command === "uninstall"
      ? await uninstallAntigravityHooks(common)
      : command === "status"
        ? await readAntigravityHookStatus(common)
        : undefined;
  if (!status) throw new Error(`unknown command ${command}`);
  process.stdout.write(`${JSON.stringify(status)}\n`);
}

function parseOptions(args: string[]): {
  hooksPath?: string;
  hookEventsPath?: string;
  event?: AntigravityHookEventName;
} {
  const options: {
    hooksPath?: string;
    hookEventsPath?: string;
    event?: AntigravityHookEventName;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--hooks") options.hooksPath = requiredValue(args, ++index, argument);
    else if (argument === "--hook-events") options.hookEventsPath = requiredValue(args, ++index, argument);
    else if (argument === "--event") {
      const value = requiredValue(args, ++index, argument) as AntigravityHookEventName;
      if (!ANTIGRAVITY_HOOK_EVENTS.includes(value)) throw new Error(`unknown hook event ${value}`);
      options.event = value;
    } else throw new Error(`unknown option ${argument}`);
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
