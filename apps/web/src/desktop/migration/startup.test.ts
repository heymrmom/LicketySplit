/* global IDBValidKey */
import { describe, expect, it } from "vitest";
import {
  IdentityStorageMigrationError,
  type IdentityMigrationJournal,
  type IndexedDatabaseReader,
  type IndexedDatabaseSchema,
  type IndexedDatabaseWriter,
  type LocalStoragePort,
  type MigrationJournalState,
  UncopyableIndexedDatabaseRecordError,
} from "./storage-copy";
import { IDENTITY_MIGRATION_STATUS_KEY } from "./transport-protocol";
import { migrateLegacyStorage } from "./startup";

class MemoryStorage implements LocalStoragePort {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class MemoryJournal implements IdentityMigrationJournal {
  readonly values = new Map<string, MigrationJournalState>();
  async get(id: string): Promise<MigrationJournalState | undefined> { return this.values.get(id); }
  async set(id: string, state: MigrationJournalState): Promise<void> { this.values.set(id, state); }
  async delete(id: string): Promise<void> { this.values.delete(id); }
}

class MemoryDatabase implements IndexedDatabaseWriter {
  readonly schemas = new Map<string, IndexedDatabaseSchema>();
  readonly rows = new Map<string, Map<string, Array<{ key: IDBValidKey; value: unknown }>>>();
  async ensureSchema(name: string, schema: IndexedDatabaseSchema): Promise<void> {
    this.schemas.set(name, schema);
    this.rows.set(name, new Map(schema.stores.map((store) => [store.name, []])));
  }
  async hasRecord(name: string, store: string, key: IDBValidKey): Promise<boolean> {
    return Boolean(this.rows.get(name)?.get(store)?.some((row) => row.key === key));
  }
  async writeRecord(name: string, store: string, record: { key: IDBValidKey; value: unknown }): Promise<boolean> {
    const rows = this.rows.get(name)?.get(store);
    if (!rows || rows.some((row) => row.key === record.key)) return false;
    rows.push(record);
    return true;
  }
  async readRecord(name: string, store: string, key: IDBValidKey): Promise<unknown> {
    return this.rows.get(name)?.get(store)?.find((row) => row.key === key)?.value;
  }
}

const schema: IndexedDatabaseSchema = {
  name: "legacy-projects",
  version: 2,
  stores: [{ name: "projects", keyPath: "id", autoIncrement: false, indexes: [] }],
};

describe("renderer origin migration startup", () => {
  it("copies cloneable rows, records unavailable handle rows, and does not mark a partial copy complete", async () => {
    const destination = new MemoryStorage();
    const database = new MemoryDatabase();
    const journal = new MemoryJournal();
    const acknowledgements: Array<[IDBValidKey, string]> = [];
    const source = {
      listKeys: async () => ["legacy-theme"],
      readValue: async () => "violet",
      listDatabases: async () => [{ name: "legacy-projects", version: 2 }],
      readSchema: async () => schema,
      readBatch: async () => { throw new Error("keys-first reader required"); },
      readKeysBatch: async () => [1, 2],
      readRecord: async (_name: string, _store: string, key: IDBValidKey) => {
        if (key === 1) throw new UncopyableIndexedDatabaseRecordError("legacy-projects", "projects", key);
        return { id: 2, title: "Cloneable project" };
      },
      finishRecordTransfer: async (_name: string, _store: string, key: IDBValidKey, outcome: "verified" | "unavailable") => acknowledgements.push([key, outcome]),
    } as unknown as IndexedDatabaseReader & { listKeys(): Promise<string[]>; readValue(key: string): Promise<string | null> };

    const result = await migrateLegacyStorage(source, destination, database, journal);

    expect(result).toEqual({
      status: "incomplete",
      unavailable: [{ databaseName: "legacy-projects", storeName: "projects" }],
      localStorage: { copied: 1, preserved: 0, total: 1 },
      indexedDB: { databases: 1, copied: 1, preserved: 0 },
    });
    expect(destination.getItem("legacy-theme")).toBe("violet");
    expect(destination.getItem(IDENTITY_MIGRATION_STATUS_KEY)).toBeNull();
    expect(await database.readRecord("legacy-projects", "projects", 2)).toEqual({ id: 2, title: "Cloneable project" });
    expect(acknowledgements).toEqual([[1, "unavailable"], [2, "verified"]]);
    expect(journal.values.size).toBe(0);
  });

  it("marks completion only when every enumerated source row was verified", async () => {
    const destination = new MemoryStorage();
    const database = new MemoryDatabase();
    const journal = new MemoryJournal();
    const source = {
      listKeys: async () => [],
      readValue: async () => null,
      listDatabases: async () => [{ name: "legacy-projects", version: 2 }],
      readSchema: async () => schema,
      readBatch: async () => [],
      readKeysBatch: async () => [],
      readRecord: async () => undefined,
    } as unknown as IndexedDatabaseReader & { listKeys(): Promise<string[]>; readValue(key: string): Promise<string | null> };

    const result = await migrateLegacyStorage(source, destination, database, journal, { completedAt: 987 });

    expect(result.status).toBe("complete");
    expect(JSON.parse(destination.getItem(IDENTITY_MIGRATION_STATUS_KEY) ?? "{}")).toEqual({ status: "complete", version: 1, completedAt: 987 });
  });

  it("preserves the old completion state if the destination cannot verify its new marker", async () => {
    const destination = new MemoryStorage();
    const database = new MemoryDatabase();
    const journal = new MemoryJournal();
    destination.setItem(IDENTITY_MIGRATION_STATUS_KEY, "accepted-incomplete");
    const source = {
      listKeys: async () => [], readValue: async () => null,
      listDatabases: async () => [], readSchema: async () => schema,
      readBatch: async () => [], readKeysBatch: async () => [], readRecord: async () => undefined,
    } as unknown as IndexedDatabaseReader & { listKeys(): Promise<string[]>; readValue(key: string): Promise<string | null> };
    destination.setItem = () => { throw new Error("quota denied"); };

    await expect(migrateLegacyStorage(source, destination, database, journal, { completedAt: 999 })).rejects.toBeInstanceOf(IdentityStorageMigrationError);
  });
});
