import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadClaudeSession } from "./loader.ts";

const workspace = resolve(import.meta.dirname, "../../..");
const input = resolve(workspace, "fixtures/claude/demo.jsonl");
const output = resolve(workspace, "fixtures/claude/canonical-events.jsonl");
const result = await loadClaudeSession(input, { sourceId: "fixture-claude" });
if (result.diagnostics.some((diagnostic) => diagnostic.level === "error")) {
  throw new Error(`Claude fixture has errors: ${JSON.stringify(result.diagnostics)}`);
}
await writeFile(output, `${result.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
console.log(`mapped Claude fixture to ${result.events.length} canonical events`);
