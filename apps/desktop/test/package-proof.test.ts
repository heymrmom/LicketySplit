import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Package proof helpers are standalone ESM scripts.
import {
  assertInspectorProof,
  assertInspectorLicenseNotice,
  assertPackagedAssetMatchesSha256,
  assertNoPrivatePackagePaths,
  assertRequiredAsarEntries,
  assertSourceTreeMatchesReceipt,
  digestPackageTree,
  isForbiddenPrivatePackagePath,
  readGitHead,
  REQUIRED_ASAR_ENTRIES,
  sha256Bytes,
} from "../scripts/package-proof.mjs";
// @ts-expect-error The source receipt writer is an executable ESM script.
import { buildSourceReceipt } from "../scripts/write-source-receipt.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeSourceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "licketysplit-package-proof-"));
  temporaryRoots.push(root);
  const put = async (relativePath: string, contents: string | Buffer) => {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
    return filePath;
  };

  const ffmpeg = Buffer.from("synthetic pinned ffmpeg");
  const ffprobe = Buffer.from("synthetic metadata-only ffprobe");
  const ffprobeBuildReceipt = {
    version: "9.0.1",
    sourceUrl: "https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz",
    sourceSha256: "a".repeat(64),
    arch: "arm64",
    license: "LGPL-2.1-or-later",
    sha256: sha256Bytes(ffprobe),
  };
  await put(".gitignore", "apps/desktop/resources/BUILD_SOURCE.json\n");
  await put("apps/desktop/package.json", JSON.stringify({ version: "0.1.0-alpha.2" }));
  await put("apps/desktop/resources/bin/darwin-arm64/ffmpeg", ffmpeg);
  await put("apps/desktop/resources/bin/MANIFEST.json", JSON.stringify({
    binaries: { "darwin-arm64": { sha256: sha256Bytes(ffmpeg) } },
  }));
  await put("apps/desktop/resources/native-inspector/darwin-arm64/ffprobe", ffprobe);
  await put("apps/desktop/resources/native-inspector/darwin-arm64/ffprobe-build.json", JSON.stringify(ffprobeBuildReceipt));
  await put("apps/desktop/LICENSES/FFPROBE.md", "FFprobe 9.0.1\n" + ffprobeBuildReceipt.sourceSha256 + "\n" + ffprobeBuildReceipt.sha256 + "\nFFPROBE-LGPL-2.1.txt\n");
  await put("apps/desktop/LICENSES/FFPROBE-LGPL-2.1.txt", "GNU Lesser General Public License version 2.1");
  await put("apps/desktop/build/licketysplit.icns", Buffer.from("original app icon"));
  await put("apps/web/public/icons/licketysplit-mark.png", Buffer.from("renderer icon"));

  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Package Proof Test", "-c", "user.email=package-proof@example.invalid", "commit", "-qm", "package source fixture"], { cwd: root });
  return { root, put, ffprobe, ffprobeBuildReceipt };
}

