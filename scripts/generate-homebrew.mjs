import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cliArchiveName,
  normalizeVersion,
  parseArguments,
  renderHomebrewCask,
  renderHomebrewFormula,
  requiredArgument,
  resolveFrom,
} from "./distribution-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArguments(process.argv.slice(2));
const version = normalizeVersion(requiredArgument(args, "--version"));
const repository = args.get("--repository") ?? "wang-zhengxin/orchetrace";
const assetsDir = path.resolve(requiredArgument(args, "--assets-dir"));
const output = resolveFrom(root, args.get("--output"), "dist/homebrew");

const formulaAssets = {
  arm: await asset(cliArchiveName(version, "aarch64-apple-darwin")),
  intel: await asset(cliArchiveName(version, "x86_64-apple-darwin")),
};
await mkdir(path.join(output, "Formula"), { recursive: true });
await writeFile(
  path.join(output, "Formula/orchetrace.rb"),
  renderHomebrewFormula({ version, repository, ...formulaAssets }),
);

const names = await readdir(assetsDir);
const armDmg = names.find((name) => name.endsWith(".dmg") && name.includes("aarch64"));
const intelDmg = names.find((name) => name.endsWith(".dmg") && name.includes("x64"));
if (armDmg && intelDmg) {
  await mkdir(path.join(output, "Casks"), { recursive: true });
  await writeFile(
    path.join(output, "Casks/orchetrace.rb"),
    renderHomebrewCask({
      version,
      repository,
      arm: await asset(armDmg),
      intel: await asset(intelDmg),
    }),
  );
} else if (args.get("--require-cask")) {
  throw new Error("both aarch64 and x64 DMG assets are required to generate the Homebrew Cask");
}

console.log(`Generated Homebrew Formula${armDmg && intelDmg ? " and Cask" : ""} in ${path.relative(root, output)}`);

async function asset(name) {
  const bytes = await readFile(path.join(assetsDir, name));
  return { name, sha256: createHash("sha256").update(bytes).digest("hex") };
}
