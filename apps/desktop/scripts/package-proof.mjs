import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Hashes a canonical manifest of every path below a package root (directories, files, and symlinks). */
export async function digestPackageTree(root) {
  const entries = [];
  const addTree = async (directory, relativeDirectory) => {
    const names = (await fs.readdir(directory)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const name of names) {
      const filePath = path.join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat = await fs.lstat(filePath);
      const mode = stat.mode & 0o7777;
      if (stat.isDirectory()) {
        entries.push({ path: relativePath, type: "directory", mode });
        await addTree(filePath, relativePath);
      } else if (stat.isFile()) {
        entries.push({ path: relativePath, type: "file", mode, size: stat.size, sha256: await sha256File(filePath) });
      } else if (stat.isSymbolicLink()) {
        entries.push({ path: relativePath, type: "symlink", target: await fs.readlink(filePath) });
      } else {
        throw new Error(`Unsupported special file in package tree: ${relativePath}`);
      }
    }
  };

  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory()) throw new Error("Package tree root must be a directory");
  entries.push({ path: ".", type: "directory", mode: rootStat.mode & 0o7777 });
  await addTree(root, "");
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const fileCount = entries.filter((entry) => entry.type === "file").length;
  const directoryCount = entries.filter((entry) => entry.type === "directory").length;
  const symlinkCount = entries.filter((entry) => entry.type === "symlink").length;
  return {
    sha256: sha256Bytes(JSON.stringify(entries)),
    entries,
    fileCount,
    directoryCount,
    symlinkCount,
  };
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assertCleanSourceStatus(statusText) {
  if (statusText.trim()) {
    throw new Error("Commit tracked and non-ignored untracked source changes before packaging");
  }
}

export function readGitSourceStatus(root) {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
}

export function readGitHead(root) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

