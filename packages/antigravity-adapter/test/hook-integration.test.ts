import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  installAntigravityHooks,
  readAntigravityHookStatus,
  recordAntigravityHookEvent,
  uninstallAntigravityHooks,
} from "../src/hook-integration.ts";

test("hook installation follows Antigravity's named hook schema and preserves unrelated hooks", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-antigravity-hook-install-"));
  const hooksPath = resolve(directory, "hooks.json");
  const hookEventsPath = resolve(directory, "events.jsonl");
  const options = {
    hooksPath,
    hookEventsPath,
    scriptPath: resolve(directory, "hook-cli.ts"),
    nodePath: "/usr/local/bin/node",
  };
  try {
    await writeFile(hooksPath, `${JSON.stringify({
      "team-linter": {
        PostToolUse: [{ matcher: "write_to_file", hooks: [{ command: "./lint.sh" }] }],
      },
    })}\n`);
    assert.equal((await installAntigravityHooks(options)).installed, true);
    assert.equal((await installAntigravityHooks(options)).installed, true);

    const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
    assert.equal(hooks["team-linter"].PostToolUse[0].hooks[0].command, "./lint.sh");
    assert.deepEqual(Object.keys(hooks["orchetrace-observer"]).sort(), [
      "PostInvocation",
      "PostToolUse",
      "PreInvocation",
      "PreToolUse",
      "Stop",
    ]);
    assert.equal(hooks["orchetrace-observer"].PreToolUse[0].matcher, "*");
    assert.match(
      hooks["orchetrace-observer"].Stop[0].command,
      /ORCHETRACE_ANTIGRAVITY_HOOK=1.*--event Stop/,
    );

    const removed = await uninstallAntigravityHooks(options);
    assert.equal(removed.installed, false);
    const after = JSON.parse(await readFile(hooksPath, "utf8"));
    assert(after["team-linter"]);
    assert.equal(after["orchetrace-observer"], undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hook mailbox stores discovery metadata but excludes tool arguments", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "orchetrace-antigravity-hook-event-"));
  const hookEventsPath = resolve(directory, "events.jsonl");
  try {
    assert.equal(await recordAntigravityHookEvent("PreToolUse", {
      conversationId: "b1b1695c-d639-4cab-b5d3-52eadb33bb6d",
      transcriptPath: "/tmp/brain/b1b1695c-d639-4cab-b5d3-52eadb33bb6d/.system_generated/logs/transcript.jsonl",
      workspacePaths: ["/workspace/project"],
      modelName: "gemini-3.1-pro",
      stepIdx: 7,
      toolCall: {
        name: "run_command",
        args: { CommandLine: "print-secret-value" },
      },
    }, hookEventsPath), true);

    const record = JSON.parse((await readFile(hookEventsPath, "utf8")).trim());
    assert.equal(record.hook_event_name, "PreToolUse");
    assert.equal(record.tool_name, "run_command");
    assert.equal(record.step_index, 7);
    assert.equal(record.args, undefined);
    assert(!JSON.stringify(record).includes("print-secret-value"));
    assert.equal((await readAntigravityHookStatus({
      hooksPath: resolve(directory, "missing.json"),
      hookEventsPath,
      scriptPath: "hook.ts",
    })).installed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
