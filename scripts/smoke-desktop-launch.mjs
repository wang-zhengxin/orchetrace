import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { distributionTarget, parseArguments, requiredArgument } from "./distribution-lib.mjs";

const execute = promisify(execFile);

export async function smokeDesktopLaunch({ target, bundleRoot, settleMs = 3_000 }) {
  const metadata = distributionTarget(target);
  if (metadata.os !== "darwin") {
    throw new Error("isolated desktop launch smoke currently supports macOS DMG artifacts only");
  }
  if (process.platform !== metadata.os || process.arch !== metadata.cpu) {
    throw new Error(
      `desktop launch smoke must run on ${metadata.os}-${metadata.cpu}; ` +
      `current host is ${process.platform}-${process.arch}`,
    );
  }

  const installers = (await walkFiles(path.resolve(bundleRoot)))
    .filter((file) => file.toLowerCase().endsWith(".dmg"))
    .sort();
  if (installers.length === 0) throw new Error("desktop launch smoke could not find a DMG");

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "orchetrace-desktop-launch-"));
  const mountPoint = path.join(temporaryRoot, "mount");
  const installedApp = path.join(temporaryRoot, "Applications", "Orchetrace.app");
  let mounted = false;
  try {
    await mkdir(mountPoint, { recursive: true });
    await execute("hdiutil", [
      "attach",
      installers[0],
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mountPoint,
    ]);
    mounted = true;
    const sourceApp = path.join(mountPoint, "Orchetrace.app");
    await access(path.join(sourceApp, "Contents", "Info.plist"));
    await mkdir(path.dirname(installedApp), { recursive: true });
    await execute("ditto", [sourceApp, installedApp]);
    await execute("hdiutil", ["detach", mountPoint, "-force"]);
    mounted = false;

    await execute("codesign", ["--verify", "--deep", "--strict", installedApp]);
    const executable = path.join(installedApp, "Contents", "MacOS", "orchetrace-desktop");
    const isolatedHome = path.join(temporaryRoot, "home");
    await mkdir(isolatedHome, { recursive: true });
    const environment = {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      ORCHETRACE_APP_DATA_DIR: path.join(temporaryRoot, "app-data"),
      ORCHETRACE_DATA_DIR: path.join(temporaryRoot, "data"),
      ORCHETRACE_AUTOSTART: "0",
    };
    const launch = await launchUntilSettled(executable, environment, settleMs);
    return {
      installer: installers[0],
      settleMs,
      stderr: launch.stderr,
    };
  } finally {
    if (mounted) await execute("hdiutil", ["detach", mountPoint, "-force"]);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function launchUntilSettled(executable, environment, settleMs, executableArgs = []) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, executableArgs, {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_192);
    });
    let settled = false;
    let forceTimer;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, settleMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (!settled) {
        reject(new Error(
          `desktop exited before reaching the event loop: code=${String(code)} ` +
          `signal=${String(signal)}${stderr ? `\n${stderr}` : ""}`,
        ));
      } else {
        resolvePromise({ code, signal, stderr });
      }
    });
  });
}

async function walkFiles(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArguments(process.argv.slice(2));
  const result = await smokeDesktopLaunch({
    target: requiredArgument(args, "--target"),
    bundleRoot: requiredArgument(args, "--bundle-root"),
  });
  console.log(
    `Verified isolated desktop launch from ${path.basename(result.installer)} for ` +
    `${result.settleMs} ms with managed ingest disabled.`,
  );
}
