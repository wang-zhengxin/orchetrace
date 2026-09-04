import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeVersion, parseArguments, requiredArgument } from "./distribution-lib.mjs";

const artifactExtensions = [".dmg", ".deb", ".msi", ".tar.gz", ".tgz"];

export async function summarizeReleaseCandidate({ version, mode, assetsDir, output, signingPolicy }) {
  const releaseVersion = normalizeVersion(version);
  if (!new Set(["preview", "release"]).has(mode)) throw new Error(`invalid release mode ${mode}`);
  const root = path.resolve(assetsDir);
  const files = (await walkFiles(root))
    .filter((file) => artifactExtensions.some((extension) => file.toLowerCase().endsWith(extension)))
    .sort();
  if (files.length === 0) throw new Error(`no release artifacts found below ${root}`);
  const artifacts = [];
  for (const file of files) {
    const bytes = await readFile(file);
    artifacts.push({
      path: path.relative(root, file).replaceAll("\\", "/"),
      bytes: (await stat(file)).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const signing = signingPolicy ? JSON.parse(await readFile(path.resolve(signingPolicy), "utf8")) : undefined;
  if (signing && (signing.version !== releaseVersion || signing.mode !== mode)) {
    throw new Error("release signing policy does not match candidate context");
  }
  const summary = {
    schemaVersion: 1,
    mode,
    version: releaseVersion,
    generatedAt: new Date().toISOString(),
    ...(signing ? { signing: {
      channel: signing.channel,
      status: signing.status,
      signedRelease: signing.signedRelease,
    } } : {}),
    artifacts,
  };
  const outputRoot = path.resolve(output);
  await mkdir(outputRoot, { recursive: true });
  const jsonFile = path.join(outputRoot, "release-candidate.json");
  const markdownFile = path.join(outputRoot, "release-candidate.md");
  const markdown = renderMarkdown(summary);
  await Promise.all([
    writeFile(jsonFile, `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(markdownFile, markdown),
  ]);
  return { summary, jsonFile, markdownFile, markdown };
}

export function renderMarkdown(summary) {
  const rows = summary.artifacts.map((artifact) =>
    `| \`${artifact.path}\` | ${artifact.bytes} | \`${artifact.sha256}\` |`).join("\n");
  const signing = summary.signing
    ? `Signing: \`${summary.signing.status}\` (${summary.signing.channel})\n\n`
    : "";
  return `## Orchetrace ${summary.mode} ${summary.version}\n\n` +
    signing +
    `Validated artifacts: ${summary.artifacts.length}\n\n` +
    "| Artifact | Bytes | SHA-256 |\n| --- | ---: | --- |\n" +
    `${rows}\n`;
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
  const result = await summarizeReleaseCandidate({
    version: requiredArgument(args, "--version"),
    mode: requiredArgument(args, "--mode"),
    assetsDir: requiredArgument(args, "--assets-dir"),
    output: requiredArgument(args, "--output"),
    signingPolicy: args.get("--signing-policy"),
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, result.markdown);
  }
  console.log(`Summarized ${result.summary.artifacts.length} ${result.summary.mode} artifacts.`);
}
