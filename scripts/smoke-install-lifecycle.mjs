import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  distributionTarget,
  normalizeVersion,
  npmInvocation,
  npmTarballName,
  parseArguments,
  requiredArgument,
} from "./distribution-lib.mjs";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArguments(process.argv.slice(2));
const target = requiredArgument(args, "--target");
const bundle = path.resolve(requiredArgument(args, "--bundle"));
const candidateVersion = normalizeVersion(requiredArgument(args, "--version"));
const baselineVersion = candidateVersion === "0.0.0-lifecycle.0"
  ? "0.0.0-lifecycle.1"
  : "0.0.0-lifecycle.0";
const metadata = distributionTarget(target);

assertHostMatchesTarget(metadata, target);
const bundleManifest = await readJson(path.join(bundle, "manifest.json"));
if (bundleManifest.schema_version !== 1 || bundleManifest.target !== target) {
  throw new Error(`CLI bundle manifest does not match ${target}`);
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "orchetrace-install-lifecycle-"));
try {
  const baselineOutput = path.join(temporaryRoot, "baseline");
  const candidateOutput = path.join(temporaryRoot, "candidate");
  const installPrefix = path.join(temporaryRoot, "prefix");
  await stageVersion(baselineVersion, baselineOutput);
  await stageVersion(candidateVersion, candidateOutput);

  const baselineTarballs = tarballs(baselineOutput, baselineVersion);
  const candidateTarballs = tarballs(candidateOutput, candidateVersion);

  await install(installPrefix, baselineTarballs);
  await verifyInstallation(installPrefix, baselineVersion, "install");

  await install(installPrefix, candidateTarballs);
  await verifyInstallation(installPrefix, candidateVersion, "upgrade");

  await install(installPrefix, baselineTarballs);
  await verifyInstallation(installPrefix, baselineVersion, "rollback");

  await uninstall(installPrefix);
  await verifyUninstalled(installPrefix);

  console.log(
    `Verified npm lifecycle for ${target}: install ${baselineVersion}, upgrade ${candidateVersion}, ` +
    "rollback, and uninstall.",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function assertHostMatchesTarget(targetMetadata, targetName) {
  const hostOs = process.platform;
  const hostCpu = process.arch;
  if (targetMetadata.os !== hostOs || targetMetadata.cpu !== hostCpu) {
    throw new Error(
      `install lifecycle must run on its target host: ${targetName} requires ` +
      `${targetMetadata.os}-${targetMetadata.cpu}, current host is ${hostOs}-${hostCpu}`,
    );
  }
}

function tarballs(output, version) {
  const directory = path.join(output, "tarballs");
  return [
    path.join(directory, npmTarballName("@orchetrace/cli", version)),
    path.join(directory, npmTarballName(metadata.npmPackage, version)),
  ];
}

async function stageVersion(version, output) {
  await run(process.execPath, [
    path.join(root, "scripts/stage-npm-packages.mjs"),
    "--target",
    target,
    "--bundle",
    bundle,
    "--version",
    version,
    "--output",
    output,
  ], root, process.env, ["ignore", "ignore", "inherit"]);
}

async function install(prefix, packageTarballs) {
  const npm = npmInvocation([
    "install",
    "--global",
    "--prefix",
    prefix,
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    ...packageTarballs,
  ]);
  await run(npm.command, npm.args, root, {
    ...process.env,
    npm_config_cache: path.join(temporaryRoot, "npm-cache"),
  });
}

async function uninstall(prefix) {
  const npm = npmInvocation([
    "uninstall",
    "--global",
    "--prefix",
    prefix,
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "@orchetrace/cli",
    metadata.npmPackage,
  ]);
  await run(npm.command, npm.args, root, {
    ...process.env,
    npm_config_cache: path.join(temporaryRoot, "npm-cache"),
  });
}

async function globalRoot(prefix) {
  const npm = npmInvocation(["root", "--global", "--prefix", prefix]);
  const { stdout } = await execute(npm.command, npm.args, {
    cwd: root,
    env: process.env,
  });
  return stdout.trim();
}

async function verifyInstallation(prefix, expectedVersion, phase) {
  const packagesRoot = await globalRoot(prefix);
  const cliRoot = path.join(packagesRoot, "@orchetrace", "cli");
  const platformRoot = path.join(packagesRoot, ...metadata.npmPackage.split("/"));
  const [cliManifest, platformManifest] = await Promise.all([
    readJson(path.join(cliRoot, "package.json")),
    readJson(path.join(platformRoot, "package.json")),
  ]);
  if (cliManifest.version !== expectedVersion || platformManifest.version !== expectedVersion) {
    throw new Error(
      `${phase} version mismatch: cli=${String(cliManifest.version)}, ` +
      `platform=${String(platformManifest.version)}, expected=${expectedVersion}`,
    );
  }

  await access(commandShim(prefix, "orche"));
  await access(commandShim(prefix, "otrace"));
  const isolatedHome = path.join(temporaryRoot, "home");
  const environment = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
  };
  const { stdout: orcheOutput } = await executeShim(prefix, "orche", ["--help"], environment);
  if (!orcheOutput.includes("terminal multi-Agent observer")) {
    throw new Error(`${phase} installed orche launcher did not start`);
  }
  const { stdout: otraceOutput } = await executeShim(prefix, "otrace", [], environment);
  if (!otraceOutput.includes("Usage:")) {
    throw new Error(`${phase} installed otrace launcher did not start`);
  }
}

async function verifyUninstalled(prefix) {
  const packagesRoot = await globalRoot(prefix);
  for (const removedPath of [
    commandShim(prefix, "orche"),
    commandShim(prefix, "otrace"),
    path.join(packagesRoot, "@orchetrace", "cli"),
    path.join(packagesRoot, ...metadata.npmPackage.split("/")),
  ]) {
    try {
      await access(removedPath);
      throw new Error(`uninstall left a package artifact behind: ${removedPath}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("uninstall left")) throw error;
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  }
}

function executeShim(prefix, name, commandArgs, environment) {
  const shim = commandShim(prefix, name);
  if (process.platform !== "win32") {
    return execute(shim, commandArgs, { cwd: temporaryRoot, env: environment });
  }
  const commandLine = [`"${shim}"`, ...commandArgs].join(" ");
  return execute(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", commandLine], {
    cwd: temporaryRoot,
    env: environment,
  });
}

function commandShim(prefix, name) {
  return process.platform === "win32"
    ? path.join(prefix, `${name}.cmd`)
    : path.join(prefix, "bin", name);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function run(
  command,
  commandArgs,
  cwd,
  environment = process.env,
  stdio = "inherit",
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, { cwd, env: environment, stdio });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`));
    });
  });
}
