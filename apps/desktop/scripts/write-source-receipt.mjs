#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCleanSourceStatus,
  assertInspectorBuildReceipt,
  assertTrackedAssetMatchesCommit,
  readGitHead,
  readGitSourceStatus,
  readInspectorProof,
  sha256File,
} from "./package-proof.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "../../..");

export async function buildSourceReceipt(root = defaultRoot) {
  assertCleanSourceStatus(readGitSourceStatus(root));
  const sourceCommit = readGitHead(root);
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "apps/desktop/package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || !packageJson.version) {
    throw new Error("Desktop package version is missing");
  }

  const ffmpegPath = path.join(root, "apps/desktop/resources/bin/darwin-arm64/ffmpeg");
  const ffmpegManifestPath = path.join(root, "apps/desktop/resources/bin/MANIFEST.json");
  const ffmpegSourceSha256 = await sha256File(ffmpegPath);
  const ffmpegManifest = JSON.parse(await fs.readFile(ffmpegManifestPath, "utf8"));
  if (ffmpegManifest.binaries?.["darwin-arm64"]?.sha256 !== ffmpegSourceSha256) {
    throw new Error("FFmpeg binary does not match its committed source manifest");
  }
  const inspectorBinary = path.join(root, "apps/desktop/resources/native-inspector/darwin-arm64/ffprobe");
  const inspectorReceipt = path.join(root, "apps/desktop/resources/native-inspector/darwin-arm64/ffprobe-build.json");
  const inspectorProof = await readInspectorProof(inspectorBinary, inspectorReceipt);
  assertInspectorBuildReceipt({
    proof: inspectorProof,
    expectedBinarySha256: inspectorProof.binarySha256,
    expectedBuildReceiptSha256: inspectorProof.buildReceiptSha256,
  });

  for (const relativePath of [
    "apps/desktop/resources/native-inspector/darwin-arm64/ffprobe",
    "apps/desktop/resources/native-inspector/darwin-arm64/ffprobe-build.json",
    "apps/desktop/LICENSES/FFPROBE.md",
    "apps/desktop/LICENSES/FFPROBE-LGPL-2.1.txt",
  ]) {
    await assertTrackedAssetMatchesCommit({
      root,
      revision: sourceCommit,
      relativePath,
      expectedSha256: await sha256File(path.join(root, relativePath)),
    });
  }

  const originalIconSourceSha256 = await sha256File(path.join(root, "apps/desktop/build/licketysplit.icns"));
  const rendererMarkSourceSha256 = await sha256File(path.join(root, "apps/web/public/icons/licketysplit-mark.png"));
  await assertTrackedAssetMatchesCommit({
    root,
    revision: sourceCommit,
    relativePath: "apps/desktop/build/licketysplit.icns",
    expectedSha256: originalIconSourceSha256,
  });
  await assertTrackedAssetMatchesCommit({
    root,
    revision: sourceCommit,
    relativePath: "apps/web/public/icons/licketysplit-mark.png",
    expectedSha256: rendererMarkSourceSha256,
  });

  // Recheck before emitting the receipt. The receipt itself is ignored by git.
  assertCleanSourceStatus(readGitSourceStatus(root));
  return {
    schemaVersion: 2,
    repository: "heymrmom/LicketySplit",
    version: packageJson.version,
    sourceCommit,
    ffmpegSourceSha256,
    ffprobeSha256: inspectorProof.binarySha256,
    ffprobeBuildReceiptSha256: inspectorProof.buildReceiptSha256,
    originalIconSourceSha256,
    rendererMarkSourceSha256,
  };
}

async function main() {
  const receipt = await buildSourceReceipt();
  const destination = path.join(defaultRoot, "apps/desktop/resources/BUILD_SOURCE.json");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
