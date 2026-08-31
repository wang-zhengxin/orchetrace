import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

import {
  DISTRIBUTION_TARGETS,
  normalizeVersion,
  npmTarballName,
  parseArguments,
  requiredArgument,
} from "./distribution-lib.mjs";

const args = parseArguments(process.argv.slice(2));
const version = normalizeVersion(requiredArgument(args, "--version"));
const platformDir = path.resolve(requiredArgument(args, "--platform-dir"));
const mainDir = path.resolve(requiredArgument(args, "--main-dir"));
const tag = args.get("--tag") ?? "beta";

for (const { npmPackage } of Object.values(DISTRIBUTION_TARGETS)) {
  await publishIfMissing(npmPackage, path.join(platformDir, npmTarballName(npmPackage, version)));
}
await publishIfMissing("@orchetrace/cli", path.join(mainDir, npmTarballName("@orchetrace/cli", version)));

async function publishIfMissing(packageName, tarball) {
  await access(tarball);
  const spec = `${packageName}@${version}`;
  const lookup = await run("npm", ["view", spec, "version", "--json"], { tolerateFailure: true });
  if (lookup.code === 0) {
    const published = JSON.parse(lookup.stdout);
    if (published !== version) throw new Error(`${spec} returned unexpected version ${lookup.stdout.trim()}`);
    console.log(`Skipping ${spec}; it is already published`);
    return;
  }
  if (!/E404|404 Not Found|is not in this registry/i.test(`${lookup.stdout}\n${lookup.stderr}`)) {
    throw new Error(`Unable to inspect ${spec}: ${lookup.stderr.trim() || lookup.stdout.trim()}`);
  }
  await run("npm", ["publish", tarball, "--access", "public", "--tag", tag]);
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, commandArgs, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 || options.tolerateFailure) {
        if (stdout) process.stdout.write(stdout);
        if (stderr && code === 0) process.stderr.write(stderr);
        resolve({ code: code ?? 1, stdout, stderr });
      } else {
        reject(new Error(`${command} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}: ${stderr.trim()}`));
      }
    });
  });
}