export function readGitBlob(root, revision, relativePath) {
  return execFileSync("git", ["show", `${revision}:${relativePath}`], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
}

export async function assertTrackedAssetMatchesCommit({ root, revision, relativePath, expectedSha256 }) {
  const localSha256 = await sha256File(path.join(root, relativePath));
  if (localSha256 !== expectedSha256) {
    throw new Error(`Source asset differs from receipt: ${relativePath}`);
  }
  const committedSha256 = sha256Bytes(readGitBlob(root, revision, relativePath));
  if (committedSha256 !== expectedSha256) {
    throw new Error(`Source asset does not match committed source: ${relativePath}`);
  }
}

export async function assertPackagedFileMatchesCommit({ root, revision, relativePath, packagedPath }) {
  const sourcePath = path.join(root, relativePath);
  const sourceSha256 = await sha256File(sourcePath);
  await assertTrackedAssetMatchesCommit({ root, revision, relativePath, expectedSha256: sourceSha256 });
  if (await sha256File(packagedPath) !== sourceSha256) {
    throw new Error(`Packaged license differs from committed source: ${relativePath}`);
  }
}

export async function assertPackagedAssetMatchesSha256({ packagedPath, expectedSha256, label }) {
  const actualSha256 = await sha256File(packagedPath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Packaged ${label ?? "asset"} differs from its source receipt`);
  }
  return actualSha256;
}

export const REQUIRED_ASAR_ENTRIES = [
  "/dist/main/index.js",
  "/dist/preload/index.js",
  "/dist/preload/migration-reader.js",
];

export function assertRequiredAsarEntries(files) {
  for (const required of REQUIRED_ASAR_ENTRIES) {
    if (!files.includes(required)) throw new Error(`Missing packaged entry ${required}`);
  }
}

export async function readInspectorProof(binaryPath, buildReceiptPath) {
  const receiptBytes = await fs.readFile(buildReceiptPath);
  return {
    buildReceipt: JSON.parse(receiptBytes.toString("utf8")),
    buildReceiptSha256: sha256Bytes(receiptBytes),
    binarySha256: await sha256File(binaryPath),
  };
}

export function assertInspectorBuildReceipt({ proof, expectedBinarySha256, expectedBuildReceiptSha256 }) {
  const receipt = proof.buildReceipt;
  if (!receipt || receipt.arch !== "arm64") throw new Error("Native inspector build receipt must target arm64");
  if (!/^\d+\.\d+\.\d+$/.test(receipt.version ?? "")) throw new Error("Native inspector version is missing or invalid");
  if (receipt.license !== "LGPL-2.1-or-later") throw new Error("Unexpected native inspector license metadata");
  if (!SHA256.test(receipt.sourceSha256 ?? "")) throw new Error("Native inspector source provenance checksum is missing or invalid");
  if (!SHA256.test(receipt.sha256 ?? "") || receipt.sha256 !== expectedBinarySha256) {
    throw new Error("Native inspector pre-sign checksum does not match source receipt");
  }
  if (proof.buildReceiptSha256 !== expectedBuildReceiptSha256) {
    throw new Error("Native inspector provenance receipt checksum mismatch");
  }
}

export function assertInspectorProof({
  proof,
  expectedBinarySha256,
  expectedBuildReceiptSha256,
  actualBinarySha256 = proof.binarySha256,
  architectures,
  versionOutput,
  licenseOutput,
  allowSignedBinary = false,
}) {
  assertInspectorBuildReceipt({ proof, expectedBinarySha256, expectedBuildReceiptSha256 });
  if (!architectures || architectures.length !== 1 || architectures[0] !== "arm64") {
    throw new Error(`Unsupported native inspector architecture: ${architectures?.join(", ") ?? "unknown"}`);
  }
  if (!versionOutput?.includes(`ffprobe version ${proof.buildReceipt.version}`)) {
    throw new Error("Packaged native inspector version does not match build receipt");
  }
  const license = licenseOutput?.toLowerCase().replace(/\s+/g, " ") ?? "";
  if (!license.includes("gnu lesser general public license") || !license.includes("version 2.1")) {
    throw new Error("Packaged native inspector does not report LGPL 2.1");
  }
  if (!allowSignedBinary && actualBinarySha256 !== expectedBinarySha256) {
    throw new Error("Packaged native inspector checksum mismatch");
  }
}

export function assertSourceReceipt(receipt, { version, sourceCommit } = {}) {
  if (receipt?.schemaVersion !== 2) throw new Error("Unsupported source receipt schema");
  if (!receipt || !COMMIT.test(receipt.sourceCommit ?? "")) throw new Error("Missing packaged source identity");
  if (sourceCommit && receipt.sourceCommit !== sourceCommit) throw new Error("Packaged source does not match current commit");
  if (typeof receipt.version !== "string" || (version && receipt.version !== version)) {
    throw new Error("Packaged source version mismatch");
  }
  for (const field of [
    "ffmpegSourceSha256",
    "ffprobeSha256",
    "ffprobeBuildReceiptSha256",
    "originalIconSourceSha256",
    "rendererMarkSourceSha256",
  ]) {
    if (!SHA256.test(receipt[field] ?? "")) throw new Error(`Missing or invalid source receipt field: ${field}`);
  }
}

export async function assertOriginalAssetProvenance({ root, receipt }) {
  const assets = [
    ["apps/desktop/build/licketysplit.icns", receipt.originalIconSourceSha256],
    ["apps/web/public/icons/licketysplit-mark.png", receipt.rendererMarkSourceSha256],
  ];
  for (const [relativePath, expectedSha256] of assets) {
    await assertTrackedAssetMatchesCommit({
      root,
      revision: receipt.sourceCommit,
      relativePath,
      expectedSha256,
    });
  }
}

export async function assertSourceTreeMatchesReceipt(root, receipt, { version } = {}) {
  assertCleanSourceStatus(readGitSourceStatus(root));
  const sourceCommit = readGitHead(root);
  assertSourceReceipt(receipt, { version, sourceCommit });
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "apps/desktop/package.json"), "utf8"));
  if (packageJson.version !== receipt.version) throw new Error("Current source package version differs from receipt");

  const ffmpegPath = path.join(root, "apps/desktop/resources/bin/darwin-arm64/ffmpeg");
  const ffmpegManifest = JSON.parse(await fs.readFile(path.join(root, "apps/desktop/resources/bin/MANIFEST.json"), "utf8"));
  const ffmpegSha256 = await sha256File(ffmpegPath);
  if (ffmpegSha256 !== receipt.ffmpegSourceSha256
    || ffmpegManifest.binaries?.["darwin-arm64"]?.sha256 !== receipt.ffmpegSourceSha256) {
    throw new Error("Current source FFmpeg does not match packaged receipt");
  }

  const inspectorDirectory = path.join(root, "apps/desktop/resources/native-inspector/darwin-arm64");
  const inspectorProof = await readInspectorProof(
    path.join(inspectorDirectory, "ffprobe"),
    path.join(inspectorDirectory, "ffprobe-build.json"),
  );
  assertInspectorBuildReceipt({
    proof: inspectorProof,
    expectedBinarySha256: receipt.ffprobeSha256,
    expectedBuildReceiptSha256: receipt.ffprobeBuildReceiptSha256,
  });
  await assertOriginalAssetProvenance({ root, receipt });
}

export function assertNoPrivatePackagePaths(filePaths) {
  const forbidden = filePaths.filter(isForbiddenPrivatePackagePath);
  if (forbidden.length > 0) throw new Error(`Private data found in package: ${forbidden[0]}`);
}

export function assertInspectorLicenseNotice(noticeText, fullLicenseText, receipt) {
  if (!noticeText.includes(`FFprobe ${receipt.version}`)
    || !noticeText.includes(receipt.sourceSha256)
    || !noticeText.includes(receipt.sha256)
    || !noticeText.includes("FFPROBE-LGPL-2.1.txt")) {
    throw new Error("Packaged FFprobe license notice is missing source or binary provenance");
  }
  const fullLicense = fullLicenseText.toLowerCase().replace(/\s+/g, " ");
  if (!fullLicense.includes("gnu lesser general public license") || !fullLicense.includes("version 2.1")) {
    throw new Error("Packaged FFprobe LGPL 2.1 license text is missing or invalid");
  }
}

export function isForbiddenPrivatePackagePath(filePath) {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
  if (normalized === "licenses/openreel.md" || normalized === "resources/licenses/openreel.md") return false;
  return /(^|\/)(\.env(?:\..*)?|.*\.(?:p12|pfx|pem|key)|(?:openreel|licketysplit)-keys\.json|assets\.json|jobs\.json|publishing-manifest\.json)$/i.test(normalized)
    || /\.(?:oreel|openreel|licketysplit)$/i.test(normalized);
}
