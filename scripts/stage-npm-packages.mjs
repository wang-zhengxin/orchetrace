import { spawn } from "node:child_process";
import { chmod, copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DISTRIBUTION_TARGETS,
  RUNTIME_PACKAGES,
  distributionTarget,
  executableName,
  normalizeVersion,
  npmDirectoryName,
  parseArguments,
  requiredArgument,
  resolveFrom,
} from "./distribution-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArguments(process.argv.slice(2));
const version = normalizeVersion(requiredArgument(args, "--version"));
const outputRoot = resolveFrom(root, args.get("--output"), "dist/npm");
const packageRoot = path.join(outputRoot, "packages");
const tarballRoot = path.join(outputRoot, "tarballs");
const mainRoot = path.join(packageRoot, npmDirectoryName("@orchetrace/cli"));

await stageMainPackage();
await pack(mainRoot);

const target = args.get("--target");
if (typeof target === "string") {
  const bundle = path.resolve(requiredArgument(args, "--bundle"));
  const platformRoot = await stagePlatformPackage(target, bundle);
  await pack(platformRoot);
  await smoke(mainRoot, platformRoot, target);
}

console.log(`Staged npm packages ${version} in ${path.relative(root, outputRoot)}`);

async function stageMainPackage() {
  await rm(mainRoot, { recursive: true, force: true });
  await mkdir(path.join(mainRoot, "bin"), { recursive: true });
  await mkdir(path.join(mainRoot, "packages"), { recursive: true });
  await cp(path.join(root, "packaging/npm/cli/bin"), path.join(mainRoot, "bin"), { recursive: true });
  if (process.platform !== "win32") {
    await chmod(path.join(mainRoot, "bin/orche.mjs"), 0o755);
    await chmod(path.join(mainRoot, "bin/otrace.mjs"), 0o755);
  }
  for (const packageName of RUNTIME_PACKAGES) {
    const source = path.join(root, "packages", packageName);
    const destination = path.join(mainRoot, "packages", packageName);
    await mkdir(destination, { recursive: true });
    await copyFile(path.join(source, "package.json"), path.join(destination, "package.json"));
    await cp(path.join(source, "src"), path.join(destination, "src"), { recursive: true });
  }
  await copyFile(path.join(root, "LICENSE"), path.join(mainRoot, "LICENSE"));
  await copyFile(
    path.join(root, "apps/desktop/src-tauri/resources/THIRD_PARTY_NOTICES.md"),
    path.join(mainRoot, "THIRD_PARTY_NOTICES.md"),
  );
  await copyFile(path.join(root, "README.md"), path.join(mainRoot, "README.md"));
  const optionalDependencies = Object.fromEntries(
    Object.values(DISTRIBUTION_TARGETS).map(({ npmPackage }) => [npmPackage, version]),
  );
  await writeJson(path.join(mainRoot, "package.json"), {
    name: "@orchetrace/cli",
    version,
    description: "Local-first multi-Agent observability CLI for Claude Code, Codex, Pi, and DeepSeek Harness",
    license: "MIT",
    type: "module",
    bin: {
      orche: "bin/orche.mjs",
      otrace: "bin/otrace.mjs",
    },
    files: ["bin", "packages", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    engines: { node: ">=22" },
    optionalDependencies,
    publishConfig: { access: "public", provenance: true },
    repository: { type: "git", url: "git+https://github.com/wang-zhengxin/orchetrace.git" },
    bugs: { url: "https://github.com/wang-zhengxin/orchetrace/issues" },
    homepage: "https://github.com/wang-zhengxin/orchetrace#readme",
  });
}

async function stagePlatformPackage(targetName, bundle) {
  const metadata = distributionTarget(targetName);
  const destination = path.join(packageRoot, npmDirectoryName(metadata.npmPackage));
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.join(destination, "bin"), { recursive: true });
  for (const binary of ["orche", "otrace"]) {
    const name = executableName(binary, targetName);
    await copyFile(path.join(bundle, "bin", name), path.join(destination, "bin", name));
    if (!targetName.includes("windows")) await chmod(path.join(destination, "bin", name), 0o755);
  }
  await copyFile(path.join(root, "LICENSE"), path.join(destination, "LICENSE"));
  await copyFile(
    path.join(root, "apps/desktop/src-tauri/resources/THIRD_PARTY_NOTICES.md"),
    path.join(destination, "THIRD_PARTY_NOTICES.md"),
  );
  await writeFile(
    path.join(destination, "README.md"),
    `# ${metadata.npmPackage}\n\nNative ${targetName} binaries for [@orchetrace/cli](https://www.npmjs.com/package/@orchetrace/cli).\n`,
  );
  await writeJson(path.join(destination, "package.json"), {
    name: metadata.npmPackage,
    version,
    description: `Orchetrace native CLI binaries for ${targetName}`,
    license: "MIT",
    os: [metadata.os],
    cpu: [metadata.cpu],
    ...(metadata.libc ? { libc: [metadata.libc] } : {}),
    files: ["bin", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    publishConfig: { access: "public", provenance: true },
    repository: { type: "git", url: "git+https://github.com/wang-zhengxin/orchetrace.git" },
  });
  return destination;
}

async function pack(directory) {
  await mkdir(tarballRoot, { recursive: true });
  await run("npm", ["pack", directory, "--pack-destination", tarballRoot, "--json"], root, {
    ...process.env,
    npm_config_cache: process.env.npm_config_cache ?? path.join(outputRoot, ".npm-cache"),
  });
}

async function smoke(cliRoot, platformRoot, targetName) {
  const environment = { ...process.env, ORCHETRACE_PLATFORM_PACKAGE_ROOT: platformRoot };
  const orcheLauncher = path.join(cliRoot, "bin/orche.mjs");
  const otraceLauncher = path.join(cliRoot, "bin/otrace.mjs");
  await run(process.execPath, [orcheLauncher, "--help"], root, environment);
  await run(process.execPath, [otraceLauncher], root, environment);
  console.log(`Verified npm launchers for ${targetName}`);
}

async function writeJson(destination, value) {
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, commandArgs, cwd, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`));
    });
  });
}
