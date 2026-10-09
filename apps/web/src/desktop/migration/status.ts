import { IdentityStorageMigrationError, type LocalStoragePort } from "./storage-copy";
import { IDENTITY_MIGRATION_STATUS_KEY, parseMigrationStatus } from "./transport-protocol";

export type UnavailableMigrationRecords = Array<{ databaseName: string; storeName: string }>;

export function readMigrationStatus(storage: Pick<Storage, "getItem">) {
  return parseMigrationStatus(storage.getItem(IDENTITY_MIGRATION_STATUS_KEY));
}

export function recordMigrationComplete(storage: LocalStoragePort, unavailable: UnavailableMigrationRecords, completedAt = Date.now()): void {
  if (unavailable.length) throw new IdentityStorageMigrationError("Migration cannot be marked complete while source records are still unavailable.");
  writeAndVerify(storage, { status: "complete", version: 1, completedAt });
}

export function acceptIncompleteMigration(storage: LocalStoragePort, unavailable: UnavailableMigrationRecords, acceptedAt = Date.now()): void {
  if (!unavailable.length || unavailable.some((entry) => !entry.databaseName || !entry.storeName)) {
    throw new IdentityStorageMigrationError("Relink acceptance requires the list of unavailable source records.");
  }
  const unique = [...new Map(unavailable.map((entry) => [`${entry.databaseName}\0${entry.storeName}`, entry])).values()];
  writeAndVerify(storage, { status: "accepted-incomplete", version: 1, acceptedAt, unavailable: unique });
}

function writeAndVerify(storage: LocalStoragePort, value: Record<string, unknown>): void {
  const serialized = JSON.stringify(value);
  try {
    storage.setItem(IDENTITY_MIGRATION_STATUS_KEY, serialized);
    if (storage.getItem(IDENTITY_MIGRATION_STATUS_KEY) !== serialized) throw new Error("Migration status readback did not match.");
  } catch (error) {
    throw new IdentityStorageMigrationError("The migration status could not be saved and verified. The original profile remains available; retry before continuing.", { cause: error });
  }
}
