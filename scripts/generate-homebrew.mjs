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

const assetFiles = await walkFiles(assetsDir);
const formulaAssets = {
  arm: await namedAsset(cliArchiveName(version, "aarch64-apple-darwin")),
  intel: await namedAsset(cliArchiveName(version, "x86_64-apple-darwin")),
};
await mkdir(path.join(output, "Formula"), { recursive: true });
await writeFile(
  path.join(output, "Formula/orchetrace.rb"),
  renderHomebrewFormula({ version, repository, ...formulaAssets }),
);

const armDmg = assetFiles.find((file) => file.endsWith(".dmg") && path.basename(file).includes("aarch64"));
const intelDmg = assetFiles.find((file) => file.endsWith(".dmg") && path.basename(file).includes("x64"));
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

async function namedAsset(name) {
  const matches = assetFiles.filter((file) => path.basename(file) === name);
  if (matches.length !== 1) {
    throw new Error(`expected one ${name} below ${assetsDir}, found ${matches.length}`);
  }
  return asset(matches[0]);
}

async function asset(file) {
  const bytes = await readFile(file);
  return { name: path.basename(file), sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function walkFiles(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  return files;
}
