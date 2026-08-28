import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  installClaudeHooks,
  readClaudeHookStatus,
  recordClaudeHookEvent,
  uninstallClaudeHooks,
} from "../src/hook-integration.ts";

test("hook installation is idempotent and preserves unrelated Claude settings", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-claude-hook-install-"));
  const settingsPath = resolve(directory, "settings.json");
  const hookEventsPath = resolve(directory, "events.jsonl");
  const options = {
    settingsPath,
    hookEventsPath,
    scriptPath: resolve(directory, "hook-cli.ts"),
    nodePath: "/usr/local/bin/node",
  };
  try {
    await writeFile(
      settingsPath,
      `${JSON.stringify({
        model: "sonnet",
        hooks: {
          SessionStart: [
            { matcher: "startup", hooks: [{ type: "command", command: "echo existing" }] },
          ],
        },
      })}\n`,
    );
    assert.equal((await installClaudeHooks(options)).installed, true);
    assert.equal((await installClaudeHooks(options)).installed, true);

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.model, "sonnet");
    assert.equal(settings.hooks.SessionStart.length, 2, "reinstall replaces only the managed group");
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "echo existing");
    for (const event of [
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
      "SubagentStart",
      "SubagentStop",
    ]) {
      const managed = settings.hooks[event].flatMap((group: { hooks: Array<{ command: string }> }) => group.hooks)
        .filter((hook: { command: string }) => hook.command.includes("ORCHETRACE_CLAUDE_HOOK=1"));
      assert.equal(managed.length, 1);
      assert.equal(managed[0].async, true);
    }

    const removed = await uninstallClaudeHooks(options);
    assert.equal(removed.installed, false);
    const after = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(after.hooks.SessionStart.length, 1);
    assert.equal(after.hooks.SessionStart[0].hooks[0].command, "echo existing");
    assert.equal(after.hooks.SessionEnd, undefined);
    assert.equal(after.hooks.UserPromptSubmit, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hook mailbox stores lifecycle identity without assistant message content", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-claude-hook-event-"));
  const hookEventsPath = resolve(directory, "events.jsonl");
  try {
    assert.equal(
      await recordClaudeHookEvent(
        {
          hook_event_name: "SubagentStop",
          session_id: "root-1",
          transcript_path: "/tmp/root-1.jsonl",
          cwd: "/workspace",
          agent_id: "agent-1",
          agent_type: "Explore",
          agent_transcript_path: "/tmp/root-1/subagents/agent-agent-1.jsonl",
          last_assistant_message: "private answer",
        } as never,
        hookEventsPath,
      ),
      true,
    );
    const record = JSON.parse((await readFile(hookEventsPath, "utf8")).trim());
    assert.equal(record.hook_event_name, "SubagentStop");
    assert.equal(record.agent_id, "agent-1");
    assert.equal(record.last_assistant_message, undefined);
    assert.equal((await readClaudeHookStatus({ settingsPath: resolve(directory, "missing.json"), hookEventsPath, scriptPath: "hook.ts" })).installed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
