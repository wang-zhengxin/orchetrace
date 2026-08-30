import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = path.join(root, "apps", "desktop", "src-tauri");
const target = argumentValue("--target");
if (!target) throw new Error("Usage: node scripts/verify-release.mjs --target <rust-target-triple>");

const suffix = target.includes("windows") ? ".exe" : "";
const node = path.join(tauriRoot, "binaries", `orchetrace-node-${target}${suffix}`);
const otrace = path.join(tauriRoot, "binaries", `otrace-${target}${suffix}`);
const resources = [
  path.join(root, "apps", "desktop", "dist", "runtime-diagnostics.js"),
  path.join(tauriRoot, "resources", "licenses", "NODE_LICENSE"),
  path.join(tauriRoot, "resources", "THIRD_PARTY_NOTICES.md"),
  node,
  otrace,
];
for (const resource of resources) await access(resource);

const manifest = JSON.parse(await readFile(path.join(tauriRoot, "resources", "release-manifest.json"), "utf8"));
if (manifest.schema_version !== 1 || manifest.target !== target) {
  throw new Error(`Release manifest does not describe ${target}`);
}

const { stdout: versionOutput } = await execute(node, ["--version"]);
if (versionOutput.trim() !== manifest.node_version) {
  throw new Error(`Bundled Node.js ${versionOutput.trim()} does not match manifest ${manifest.node_version}`);
}

for (const [packageName, expected] of [
  ["claude-adapter", "orchetrace-claude-auto"],
  ["pi-adapter", "orchetrace-pi-auto"],
  ["dsh-observer", "orchetrace-dsh-auto"],
  ["codex-adapter", "orchetrace-codex-auto"],
]) {
  const script = path.join(root, "packages", packageName, "src", "auto-cli.ts");
  const { stdout } = await execute(node, [script, "--help"], { cwd: root });
  if (!stdout.includes(expected)) throw new Error(`${packageName} did not load with bundled Node.js`);
}

console.log(`Verified ${target}: ${manifest.node_version}, otrace, frontend, and 4 runtime adapters`);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
