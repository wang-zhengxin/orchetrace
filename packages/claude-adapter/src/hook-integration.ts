import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const HOOK_MARKER = "ORCHETRACE_CLAUDE_HOOK=1";
const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
] as const;

type HookEventName = (typeof HOOK_EVENTS)[number];

interface CommandHook {
  type?: unknown;
  command?: unknown;
  async?: unknown;
  timeout?: unknown;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: unknown;
  hooks?: unknown;
  [key: string]: unknown;
}

interface ClaudeSettings {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ClaudeHookInstallOptions {
  settingsPath?: string;
  hookEventsPath?: string;
  scriptPath: string;
  nodePath?: string;
}

export interface ClaudeHookStatus {
  installed: boolean;
  settingsPath: string;
  hookEventsPath: string;
  installedEvents: string[];
}

export interface ClaudeHookInput {
  hook_event_name?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
  agent_transcript_path?: unknown;
}

export async function installClaudeHooks(options: ClaudeHookInstallOptions): Promise<ClaudeHookStatus> {
  const settingsPath = resolve(options.settingsPath ?? resolve(homedir(), ".claude/settings.json"));
  const hookEventsPath = resolve(
    options.hookEventsPath ?? resolve(homedir(), ".orchetrace/claude-hooks.jsonl"),
  );
  const settings = await readSettings(settingsPath);
  const hooks = normalizeHooks(settings.hooks);
  removeManagedHooks(hooks);
  const handler: CommandHook = {
    type: "command",
    command: buildClaudeHookCommand({
      nodePath: options.nodePath ?? process.execPath,
      scriptPath: resolve(options.scriptPath),
      hookEventsPath,
    }),
    async: true,
    timeout: 5,
  };
  for (const event of HOOK_EVENTS) {
    const groups = normalizeGroups(hooks[event]);
    groups.push({
      matcher: event === "SessionStart" ? "startup|resume|clear|compact" : "",
      hooks: [{ ...handler }],
    });
    hooks[event] = groups;
  }
  settings.hooks = hooks;
  await writeSettings(settingsPath, settings);
  return readClaudeHookStatus({ ...options, settingsPath, hookEventsPath });
}

export async function uninstallClaudeHooks(
  options: ClaudeHookInstallOptions,
): Promise<ClaudeHookStatus> {
  const settingsPath = resolve(options.settingsPath ?? resolve(homedir(), ".claude/settings.json"));
  const hookEventsPath = resolve(
    options.hookEventsPath ?? resolve(homedir(), ".orchetrace/claude-hooks.jsonl"),
  );
  const settings = await readSettings(settingsPath);
  const hooks = normalizeHooks(settings.hooks);
  removeManagedHooks(hooks);
  settings.hooks = hooks;
  await writeSettings(settingsPath, settings);
  return readClaudeHookStatus({ ...options, settingsPath, hookEventsPath });
}

export async function readClaudeHookStatus(
  options: ClaudeHookInstallOptions,
): Promise<ClaudeHookStatus> {
  const settingsPath = resolve(options.settingsPath ?? resolve(homedir(), ".claude/settings.json"));
  const hookEventsPath = resolve(
    options.hookEventsPath ?? resolve(homedir(), ".orchetrace/claude-hooks.jsonl"),
  );
  const settings = await readSettings(settingsPath);
  const hooks = normalizeHooks(settings.hooks);
  const installedEvents = HOOK_EVENTS.filter((event) =>
    normalizeGroups(hooks[event]).some((group) =>
      normalizeHandlers(group.hooks).some(isManagedHandler),
    ),
  );
  return {
    installed: installedEvents.length === HOOK_EVENTS.length,
    settingsPath,
    hookEventsPath,
    installedEvents,
  };
}

export async function recordClaudeHookEvent(
  input: ClaudeHookInput,
  hookEventsPath = resolve(homedir(), ".orchetrace/claude-hooks.jsonl"),
): Promise<boolean> {
  if (
    typeof input.hook_event_name !== "string" ||
    !HOOK_EVENTS.includes(input.hook_event_name as HookEventName) ||
    typeof input.transcript_path !== "string" ||
    !input.transcript_path.trim()
  ) {
    return false;
  }
  const record = Object.fromEntries(
    Object.entries({
      hook_event_name: input.hook_event_name,
      session_id: stringValue(input.session_id),
      transcript_path: input.transcript_path,
      cwd: stringValue(input.cwd),
      agent_id: stringValue(input.agent_id),
      agent_type: stringValue(input.agent_type),
      agent_transcript_path: stringValue(input.agent_transcript_path),
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

export function buildClaudeHookCommand(options: {
  nodePath: string;
  scriptPath: string;
  hookEventsPath: string;
}): string {
  return [
    HOOK_MARKER,
    `ORCHETRACE_CLAUDE_HOOK_EVENTS=${shellQuote(resolve(options.hookEventsPath))}`,
    shellQuote(resolve(options.nodePath)),
    shellQuote(resolve(options.scriptPath)),
    "emit",
  ].join(" ");
}

function removeManagedHooks(hooks: Record<string, unknown>): void {
  for (const event of HOOK_EVENTS) {
    const groups = normalizeGroups(hooks[event])
      .map((group) => ({ ...group, hooks: normalizeHandlers(group.hooks).filter((hook) => !isManagedHandler(hook)) }))
      .filter((group) => normalizeHandlers(group.hooks).length > 0);
    if (groups.length > 0) hooks[event] = groups;
    else delete hooks[event];
  }
}

function isManagedHandler(handler: CommandHook): boolean {
  return typeof handler.command === "string" && handler.command.includes(HOOK_MARKER);
}

async function readSettings(path: string): Promise<ClaudeSettings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Claude settings root must be an object");
    }
    return parsed as ClaudeSettings;
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw cause;
  }
}

async function writeSettings(path: string, settings: ClaudeSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function normalizeHooks(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function normalizeGroups(value: unknown): HookGroup[] {
  return Array.isArray(value)
    ? value.filter((item): item is HookGroup => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function normalizeHandlers(value: unknown): CommandHook[] {
  return Array.isArray(value)
    ? value.filter((item): item is CommandHook => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
