import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeVersion, parseArguments, requiredArgument } from "./distribution-lib.mjs";

const APPLE_REQUIREMENTS = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
];
const WINDOWS_REQUIREMENTS = ["WINDOWS_CERTIFICATE", "WINDOWS_CERTIFICATE_PASSWORD"];

export function evaluateReleaseSigningPolicy({ version, mode, signedReleasesEnabled, environment = {} }) {
  const releaseVersion = normalizeVersion(version);
  if (!new Set(["preview", "release"]).has(mode)) throw new Error(`invalid release mode ${mode}`);
  const prerelease = releaseVersion.includes("-");
  const channel = mode === "preview" ? "preview" : prerelease ? "prerelease" : "stable";
  const missingApple = missingEnvironment(environment, APPLE_REQUIREMENTS);
  const missingWindows = missingEnvironment(environment, WINDOWS_REQUIREMENTS);
  const credentialsReady = missingApple.length === 0 && missingWindows.length === 0;
  const signingRequested = mode === "release" && signedReleasesEnabled === true;
  const signedRelease = signingRequested && credentialsReady;
  const blockers = [];
  if (channel === "stable" && !signedReleasesEnabled) blockers.push("SIGNED_RELEASES_ENABLED");
  if (channel === "stable" || signingRequested) blockers.push(...missingApple, ...missingWindows);

  return {
    schemaVersion: 1,
    version: releaseVersion,
    mode,
    channel,
    prerelease,
    status: blockers.length > 0 ? "blocked" : signedRelease ? "signed" : "unsigned-allowed",
    signedRelease,
    requirements: {
      stableReleaseRequiresSigning: true,
      signedReleasesEnabled: signedReleasesEnabled === true,
      macos: {
        ready: missingApple.length === 0,
        missing: missingApple,
        notarization: "apple-id",
      },
      windows: {
        ready: missingWindows.length === 0,
        missing: missingWindows,
        signing: "pfx-authenticode",
      },
    },
    blockers: [...new Set(blockers)],
  };
}

export async function writeReleaseSigningPolicy(policy, outputRoot) {
  const root = path.resolve(outputRoot);
  await mkdir(root, { recursive: true });
  const jsonFile = path.join(root, "release-signing-policy.json");
  const markdownFile = path.join(root, "release-signing-policy.md");
  const markdown = renderReleaseSigningPolicy(policy);
  await Promise.all([
    writeFile(jsonFile, `${JSON.stringify(policy, null, 2)}\n`),
    writeFile(markdownFile, markdown),
  ]);
  return { jsonFile, markdownFile, markdown };
}

export function renderReleaseSigningPolicy(policy) {
  const outcome = policy.status === "signed"
    ? "Platform signing is enabled and all configured credentials are present."
    : policy.status === "blocked"
      ? `Release blocked: ${policy.blockers.join(", ")}.`
      : "Unsigned/ad-hoc artifacts are allowed for this non-stable channel.";
  return `## Release signing policy\n\n` +
    `- Version: \`${policy.version}\`\n` +
    `- Channel: \`${policy.channel}\`\n` +
    `- Status: \`${policy.status}\`\n` +
    `- macOS Developer ID + notarization ready: \`${policy.requirements.macos.ready}\`\n` +
    `- Windows Authenticode ready: \`${policy.requirements.windows.ready}\`\n\n` +
    `${outcome}\n`;
}

function missingEnvironment(environment, names) {
  return names.filter((name) => !String(environment[name] ?? "").trim());
}

async function appendOutputs(policy) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, [
    `release_channel=${policy.channel}`,
    `release_prerelease=${policy.prerelease}`,
    `signed_release=${policy.signedRelease}`,
    `signing_status=${policy.status}`,
  ].join("\n") + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArguments(process.argv.slice(2));
  const policy = evaluateReleaseSigningPolicy({
    version: requiredArgument(args, "--version"),
    mode: requiredArgument(args, "--mode"),
    signedReleasesEnabled: process.env.ORCHETRACE_SIGNED_RELEASES_ENABLED === "true",
    environment: process.env,
  });
  const result = await writeReleaseSigningPolicy(policy, requiredArgument(args, "--output"));
  await appendOutputs(policy);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, result.markdown);
  console.log(`Release signing policy: ${policy.channel} / ${policy.status}`);
  if (policy.blockers.length > 0) {
    throw new Error(`stable release signing requirements are incomplete: ${policy.blockers.join(", ")}`);
  }
}
