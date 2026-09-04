import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { distributionTarget, parseArguments, requiredArgument } from "./distribution-lib.mjs";
import { installerExtension } from "./verify-desktop-artifact.mjs";

export function releaseAssetMatchesTarget(name, target) {
  const normalized = name.toLowerCase();
  const metadata = distributionTarget(target);
  if (!normalized.endsWith(installerExtension(target))) return false;
  if (metadata.os === "darwin") {
    return metadata.cpu === "arm64"
      ? normalized.includes("aarch64") || normalized.includes("arm64")
      : normalized.includes("x64") || normalized.includes("x86_64");
  }
  if (metadata.os === "linux") return normalized.includes("amd64") || normalized.includes("x86_64");
  return normalized.includes("x64") || normalized.includes("x86_64");
}

export function selectDesktopBaseline(releases, currentTag, target, minimumTag) {
  for (const release of releases) {
    if (release.draft) continue;
    try {
      if (compareReleaseVersions(release.tag_name, currentTag) >= 0) continue;
      if (minimumTag && compareReleaseVersions(release.tag_name, minimumTag) < 0) continue;
    } catch {
      continue;
    }
    const asset = release.assets?.find((candidate) =>
      releaseAssetMatchesTarget(candidate.name ?? "", target));
    if (asset) return { tag: release.tag_name, asset };
  }
  return undefined;
}

export function compareReleaseVersions(left, right) {
  const leftVersion = parseReleaseVersion(left);
  const rightVersion = parseReleaseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index] - rightVersion.core[index];
    }
  }
  if (leftVersion.prerelease.length === 0) return rightVersion.prerelease.length === 0 ? 0 : 1;
  if (rightVersion.prerelease.length === 0) return -1;
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart.localeCompare(rightPart, "en");
  }
  return 0;
}

function parseReleaseVersion(tag) {
  const match = String(tag).match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u);
  if (!match) throw new Error(`invalid release tag ${JSON.stringify(tag)}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export async function downloadDesktopBaseline({ repository, currentTag, minimumTag, target, output }) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=50`, {
    headers,
  });
  if (!response.ok) throw new Error(`GitHub releases request failed: HTTP ${response.status}`);
  const selected = selectDesktopBaseline(await response.json(), currentTag, target, minimumTag);
  const outputRoot = path.resolve(output);
  await mkdir(outputRoot, { recursive: true });
  if (!selected) {
    await writeFile(path.join(outputRoot, ".no-baseline"), `${currentTag}\n`);
    return undefined;
  }

  const destination = path.join(outputRoot, selected.asset.name);
  const download = await fetch(selected.asset.url, {
    headers: { ...headers, Accept: "application/octet-stream" },
    redirect: "follow",
  });
  if (!download.ok || !download.body) {
    throw new Error(`baseline download failed: HTTP ${download.status}`);
  }
  await pipeline(Readable.fromWeb(download.body), createWriteStream(destination, { flags: "wx" }));
  const digest = createHash("sha256").update(await readFile(destination)).digest("hex");
  const expected = selected.asset.digest?.replace(/^sha256:/u, "");
  if (expected && digest !== expected) {
    throw new Error(`baseline digest mismatch: expected ${expected}, received ${digest}`);
  }
  await writeFile(path.join(outputRoot, "baseline.json"), `${JSON.stringify({
    schemaVersion: 1,
    tag: selected.tag,
    target,
    installer: selected.asset.name,
    sha256: digest,
  }, null, 2)}\n`);
  return { tag: selected.tag, installer: destination, sha256: digest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArguments(process.argv.slice(2));
  const currentTag = args.get("--current-tag") ?? process.env.ORCHETRACE_CURRENT_TAG;
  if (typeof currentTag !== "string" || currentTag.length === 0) {
    throw new Error("--current-tag or ORCHETRACE_CURRENT_TAG is required");
  }
  const minimumTag = args.get("--minimum-tag");
  if (minimumTag !== undefined && typeof minimumTag !== "string") {
    throw new Error("--minimum-tag requires a value");
  }
  const result = await downloadDesktopBaseline({
    repository: requiredArgument(args, "--repository"),
    currentTag,
    minimumTag,
    target: requiredArgument(args, "--target"),
    output: requiredArgument(args, "--output"),
  });
  console.log(result
    ? `Downloaded ${result.tag} desktop baseline (${result.sha256}).`
    : "No prior desktop baseline exists; treating this as the first compatible release.");
}
