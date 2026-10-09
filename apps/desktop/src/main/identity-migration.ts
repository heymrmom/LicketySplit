import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type ProtectedKeyCopyResult =
  | { status: "copied" | "already-present" | "destination-wins"; bytesCopied: number }
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

/**
 * Copy an encrypted OS-safe-storage key file without decrypting, rewriting, or removing the source.
 * The destination parent directory must already exist (Electron's userData directory does).
 * A same-directory hard link publishes the fully synced temporary file atomically and refuses overwrite.
 */
export async function copyProtectedKeyFile(sourcePath: string, destinationPath: string): Promise<ProtectedKeyCopyResult> {
  const sourceBytes = await existingFileBytes(sourcePath);
  if (!sourceBytes) return { status: "source-missing", bytesCopied: 0 };

  const currentDestination = await existingFileBytes(destinationPath);
  if (currentDestination) {
    return {
      status: currentDestination.equals(sourceBytes) ? "already-present" : "destination-wins",
      bytesCopied: 0,
    };
  }

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
      return {
        status: racedDestination?.equals(sourceBytes) ? "already-present" : "destination-wins",
        bytesCopied: 0,
      };
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
