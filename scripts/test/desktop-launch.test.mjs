import assert from "node:assert/strict";
import test from "node:test";

import { desktopLaunchCommand, launchUntilSettled } from "../smoke-desktop-launch.mjs";

test("desktop launch smoke uses a virtual display on Linux", () => {
  assert.deepEqual(desktopLaunchCommand({ os: "linux" }, "/opt/orchetrace"), {
    executable: "xvfb-run",
    args: [
      "--auto-servernum",
      "--server-args=-screen 0 1280x720x24",
      "/opt/orchetrace",
    ],
  });
});

test("desktop launch smoke starts macOS and Windows executables directly", () => {
  assert.deepEqual(desktopLaunchCommand({ os: "darwin" }, "/Applications/Orchetrace"), {
    executable: "/Applications/Orchetrace",
    args: [],
  });
  assert.deepEqual(desktopLaunchCommand({ os: "win32" }, "C:\\Orchetrace.exe"), {
    executable: "C:\\Orchetrace.exe",
    args: [],
  });
});

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
