import { execFile, spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = path.join(root, "apps", "desktop", "src-tauri");
const binaries = path.join(tauriRoot, "binaries");
const licenses = path.join(tauriRoot, "resources", "licenses");
const cargo = process.env.CARGO || path.join(os.homedir(), ".cargo", "bin", `cargo${process.platform === "win32" ? ".exe" : ""}`);
const rustc = process.env.RUSTC || path.join(os.homedir(), ".cargo", "bin", `rustc${process.platform === "win32" ? ".exe" : ""}`);
const target = argumentValue("--target") ?? (await hostTarget());
const executableSuffix = target.includes("windows") ? ".exe" : "";
const releaseDirectory = path.join(root, "target", target, "release");
const nodeSource = path.resolve(process.env.ORCHETRACE_RELEASE_NODE || process.execPath);

validateNativeTarget(target);
validateNodeSource(nodeSource);
const nodeVersion = await validateNode(nodeSource);
await import("./build-desktop.mjs");
await run(cargo, [
  "build",
  "--release",
  "--locked",
  "--target",
  target,
  "-p",
  "orchetrace-cli",
  "--bin",
  "otrace",
  "--bin",
  "orche",
]);

await mkdir(binaries, { recursive: true });
await mkdir(licenses, { recursive: true });
const otraceTarget = path.join(binaries, `otrace-${target}${executableSuffix}`);
const nodeTarget = path.join(binaries, `orchetrace-node-${target}${executableSuffix}`);
await copyExecutable(path.join(releaseDirectory, `otrace${executableSuffix}`), otraceTarget);
await copyExecutable(nodeSource, nodeTarget);

const nodeLicense = process.env.ORCHETRACE_NODE_LICENSE
  ? path.resolve(process.env.ORCHETRACE_NODE_LICENSE)
  : await findNodeLicense(nodeSource);
if (!nodeLicense) {
  throw new Error("Unable to locate the Node.js LICENSE. Set ORCHETRACE_NODE_LICENSE explicitly.");
}
await copyFile(nodeLicense, path.join(licenses, "NODE_LICENSE"));
await writeManifest({ target, nodeSource, nodeLicense, nodeVersion });

console.log(`Prepared ${target} release resources in ${path.relative(root, tauriRoot)}`);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function hostTarget() {
  const { stdout } = await execute(rustc, ["--print", "host-tuple"], { cwd: root });
  return stdout.trim();
}

function validateNativeTarget(value) {
  const architecture = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  if (!value.startsWith(`${architecture}-`)) {
    throw new Error(`Bundled Node.js must be native: current architecture is ${process.arch}, target is ${value}`);
  }
  if (process.platform === "win32" && !value.includes("windows")) {
    throw new Error(`Windows Node.js cannot be bundled for ${value}`);
  }
  if (process.platform !== "win32" && value.includes("windows")) {
    throw new Error(`A ${process.platform} Node.js cannot be bundled for ${value}`);
  }
}

async function validateNode(executable) {
  await access(executable);
  const { stdout } = await execute(executable, ["--version"]);
  const major = Number.parseInt(stdout.trim().replace(/^v/, "").split(".")[0], 10);
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(`Orchetrace release packages require Node.js 22 or newer; found ${stdout.trim()}`);
  }
  return stdout.trim();
}

function validateNodeSource(executable) {
  const normalized = executable.replaceAll("\\", "/").toLowerCase();
  const isPackageManagerNode = normalized.includes("/homebrew/") || normalized.includes("/cellar/");
  if (!process.env.ORCHETRACE_RELEASE_NODE && isPackageManagerNode) {
    throw new Error(
      "Refusing to bundle a package-manager Node.js with non-portable dynamic libraries. " +
      "Set ORCHETRACE_RELEASE_NODE to a verified official Node.js distribution binary.",
    );
  }
}

async function findNodeLicense(executable) {
  let directory = path.dirname(executable);
  for (let depth = 0; depth < 5; depth += 1) {
    for (const name of ["LICENSE", "LICENSE.txt"]) {
      const candidate = path.join(directory, name);
      try {
        await access(candidate);
        const contents = await readFile(candidate, "utf8");
        if (contents.includes("Node.js") || contents.includes("Node contributors")) return candidate;
      } catch {
        // Continue walking towards the root of the Node.js distribution.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

async function copyExecutable(source, destination) {
  await rm(destination, { force: true });
  await copyFile(source, destination);
  if (process.platform !== "win32") await chmod(destination, 0o755);
}

async function writeManifest({ target: releaseTarget, nodeSource: source, nodeLicense: license, nodeVersion: version }) {
  const manifest = JSON.stringify({
    schema_version: 1,
    target: releaseTarget,
    node_version: version,
    node_source: source,
    node_license: license,
    generated_at: new Date().toISOString(),
  }, null, 2);
  const destination = path.join(tauriRoot, "resources", "release-manifest.json");
  await writeFile(destination, `${manifest}\n`);
}

async function run(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`));
    });
  });
}
