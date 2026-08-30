import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";

export interface FileTailCursor {
  path: string;
  identity: string;
  offset: number;
  nextLine: number;
  mtimeMs: number;
}

export interface FileTailReadOptions {
  maxBytes?: number;
}

export interface FileTailRead {
  cursor: FileTailCursor;
  fileSize: number;
  text: string;
  startLine: number;
  bytesRead: number;
  changed: boolean;
  reset: boolean;
}

/**
 * Reads only complete newline-delimited records after a committed cursor.
 * The returned cursor is a proposal: adapters must persist it only after the
 * emitted canonical events have been acknowledged by the ingest service.
 */
export async function readCompleteFileTail(
  inputPath: string,
  committed?: FileTailCursor,
  options: FileTailReadOptions = {},
): Promise<FileTailRead> {
  const path = resolve(inputPath);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`tail source is not a file: ${path}`);
  const identity = `${metadata.dev}:${metadata.ino}`;
  const samePath = committed?.path === path;
  const replaced = Boolean(
    committed && (
      !samePath ||
      committed.identity !== identity ||
      metadata.size < committed.offset ||
      (metadata.size === committed.offset && metadata.mtimeMs !== committed.mtimeMs)
    ),
  );
  const offset = committed && !replaced ? committed.offset : 0;
  const nextLine = committed && !replaced ? committed.nextLine : 1;
  const available = metadata.size - offset;
  const baseCursor: FileTailCursor = {
    path,
    identity,
    offset,
    nextLine,
    mtimeMs: metadata.mtimeMs,
  };
  if (available === 0) {
    return {
      cursor: baseCursor,
      fileSize: metadata.size,
      text: "",
      startLine: nextLine,
      bytesRead: 0,
      changed: replaced,
      reset: replaced,
    };
  }

  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("tail maxBytes must be a positive safe integer");
  }
  const length = Math.min(available, maxBytes);
  const handle = await open(path, "r");
  let bytes: Buffer;
  try {
    bytes = Buffer.alloc(length);
    const result = await handle.read(bytes, 0, length, offset);
    bytes = bytes.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    if (available > maxBytes) {
      throw new Error(`newline-delimited record exceeds ${maxBytes} bytes at ${path}:${nextLine}`);
    }
    return {
      cursor: baseCursor,
      fileSize: metadata.size,
      text: "",
      startLine: nextLine,
      bytesRead: bytes.length,
      changed: replaced,
      reset: replaced,
    };
  }
  const consumed = bytes.subarray(0, lastNewline + 1);
  const lines = countNewlines(consumed);
  return {
    cursor: {
      ...baseCursor,
      offset: offset + consumed.length,
      nextLine: nextLine + lines,
    },
    fileSize: metadata.size,
    text: consumed.toString("utf8"),
    startLine: nextLine,
    bytesRead: bytes.length,
    changed: true,
    reset: replaced,
  };
}

function countNewlines(bytes: Buffer): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return count;
}
