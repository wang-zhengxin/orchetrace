import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadPiSession } from "./loader.ts";

const workspace = resolve(import.meta.dirname, "../../..");
const input = resolve(workspace, "fixtures/pi/demo.jsonl");
const output = resolve(workspace, "fixtures/pi/canonical-events.jsonl");
const result = await loadPiSession(input, { sourceId: "fixture-pi" });
if (result.diagnostics.some((diagnostic) => diagnostic.level === "error")) {
  throw new Error(`Pi fixture has errors: ${JSON.stringify(result.diagnostics)}`);
}
await writeFile(output, `${result.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
console.log(
  `mapped Pi fixture to ${result.events.length} canonical events (${result.activeEntryCount} active, ${result.abandonedEntryCount} abandoned entries)`,
);

const telemetryInput = resolve(workspace, "fixtures/pi/telemetry.jsonl");
const telemetryOutput = resolve(workspace, "fixtures/pi/telemetry-canonical-events.jsonl");
const telemetry = await loadPiSession(telemetryInput, { sourceId: "fixture-pi-telemetry" });
if (telemetry.diagnostics.some((diagnostic) => diagnostic.level === "error")) {
  throw new Error(`Pi telemetry fixture has errors: ${JSON.stringify(telemetry.diagnostics)}`);
}
await writeFile(
  telemetryOutput,
  `${telemetry.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
);
console.log(`mapped Pi telemetry fixture to ${telemetry.events.length} canonical events`);
