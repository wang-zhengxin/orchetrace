import assert from "node:assert/strict";
import test from "node:test";

import { launchUntilSettled } from "../smoke-desktop-launch.mjs";

test("desktop launch smoke accepts a process that remains in its event loop", async () => {
  const result = await launchUntilSettled(
    process.execPath,
    process.env,
    30,
    ["-e", "setInterval(() => {}, 1000)"],
  );
  assert.equal(result.signal, "SIGTERM");
});

test("desktop launch smoke rejects a process that exits during setup", async () => {
  await assert.rejects(
    launchUntilSettled(process.execPath, process.env, 1_000, ["-e", "process.exit(7)"]),
    /exited before reaching the event loop: code=7/u,
  );
});
