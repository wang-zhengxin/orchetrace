import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_PACKAGES,
  cliArchiveName,
  distributionTarget,
  executableName,
  normalizeVersion,
  parseArguments,
  resolveFrom,
} from "./distribution-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArguments(process.argv.slice(2));
const target = args.get("--target") ?? (await hostTarget());
const version = normalizeVersion(args.get("--version") ?? await workspaceVersion());
const outputRoot = resolveFrom(root, args.get("--output"), "dist/cli");
const bundleRoot = path.join(outputRoot, target, "orchetrace");
const artifactsRoot = path.join(outputRoot, "artifacts");
const cargo = process.env.CARGO || "cargo";

distributionTarget(target);
if (!args.get("--skip-build")) {
  await run(cargo, [
    "build",
    "--release",
    "--locked",
    "--target",
    target,
    "-p",
    "orchetrace-cli",
    "--bin",
    "orche",
    "--bin",
    "otrace",
  ], root);
}

await rm(bundleRoot, { recursive: true, force: true });
await mkdir(path.join(bundleRoot, "bin"), { recursive: true });
await mkdir(path.join(bundleRoot, "packages"), { recursive: true });

for (const binary of ["orche", "otrace"]) {
  const name = executableName(binary, target);
  const source = path.join(root, "target", target, "release", name);
  const destination = path.join(bundleRoot, "bin", name);
  await access(source);
  await copyFile(source, destination);
  if (!target.includes("windows")) await chmod(destination, 0o755);
}

for (const packageName of RUNTIME_PACKAGES) {
  const source = path.join(root, "packages", packageName);
  const destination = path.join(bundleRoot, "packages", packageName);
  await mkdir(destination, { recursive: true });
  await copyFile(path.join(source, "package.json"), path.join(destination, "package.json"));
  await cp(path.join(source, "src"), path.join(destination, "src"), { recursive: true });
}

await copyFile(path.join(root, "LICENSE"), path.join(bundleRoot, "LICENSE"));
await copyFile(
  path.join(root, "apps/desktop/src-tauri/resources/THIRD_PARTY_NOTICES.md"),
  path.join(bundleRoot, "THIRD_PARTY_NOTICES.md"),
);
await copyFile(path.join(root, "README.md"), path.join(bundleRoot, "README.md"));
await writeFile(path.join(bundleRoot, "package.json"), `${JSON.stringify({
  name: "orchetrace-cli-bundle",
  version,
  private: true,
  type: "module",
  engines: { node: ">=22" },
}, null, 2)}\n`);
await writeFile(path.join(bundleRoot, "manifest.json"), `${JSON.stringify({
  schema_version: 1,
  name: "orchetrace-cli",
  version,
  target,
  node: ">=22",
  binaries: [executableName("orche", target), executableName("otrace", target)],
  runtime_packages: RUNTIME_PACKAGES,
}, null, 2)}\n`);

await run(process.execPath, [path.join(root, "scripts/verify-cli-bundle.mjs"), "--bundle", bundleRoot, "--target", target], root);

if (!args.get("--skip-archive")) {
  await mkdir(artifactsRoot, { recursive: true });
  const archive = path.join(artifactsRoot, cliArchiveName(version, target));
  await rm(archive, { force: true });
  await run("tar", ["-czf", archive, "-C", path.dirname(bundleRoot), path.basename(bundleRoot)], root);
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
  console.log(`Created ${path.relative(root, archive)} (${digest})`);
}

console.log(`Prepared CLI bundle ${version} for ${target} in ${path.relative(root, bundleRoot)}`);

async function workspaceVersion() {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  return manifest.version;
}

async function hostTarget() {
  let output = "";
  await run(process.env.RUSTC || "rustc", ["--print", "host-tuple"], root, (chunk) => { output += chunk; });
  return output.trim();
}

function run(command, commandArgs, cwd, capture) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env: process.env,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    if (capture) child.stdout.on("data", (chunk) => capture(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`));
    });
  });
}
