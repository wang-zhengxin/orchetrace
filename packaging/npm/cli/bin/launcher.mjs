import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM_PACKAGES = Object.freeze({
  "darwin-arm64": "@orchetrace/cli-darwin-arm64",
  "darwin-x64": "@orchetrace/cli-darwin-x64",
  "linux-x64": "@orchetrace/cli-linux-x64-gnu",
  "win32-x64": "@orchetrace/cli-win32-x64-msvc",
});

export function launch(binaryName) {
  const key = `${process.platform}-${process.arch}`;
  const platformPackage = PLATFORM_PACKAGES[key];
  if (!platformPackage) {
    throw new Error(`Orchetrace does not provide a native CLI for ${key}`);
  }

  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const platformRoot = process.env.ORCHETRACE_PLATFORM_PACKAGE_ROOT
    ? path.resolve(process.env.ORCHETRACE_PLATFORM_PACKAGE_ROOT)
    : resolvePlatformPackage(platformPackage);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const binary = path.join(platformRoot, "bin", `${binaryName}${suffix}`);
  const otrace = path.join(platformRoot, "bin", `otrace${suffix}`);
  const child = spawn(binary, process.argv.slice(2), {
    stdio: "inherit",
    env: {
      ...process.env,
      ORCHETRACE_PROJECT_ROOT: packageRoot,
      ORCHETRACE_NODE_PATH: process.execPath,
      ORCHETRACE_CLI_PATH: otrace,
      ORCHETRACE_ZSTD_PATH: otrace,
    },
  });
  child.once("error", (error) => {
    process.stderr.write(`Failed to start ${binaryName}: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

function resolvePlatformPackage(packageName) {
  try {
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve(`${packageName}/package.json`));
  } catch (cause) {
    throw new Error(
      `Missing optional package ${packageName}. Reinstall @orchetrace/cli for the current platform.`,
      { cause },
    );
  }
}
