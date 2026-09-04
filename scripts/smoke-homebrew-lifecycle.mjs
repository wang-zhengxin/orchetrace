import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  cliArchiveName,
  normalizeVersion,
  parseArguments,
  renderHomebrewCask,
  renderHomebrewFormula,
  requiredArgument,
} from "./distribution-lib.mjs";
import { launchUntilSettled } from "./smoke-desktop-launch.mjs";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function homebrewTargetForHost(platform, arch) {
  if (platform !== "darwin") throw new Error("Homebrew lifecycle smoke requires macOS");
  if (arch === "arm64") return "aarch64-apple-darwin";
  if (arch === "x64") return "x86_64-apple-darwin";
  throw new Error(`Homebrew lifecycle smoke does not support ${platform}-${arch}`);
}

export async function smokeHomebrewLifecycle({ version, assetsDir, definitionsDir }) {
  const releaseVersion = normalizeVersion(version);
  const target = homebrewTargetForHost(process.platform, process.arch);
  const files = await walkFiles(path.resolve(assetsDir));
  const archive = uniqueFile(files, (file) =>
    path.basename(file) === cliArchiveName(releaseVersion, target), "CLI archive");
  const architectureLabel = process.arch === "arm64" ? "aarch64" : "x64";
  const dmg = uniqueFile(files, (file) =>
    file.toLowerCase().endsWith(".dmg") && path.basename(file).includes(architectureLabel), "DMG");
  await Promise.all([
    access(path.resolve(definitionsDir, "Formula", "orchetrace.rb")),
    access(path.resolve(definitionsDir, "Casks", "orchetrace.rb")),
  ]);

  const [archiveSha, dmgSha] = await Promise.all([sha256(archive), sha256(dmg)]);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "orchetrace-homebrew-lifecycle-"));
  const localFormula = path.join(temporaryRoot, "Formula", "orchetrace.rb");
  const localCask = path.join(temporaryRoot, "Casks", "orchetrace.rb");
  const appDir = path.join(temporaryRoot, "Applications");
  const brewEnvironment = {
    ...process.env,
    HOMEBREW_NO_ANALYTICS: "1",
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_INSTALL_CLEANUP: "1",
  };
  let formulaAttempted = false;
  let caskAttempted = false;

  try {
    if (await brewInstalled("--formula", brewEnvironment) ||
        await brewInstalled("--cask", brewEnvironment)) {
      throw new Error("refusing to replace an existing Homebrew orchetrace installation");
    }
    await mkdir(path.dirname(localFormula), { recursive: true });
    await mkdir(path.dirname(localCask), { recursive: true });
    await mkdir(appDir, { recursive: true });
    const localArchive = {
      name: path.basename(archive),
      sha256: archiveSha,
      url: pathToFileURL(archive).href,
    };
    await writeFile(localFormula, renderHomebrewFormula({
      version: releaseVersion,
      repository: "wang-zhengxin/orchetrace",
      arm: localArchive,
      intel: localArchive,
    }));
    await writeFile(localCask, renderHomebrewCask({
      version: releaseVersion,
      repository: "wang-zhengxin/orchetrace",
      arm: { name: path.basename(dmg), sha256: dmgSha },
      intel: { name: path.basename(dmg), sha256: dmgSha },
      url: pathToFileURL(dmg).href,
    }));

    formulaAttempted = true;
    await brew(["install", "--formula", "--build-from-source", localFormula], brewEnvironment);
    const { stdout: formulaPrefixOutput } = await brew(["--prefix", "orchetrace"], brewEnvironment);
    const formulaPrefix = formulaPrefixOutput.trim();
    await verifyCli(path.join(formulaPrefix, "bin"), temporaryRoot);
    await brew(["uninstall", "--formula", "--force", "orchetrace"], brewEnvironment);
    formulaAttempted = false;
    if (await brewInstalled("--formula", brewEnvironment)) {
      throw new Error("Homebrew Formula uninstall left orchetrace installed");
    }

    caskAttempted = true;
    await brew([
      "install",
      "--cask",
      "--no-quarantine",
      `--appdir=${appDir}`,
      localCask,
    ], brewEnvironment);
    const app = path.join(appDir, "Orchetrace.app");
    const executable = path.join(app, "Contents", "MacOS", "orchetrace-desktop");
    await access(executable);
    await launchUntilSettled(executable, {
      ...process.env,
      HOME: path.join(temporaryRoot, "home"),
      ORCHETRACE_APP_DATA_DIR: path.join(temporaryRoot, "app-data"),
      ORCHETRACE_DATA_DIR: path.join(temporaryRoot, "data"),
      ORCHETRACE_AUTOSTART: "0",
    }, 3_000, [], path.dirname(executable));
    await brew(["uninstall", "--cask", "--force", "orchetrace"], brewEnvironment);
    caskAttempted = false;
    if (await brewInstalled("--cask", brewEnvironment)) {
      throw new Error("Homebrew Cask uninstall left orchetrace installed");
    }

    return { releaseVersion, target };
  } finally {
    if (caskAttempted) {
      await ignoreFailure(() => brew(["uninstall", "--cask", "--force", "orchetrace"], brewEnvironment));
    }
    if (formulaAttempted) {
      await ignoreFailure(() => brew(["uninstall", "--formula", "--force", "orchetrace"], brewEnvironment));
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifyCli(binDir, temporaryRoot) {
  const environment = {
    ...process.env,
    HOME: path.join(temporaryRoot, "home"),
    USERPROFILE: path.join(temporaryRoot, "home"),
  };
  const { stdout: orcheOutput } = await execute(path.join(binDir, "orche"), ["--help"], {
    cwd: temporaryRoot,
    env: environment,
  });
  if (!orcheOutput.includes("terminal multi-Agent observer")) {
    throw new Error("Homebrew Formula orche launcher did not start");
  }
  const { stdout: otraceOutput } = await execute(path.join(binDir, "otrace"), [], {
    cwd: temporaryRoot,
    env: environment,
  });
  if (!otraceOutput.includes("Usage:")) {
    throw new Error("Homebrew Formula otrace launcher did not start");
  }
}

async function brewInstalled(kind, environment) {
  const { stdout } = await brew(["list", kind], environment);
  return stdout.split(/\r?\n/u).includes("orchetrace");
}

function brew(args, environment) {
  return execute("brew", args, { cwd: root, env: environment });
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function uniqueFile(files, predicate, label) {
  const matches = files.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`expected one ${label}, found ${matches.length}`);
  }
  return matches[0];
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

async function ignoreFailure(operation) {
  try {
    await operation();
  } catch {
    // Best-effort cleanup preserves the original lifecycle failure.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArguments(process.argv.slice(2));
  const result = await smokeHomebrewLifecycle({
    version: requiredArgument(args, "--version"),
    assetsDir: requiredArgument(args, "--assets-dir"),
    definitionsDir: requiredArgument(args, "--definitions-dir"),
  });
  console.log(
    `Verified Homebrew Formula and Cask install/start/uninstall for ` +
    `${result.releaseVersion} (${result.target}).`,
  );
}
