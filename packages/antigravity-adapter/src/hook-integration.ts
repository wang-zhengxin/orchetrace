import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const MANAGED_HOOK = "orchetrace-observer";
export const ANTIGRAVITY_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PreInvocation",
  "PostInvocation",
  "Stop",
] as const;

export type AntigravityHookEventName = (typeof ANTIGRAVITY_HOOK_EVENTS)[number];

interface CommandHook {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
  [key: string]: unknown;
}

interface AntigravityHooks {
  [key: string]: unknown;
}

export interface AntigravityHookInstallOptions {
  hooksPath?: string;
  hookEventsPath?: string;
  scriptPath: string;
  nodePath?: string;
}

export interface AntigravityHookStatus {
  installed: boolean;
  hooksPath: string;
  hookEventsPath: string;
  installedEvents: string[];
}

export interface AntigravityHookInput {
  conversationId?: unknown;
  workspacePaths?: unknown;
  transcriptPath?: unknown;
  artifactDirectoryPath?: unknown;
  modelName?: unknown;
  stepIdx?: unknown;
  invocationNum?: unknown;
  executionNum?: unknown;
  terminationReason?: unknown;
  fullyIdle?: unknown;
  toolCall?: unknown;
}

export async function installAntigravityHooks(
  options: AntigravityHookInstallOptions,
): Promise<AntigravityHookStatus> {
  const hooksPath = resolve(options.hooksPath ?? resolve(homedir(), ".gemini/config/hooks.json"));
  const hookEventsPath = resolve(
    options.hookEventsPath ?? resolve(homedir(), ".orchetrace/antigravity-hooks.jsonl"),
  );
  const hooks = await readHooks(hooksPath);
  const handler = (event: AntigravityHookEventName): CommandHook => ({
    type: "command",
    command: buildAntigravityHookCommand({
      event,
      nodePath: options.nodePath ?? process.execPath,
      scriptPath: resolve(options.scriptPath),
      hookEventsPath,
    }),
    timeout: 5,
  });
  hooks[MANAGED_HOOK] = {
    PreToolUse: [{ matcher: "*", hooks: [handler("PreToolUse")] }],
    PostToolUse: [{ matcher: "*", hooks: [handler("PostToolUse")] }],
    PreInvocation: [handler("PreInvocation")],
    PostInvocation: [handler("PostInvocation")],
    Stop: [handler("Stop")],
  };
  await writeHooks(hooksPath, hooks);
  return readAntigravityHookStatus({ ...options, hooksPath, hookEventsPath });
}

export async function uninstallAntigravityHooks(
  options: AntigravityHookInstallOptions,
): Promise<AntigravityHookStatus> {
  const hooksPath = resolve(options.hooksPath ?? resolve(homedir(), ".gemini/config/hooks.json"));
  const hookEventsPath = resolve(
    options.hookEventsPath ?? resolve(homedir(), ".orchetrace/antigravity-hooks.jsonl"),
  );
  const hooks = await readHooks(hooksPath);
  delete hooks[MANAGED_HOOK];
  await writeHooks(hooksPath, hooks);
  return readAntigravityHookStatus({ ...options, hooksPath, hookEventsPath });
}

export async function readAntigravityHookStatus(
  options: AntigravityHookInstallOptions,
): Promise<AntigravityHookStatus> {
  const hooksPath = resolve(options.hooksPath ?? resolve(homedir(), ".gemini/config/hooks.json"));
  const hookEventsPath = resolve(
    options.hookEventsPath ?? resolve(homedir(), ".orchetrace/antigravity-hooks.jsonl"),
  );
  const hooks = await readHooks(hooksPath);
  const managed = objectValue(hooks[MANAGED_HOOK]);
  const installedEvents = ANTIGRAVITY_HOOK_EVENTS.filter((event) =>
    containsManagedCommand(managed[event]),
  );
  return {
    installed: installedEvents.length === ANTIGRAVITY_HOOK_EVENTS.length,
    hooksPath,
    hookEventsPath,
    installedEvents,
  };
}

export async function recordAntigravityHookEvent(
  event: AntigravityHookEventName,
  input: AntigravityHookInput,
  hookEventsPath = resolve(homedir(), ".orchetrace/antigravity-hooks.jsonl"),
): Promise<boolean> {
  if (
    !ANTIGRAVITY_HOOK_EVENTS.includes(event) ||
    typeof input.transcriptPath !== "string" ||
    !input.transcriptPath.trim()
  ) {
    return false;
  }
  const toolCall = objectValue(input.toolCall);
  const record = Object.fromEntries(
    Object.entries({
      hook_event_name: event,
      conversation_id: stringValue(input.conversationId),
      transcript_path: input.transcriptPath,
      workspace_paths: stringArray(input.workspacePaths),
      model_name: stringValue(input.modelName),
      tool_name: stringValue(toolCall.name),
      step_index: integerValue(input.stepIdx),
      invocation_number: integerValue(input.invocationNum),
      execution_number: integerValue(input.executionNum),
      termination_reason: stringValue(input.terminationReason),
      fully_idle: booleanValue(input.fullyIdle),
      at: new Date().toISOString(),
    }).filter(([, value]) => value !== undefined),
  );
  const path = resolve(hookEventsPath);
  await mkdir(dirname(path), { recursive: true });
  const handle = await import("node:fs/promises").then(({ open }) => open(path, "a", 0o600));
  try {
    await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  return true;
}

export function antigravityHookResponse(event: AntigravityHookEventName): object {
  if (event === "PreToolUse") return { decision: "allow" };
  if (event === "Stop") return { decision: "allow" };
  return {};
}

export function buildAntigravityHookCommand(options: {
  event: AntigravityHookEventName;
  nodePath: string;
  scriptPath: string;
  hookEventsPath: string;
}): string {
  return [
    "ORCHETRACE_ANTIGRAVITY_HOOK=1",
    `ORCHETRACE_ANTIGRAVITY_HOOK_EVENTS=${shellQuote(resolve(options.hookEventsPath))}`,
    shellQuote(resolve(options.nodePath)),
    shellQuote(resolve(options.scriptPath)),
    "emit",
    "--event",
    options.event,
  ].join(" ");
}

function containsManagedCommand(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    const record = objectValue(item);
    if (typeof record.command === "string") {
      return record.command.includes("ORCHETRACE_ANTIGRAVITY_HOOK=1");
    }
    const handlers = Array.isArray(record.hooks) ? record.hooks : [];
    return handlers.some((handler) => {
      const command = objectValue(handler).command;
      return typeof command === "string" && command.includes("ORCHETRACE_ANTIGRAVITY_HOOK=1");
    });
  });
}

async function readHooks(path: string): Promise<AntigravityHooks> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Antigravity hooks root must be an object");
    }
    return { ...(parsed as AntigravityHooks) };
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw cause;
  }
}

async function writeHooks(path: string, hooks: AntigravityHooks): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(hooks, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function integerValue(value: unknown): number | undefined {
  return Number.isInteger(value) ? value as number : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
