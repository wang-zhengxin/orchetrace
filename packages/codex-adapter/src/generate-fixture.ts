import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadCodexSession } from "./loader.ts";

const workspace = resolve(import.meta.dirname, "../../..");
const root = await loadCodexSession(resolve(workspace, "fixtures/codex/root-rollout.jsonl"), "fixture-codex");
const child = await loadCodexSession(resolve(workspace, "fixtures/codex/subagent-rollout.jsonl"), "fixture-codex");
const events = [...root.events, ...child.events].sort((left, right) =>
  `${left.observed_at}\u0000${left.event_id}`.localeCompare(`${right.observed_at}\u0000${right.event_id}`),
);
await writeFile(
  resolve(workspace, "fixtures/codex/canonical-events.jsonl"),
  `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
);
