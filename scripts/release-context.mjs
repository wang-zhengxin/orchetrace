import { appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeVersion } from "./distribution-lib.mjs";

export function resolveReleaseContext({ refType, refName, previewVersion }) {
  if (refType === "tag") {
    if (!String(refName).startsWith("v")) throw new Error(`release tag must start with v: ${refName}`);
    const version = normalizeVersion(refName);
    return { mode: "release", version, currentTag: `v${version}` };
  }
  const version = normalizeVersion(previewVersion);
  return { mode: "preview", version, currentTag: `v${version}` };
}

export async function exposeReleaseContext(context, environmentFile) {
  const contents = [
    `ORCHETRACE_RELEASE_MODE=${context.mode}`,
    `ORCHETRACE_RELEASE_VERSION=${context.version}`,
    `ORCHETRACE_CURRENT_TAG=${context.currentTag}`,
  ].join("\n") + "\n";
  if (environmentFile) await appendFile(environmentFile, contents);
  return contents;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const context = resolveReleaseContext({
    refType: process.env.GITHUB_REF_TYPE,
    refName: process.env.GITHUB_REF_NAME,
    previewVersion: process.env.ORCHETRACE_PREVIEW_VERSION,
  });
  process.stdout.write(await exposeReleaseContext(context, process.env.GITHUB_ENV));
}
