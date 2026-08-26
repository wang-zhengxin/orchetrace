import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mapDshRecord, type DshRecord } from "./mapper.ts";

const workspaceDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const input = resolve(workspaceDir, "fixtures/dsh/source-events.jsonl");
const output = resolve(workspaceDir, "fixtures/dsh/canonical-events.jsonl");

const source = await readFile(input, "utf8");
const records = source
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line, index) => {
    try {
      return JSON.parse(line) as DshRecord;
    } catch (error) {
      throw new Error(`${input}:${index + 1}: ${String(error)}`);
    }
  });

const events = records.flatMap(mapDshRecord);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
console.log(`mapped ${records.length} DSH records to ${events.length} canonical events`);
