import path from "node:path";

export const RUNTIME_PACKAGES = [
  "adapter-runtime",
  "protocol-ts",
  "claude-adapter",
  "pi-adapter",
  "dsh-observer",
  "codex-adapter",
];

export const DISTRIBUTION_TARGETS = Object.freeze({
  "aarch64-apple-darwin": {
    npmPackage: "@orchetrace/cli-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    archiveLabel: "aarch64-apple-darwin",
  },
  "x86_64-apple-darwin": {
    npmPackage: "@orchetrace/cli-darwin-x64",
    os: "darwin",
    cpu: "x64",
    archiveLabel: "x86_64-apple-darwin",
  },
  "x86_64-unknown-linux-gnu": {
    npmPackage: "@orchetrace/cli-linux-x64-gnu",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    archiveLabel: "x86_64-unknown-linux-gnu",
  },
  "x86_64-pc-windows-msvc": {
    npmPackage: "@orchetrace/cli-win32-x64-msvc",
    os: "win32",
    cpu: "x64",
    archiveLabel: "x86_64-pc-windows-msvc",
  },
});

export function normalizeVersion(value) {
  const version = String(value ?? "").trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid release version ${JSON.stringify(value)}`);
  }
  return version;
}

export function distributionTarget(target) {
  const metadata = DISTRIBUTION_TARGETS[target];
  if (!metadata) throw new Error(`unsupported distribution target ${target}`);
  return metadata;
}

export function executableName(name, target) {
  return `${name}${target.includes("windows") ? ".exe" : ""}`;
}

export function cliArchiveName(version, target) {
  return `orchetrace-cli-v${normalizeVersion(version)}-${distributionTarget(target).archiveLabel}.tar.gz`;
}

export function npmDirectoryName(packageName) {
  return packageName.replace(/^@/, "").replaceAll("/", "-");
}

export function npmTarballName(packageName, version) {
  return `${npmDirectoryName(packageName)}-${normalizeVersion(version)}.tgz`;
}

export function parseArguments(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument ${argument}`);
    if (!argv[index + 1] || argv[index + 1].startsWith("--")) {
      result.set(argument, true);
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    result.set(argument, value);
  }
  return result;
}

export function requiredArgument(argumentsMap, name) {
  const value = argumentsMap.get(name);
  if (typeof value !== "string") throw new Error(`${name} is required`);
  return value;
}

export function resolveFrom(root, value, fallback) {
  return path.resolve(root, value ?? fallback);
}

export function renderHomebrewFormula({ version, repository, arm, intel }) {
  const releaseVersion = normalizeVersion(version);
  return `class Orchetrace < Formula
  desc "Observe Claude Code, Codex, Pi, and DeepSeek Harness agents"
  homepage "https://github.com/${repository}"
  version "${releaseVersion}"

  if Hardware::CPU.arm?
    url "https://github.com/${repository}/releases/download/v${releaseVersion}/${arm.name}"
    sha256 "${arm.sha256}"
  else
    url "https://github.com/${repository}/releases/download/v${releaseVersion}/${intel.name}"
    sha256 "${intel.sha256}"
  end

  license "MIT"

  depends_on :macos
  depends_on "node@22"

  def install
    libexec.install Dir["*"]
    runtime_env = {
      "ORCHETRACE_PROJECT_ROOT" => libexec,
      "ORCHETRACE_NODE_PATH"    => Formula["node@22"].opt_bin/"node",
      "ORCHETRACE_CLI_PATH"     => libexec/"bin/otrace",
      "ORCHETRACE_ZSTD_PATH"    => libexec/"bin/otrace",
    }
    (bin/"orche").write_env_script libexec/"bin/orche", runtime_env
    (bin/"otrace").write_env_script libexec/"bin/otrace", runtime_env
  end

  test do
    assert_match "terminal multi-Agent observer", shell_output("#{bin}/orche --help")
    assert_match "Usage:", shell_output("#{bin}/otrace")
  end
end
`;
}

export function renderHomebrewCask({ version, repository, arm, intel }) {
  const releaseVersion = normalizeVersion(version);
  return `cask "orchetrace" do
  arch arm: "aarch64", intel: "x64"

  version "${releaseVersion}"
  sha256 arm:   "${arm.sha256}",
         intel: "${intel.sha256}"

  url "https://github.com/${repository}/releases/download/v#{version}/${arm.name.replace("aarch64", "#{arch}")}",
      verified: "github.com/${repository}/"
  name "Orchetrace"
  desc "Local-first multi-Agent observability desktop application"
  homepage "https://github.com/${repository}"

  app "Orchetrace.app"

  caveats do
    <<~EOS
      Beta builds may use ad-hoc signing. A notarized Developer ID build will
      replace this caveat before the stable channel is promoted.
    EOS
  end
end
`;
}
