#!/usr/bin/env node

import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { ClaudeIncrementalSourceCache } from "../packages/claude-adapter/src/index.ts";
import { PiIncrementalSessionCache } from "../packages/pi-adapter/src/index.ts";

const eventCount = positiveInteger(process.env.ORCHETRACE_BENCH_EVENTS ?? "100000");
const appendCount = positiveInteger(process.env.ORCHETRACE_BENCH_APPEND_EVENTS ?? "100");
const directory = await mkdtemp(join(tmpdir(), "orchetrace-adapter-bench-"));

try {
  const claude = await benchmarkClaude(join(directory, "claude.jsonl"));
  const pi = await benchmarkPi(join(directory, "pi.jsonl"));
  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    event_count: eventCount,
    append_count: appendCount,
    claude,
    pi,
    heap_used_bytes: process.memoryUsage().heapUsed,
  }, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function benchmarkClaude(path) {
  await writeBatches(path, eventCount, (index) => JSON.stringify({
    type: "user",
    uuid: `claude-${index}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { content: `prompt-${index}` },
  }));
  const cache = new ClaudeIncrementalSourceCache(path, { maxCachedBytes: 512 * 1024 * 1024 });
  const cold = await measured(() => cache.load({ sessionId: "claude-benchmark" }));
  const appendedText = lines(eventCount, appendCount, (index) => JSON.stringify({
    type: "assistant",
    uuid: `claude-${index}`,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { content: `response-${index}` },
  }));
  await appendFile(path, appendedText);
  const warm = await measured(() => cache.load({ sessionId: "claude-benchmark" }));
  const idle = await measured(() => cache.load({ sessionId: "claude-benchmark" }));
  return metrics(cold, warm, idle, Buffer.byteLength(appendedText));
}

async function benchmarkPi(path) {
  const header = `${JSON.stringify({
    type: "session",
    version: 3,
    id: "pi-benchmark",
    timestamp: "2026-01-01T00:00:00.000Z",
  })}\n`;
  await writeFile(path, header);
  await appendBatches(path, 0, eventCount, piLine);
  const cache = new PiIncrementalSessionCache(path, { maxCachedBytes: 512 * 1024 * 1024 });
  const cold = await measured(() => cache.load("pi-benchmark"));
  const appendedText = lines(eventCount, appendCount, piLine);
  await appendFile(path, appendedText);
  const warm = await measured(() => cache.load("pi-benchmark"));
  const idle = await measured(() => cache.load("pi-benchmark"));
  return metrics(cold, warm, idle, Buffer.byteLength(appendedText));
}

function piLine(index) {
  return JSON.stringify({
    type: "message",
    id: `pi-${index}`,
    parentId: index === 0 ? null : `pi-${index - 1}`,
    timestamp: "2026-01-01T00:00:01.000Z",
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index}`,
  });
}

async function measured(operation) {
  const started = performance.now();
  const result = await operation();
  return { elapsed_ms: round(performance.now() - started), result };
}

function metrics(cold, warm, idle, expectedAppendBytes) {
  return {
    cold_ms: cold.elapsed_ms,
    cold_bytes_read: cold.result.bytesRead,
    append_ms: warm.elapsed_ms,
    append_bytes_read: warm.result.bytesRead,
    expected_append_bytes: expectedAppendBytes,
    idle_ms: idle.elapsed_ms,
    idle_bytes_read: idle.result.bytesRead,
    cached_bytes: idle.result.cachedBytes,
    reads_only_append: warm.result.bytesRead === expectedAppendBytes,
  };
}

async function writeBatches(path, count, createLine) {
  await writeFile(path, "");
  await appendBatches(path, 0, count, createLine);
}

async function appendBatches(path, start, count, createLine) {
  const batchSize = 10_000;
  for (let offset = 0; offset < count; offset += batchSize) {
    await appendFile(path, lines(start + offset, Math.min(batchSize, count - offset), createLine));
  }
}

function lines(start, count, createLine) {
  let output = "";
  for (let index = start; index < start + count; index += 1) output += `${createLine(index)}\n`;
  return output;
}

function positiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`expected a positive integer, received ${value}`);
  return parsed;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
