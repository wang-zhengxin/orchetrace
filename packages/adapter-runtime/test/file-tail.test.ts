import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { readCompleteFileTail } from "../src/index.ts";

test("file tail reads only appended complete lines", async () => {
  const directory = resolve(tmpdir(), `orchetrace-tail-${process.pid}-${Date.now()}`);
  const path = resolve(directory, "session.jsonl");
  await mkdir(directory, { recursive: true });
  await writeFile(path, "{\"line\":1}\n{\"line\":2}");

  const first = await readCompleteFileTail(path);
  assert.equal(first.text, "{\"line\":1}\n");
  assert.equal(first.cursor.nextLine, 2);
  assert.equal(first.cursor.offset, Buffer.byteLength(first.text));

  await appendFile(path, "\n{\"line\":3}\n");
  const second = await readCompleteFileTail(path, first.cursor);
  assert.equal(second.text, "{\"line\":2}\n{\"line\":3}\n");
  assert.equal(second.startLine, 2);
  assert.equal(second.cursor.nextLine, 4);

  const idle = await readCompleteFileTail(path, second.cursor);
  assert.equal(idle.changed, false);
  assert.equal(idle.text, "");
});

test("file tail resets safely after truncation or replacement", async () => {
  const directory = resolve(tmpdir(), `orchetrace-tail-reset-${process.pid}-${Date.now()}`);
  const path = resolve(directory, "session.jsonl");
  await mkdir(directory, { recursive: true });
  await writeFile(path, "one\ntwo\n");
  const first = await readCompleteFileTail(path);

  await writeFile(path, "new\n");
  const reset = await readCompleteFileTail(path, first.cursor);
  assert.equal(reset.reset, true);
  assert.equal(reset.startLine, 1);
  assert.equal(reset.text, "new\n");
});

test("file tail applies a bounded record size", async () => {
  const directory = resolve(tmpdir(), `orchetrace-tail-bound-${process.pid}-${Date.now()}`);
  const path = resolve(directory, "session.jsonl");
  await mkdir(directory, { recursive: true });
  await writeFile(path, "x".repeat(32));
  await assert.rejects(() => readCompleteFileTail(path, undefined, { maxBytes: 16 }), /exceeds 16 bytes/);
});
