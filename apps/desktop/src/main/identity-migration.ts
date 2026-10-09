import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type ProtectedKeyCopyResult =
  | { status: "copied" | "already-present"; bytesCopied: number }
  | { status: "destination-wins"; bytesCopied: 0; sourceState: "different" | "unreadable" | "missing" }
  | { status: "source-missing"; bytesCopied: 0 };

async function existingFileBytes(filePath: string): Promise<Buffer | undefined> {
  try {
    const info = await fs.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Identity migration expected a regular file at ${filePath}.`);
    }
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows does not support opening directories for fsync through Node's file API.
    if (process.platform === "win32" && ["EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")) return;
    throw error;
  } finally {
    await handle?.close();
  }
}

function validateEncryptedKeyFile(bytes: Buffer, filePath: string): void {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Protected key storage at ${filePath} is unreadable JSON; its original bytes were preserved.`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error(`Protected key storage at ${filePath} is not a valid encrypted-key object; its original bytes were preserved.`);
  }
}

/**
 * Copy an encrypted OS-safe-storage key file without decrypting, rewriting, or removing the source.
 * The destination parent directory must already exist (Electron's userData directory does).
 * A same-directory hard link publishes the fully synced temporary file atomically and refuses overwrite.
 */
export async function copyProtectedKeyFile(sourcePath: string, destinationPath: string): Promise<ProtectedKeyCopyResult> {
  const currentDestination = await existingFileBytes(destinationPath);
  if (currentDestination) validateEncryptedKeyFile(currentDestination, destinationPath);

  let sourceBytes: Buffer | undefined;
  try { sourceBytes = await existingFileBytes(sourcePath); }
  catch (error) {
    if (!currentDestination) throw error;
    return { status: "destination-wins", bytesCopied: 0, sourceState: "unreadable" };
  }

  if (currentDestination) {
    if (!sourceBytes) return { status: "destination-wins", bytesCopied: 0, sourceState: "missing" };
    try { validateEncryptedKeyFile(sourceBytes, sourcePath); }
    catch { return { status: "destination-wins", bytesCopied: 0, sourceState: "unreadable" }; }
    return currentDestination.equals(sourceBytes)
      ? { status: "already-present", bytesCopied: 0 }
      : { status: "destination-wins", bytesCopied: 0, sourceState: "different" };
  }

  if (!sourceBytes) return { status: "source-missing", bytesCopied: 0 };
  validateEncryptedKeyFile(sourceBytes, sourcePath);

  const directory = path.dirname(destinationPath);
  const temporaryPath = path.join(directory, `.${path.basename(destinationPath)}.migration-${randomUUID()}.tmp`);
  let temporaryHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    temporaryHandle = await fs.open(temporaryPath, "wx", 0o600);
    await temporaryHandle.writeFile(sourceBytes);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    try {
      await fs.link(temporaryPath, destinationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const racedDestination = await existingFileBytes(destinationPath);
      if (!racedDestination) throw new Error(`Protected key destination disappeared during migration: ${destinationPath}.`);
      validateEncryptedKeyFile(racedDestination, destinationPath);
      if (racedDestination.equals(sourceBytes)) return { status: "already-present", bytesCopied: 0 };
      return { status: "destination-wins", bytesCopied: 0, sourceState: "different" };
    }

    await syncDirectory(directory);
    return { status: "copied", bytesCopied: sourceBytes.length };
  } finally {
    await temporaryHandle?.close();
    await fs.unlink(temporaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
