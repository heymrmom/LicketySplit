import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyProtectedKeyFile } from "../src/main/identity-migration";

describe("protected identity file migration", () => {
  let root = "";
  let sourcePath = "";
  let destinationPath = "";
  let sourceBytes: Buffer;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "licketysplit-identity-migration-"));
    sourcePath = path.join(root, "openreel-keys.json");
    destinationPath = path.join(root, "licketysplit-keys.json");
    sourceBytes = Buffer.from('{"apiKey":"encrypted-base64-value","note":"bytes stay exact"}\n');
    await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("copies protected bytes exactly and leaves the source file in place", async () => {
    await expect(copyProtectedKeyFile(sourcePath, destinationPath)).resolves.toEqual({ status: "copied", bytesCopied: sourceBytes.length });
    await expect(readFile(destinationPath)).resolves.toEqual(sourceBytes);
    await expect(readFile(sourcePath)).resolves.toEqual(sourceBytes);
  });

  it("keeps an existing destination value and identifies identical prior copies", async () => {
    const newerBytes = Buffer.from('{"other":"encrypted-v2"}\n');
    await writeFile(destinationPath, newerBytes, { mode: 0o600 });
    await expect(copyProtectedKeyFile(sourcePath, destinationPath)).resolves.toEqual({ status: "destination-wins", bytesCopied: 0, sourceState: "different" });
    await expect(readFile(destinationPath)).resolves.toEqual(newerBytes);

    await writeFile(destinationPath, sourceBytes, { mode: 0o600 });
    await expect(copyProtectedKeyFile(sourcePath, destinationPath)).resolves.toEqual({ status: "already-present", bytesCopied: 0 });
  });

  it("uses a valid destination when stale legacy key bytes are unreadable", async () => {
    const currentBytes = Buffer.from('{"apiKey":"destination-encrypted-value"}\n');
    const staleBytes = Buffer.from("not valid protected key JSON\n");
    await writeFile(destinationPath, currentBytes, { mode: 0o600 });
    await writeFile(sourcePath, staleBytes, { mode: 0o600 });

    await expect(copyProtectedKeyFile(sourcePath, destinationPath)).resolves.toEqual({
      status: "destination-wins",
      bytesCopied: 0,
      sourceState: "unreadable",
    });
    await expect(readFile(sourcePath)).resolves.toEqual(staleBytes);
    await expect(readFile(destinationPath)).resolves.toEqual(currentBytes);
  });

  it("reports an absent legacy file without touching the destination", async () => {
    await rm(sourcePath);
    await expect(copyProtectedKeyFile(sourcePath, destinationPath)).resolves.toEqual({ status: "source-missing", bytesCopied: 0 });
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves no partial destination or temporary file when the destination directory is unavailable", async () => {
    const missingDirectory = path.join(root, "not-created");
    const impossibleDestination = path.join(missingDirectory, "licketysplit-keys.json");
    await expect(copyProtectedKeyFile(sourcePath, impossibleDestination)).rejects.toBeInstanceOf(Error);
    await expect(readFile(sourcePath)).resolves.toEqual(sourceBytes);
    await expect(readdir(missingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an unreadable legacy key object and preserves its exact bytes", async () => {
    const corruptBytes = Buffer.from('{"assemblyai":7}\n');
    await writeFile(sourcePath, corruptBytes, { mode: 0o600 });

    await expect(copyProtectedKeyFile(sourcePath, destinationPath)).rejects.toThrow("valid encrypted-key object");
    await expect(readFile(sourcePath)).resolves.toEqual(corruptBytes);
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not accept or replace an unreadable destination key object", async () => {
    const corruptBytes = Buffer.from("[]\n");
    await writeFile(destinationPath, corruptBytes, { mode: 0o600 });

    await expect(copyProtectedKeyFile(sourcePath, destinationPath)).rejects.toThrow("valid encrypted-key object");
    await expect(readFile(sourcePath)).resolves.toEqual(sourceBytes);
    await expect(readFile(destinationPath)).resolves.toEqual(corruptBytes);
  });
});
