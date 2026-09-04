import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, "..");
const coverageValues = new Set(["fixture-verified", "experimental"]);
const versionBasisValues = new Set(["declared-schema", "observed-unversioned", "mixed"]);
const evidenceKinds = new Set(["raw-fixture", "canonical-fixture", "test"]);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeRepositoryPath(path) {
  return nonEmptyString(path) &&
    !isAbsolute(path) &&
    !path.split(/[\\/]/u).includes("..");
}

function duplicateValues(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

async function validateEvidencePath(rootDir, runtimeId, evidence, errors) {
  if (!record(evidence) || !evidenceKinds.has(evidence.kind)) {
    errors.push(`${runtimeId}: evidence kind must be raw-fixture, canonical-fixture, or test`);
    return;
  }
  if (!safeRepositoryPath(evidence.path)) {
    errors.push(`${runtimeId}: evidence path must stay inside the repository: ${String(evidence.path)}`);
    return;
  }

  const absolutePath = resolve(rootDir, evidence.path);
  try {
    const [fileStat, resolvedPath, resolvedRoot] = await Promise.all([
      stat(absolutePath),
      realpath(absolutePath),
      realpath(rootDir),
    ]);
    const repositoryRelativePath = relative(resolvedRoot, resolvedPath);
    const outsideRoot = isAbsolute(repositoryRelativePath) ||
      repositoryRelativePath.startsWith(`..${sep}`) ||
      repositoryRelativePath === "..";
    if (!fileStat.isFile() || outsideRoot) {
      errors.push(`${runtimeId}: evidence is not a repository file: ${evidence.path}`);
      return;
    }
  } catch {
    errors.push(`${runtimeId}: evidence file does not exist: ${evidence.path}`);
    return;
  }

  if (evidence.kind !== "canonical-fixture") return;

  const lines = (await readFile(absolutePath, "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    errors.push(`${runtimeId}: canonical fixture is empty: ${evidence.path}`);
    return;
  }
  for (const [index, line] of lines.entries()) {
    try {
      const event = JSON.parse(line);
      if (event.schema_version !== 1) {
        errors.push(`${runtimeId}: ${evidence.path}:${index + 1} is not Canonical Event v1`);
      }
      if (event.runtime !== runtimeId) {
        errors.push(
          `${runtimeId}: ${evidence.path}:${index + 1} declares runtime ${String(event.runtime)}`,
        );
      }
    } catch {
      errors.push(`${runtimeId}: ${evidence.path}:${index + 1} is not valid JSON`);
    }
  }
}

export async function validateRuntimeCompatibility(options = {}) {
  const rootDir = resolve(options.rootDir ?? defaultRoot);
  const compatibility = options.compatibility ?? await readJson(
    resolve(rootDir, "runtimes/compatibility.json"),
  );
  const registry = options.registry ?? await readJson(resolve(rootDir, "runtimes/registry.json"));
  const packageJson = options.packageJson ?? await readJson(resolve(rootDir, "package.json"));
  const errors = [];

  if (!record(compatibility) || compatibility.schema_version !== 1) {
    throw new Error("Runtime compatibility validation failed:\n- schema_version must be 1");
  }
  if (compatibility.$schema !== "./compatibility.schema.json") {
    errors.push("$schema must reference ./compatibility.schema.json");
  }
  if (!Array.isArray(compatibility.runtimes)) {
    errors.push("runtimes must be an array");
  }
  if (!record(registry) || !Array.isArray(registry.runtimes)) {
    errors.push("runtime registry must contain a runtimes array");
  }

  const matrixRuntimes = Array.isArray(compatibility.runtimes) ? compatibility.runtimes : [];
  const registryRuntimes = Array.isArray(registry.runtimes) ? registry.runtimes : [];
  const matrixIds = matrixRuntimes.map((runtime) => runtime?.id).filter(nonEmptyString);
  const registryIds = registryRuntimes.map((runtime) => runtime?.id).filter(nonEmptyString);
  for (const id of duplicateValues(matrixIds)) errors.push(`duplicate runtime: ${id}`);
  for (const id of registryIds.filter((id) => !matrixIds.includes(id))) {
    errors.push(`missing registered runtime: ${id}`);
  }
  for (const id of matrixIds.filter((id) => !registryIds.includes(id))) {
    errors.push(`compatibility matrix contains unregistered runtime: ${id}`);
  }

  let formatCount = 0;
  let evidenceCount = 0;
  for (const runtime of matrixRuntimes) {
    const runtimeId = nonEmptyString(runtime?.id) ? runtime.id : "<unknown-runtime>";
    if (!record(runtime)) {
      errors.push("runtime entry must be an object");
      continue;
    }
    if (!nonEmptyString(runtime.id)) errors.push("runtime id must be a non-empty string");
    if (!coverageValues.has(runtime.coverage)) {
      errors.push(`${runtimeId}: invalid coverage ${String(runtime.coverage)}`);
    }
    if (!versionBasisValues.has(runtime.version_basis)) {
      errors.push(`${runtimeId}: invalid version_basis ${String(runtime.version_basis)}`);
    }
    if (!nonEmptyString(runtime.unknown_record_policy)) {
      errors.push(`${runtimeId}: unknown_record_policy must be documented`);
    }
    if (!Array.isArray(runtime.limitations) || runtime.limitations.length === 0 ||
      runtime.limitations.some((item) => !nonEmptyString(item))) {
      errors.push(`${runtimeId}: limitations must contain at least one non-empty entry`);
    }
    if (!Array.isArray(runtime.test_scripts) || runtime.test_scripts.length === 0) {
      errors.push(`${runtimeId}: test_scripts must not be empty`);
    } else {
      for (const script of runtime.test_scripts) {
        if (!nonEmptyString(script) || !record(packageJson.scripts) || !packageJson.scripts[script]) {
          errors.push(`${runtimeId}: unknown npm test script ${String(script)}`);
        }
      }
    }
    if (!Array.isArray(runtime.formats) || runtime.formats.length === 0) {
      errors.push(`${runtimeId}: formats must not be empty`);
      continue;
    }

    const formatIds = runtime.formats.map((format) => format?.id).filter(nonEmptyString);
    for (const id of duplicateValues(formatIds)) errors.push(`${runtimeId}: duplicate format ${id}`);
    const observedKinds = new Set();
    for (const format of runtime.formats) {
      formatCount += 1;
      const formatId = nonEmptyString(format?.id) ? format.id : "<unknown-format>";
      if (!record(format) || !nonEmptyString(format.id)) {
        errors.push(`${runtimeId}: format id must be a non-empty string`);
        continue;
      }
      if (!Array.isArray(format.versions) || format.versions.length === 0 ||
        format.versions.some((version) => !nonEmptyString(version))) {
        errors.push(`${runtimeId}/${formatId}: versions must not be empty`);
      }
      if (!Array.isArray(format.evidence) || format.evidence.length === 0) {
        errors.push(`${runtimeId}/${formatId}: evidence must not be empty`);
        continue;
      }
      for (const evidence of format.evidence) {
        evidenceCount += 1;
        if (record(evidence) && evidenceKinds.has(evidence.kind)) observedKinds.add(evidence.kind);
        await validateEvidencePath(rootDir, runtimeId, evidence, errors);
      }
    }
    for (const kind of evidenceKinds) {
      if (!observedKinds.has(kind)) errors.push(`${runtimeId}: missing ${kind} evidence`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Runtime compatibility validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
  return {
    runtimeCount: matrixRuntimes.length,
    formatCount,
    evidenceCount,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await validateRuntimeCompatibility();
    console.log(
      `Runtime compatibility matrix verified: ${result.runtimeCount} runtimes, ` +
      `${result.formatCount} formats, ${result.evidenceCount} evidence links.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
