import {
  BrowserIdentityMigrationJournal,
  BrowserIndexedDatabaseWriter,
  copyIndexedDatabases,
  copyLocalStorageFromReader,
  type IdentityMigrationJournal,
  type IndexedDatabaseReader,
  type IndexedDatabaseWriter,
  type LocalStoragePort,
  type LocalStorageReader,
  type IndexedDatabaseCopyProgress,
} from "./storage-copy";
import { IDENTITY_MIGRATION_STATUS_KEY } from "./transport-protocol";
import { recordMigrationComplete, type UnavailableMigrationRecords } from "./status";

const RUN_ID = "origin-migration-v2";

export type OriginMigrationResult =
  | {
      status: "complete";
      localStorage: { copied: number; preserved: number; total: number };
      indexedDB: { databases: number; copied: number; preserved: number };
    }
  | {
      status: "incomplete";
      unavailable: UnavailableMigrationRecords;
      localStorage: { copied: number; preserved: number; total: number };
      indexedDB: { databases: number; copied: number; preserved: number };
    };

export async function migrateLegacyStorage(
  source: IndexedDatabaseReader & LocalStorageReader,
  destinationLocalStorage: LocalStoragePort,
  destinationDatabase: IndexedDatabaseWriter,
  journal: IdentityMigrationJournal,
  options: {
    completedAt?: number;
    onLocalStorageProgress?: (progress: { copied: number; preserved: number; total: number; key: string }) => void;
    onIndexedDbProgress?: (progress: IndexedDatabaseCopyProgress) => void;
  } = {},
): Promise<OriginMigrationResult> {
  const localStorage = await copyLocalStorageFromReader(source, destinationLocalStorage, journal, {
    runId: RUN_ID,
    excludeKeys: [IDENTITY_MIGRATION_STATUS_KEY],
    onProgress: options.onLocalStorageProgress,
  });
  const unavailableByLocation = new Map<string, { databaseName: string; storeName: string }>();
  const indexedDB = await copyIndexedDatabases(source, destinationDatabase, journal, {
    runId: RUN_ID,
    onProgress: options.onIndexedDbProgress,
    onUncopyableRecord: ({ databaseName, storeName }) => {
      unavailableByLocation.set(`${databaseName}\0${storeName}`, { databaseName, storeName });
    },
  });
  const unavailable = [...unavailableByLocation.values()];
  if (unavailable.length) return { status: "incomplete", unavailable, localStorage, indexedDB };

  recordMigrationComplete(destinationLocalStorage, [], options.completedAt);
  return { status: "complete", localStorage, indexedDB };
}

export async function migrateLegacyStorageInBrowser(
  source: IndexedDatabaseReader & LocalStorageReader,
  destinationLocalStorage: LocalStoragePort,
  destinationFactory: IDBFactory,
  options: Parameters<typeof migrateLegacyStorage>[4] = {},
): Promise<OriginMigrationResult> {
  const journal = new BrowserIdentityMigrationJournal(destinationFactory);
  const writer = new BrowserIndexedDatabaseWriter(destinationFactory);
  try { return await migrateLegacyStorage(source, destinationLocalStorage, writer, journal, options); }
  finally {
    writer.close();
    journal.close();
  }
}
