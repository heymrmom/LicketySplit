#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  assertInspectorLicenseNotice,
  assertInspectorProof,
  assertNoPrivatePackagePaths,
  assertPackagedFileMatchesCommit,
  assertSourceReceipt,
  assertSourceTreeMatchesReceipt,
  readGitHead,
  readGitSourceStatus,
  readInspectorProof,
  sha256File,
} from "./package-proof.mjs";

const exec = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "../../..");

export function assertArm64Architectures(architectures) {
  if (architectures.length !== 1 || architectures[0] !== "arm64") {
    throw new Error(`Unsupported binary architecture: ${architectures.join(", ")}`);
  }
  return "arm64";
}

export function canPromote(evidence) {
  return evidence.signed === true && evidence.notarized === true && evidence.deviceAccepted === true;
}

async function* walk(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walk(file);
    else if (entry.isFile()) yield file;
  }
}

async function assertPackagedInspector(resources, sourceReceipt, teamId) {
  const inspectorDirectory = path.join(resources, "native-inspector", "darwin-arm64");
  const binaryPath = path.join(inspectorDirectory, "ffprobe");
  const buildReceiptPath = path.join(inspectorDirectory, "ffprobe-build.json");
  await fs.access(binaryPath);
  await fs.access(buildReceiptPath);

  const proof = await readInspectorProof(binaryPath, buildReceiptPath);
  const versionResult = await exec(binaryPath, ["-version"]);
  const licenseResult = await exec(binaryPath, ["-L"]);
  const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`;
  const licenseOutput = `${licenseResult.stdout}\n${licenseResult.stderr}`;
  const architectures = (await exec("/usr/bin/lipo", ["-archs", binaryPath])).stdout.trim().split(/\s+/);
  assertInspectorProof({
    proof,
    expectedBinarySha256: sourceReceipt.ffprobeSha256,
    expectedBuildReceiptSha256: sourceReceipt.ffprobeBuildReceiptSha256,
    actualBinarySha256: proof.binarySha256,
    architectures,
    versionOutput,
    licenseOutput,
    allowSignedBinary: Boolean(teamId),
  });

  const licenses = path.join(resources, "LICENSES");
  const noticePath = path.join(licenses, "FFPROBE.md");
  const fullLicensePath = path.join(licenses, "FFPROBE-LGPL-2.1.txt");
  const [noticeText, fullLicenseText] = await Promise.all([
    fs.readFile(noticePath, "utf8"),
    fs.readFile(fullLicensePath, "utf8"),
  ]);
  assertInspectorLicenseNotice(noticeText, fullLicenseText, proof.buildReceipt);
  return { binaryPath, buildReceiptPath, proof, architectures };
}

export async function verifyLicketySplitPackage(appPath, expectedVersion, teamId, options = {}) {
  const sourceRoot = options.sourceRoot ?? defaultRoot;
  if (sourceRoot) {
    // Reject dirty or moved source both before and after package inspection.
    if (readGitSourceStatus(sourceRoot).trim()) {
      throw new Error("Commit tracked and non-ignored untracked source changes before packaging");
    }
  }

  const contents = path.join(appPath, "Contents");
  const plist = path.join(contents, "Info.plist");
  const field = async (name) => (await exec("/usr/bin/plutil", ["-extract", name, "raw", "-o", "-", plist])).stdout.trim();
  const appId = await field("CFBundleIdentifier");
  const version = await field("CFBundleShortVersionString");
  if (appId !== "com.heymrmom.licketysplit.desktop" || version !== expectedVersion) {
    throw new Error("Package identity/version mismatch");
  }
  const minimum = await field("LSMinimumSystemVersion");
  if (Number(minimum.split(".")[0]) < 14) throw new Error("Package must require macOS 14");

  const resources = path.join(contents, "Resources");
  const sourceReceipt = JSON.parse(await fs.readFile(path.join(resources, "BUILD_SOURCE.json"), "utf8"));
  assertSourceReceipt(sourceReceipt, { version: expectedVersion });
  if (sourceRoot) {
    await assertSourceTreeMatchesReceipt(sourceRoot, sourceReceipt, { version: expectedVersion });
    if (sourceReceipt.sourceCommit !== readGitHead(sourceRoot)) {
      throw new Error("Packaged source does not match current commit");
    }
  }

  const ffmpeg = path.join(resources, "bin", "darwin-arm64", "ffmpeg");
  await fs.access(ffmpeg);
  const manifest = JSON.parse(await fs.readFile(path.join(resources, "bin", "MANIFEST.json"), "utf8"));
  const ffmpegSha = await sha256File(ffmpeg);
  const pinnedSha = manifest.binaries?.["darwin-arm64"]?.sha256;
  if (sourceReceipt.ffmpegSourceSha256 !== pinnedSha) throw new Error("Pre-sign FFmpeg source checksum mismatch");
  if (pinnedSha !== ffmpegSha && !teamId) throw new Error("FFmpeg checksum mismatch");

  const inspector = await assertPackagedInspector(resources, sourceReceipt, teamId);
  if (teamId) {
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
    const signature = await exec("/usr/bin/codesign", ["--display", "--verbose=4", appPath]);
    if (!signature.stderr.includes(`TeamIdentifier=${teamId}`)) throw new Error("Signing team mismatch");
    await exec("/usr/bin/xcrun", ["stapler", "validate", appPath]);
    await exec("/usr/sbin/spctl", ["--assess", "--type", "execute", appPath]);
  }

  const licenses = path.join(resources, "LICENSES");
  for (const name of ["FFMPEG.md", "OPENREEL.md", "FFPROBE.md", "FFPROBE-LGPL-2.1.txt"]) {
    await fs.access(path.join(licenses, name));
  }
  if (sourceRoot) {
    for (const relativePath of ["apps/desktop/LICENSES/FFPROBE.md", "apps/desktop/LICENSES/FFPROBE-LGPL-2.1.txt"]) {
      await assertPackagedFileMatchesCommit({
        root: sourceRoot,
        revision: sourceReceipt.sourceCommit,
        relativePath,
        packagedPath: path.join(licenses, path.basename(relativePath)),
      });
    }
  }

  const require = createRequire(import.meta.url);
  const builder = createRequire(require.resolve("electron-builder"));
  const appBuilder = createRequire(builder.resolve("app-builder-lib"));
  const asar = appBuilder("@electron/asar");
  const archive = path.join(resources, "app.asar");
  const files = asar.listPackage(archive);
  for (const required of ["/dist/main/index.js", "/dist/preload/index.js"]) {
    if (!files.includes(required)) throw new Error(`Missing packaged entry ${required}`);
  }
  assertNoPrivatePackagePaths(files);

  const native = [];
  const packagedResources = [];
  for await (const file of walk(contents)) {
    const relative = path.relative(contents, file).replaceAll("\\", "/");
    if (relative.toLowerCase().includes("managed-media/")) {
      throw new Error("Private data found in package: managed-media/");
    }
    packagedResources.push(relative);
    const result = await exec("/usr/bin/file", ["-b", file]);
    if (result.stdout.includes("Mach-O")) {
      if (teamId) {
        await exec("/usr/bin/codesign", ["--verify", "--strict", file]);
        const signature = await exec("/usr/bin/codesign", ["--display", "--verbose=4", file]);
        if (!signature.stderr.includes(`TeamIdentifier=${teamId}`)) throw new Error("Nested executable signing team mismatch");
      }
      const architectures = (await exec("/usr/bin/lipo", ["-archs", file])).stdout.trim().split(/\s+/);
      assertArm64Architectures(architectures);
      native.push({ file: relative, sha256: await sha256File(file) });
    }
  }
  assertNoPrivatePackagePaths(packagedResources);
  if (!native.some((row) => row.file.startsWith("MacOS/"))) throw new Error("Missing app executable");

  const archiveSha = await sha256File(archive);
  const digest = createHash("sha256").update(JSON.stringify(native)).update(archiveSha).digest("hex");
  if (sourceRoot) await assertSourceTreeMatchesReceipt(sourceRoot, sourceReceipt, { version: expectedVersion });
  return {
    sourceCommit: sourceReceipt.sourceCommit,
    architecture: "arm64",
    appId,
    version,
    sha256: digest,
    ffmpegSha256: ffmpegSha,
    ffmpegSourceSha256: sourceReceipt.ffmpegSourceSha256,
    ffprobeSha256: inspector.proof.binarySha256,
    ffprobeSourceSha256: sourceReceipt.ffprobeSha256,
    ffprobeBuildReceiptSha256: inspector.proof.buildReceiptSha256,
    native,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const app = valueAfter("--app");
  const version = valueAfter("--version");
  const teamId = valueAfter("--team");
  const sourceRoot = path.resolve(valueAfter("--source-root") ?? defaultRoot);
  if (!app || !version) throw new Error("Use --app /path/LicketySplit.app --version VERSION [--team TEAM_ID] [--source-root REPO] [--out build-manifest.json]");

  const receipt = await verifyLicketySplitPackage(app, version, teamId, { sourceRoot });
  const report = {
    schemaVersion: 2,
    repository: "heymrmom/LicketySplit",
    sourceCommit: receipt.sourceCommit,
    verifiedAt: new Date().toISOString(),
    node: process.version,
    pnpm: (await exec("pnpm", ["--version"])).stdout.trim(),
    signing: teamId ? "signed-notarized" : "unsigned-test-unverified",
    ...(teamId ? { teamId } : {}),
    ...receipt,
  };
  const output = valueAfter("--out");
  if (output) await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();
