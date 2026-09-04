import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { distributionTarget, parseArguments, requiredArgument } from "./distribution-lib.mjs";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adapterEntrypoints = Object.freeze([
  ["claude-adapter", "orchetrace-claude-auto"],
  ["pi-adapter", "orchetrace-pi-auto"],
  ["dsh-observer", "orchetrace-dsh-auto"],
  ["codex-adapter", "orchetrace-codex-auto"],
  ["antigravity-adapter", "orchetrace-antigravity-auto"],
]);

export function installerExtension(target) {
  const metadata = distributionTarget(target);
  if (metadata.os === "darwin") return ".dmg";
  if (metadata.os === "linux") return ".deb";
  if (metadata.os === "win32") return ".msi";
  throw new Error(`desktop artifact verification is unsupported for ${target}`);
}

export function locateExtractedRuntime(files, target) {
  const suffix = target.includes("windows") ? ".exe" : "";
  const normalized = files.map((file) => file.replaceAll("\\", "/"));
  const findBase = (name) => normalized.find((file) => path.posix.basename(file) === name);
  const findSuffix = (value) => normalized.find((file) => file.endsWith(value));
  const desktop = findBase(`orchetrace-desktop${suffix}`);
  const node = findBase(`orchetrace-node${suffix}`);
  const otrace = findBase(`otrace${suffix}`);
  const adapters = Object.fromEntries(adapterEntrypoints.map(([packageName]) => [
    packageName,
    findSuffix(`/packages/${packageName}/src/auto-cli.ts`),
  ]));
  const missing = [
    ["desktop executable", desktop],
    ["bundled Node.js", node],
    ["otrace sidecar", otrace],
    ...Object.entries(adapters).map(([name, value]) => [`${name} entrypoint`, value]),
  ].filter(([, value]) => !value).map(([label]) => label);
  if (missing.length > 0) {
    throw new Error(`desktop installer is missing: ${missing.join(", ")}`);
  }
  return { desktop, node, otrace, adapters };
}

export async function verifyDesktopArtifact({ target, bundleRoot, requireTrustedSignature = false }) {
  const metadata = distributionTarget(target);
  if (metadata.os !== process.platform || metadata.cpu !== process.arch) {
    throw new Error(
      `desktop artifact must be verified on its target host: ${target} requires ` +
      `${metadata.os}-${metadata.cpu}, current host is ${process.platform}-${process.arch}`,
    );
  }
  const bundle = path.resolve(bundleRoot);
  const extension = installerExtension(target);
  const installers = (await walkFiles(bundle))
    .filter((file) => file.toLowerCase().endsWith(extension))
    .sort();
  if (installers.length === 0) {
    throw new Error(`no ${extension} installer found below ${bundle}`);
  }
  const installer = installers[0];
  const installerStat = await stat(installer);
  if (installerStat.size < 100_000) throw new Error(`desktop installer is unexpectedly small: ${installer}`);

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "orchetrace-desktop-artifact-"));
  let mountedPath;
  try {
    const extractedRoot = path.join(temporaryRoot, "extracted");
    await mkdir(extractedRoot, { recursive: true });
    if (metadata.os === "darwin") {
      await execute("hdiutil", [
        "attach",
        installer,
        "-readonly",
        "-nobrowse",
        "-mountpoint",
        extractedRoot,
      ]);
      mountedPath = extractedRoot;
    } else if (metadata.os === "linux") {
      await execute("dpkg-deb", ["--extract", installer, extractedRoot]);
    } else {
      await execute(process.env.SystemRoot
        ? path.join(process.env.SystemRoot, "System32", "msiexec.exe")
        : "msiexec.exe", ["/a", installer, "/qn", `TARGETDIR=${extractedRoot}`]);
    }

    const extractedFiles = await walkFiles(extractedRoot);
    const runtime = locateExtractedRuntime(extractedFiles, target);
    if (metadata.os === "darwin") {
      const appInfo = extractedFiles.find((file) =>
        file.replaceAll("\\", "/").endsWith("/Orchetrace.app/Contents/Info.plist")
      );
      if (!appInfo) throw new Error("mounted DMG does not contain Orchetrace.app");
      await execute("codesign", [
        "--verify",
        "--deep",
        "--strict",
        path.dirname(path.dirname(appInfo)),
      ]);
      if (requireTrustedSignature) {
        const appPath = path.dirname(path.dirname(appInfo));
        const { stderr: signatureDetails } = await execute("codesign", ["-dv", "--verbose=4", appPath]);
        if (!/^Authority=Developer ID Application:/mu.test(signatureDetails)) {
          throw new Error("macOS application is not signed with a Developer ID Application identity");
        }
        await execute("xcrun", ["stapler", "validate", appPath]);
        await execute("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
      }
    } else if (metadata.os === "win32" && requireTrustedSignature) {
      await verifyWindowsAuthenticode([installer, runtime.desktop]);
    }

    const { stdout: nodeVersionOutput } = await execute(runtime.node, ["--version"]);
    const nodeVersion = nodeVersionOutput.trim();
    if (!/^v(?:2[2-9]|[3-9]\d|\d{3,})\./u.test(nodeVersion)) {
      throw new Error(`desktop installer bundled unsupported Node.js ${nodeVersion}`);
    }
    const { stdout: otraceOutput } = await execute(runtime.otrace, []);
    if (!otraceOutput.includes("Usage:")) throw new Error("desktop installer otrace did not start");
    for (const [packageName, expected] of adapterEntrypoints) {
      const { stdout } = await execute(runtime.node, [runtime.adapters[packageName], "--help"]);
      if (!stdout.includes(expected)) {
        throw new Error(`${packageName} did not load from the desktop installer`);
      }
    }

    const digest = createHash("sha256").update(await readFile(installer)).digest("hex");
    return {
      installer: path.relative(root, installer),
      bytes: installerStat.size,
      sha256: digest,
      nodeVersion,
      adapterCount: adapterEntrypoints.length,
    };
  } finally {
    if (mountedPath) {
      await execute("hdiutil", ["detach", mountedPath, "-force"]);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifyWindowsAuthenticode(files) {
  const environment = { ...process.env };
  files.forEach((file, index) => {
    environment[`ORCHETRACE_SIGN_TARGET_${index}`] = file;
  });
  const command = files.map((_, index) =>
    `$signature = Get-AuthenticodeSignature -FilePath $env:ORCHETRACE_SIGN_TARGET_${index}; ` +
    `if ($signature.Status -ne 'Valid') { throw \"invalid Authenticode signature: $($signature.Status)\" }`,
  ).join("; ");
  await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { env: environment });
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
  const result = await verifyDesktopArtifact({
    target: requiredArgument(args, "--target"),
    bundleRoot: requiredArgument(args, "--bundle-root"),
    requireTrustedSignature: args.has("--require-trusted-signature"),
  });
  console.log(
    `Verified desktop installer ${result.installer}: ${result.bytes} bytes, ` +
    `${result.nodeVersion}, ${result.adapterCount} adapters, sha256 ${result.sha256}`,
  );
}