describe("package source proof", () => {
  it("receipts the exact clean source, inspector, and original icon inputs", async () => {
    const fixture = await makeSourceFixture();
    const receipt = await buildSourceReceipt(fixture.root);
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      version: "0.1.0-alpha.2",
      sourceCommit: readGitHead(fixture.root),
      ffprobeSha256: sha256Bytes(fixture.ffprobe),
      ffprobeBuildReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      originalIconSourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      rendererMarkSourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    await writeFile(path.join(fixture.root, "apps/desktop/resources/BUILD_SOURCE.json"), "generated receipt");
    await expect(buildSourceReceipt(fixture.root)).resolves.toMatchObject({ sourceCommit: receipt.sourceCommit });
    expect(await readFile(path.join(fixture.root, "apps/desktop/resources/BUILD_SOURCE.json"), "utf8")).toBe("generated receipt");
  });

  it.each([
    ["tracked edits", async (fixture: Awaited<ReturnType<typeof makeSourceFixture>>) => {
      await writeFile(path.join(fixture.root, "apps/desktop/package.json"), "changed");
    }],
    ["non-ignored untracked source", async (fixture: Awaited<ReturnType<typeof makeSourceFixture>>) => {
      await fixture.put("apps/desktop/src/untracked.ts", "export {};");
    }],
  ])("rejects %s before receipt generation", async (_name, dirty) => {
    const fixture = await makeSourceFixture();
    await dirty(fixture);
    await expect(buildSourceReceipt(fixture.root)).rejects.toThrow(/tracked and non-ignored untracked source/);
  });

  it("rejects missing or changed inspector binaries against the committed build receipt", async () => {
    const missing = await makeSourceFixture();
    await rm(path.join(missing.root, "apps/desktop/resources/native-inspector/darwin-arm64/ffprobe"));
    execFileSync("git", ["add", "-A"], { cwd: missing.root });
    execFileSync("git", ["-c", "user.name=Package Proof Test", "-c", "user.email=package-proof@example.invalid", "commit", "-qm", "remove inspector"], { cwd: missing.root });
    await expect(buildSourceReceipt(missing.root)).rejects.toThrow();

    const changed = await makeSourceFixture();
    await writeFile(path.join(changed.root, "apps/desktop/resources/native-inspector/darwin-arm64/ffprobe"), "tampered inspector");
    execFileSync("git", ["add", "-A"], { cwd: changed.root });
    execFileSync("git", ["-c", "user.name=Package Proof Test", "-c", "user.email=package-proof@example.invalid", "commit", "-qm", "tamper inspector"], { cwd: changed.root });
    await expect(buildSourceReceipt(changed.root)).rejects.toThrow(/pre-sign checksum/);
  });

  it("checks source-tree receipt identity and provenance again during package verification", async () => {
    const fixture = await makeSourceFixture();
    const receipt = await buildSourceReceipt(fixture.root);
    await expect(assertSourceTreeMatchesReceipt(fixture.root, receipt, { version: receipt.version })).resolves.toBeUndefined();
    await writeFile(path.join(fixture.root, "apps/web/public/icons/licketysplit-mark.png"), "changed icon");
    await expect(assertSourceTreeMatchesReceipt(fixture.root, receipt)).rejects.toThrow(/Commit tracked/);
  });

  it("rejects a package receipt after the source HEAD advances", async () => {
    const fixture = await makeSourceFixture();
    const receipt = await buildSourceReceipt(fixture.root);
    await writeFile(path.join(fixture.root, "apps/desktop/package.json"), JSON.stringify({ version: "0.1.0-alpha.3" }));
    execFileSync("git", ["add", "-A"], { cwd: fixture.root });
    execFileSync("git", ["-c", "user.name=Package Proof Test", "-c", "user.email=package-proof@example.invalid", "commit", "-qm", "advance source"], { cwd: fixture.root });
    await expect(assertSourceTreeMatchesReceipt(fixture.root, receipt)).rejects.toThrow(/current commit/);
  });
});

