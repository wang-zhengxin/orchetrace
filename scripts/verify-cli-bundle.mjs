import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { RUNTIME_PACKAGES, executableName, parseArguments, requiredArgument } from "./distribution-lib.mjs";

const execute = promisify(execFile);
const args = parseArguments(process.argv.slice(2));
const bundle = path.resolve(requiredArgument(args, "--bundle"));
const target = requiredArgument(args, "--target");
const manifest = JSON.parse(await readFile(path.join(bundle, "manifest.json"), "utf8"));

if (manifest.schema_version !== 1 || manifest.target !== target) {
  throw new Error(`CLI bundle manifest does not match ${target}`);
}

const orche = path.join(bundle, "bin", executableName("orche", target));
const otrace = path.join(bundle, "bin", executableName("otrace", target));
for (const required of [
  orche,
  otrace,
  path.join(bundle, "LICENSE"),
  path.join(bundle, "README.md"),
  path.join(bundle, "THIRD_PARTY_NOTICES.md"),
]) {
  await access(required);
}
for (const packageName of RUNTIME_PACKAGES) {
  await access(path.join(bundle, "packages", packageName, "package.json"));
  await access(path.join(bundle, "packages", packageName, "src", "index.ts"));
}

const environment = {
  ...process.env,
  ORCHETRACE_PROJECT_ROOT: bundle,
  ORCHETRACE_NODE_PATH: process.execPath,
  ORCHETRACE_CLI_PATH: otrace,
  ORCHETRACE_ZSTD_PATH: otrace,
};
await execute(orche, ["--help"], { env: environment });
await execute(otrace, [], { env: environment });

for (const [packageName, entrypoint] of [
  ["claude-adapter", "auto-cli.ts"],
  ["pi-adapter", "auto-cli.ts"],
  ["dsh-observer", "auto-cli.ts"],
  ["codex-adapter", "auto-cli.ts"],
  ["antigravity-adapter", "auto-cli.ts"],
]) {
  const script = path.join(bundle, "packages", packageName, "src", entrypoint);
  const { stdout } = await execute(process.execPath, [script, "--help"], { env: environment });
  if (!stdout.includes("Usage:")) throw new Error(`${packageName} did not load from the portable bundle`);
}

console.log(`Verified portable CLI bundle for ${target}: 2 binaries and 5 runtime observers`);
