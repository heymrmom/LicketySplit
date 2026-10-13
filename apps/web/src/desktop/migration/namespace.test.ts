/* global IDBValidKey */
import { describe, expect, it } from "vitest";
import type {
  IdentityMigrationJournal,
  IndexedDatabaseReader,
  IndexedDatabaseSchema,
  IndexedDatabaseWriter,
  LocalStoragePort,
  MigrationJournalState,
} from "./storage-copy";
import { UncopyableIndexedDatabaseRecordError } from "./storage-copy";
import {
  LEGACY_DATABASE_NAME_MAP,
  LEGACY_LOCAL_STORAGE_KEY_MAP,
  NAMESPACE_MIGRATION_STATUS_KEY,
  migrateLegacyNamespace,
  readNamespaceMigrationComplete,
} from "./namespace";

class MemoryStorage implements LocalStoragePort {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  seed(key: string, value: string): void { this.values.set(key, value); }
}

class MemoryJournal implements IdentityMigrationJournal {
  private readonly values = new Map<string, MigrationJournalState>();
  async get(id: string): Promise<MigrationJournalState | undefined> { return this.values.get(id); }
  async set(id: string, state: MigrationJournalState): Promise<void> { this.values.set(id, state); }
  async delete(id: string): Promise<void> { this.values.delete(id); }
}

class MemoryDatabase implements IndexedDatabaseReader, IndexedDatabaseWriter {
  readonly schemas = new Map<string, IndexedDatabaseSchema>();
  readonly rows = new Map<string, Map<string, Array<{ key: IDBValidKey; value: unknown }>>>();

  seed(name: string, schema: IndexedDatabaseSchema, records: Array<{ key: IDBValidKey; value: unknown }>): void {
    this.schemas.set(name, { ...schema, name });
    this.rows.set(name, new Map(schema.stores.map((store) => [store.name, records.map((record) => structuredClone(record))])));
  }
  async listDatabases(): Promise<Array<{ name: string; version: number }>> {
    return [...this.schemas.values()].map(({ name, version }) => ({ name, version }));
  }
  async readSchema(name: string): Promise<IndexedDatabaseSchema> { return structuredClone(this.schemas.get(name)!); }
  async readBatch(name: string, store: string, afterKey: IDBValidKey | undefined, limit: number): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
    const records = this.rows.get(name)?.get(store) ?? [];
    return records.filter((record) => afterKey === undefined || String(record.key) > String(afterKey)).slice(0, limit).map((record) => structuredClone(record));
  }
  async readKeysBatch(name: string, store: string, afterKey: IDBValidKey | undefined, limit: number): Promise<IDBValidKey[]> {
    return (await this.readBatch(name, store, afterKey, limit)).map(({ key }) => key);
  }
  async readRecord(name: string, store: string, key: IDBValidKey): Promise<unknown> {
    return structuredClone(this.rows.get(name)?.get(store)?.find((entry) => entry.key === key)?.value);
  }
  async ensureSchema(name: string, sourceSchema: IndexedDatabaseSchema): Promise<void> {
    const existingSchema = this.schemas.get(name);
    if (!existingSchema) {
      this.schemas.set(name, { ...structuredClone(sourceSchema), name });
      this.rows.set(name, new Map(sourceSchema.stores.map((store) => [store.name, []])));
      return;
    }
    this.schemas.set(name, {
      ...existingSchema,
      version: Math.max(existingSchema.version, sourceSchema.version),
      stores: sourceSchema.stores.map((sourceStore) => {
        const current = existingSchema.stores.find((store) => store.name === sourceStore.name);
        return current
          ? { ...current, indexes: [...current.indexes, ...sourceStore.indexes.filter((index) => !current.indexes.some((entry) => entry.name === index.name))] }
          : sourceStore;
      }),
    });
    for (const store of sourceSchema.stores) if (!this.rows.get(name)?.has(store.name)) this.rows.get(name)?.set(store.name, []);
  }
  async hasRecord(name: string, store: string, key: IDBValidKey): Promise<boolean> {
    return (this.rows.get(name)?.get(store) ?? []).some((entry) => entry.key === key);
  }
  async writeRecord(name: string, store: string, record: { key: IDBValidKey; value: unknown }): Promise<boolean> {
    const records = this.rows.get(name)?.get(store);
    if (!records || records.some((entry) => entry.key === record.key)) return false;
    records.push(structuredClone(record));
    return true;
  }
}