describe("packaged private-file and inspector checks", () => {
  it("requires the dedicated migration preload inside the packaged ASAR", () => {
    expect(REQUIRED_ASAR_ENTRIES).toContain("/dist/preload/migration-reader.js");
    expect(() => assertRequiredAsarEntries(REQUIRED_ASAR_ENTRIES)).not.toThrow();
    expect(() => assertRequiredAsarEntries(REQUIRED_ASAR_ENTRIES.filter((entry) => !entry.includes("migration-reader"))))
      .toThrow(/migration-reader/);
  });

  it("compares packaged icon and renderer files to receipt hashes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "licketysplit-packaged-assets-"));
    temporaryRoots.push(root);
    const asset = path.join(root, "icon.icns");
    const expected = Buffer.from("source icon bytes");
    await writeFile(asset, expected);
    await expect(assertPackagedAssetMatchesSha256({
      packagedPath: asset,
      expectedSha256: sha256Bytes(expected),
      label: "CFBundleIconFile",
    })).resolves.toBe(sha256Bytes(expected));
    await writeFile(asset, "tampered icon bytes");
    await expect(assertPackagedAssetMatchesSha256({
      packagedPath: asset,
      expectedSha256: sha256Bytes(expected),
      label: "CFBundleIconFile",
    })).rejects.toThrow(/CFBundleIconFile/);
  });

  it("digests every sorted package path, file byte, mode, and symlink target deterministically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "licketysplit-package-tree-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "Resources"));
    await writeFile(path.join(root, "z-last.txt"), "last");
    await writeFile(path.join(root, "Resources", "icon.icns"), "icon");
    await chmod(path.join(root, "Resources", "icon.icns"), 0o751);
    await symlink("Resources/icon.icns", path.join(root, "icon-link.icns"));

    const first = await digestPackageTree(root);
    const second = await digestPackageTree(root);
    expect(second.sha256).toBe(first.sha256);
    expect(first.entries.map((entry) => entry.path)).toEqual([
      ".", "Resources", "Resources/icon.icns", "icon-link.icns", "z-last.txt",
    ]);
    expect(first.entries.find((entry) => entry.path === "Resources/icon.icns")).toMatchObject({ type: "file", mode: 0o751 });
    expect(first.entries.find((entry) => entry.path === "icon-link.icns")).toMatchObject({ type: "symlink", target: "Resources/icon.icns" });
    expect(first).toMatchObject({ fileCount: 2, directoryCount: 2, symlinkCount: 1 });

    await chmod(path.join(root, "Resources", "icon.icns"), 0o644);
    expect((await digestPackageTree(root)).sha256).not.toBe(first.sha256);
    await writeFile(path.join(root, "z-last.txt"), "changed");
    expect((await digestPackageTree(root)).sha256).not.toBe(first.sha256);
  });

  it("excludes old and new private key/project file names while retaining the named license exception", () => {
    const privatePaths = [
      "Contents/Resources/openreel-keys.json",
      "Contents/Resources/licketysplit-keys.json",
      "Contents/Resources/identity.p12",
      "Contents/Resources/signing.pfx",
      "Contents/Resources/id.pem",
      "Contents/Resources/session.key",
      "Contents/Resources/source.openreel",
      "Contents/Resources/source.oreel",
      "Contents/Resources/source.licketysplit",
      "Contents/Resources/jobs.json",
      "Contents/Resources/assets.json",
      "Contents/Resources/publishing-manifest.json",
    ];
    for (const file of privatePaths) expect(isForbiddenPrivatePackagePath(file), file).toBe(true);
    expect(isForbiddenPrivatePackagePath("Contents/Resources/LICENSES/OPENREEL.md")).toBe(false);
    expect(() => assertNoPrivatePackagePaths(privatePaths)).toThrow(/Private data found/);
  });

  it("requires arm64, a matching pre-sign hash, a runnable version, and LGPL 2.1", () => {
    const binary = Buffer.from("ffprobe bytes");
    const buildReceipt = {
      version: "9.0.1",
      sourceSha256: "a".repeat(64),
      arch: "arm64",
      license: "LGPL-2.1-or-later",
      sha256: sha256Bytes(binary),
    };
    const proof = {
      buildReceipt,
      buildReceiptSha256: "b".repeat(64),
      binarySha256: sha256Bytes(binary),
    };
    const valid = {
      proof,
      expectedBinarySha256: buildReceipt.sha256,
      expectedBuildReceiptSha256: proof.buildReceiptSha256,
      actualBinarySha256: proof.binarySha256,
      architectures: ["arm64"],
      versionOutput: "ffprobe version 9.0.1",
      licenseOutput: "GNU Lesser General Public License version 2.1 or later",
    };
    expect(() => assertInspectorProof(valid)).not.toThrow();
    expect(() => assertInspectorProof({ ...valid, architectures: ["x86_64"] })).toThrow(/architecture/);
    expect(() => assertInspectorProof({ ...valid, actualBinarySha256: "0".repeat(64) })).toThrow(/checksum mismatch/);
    expect(() => assertInspectorProof({ ...valid, licenseOutput: "GPL version 3" })).toThrow(/LGPL 2.1/);
    expect(() => assertInspectorLicenseNotice(
      `FFprobe 9.0.1 ${buildReceipt.sourceSha256} ${buildReceipt.sha256} FFPROBE-LGPL-2.1.txt`,
      "GNU Lesser General Public License version 2.1",
      buildReceipt,
    )).not.toThrow();
    expect(() => assertInspectorLicenseNotice("FFprobe 9.0.1", "missing", buildReceipt)).toThrow(/provenance/);
  });
});
