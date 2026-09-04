import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseArguments, requiredArgument } from "./distribution-lib.mjs";
import { installerExtension } from "./verify-desktop-artifact.mjs";
import { smokeDesktopLaunch } from "./smoke-desktop-launch.mjs";

export async function smokeDesktopVersionLifecycle({ target, baselineRoot, candidateRoot }) {
  const baseline = await findInstallerOrFirstRelease(baselineRoot, target);
  if (!baseline) return { skipped: true };
  const candidate = await findInstaller(candidateRoot, target);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "orchetrace-desktop-version-"));
  const stateFile = path.join(temporaryRoot, "app-data", "lifecycle-sentinel.txt");
  try {
    await smokeDesktopLaunch({ target, installerPath: baseline, dataRoot: temporaryRoot });
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, "preserve-across-upgrade\n");
    await smokeDesktopLaunch({ target, installerPath: candidate, dataRoot: temporaryRoot });
    await assertSentinel(stateFile, "candidate upgrade");
    await smokeDesktopLaunch({ target, installerPath: baseline, dataRoot: temporaryRoot });
    await assertSentinel(stateFile, "baseline rollback");
    return { skipped: false, baseline, candidate };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function findInstallerOrFirstRelease(directory, target) {
  try {
    await readFile(path.join(path.resolve(directory), ".no-baseline"));
    return undefined;
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }
  return findInstaller(directory, target);
}

async function findInstaller(directory, target) {
  const extension = installerExtension(target);
  const files = await walkFiles(path.resolve(directory));
  const matches = files.filter((file) => file.toLowerCase().endsWith(extension));
  if (matches.length !== 1) {
    throw new Error(`expected one ${extension} installer below ${directory}, found ${matches.length}`);
  }
  return matches[0];
}

async function assertSentinel(file, phase) {
  if (await readFile(file, "utf8") !== "preserve-across-upgrade\n") {
    throw new Error(`${phase} did not preserve isolated application data`);
  }
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArguments(process.argv.slice(2));
  const result = await smokeDesktopVersionLifecycle({
    target: requiredArgument(args, "--target"),
    baselineRoot: requiredArgument(args, "--baseline-root"),
    candidateRoot: requiredArgument(args, "--candidate-root"),
  });
  console.log(result.skipped
    ? "No prior installer is available; desktop version lifecycle skipped for the first release."
    : "Verified baseline, candidate, rollback launch, and shared data preservation.");
}
