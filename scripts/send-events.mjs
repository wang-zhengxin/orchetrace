import { readFile } from "node:fs/promises";

import { NdjsonTcpSink } from "../packages/dsh-observer/src/ndjson-sink.ts";

const [path, token, portText = "43117"] = process.argv.slice(2);
if (!path || !token) {
  console.error("Usage: node scripts/send-events.mjs <events.jsonl> <token> [port]");
  process.exit(1);
}

const sink = new NdjsonTcpSink({ token, port: Number(portText) });
const events = (await readFile(path, "utf8"))
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));
for (const event of events) sink.write(event);
await sink.whenIdle(15_000);
await sink.close();
console.log(`delivered ${events.length} canonical events`);
