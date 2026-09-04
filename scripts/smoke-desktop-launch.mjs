import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { distributionTarget, parseArguments, requiredArgument } from "./distribution-lib.mjs";
import { installerExtension, locateExtractedRuntime } from "./verify-desktop-artifact.mjs";

const execute = promisify(execFile);

export async function smokeDesktopLaunch({ target, bundleRoot, settleMs = 3_000 }) {
  const metadata = distributionTarget(target);
  if (process.platform !== metadata.os || process.arch !== metadata.cpu) {
    throw new Error(
      `desktop launch smoke must run on ${metadata.os}-${metadata.cpu}; ` +
      `current host is ${process.platform}-${process.arch}`,
    );
  }

  const extension = installerExtension(target);
  const installers = (await walkFiles(path.resolve(bundleRoot)))
    .filter((file) => file.toLowerCase().endsWith(extension))
    .sort();
  if (installers.length === 0) {
    throw new Error(`desktop launch smoke could not find a ${extension} installer`);
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "orchetrace-desktop-launch-"));
  const extractedRoot = path.join(temporaryRoot, "extracted");
  let mounted = false;
  try {
    await mkdir(extractedRoot, { recursive: true });
    const installation = await extractDesktopApplication({
      installer: installers[0],
      metadata,
      target,
      temporaryRoot,
      extractedRoot,
      onMounted: () => { mounted = true; },
      onDetached: () => { mounted = false; },
    });
    const isolatedHome = path.join(temporaryRoot, "home");
    await mkdir(isolatedHome, { recursive: true });
    const environment = {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      ORCHETRACE_APP_DATA_DIR: path.join(temporaryRoot, "app-data"),
      ORCHETRACE_DATA_DIR: path.join(temporaryRoot, "data"),
      ORCHETRACE_AUTOSTART: "0",
      WEBVIEW2_USER_DATA_FOLDER: path.join(temporaryRoot, "webview2"),
      ...(metadata.os === "linux" ? {
        NO_AT_BRIDGE: "1",
        WEBKIT_DISABLE_COMPOSITING_MODE: "1",
        XDG_CACHE_HOME: path.join(temporaryRoot, "xdg", "cache"),
        XDG_CONFIG_HOME: path.join(temporaryRoot, "xdg", "config"),
        XDG_DATA_HOME: path.join(temporaryRoot, "xdg", "data"),
      } : {}),
    };
    const command = desktopLaunchCommand(metadata, installation.executable);
    const launch = await launchUntilSettled(
      command.executable,
      environment,
      settleMs,
      command.args,
      path.dirname(installation.executable),
    );
    return {
      installer: installers[0],
      settleMs,
      stderr: launch.stderr,
    };
  } finally {
    if (mounted) await execute("hdiutil", ["detach", extractedRoot, "-force"]);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function extractDesktopApplication({
  installer,
  metadata,
  target,
  temporaryRoot,
  extractedRoot,
  onMounted,
  onDetached,
}) {
  if (metadata.os === "darwin") {
    await execute("hdiutil", [
      "attach",
      installer,
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      extractedRoot,
    ]);
    onMounted();
    const sourceApp = path.join(extractedRoot, "Orchetrace.app");
    const installedApp = path.join(temporaryRoot, "Applications", "Orchetrace.app");
    await access(path.join(sourceApp, "Contents", "Info.plist"));
    await mkdir(path.dirname(installedApp), { recursive: true });
    await execute("ditto", [sourceApp, installedApp]);
    await execute("hdiutil", ["detach", extractedRoot, "-force"]);
    onDetached();
    await execute("codesign", ["--verify", "--deep", "--strict", installedApp]);
    return {
      executable: path.join(installedApp, "Contents", "MacOS", "orchetrace-desktop"),
    };
  }

  if (metadata.os === "linux") {
    await execute("dpkg-deb", ["--extract", installer, extractedRoot]);
  } else {
    const msiexec = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "msiexec.exe")
      : "msiexec.exe";
    await execute(msiexec, ["/a", installer, "/qn", `TARGETDIR=${extractedRoot}`]);
  }
  const runtime = locateExtractedRuntime(await walkFiles(extractedRoot), target);
  return { executable: runtime.desktop };
}

export function desktopLaunchCommand(metadata, executable) {
  if (metadata.os === "linux") {
    return {
      executable: "xvfb-run",
      args: [
        "--auto-servernum",
        "--server-args=-screen 0 1280x720x24",
        executable,
      ],
    };
  }
  return { executable, args: [] };
}

export function launchUntilSettled(
  executable,
  environment,
  settleMs,
  executableArgs = [],
  cwd = process.cwd(),
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, executableArgs, {
      cwd,
      detached: process.platform !== "win32",
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_192);
    });
    let settled = false;
    let forceTimer;
    const terminate = (signal) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process group may already be gone; fall back to the child handle.
        }
      }
      child.kill(signal);
    };
    const timer = setTimeout(() => {
      settled = true;
      terminate("SIGTERM");
      forceTimer = setTimeout(() => terminate("SIGKILL"), 2_000);
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
