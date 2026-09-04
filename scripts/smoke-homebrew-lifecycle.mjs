import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

export async function smokeHomebrewLifecycle({ version, assetsDir, definitionsDir, baselineRoot }) {
  const releaseVersion = normalizeVersion(version);
  const target = homebrewTargetForHost(process.platform, process.arch);
  const files = await walkFiles(path.resolve(assetsDir));
  const archive = uniqueFile(files, (file) =>
    path.basename(file) === cliArchiveName(releaseVersion, target), "CLI archive");
  const architectureLabel = process.arch === "arm64" ? "aarch64" : "x64";
  const dmg = uniqueFile(files, (file) =>
    file.toLowerCase().endsWith(".dmg") && path.basename(file).includes(architectureLabel), "DMG");
  const caskBaseline = baselineRoot ? await loadCaskBaseline(baselineRoot) : undefined;
  await Promise.all([
    access(path.resolve(definitionsDir, "Formula", "orchetrace.rb")),
    access(path.resolve(definitionsDir, "Casks", "orchetrace.rb")),
  ]);

  const [archiveSha, dmgSha] = await Promise.all([sha256(archive), sha256(dmg)]);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "orchetrace-homebrew-lifecycle-"));
  const baselineFormula = path.join(temporaryRoot, "Formula", "baseline", "orchetrace.rb");
  const candidateFormula = path.join(temporaryRoot, "Formula", "candidate", "orchetrace.rb");
  const baselineCask = path.join(temporaryRoot, "Casks", "baseline", "orchetrace.rb");
  const candidateCask = path.join(temporaryRoot, "Casks", "candidate", "orchetrace.rb");
  const tapName = "orchetrace/lifecycle";
  const qualifiedToken = `${tapName}/orchetrace`;
  const appDir = path.join(temporaryRoot, "Applications");
  const brewEnvironment = {
    ...process.env,
    HOMEBREW_NO_ANALYTICS: "1",
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_INSTALL_FROM_API: "1",
    HOMEBREW_NO_INSTALL_CLEANUP: "1",
  };
  let formulaAttempted = false;
  let caskAttempted = false;
  let tapCreated = false;

  try {
    if (await brewInstalled("--formula", brewEnvironment) ||
        await brewInstalled("--cask", brewEnvironment)) {
      throw new Error("refusing to replace an existing Homebrew orchetrace installation");
    }
    await mkdir(path.dirname(baselineFormula), { recursive: true });
    await mkdir(path.dirname(candidateFormula), { recursive: true });
    await mkdir(path.dirname(baselineCask), { recursive: true });
    await mkdir(path.dirname(candidateCask), { recursive: true });
    await mkdir(appDir, { recursive: true });
    const localArchive = {
      name: path.basename(archive),
      sha256: archiveSha,
      url: pathToFileURL(archive).href,
    };
    const formulaDefinition = (formulaVersion) => renderHomebrewFormula({
      version: formulaVersion,
      repository: "wang-zhengxin/orchetrace",
      arm: localArchive,
      intel: localArchive,
    });
    await writeFile(baselineFormula, formulaDefinition("0.0.0-lifecycle.0"));
    await writeFile(candidateFormula, formulaDefinition(releaseVersion));
    await writeFile(candidateCask, renderHomebrewCask({
      version: releaseVersion,
      repository: "wang-zhengxin/orchetrace",
      arm: { name: path.basename(dmg), sha256: dmgSha },
      intel: { name: path.basename(dmg), sha256: dmgSha },
      url: pathToFileURL(dmg).href,
    }));
    if (caskBaseline) {
      const baselineSha = await sha256(caskBaseline.dmg);
      await writeFile(baselineCask, renderHomebrewCask({
        version: caskBaseline.version,
        repository: "wang-zhengxin/orchetrace",
        arm: { name: path.basename(caskBaseline.dmg), sha256: baselineSha },
        intel: { name: path.basename(caskBaseline.dmg), sha256: baselineSha },
        url: pathToFileURL(caskBaseline.dmg).href,
      }));
    }

    await brew(["tap-new", tapName, "--no-git"], brewEnvironment);
    tapCreated = true;
    const { stdout: tapOutput } = await brew(["--repository", tapName], brewEnvironment);
    const tapRoot = tapOutput.trim();
    const tapFormula = path.join(tapRoot, "Formula", "orchetrace.rb");
    const tapCask = path.join(tapRoot, "Casks", "orchetrace.rb");
    await Promise.all([
      mkdir(path.dirname(tapFormula), { recursive: true }),
      mkdir(path.dirname(tapCask), { recursive: true }),
    ]);

    formulaAttempted = true;
    await copyFile(baselineFormula, tapFormula);
    await brew(["install", "--formula", "--build-from-source", qualifiedToken], brewEnvironment);
    await verifyFormula("0.0.0-lifecycle.0", temporaryRoot, brewEnvironment);
    await copyFile(candidateFormula, tapFormula);
    await brew(["upgrade", "--formula", "--build-from-source", qualifiedToken], brewEnvironment);
    await verifyFormula(releaseVersion, temporaryRoot, brewEnvironment);
    await copyFile(baselineFormula, tapFormula);
    await brew(["reinstall", "--formula", "--build-from-source", qualifiedToken], brewEnvironment);
    await verifyFormula("0.0.0-lifecycle.0", temporaryRoot, brewEnvironment);
    await brew(["uninstall", "--formula", "--force", "orchetrace"], brewEnvironment);
    formulaAttempted = false;
    if (await brewInstalled("--formula", brewEnvironment)) {
      throw new Error("Homebrew Formula uninstall left orchetrace installed");
    }

    caskAttempted = true;
    if (caskBaseline) {
      await copyFile(baselineCask, tapCask);
      await installCask("install", qualifiedToken, appDir, brewEnvironment);
      await verifyCaskVersion(caskBaseline.version, brewEnvironment);
      await launchCask(appDir, temporaryRoot);
      await mkdir(path.join(temporaryRoot, "app-data"), { recursive: true });
      await writeFile(path.join(temporaryRoot, "app-data", "homebrew-sentinel.txt"), "preserve\n");
      await copyFile(candidateCask, tapCask);
      await installCask("upgrade", qualifiedToken, appDir, brewEnvironment);
      await verifyCaskVersion(releaseVersion, brewEnvironment);
      await launchCask(appDir, temporaryRoot);
      await verifySentinel(temporaryRoot, "Cask upgrade");
      await copyFile(baselineCask, tapCask);
      await installCask("reinstall", qualifiedToken, appDir, brewEnvironment);
      await verifyCaskVersion(caskBaseline.version, brewEnvironment);
      await launchCask(appDir, temporaryRoot);
      await verifySentinel(temporaryRoot, "Cask rollback");
    } else {
      await copyFile(candidateCask, tapCask);
      await installCask("install", qualifiedToken, appDir, brewEnvironment);
      await launchCask(appDir, temporaryRoot);
    }
    await brew(["uninstall", "--cask", "--force", "orchetrace"], brewEnvironment);
    caskAttempted = false;
    if (await brewInstalled("--cask", brewEnvironment)) {
      throw new Error("Homebrew Cask uninstall left orchetrace installed");
    }

    return { releaseVersion, target, caskBaseline: caskBaseline?.version };
  } finally {
    if (caskAttempted) {
      await ignoreFailure(() => brew(["uninstall", "--cask", "--force", "orchetrace"], brewEnvironment));
    }
    if (formulaAttempted) {
      await ignoreFailure(() => brew(["uninstall", "--formula", "--force", "orchetrace"], brewEnvironment));
    }
    if (tapCreated) {
      await ignoreFailure(() => brew(["untap", "--force", tapName], brewEnvironment));
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifyFormula(expectedVersion, temporaryRoot, environment) {
  const { stdout: versions } = await brew(["list", "--formula", "--versions", "orchetrace"], environment);
  if (!versions.split(/\s+/u).includes(expectedVersion)) {
    throw new Error(`Homebrew Formula version mismatch: expected ${expectedVersion}, received ${versions.trim()}`);
  }
  const { stdout } = await brew(["--prefix", "orchetrace"], environment);
  await verifyCli(path.join(stdout.trim(), "bin"), temporaryRoot);
}

function installCask(operation, definition, appDir, environment) {
  return brew(homebrewCaskCommand(operation, definition, appDir), environment);
}

export function homebrewCaskCommand(operation, definition, appDir) {
  return [
    operation,
    "--cask",
    ...(operation === "install" ? ["--no-quarantine"] : []),
    `--appdir=${appDir}`,
    definition,
  ];
}

async function verifyCaskVersion(expectedVersion, environment) {
  const { stdout } = await brew(["list", "--cask", "--versions", "orchetrace"], environment);
  if (!stdout.split(/\s+/u).includes(expectedVersion)) {
    throw new Error(`Homebrew Cask version mismatch: expected ${expectedVersion}, received ${stdout.trim()}`);
  }
}

async function launchCask(appDir, temporaryRoot) {
  const executable = path.join(appDir, "Orchetrace.app", "Contents", "MacOS", "orchetrace-desktop");
  await access(executable);
  await launchUntilSettled(executable, {
    ...process.env,
    HOME: path.join(temporaryRoot, "home"),
    ORCHETRACE_APP_DATA_DIR: path.join(temporaryRoot, "app-data"),
    ORCHETRACE_DATA_DIR: path.join(temporaryRoot, "data"),
    ORCHETRACE_AUTOSTART: "0",
  }, 3_000, [], path.dirname(executable));
}

async function verifySentinel(temporaryRoot, phase) {
  const value = await readFile(path.join(temporaryRoot, "app-data", "homebrew-sentinel.txt"), "utf8");
  if (value !== "preserve\n") throw new Error(`${phase} did not preserve application data`);
}

async function loadCaskBaseline(directory) {
  const baselineRoot = path.resolve(directory);
  try {
    await access(path.join(baselineRoot, ".no-baseline"));
    return undefined;
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }
  const metadata = JSON.parse(await readFile(path.join(baselineRoot, "baseline.json"), "utf8"));
  return {
    version: normalizeVersion(metadata.tag),
    dmg: path.join(baselineRoot, metadata.installer),
  };
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
    baselineRoot: typeof args.get("--baseline-root") === "string" ? args.get("--baseline-root") : undefined,
  });
  console.log(
    `Verified Homebrew Formula and Cask install/upgrade/rollback/uninstall for ` +
    `${result.releaseVersion} (${result.target})${result.caskBaseline ? ` from ${result.caskBaseline}` : ""}.`,
  );
}