describe("same-origin namespace migration", () => {
  it("does not treat the separate origin-copy marker as namespace-copy completion", () => {
    const storage = new MemoryStorage();
    storage.seed("__licketysplit_identity_migration_control_v2__", JSON.stringify({ status: "complete", version: 2, completedAt: 1 }));
    expect(readNamespaceMigrationComplete(storage)).toBe(false);
  });

  it("maps only known legacy database and preference names", () => {
    expect(LEGACY_DATABASE_NAME_MAP).toContainEqual(["openreel-projects", "licketysplit-projects"]);
    expect(LEGACY_LOCAL_STORAGE_KEY_MAP).toContainEqual(["openreel_shortcuts", "licketysplit_shortcuts"]);
    expect(LEGACY_LOCAL_STORAGE_KEY_MAP).toContainEqual(["openreel-theme", "licketysplit-theme"]);
    expect(LEGACY_LOCAL_STORAGE_KEY_MAP).toContainEqual(["openreel-desktop-timeline-h", "licketysplit-desktop-timeline-h"]);
    expect(LEGACY_LOCAL_STORAGE_KEY_MAP).not.toContainEqual(["openreel-unrelated", "licketysplit-unrelated"]);
  });

  it("copies known data to new names, preserves destination values and the old source, and marks only a verified run", async () => {
    const storage = new MemoryStorage();
    storage.seed("openreel-theme", "purple");
    storage.seed("openreel_shortcuts", '{"play":"Cmd+P"}');
    storage.seed("openreel_shortcut_preset", "openreel");
    storage.seed("openreel-unrelated", "keep-old-key-only");
    storage.seed("licketysplit-theme", "newer-theme");
    const database = new MemoryDatabase();
    const legacySchema: IndexedDatabaseSchema = {
      name: "openreel-projects",
      version: 2,
      stores: [{ name: "projects", keyPath: "id", autoIncrement: false, indexes: [{ name: "modified", keyPath: "modifiedAt", unique: false, multiEntry: false }] }],
    };
    database.seed("openreel-projects", legacySchema, [
      { key: "old-project", value: { id: "old-project", modifiedAt: 1, title: "Saved interview" } },
      { key: "new-project", value: { id: "new-project", modifiedAt: 2, title: "Legacy copy" } },
    ]);
    database.seed("licketysplit-projects", {
      ...legacySchema,
      name: "licketysplit-projects",
      stores: [{ ...legacySchema.stores[0]!, indexes: [] }],
    }, [{ key: "new-project", value: { id: "new-project", modifiedAt: 3, title: "Destination wins" } }]);

    const result = await migrateLegacyNamespace(database, storage, database, new MemoryJournal(), { completedAt: 456 });

    expect(result.status).toBe("complete");
    expect(storage.getItem("licketysplit-theme")).toBe("newer-theme");
    expect(storage.getItem("licketysplit_shortcuts")).toBe('{"play":"Cmd+P"}');
    expect(storage.getItem("licketysplit_shortcut_preset")).toBe("licketysplit");
    expect(storage.getItem("openreel-theme")).toBe("purple");
    expect(storage.getItem("openreel-unrelated")).toBe("keep-old-key-only");
    expect(await database.readRecord("licketysplit-projects", "projects", "old-project")).toEqual({ id: "old-project", modifiedAt: 1, title: "Saved interview" });
    expect(await database.readRecord("licketysplit-projects", "projects", "new-project")).toEqual({ id: "new-project", modifiedAt: 3, title: "Destination wins" });
    expect(database.schemas.get("licketysplit-projects")?.stores[0]?.indexes).toContainEqual({ name: "modified", keyPath: "modifiedAt", unique: false, multiEntry: false });
    expect(await database.readRecord("openreel-projects", "projects", "old-project")).toEqual({ id: "old-project", modifiedAt: 1, title: "Saved interview" });
    expect(JSON.parse(storage.getItem(NAMESPACE_MIGRATION_STATUS_KEY) ?? "{}")).toEqual({ status: "complete", version: 1, completedAt: 456 });
  });

  it("does not mark a partial same-origin copy complete", async () => {
    const storage = new MemoryStorage();
    const database = new MemoryDatabase();
    const legacySchema: IndexedDatabaseSchema = { name: "openreel-db", version: 1, stores: [{ name: "fileHandles", keyPath: "id", autoIncrement: false, indexes: [] }] };
    database.seed("openreel-db", legacySchema, [{ key: "handle", value: { id: "handle" } }]);
    const unreadable = Object.create(database) as MemoryDatabase;
    unreadable.readRecord = async () => { throw new UncopyableIndexedDatabaseRecordError("openreel-db", "fileHandles", "handle"); };

    const result = await migrateLegacyNamespace(unreadable, storage, database, new MemoryJournal(), { completedAt: 789 });

    expect(result.status).toBe("incomplete");
    expect(storage.getItem(NAMESPACE_MIGRATION_STATUS_KEY)).toBeNull();
    if (result.status === "complete") throw new Error("Expected an incomplete migration result.");
    expect(result.unavailable).toEqual([{ databaseName: "openreel-db", storeName: "fileHandles" }]);
  });
});
