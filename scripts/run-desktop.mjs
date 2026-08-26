import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

await import("./build-desktop.mjs");

const action = process.argv[2] === "check" ? "check" : "run";
const executableName = process.platform === "win32" ? "cargo.exe" : "cargo";
const rustupCargo = path.join(os.homedir(), ".cargo", "bin", executableName);
const cargo = process.env.CARGO || (existsSync(rustupCargo) ? rustupCargo : executableName);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (action === "run") {
  const buildCode = await runCargo(["build", "-p", "orchetrace-cli", "--bin", "otrace"]);
  if (buildCode !== 0) process.exitCode = buildCode;
}
if (!process.exitCode) {
  process.exitCode = await runCargo([action, "-p", "orchetrace-desktop"]);
}

function runCargo(args) {
  return new Promise((resolve) => {
    const child = spawn(cargo, args, { cwd: workspace, env: process.env, stdio: "inherit" });
    child.once("error", (error) => {
      console.error(`Unable to start Cargo: ${error.message}`);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      if (signal) console.error(`Cargo stopped by ${signal}`);
      resolve(code ?? 1);
    });
  });
}
