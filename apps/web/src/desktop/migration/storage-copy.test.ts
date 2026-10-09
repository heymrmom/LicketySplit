/* global IDBValidKey */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { IDENTITY_MIGRATION_JOURNAL_DB, UncopyableIndexedDatabaseRecordError } from "./storage-copy";
import type {
  IdentityMigrationJournal,
  IndexedDatabaseReader,
  IndexedDatabaseRecord,
  IndexedDatabaseSchema,
  IndexedDatabaseWriter,
  LocalStoragePort,
  MigrationJournalState,
} from "./storage-copy";
import { copyIndexedDatabase, copyIndexedDatabases, copyLocalStorage, copyLocalStorageFromReader } from "./storage-copy";

class MemoryStorage implements LocalStoragePort {
  private readonly values = new Map<string, string>();
  failNextWrite = false;
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.failNextWrite) { this.failNextWrite = false; throw new DOMException("Storage quota exceeded", "QuotaExceededError"); }
    this.values.set(key, value);
  }
  seed(key: string, value: string): void { this.values.set(key, value); }
}

class MemoryJournal implements IdentityMigrationJournal {
  readonly entries = new Map<string, MigrationJournalState>();
  async get(id: string): Promise<MigrationJournalState | undefined> { return this.entries.get(id); }
  async set(id: string, state: MigrationJournalState): Promise<void> { this.entries.set(id, state); }
  async delete(id: string): Promise<void> { this.entries.delete(id); }
}

function keyId(key: IDBValidKey): string {
  if (key instanceof Date) return "date:" + key.getTime();
  if (Array.isArray(key)) return "array:" + JSON.stringify(key);
  return typeof key + ":" + String(key);
}

class FakeFileSystemHandle {
  readonly [Symbol.toStringTag] = "FileSystemFileHandle";
  constructor(readonly identity: string) {}
  async isSameEntry(other: unknown): Promise<boolean> {
    return other instanceof FakeFileSystemHandle && other.identity === this.identity;
  }
}

function clone<T>(value: T): T {
  if (Object.prototype.toString.call(value) === "[object Blob]") return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof FakeFileSystemHandle) return new FakeFileSystemHandle(value.identity) as T;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  }
  return structuredClone(value);
}

class MemoryDatabase implements IndexedDatabaseReader, IndexedDatabaseWriter {
  readonly schemas = new Map<string, IndexedDatabaseSchema>();
  readonly rows = new Map<string, Map<string, IndexedDatabaseRecord[]>>();
  maxBatch = 0;
  failAfterWriteForKey: IDBValidKey | undefined;
  failBeforeWriteForKey: IDBValidKey | undefined;
  failNextBatch: unknown;
  raceAfterHasRecord: { key: IDBValidKey; value: unknown } | undefined;
  transformOnWrite: ((record: IndexedDatabaseRecord) => IndexedDatabaseRecord) | undefined;

  seed(name: string, schema: IndexedDatabaseSchema, records: Record<string, IndexedDatabaseRecord[]>): void {
    this.schemas.set(name, clone(schema));
    this.rows.set(name, new Map(Object.entries(records).map(([store, values]) => [store, clone(values)])));
  }

  async listDatabases(): Promise<Array<{ name: string; version: number }>> {
    return [...this.schemas.values()].map(({ name, version }) => ({ name, version }));
  }

  async readSchema(name: string): Promise<IndexedDatabaseSchema> {
    const schema = this.schemas.get(name);
    if (!schema) throw new Error("missing source db " + name);
    return clone(schema);
  }

  async readBatch(name: string, storeName: string, afterKey: IDBValidKey | undefined, limit: number): Promise<IndexedDatabaseRecord[]> {
    if (this.failNextBatch) {
      const error = this.failNextBatch;
      this.failNextBatch = undefined;
      throw error;
    }
    this.maxBatch = Math.max(this.maxBatch, limit);
    const rows = this.rows.get(name)?.get(storeName) ?? [];
    const after = afterKey === undefined ? -Infinity : Number(afterKey);
    return clone(rows.filter((row) => Number(row.key) > after).sort((a, b) => Number(a.key) - Number(b.key)).slice(0, limit));
  }

  async ensureSchema(name: string, sourceSchema: IndexedDatabaseSchema): Promise<void> {
    const existing = this.schemas.get(name);
    if (!existing) {
      this.schemas.set(name, { ...clone(sourceSchema), name });
      this.rows.set(name, new Map(sourceSchema.stores.map((store) => [store.name, []])));
      return;
    }
    for (const sourceStore of sourceSchema.stores) {
      const targetStore = existing.stores.find((store) => store.name === sourceStore.name);
      if (targetStore && (JSON.stringify(targetStore.keyPath) !== JSON.stringify(sourceStore.keyPath) || targetStore.autoIncrement !== sourceStore.autoIncrement)) {
        throw new Error("schema conflict " + sourceStore.name);
      }
      if (!targetStore) {
        existing.stores.push(clone(sourceStore));
        this.rows.get(name)?.set(sourceStore.name, []);
      } else {
        for (const sourceIndex of sourceStore.indexes) {
          if (!targetStore.indexes.some((index) => index.name === sourceIndex.name)) targetStore.indexes.push(clone(sourceIndex));
        }
      }
    }
  }

  async hasRecord(name: string, storeName: string, key: IDBValidKey): Promise<boolean> {
    const rows = this.rows.get(name)?.get(storeName);
    const exists = Boolean(rows?.some((row) => keyId(row.key) === keyId(key)));
    if (!exists && this.raceAfterHasRecord && keyId(this.raceAfterHasRecord.key) === keyId(key)) {
      rows?.push(clone({ key, value: this.raceAfterHasRecord.value }));
      this.raceAfterHasRecord = undefined;
    }
    return exists;
  }

  async writeRecord(name: string, storeName: string, record: IndexedDatabaseRecord, replaceOwned: boolean): Promise<boolean> {
    const rows = this.rows.get(name)?.get(storeName);
    if (!rows) throw new Error("missing target store " + storeName);
    const index = rows.findIndex((row) => keyId(row.key) === keyId(record.key));
    if (index >= 0 && !replaceOwned) return false;
    if (this.failBeforeWriteForKey !== undefined && keyId(this.failBeforeWriteForKey) === keyId(record.key)) {
      this.failBeforeWriteForKey = undefined;
      throw new Error("simulated interruption before destination write");
    }
    const writtenRecord = this.transformOnWrite?.(record) ?? record;
    if (index >= 0) rows.splice(index, 1);
    rows.push(clone(writtenRecord));
    if (this.failAfterWriteForKey !== undefined && keyId(this.failAfterWriteForKey) === keyId(record.key)) {
      this.failAfterWriteForKey = undefined;
      throw new Error("simulated interruption after a destination write");
    }
    return true;
  }

  async readRecord(name: string, storeName: string, key: IDBValidKey): Promise<unknown> {
    const record = this.rows.get(name)?.get(storeName)?.find((row) => keyId(row.key) === keyId(key));
    return record ? clone(record.value) : undefined;
  }
}

describe("same-origin storage copy primitives", () => {
  let journal: MemoryJournal;
  beforeEach(() => { journal = new MemoryJournal(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("copies raw localStorage strings, maps renamed keys, and keeps destination values", async () => {
    const source = new MemoryStorage();
    const destination = new MemoryStorage();
    source.seed("openreel_theme", "{\"scheme\":\"purple\",\"nested\":[1,2]}");
    source.seed("openreel_shortcuts", "{\"play\":\"Cmd+P\"}");
    source.seed("openreel_shortcut_preset", "openreel");
    source.seed("openreel_custom_preset", "custom-editorial");
    destination.seed("licketysplit_theme", "new-destination-preference");

    const result = await copyLocalStorage(source, destination, journal, {
      runId: "rename-v1",
      mapKey: (key) => key.replace("openreel_", "licketysplit_"),
      mapValue: (key, value) => key === "openreel_shortcut_preset" && value === "openreel" ? "licketysplit" : value,
    });

    expect(result).toEqual({ copied: 3, preserved: 1, total: 4 });
    expect(destination.getItem("licketysplit_theme")).toBe("new-destination-preference");
    expect(destination.getItem("licketysplit_shortcuts")).toBe("{\"play\":\"Cmd+P\"}");
    expect(destination.getItem("licketysplit_shortcut_preset")).toBe("licketysplit");
    expect(destination.getItem("licketysplit_custom_preset")).toBe("custom-editorial");
    expect(source.getItem("openreel_shortcuts")).toBe("{\"play\":\"Cmd+P\"}");
    expect(journal.entries.size).toBe(0);
  });

  it("leaves an interrupted localStorage row marked for retry, then verifies and clears it", async () => {
    const source = new MemoryStorage();
    const destination = new MemoryStorage();
    source.seed("custom-presets", "[\"preset-α\",\"preset-β\"]");
    destination.failNextWrite = true;

    await expect(copyLocalStorage(source, destination, journal, { runId: "resume-v1" })).rejects.toThrow("remains available for retry");
    expect(destination.getItem("custom-presets")).toBeNull();
    expect(journal.entries.size).toBe(1);

    await expect(copyLocalStorage(source, destination, journal, { runId: "resume-v1" })).resolves.toEqual({ copied: 1, preserved: 0, total: 1 });
    expect(destination.getItem("custom-presets")).toBe("[\"preset-α\",\"preset-β\"]");
    expect(journal.entries.size).toBe(0);
  });

  it("preserves a newer localStorage value written after an interrupted migration", async () => {
    const source = new MemoryStorage();
    const destination = new MemoryStorage();
    source.seed("custom-presets", "source-value");
    destination.failNextWrite = true;

    await expect(copyLocalStorage(source, destination, journal, { runId: "preserve-newer-v1" })).rejects.toThrow();
    destination.seed("custom-presets", "newer-destination-value");

    await expect(copyLocalStorage(source, destination, journal, { runId: "preserve-newer-v1" })).rejects.toThrow("it was preserved");
    expect(destination.getItem("custom-presets")).toBe("newer-destination-value");
    expect(journal.entries.size).toBe(1);
  });

  it("rejects colliding localStorage key mappings before writing either value", async () => {
    const source = new MemoryStorage();
    const destination = new MemoryStorage();
    source.seed("old-theme", "theme");
    source.seed("new-theme", "other-theme");

    await expect(copyLocalStorage(source, destination, journal, {
      runId: "colliding-keys-v1",
      mapKey: () => "theme",
    })).rejects.toThrow("same destination key");
    expect(destination.length).toBe(0);
  });

  it("checks existing destination localStorage before requesting the remote value", async () => {
    const destination = new MemoryStorage();
    destination.seed("theme", "new destination setting");
    const requested: string[] = [];

    const result = await copyLocalStorageFromReader({
      listKeys: async () => ["theme", "panel-state"],
      readValue: async (key) => { requested.push(key); return key === "panel-state" ? "collapsed" : "old theme"; },
    }, destination, journal, { runId: "remote-storage-v1" });

    expect(result).toEqual({ copied: 1, preserved: 1, total: 2 });
    expect(requested).toEqual(["panel-state"]);
    expect(destination.getItem("theme")).toBe("new destination setting");
    expect(destination.getItem("panel-state")).toBe("collapsed");
  });

  it("copies bounded IndexedDB cursor pages and preserves schema, structured values, and newer destination rows", async () => {
    const source = new MemoryDatabase();
    const destination = new MemoryDatabase();
    const sourceSchema: IndexedDatabaseSchema = {
      name: "openreel-projects", version: 3, stores: [
        { name: "projects", keyPath: "id", autoIncrement: false, indexes: [{ name: "lastOpened", keyPath: "lastOpened", unique: false, multiEntry: false }] },
        { name: "recent", keyPath: "id", autoIncrement: false, indexes: [] },
        { name: "attachments", keyPath: null, autoIncrement: true, indexes: [{ name: "tags", keyPath: "tags", unique: false, multiEntry: true }] },
      ],
    };
    source.seed("openreel-projects", sourceSchema, {
      projects: [1, 2, 3, 4, 5].map((key) => ({ key, value: { id: key, updatedAt: new Date(key * 1000), blob: new NodeBlob(["project-" + key], { type: "application/json" }) } })),
      recent: [{ key: 1, value: { id: 1, name: "Recent" } }],
      attachments: [{ key: 1, value: { name: "cover", tags: ["image", "project"] } }],
    });
    destination.seed("licketysplit-projects", {
      name: "licketysplit-projects", version: 5, stores: [
        { name: "projects", keyPath: "id", autoIncrement: false, indexes: [] },
        { name: "futureData", keyPath: "id", autoIncrement: false, indexes: [] },
      ],
    }, {
      projects: [{ key: 2, value: { id: 2, name: "new destination project" } }],
      futureData: [{ key: "keep", value: { id: "keep" } }],
    });

    const result = await copyIndexedDatabase(source, destination, journal, {
      sourceName: "openreel-projects", destinationName: "licketysplit-projects", runId: "db-v1", batchSize: 2,
    });

    expect(result).toEqual({ databaseName: "openreel-projects", destinationName: "licketysplit-projects", copied: 6, preserved: 1 });
    expect(source.maxBatch).toBe(2);
    const targetSchema = destination.schemas.get("licketysplit-projects")!;
    expect(targetSchema.version).toBe(5);
    expect(targetSchema.stores.map((store) => store.name)).toEqual(["projects", "futureData", "recent", "attachments"]);
    expect(targetSchema.stores.find((store) => store.name === "projects")?.indexes).toEqual(sourceSchema.stores[0]?.indexes);
    expect(targetSchema.stores.find((store) => store.name === "attachments")).toEqual(sourceSchema.stores[2]);
    expect(await destination.readRecord("licketysplit-projects", "projects", 2)).toEqual({ id: 2, name: "new destination project" });
    const copied = await destination.readRecord("licketysplit-projects", "projects", 3) as { updatedAt: Date; blob: Blob };
    expect(copied.updatedAt).toEqual(new Date(3000));
    expect(copied.blob).toBeInstanceOf(NodeBlob);
    expect(await copied.blob.text()).toBe("project-3");
    expect(await destination.readRecord("licketysplit-projects", "futureData", "keep")).toEqual({ id: "keep" });
    expect(journal.entries.size).toBe(0);
  });

  it("replays a journal-owned partial IndexedDB row after interruption without replacing unrelated rows", async () => {
    const source = new MemoryDatabase();
    const destination = new MemoryDatabase();
    const schema: IndexedDatabaseSchema = { name: "openreel-db", version: 1, stores: [{ name: "projects", keyPath: "id", autoIncrement: false, indexes: [] }] };
    source.seed("openreel-db", schema, { projects: [1, 2].map((key) => ({ key, value: { id: key, value: "source-" + key } })) });
    destination.seed("licketysplit-db", { ...schema, name: "licketysplit-db" }, { projects: [{ key: 1, value: { id: 1, value: "new destination data" } }] });
    destination.failAfterWriteForKey = 2;

    await expect(copyIndexedDatabase(source, destination, journal, {
      sourceName: "openreel-db", destinationName: "licketysplit-db", runId: "resume-db", batchSize: 1,
    })).rejects.toThrow("simulated interruption");
    expect(await destination.readRecord("licketysplit-db", "projects", 2)).toEqual({ id: 2, value: "source-2" });
    expect(journal.entries.size).toBe(1);

    await expect(copyIndexedDatabase(source, destination, journal, {
      sourceName: "openreel-db", destinationName: "licketysplit-db", runId: "resume-db", batchSize: 1,
    })).resolves.toEqual({ databaseName: "openreel-db", destinationName: "licketysplit-db", copied: 1, preserved: 1 });
    expect(await destination.readRecord("licketysplit-db", "projects", 1)).toEqual({ id: 1, value: "new destination data" });
    expect(await destination.readRecord("licketysplit-db", "projects", 2)).toEqual({ id: 2, value: "source-2" });
    expect(source.rows.get("openreel-db")?.get("projects")).toEqual([1, 2].map((key) => ({ key, value: { id: key, value: "source-" + key } })));
    expect(journal.entries.size).toBe(0);
  });

  it("preserves a newer IndexedDB row written after a partial migration", async () => {
    const source = new MemoryDatabase();
    const destination = new MemoryDatabase();
    const schema: IndexedDatabaseSchema = { name: "openreel-db", version: 1, stores: [{ name: "projects", keyPath: "id", autoIncrement: false, indexes: [] }] };
    source.seed("openreel-db", schema, { projects: [{ key: 2, value: { id: 2, value: "source" } }] });
    destination.seed("licketysplit-db", { ...schema, name: "licketysplit-db" }, { projects: [] });
    destination.failAfterWriteForKey = 2;

    await expect(copyIndexedDatabase(source, destination, journal, {
      sourceName: "openreel-db", destinationName: "licketysplit-db", runId: "preserve-newer-db-v1",
    })).rejects.toThrow("simulated interruption");
    destination.rows.get("licketysplit-db")?.get("projects")?.splice(0, 1, { key: 2, value: { id: 2, value: "newer destination" } });

    await expect(copyIndexedDatabase(source, destination, journal, {
      sourceName: "openreel-db", destinationName: "licketysplit-db", runId: "preserve-newer-db-v1",
    })).rejects.toThrow("it was preserved");
    expect(await destination.readRecord("licketysplit-db", "projects", 2)).toEqual({ id: 2, value: "newer destination" });
    expect(journal.entries.size).toBe(1);
  });

  it("stops with relink guidance when a stored handle cannot cross the copy boundary", async () => {
    const source = new MemoryDatabase();
    const destination = new MemoryDatabase();
    const schema: IndexedDatabaseSchema = { name: "openreel-db", version: 1, stores: [{ name: "projects", keyPath: "id", autoIncrement: false, indexes: [] }] };
    source.seed("openreel-db", schema, { projects: [{ key: 1, value: { id: 1, assetHandle: "fixture-only-handle" } }] });
    destination.seed("licketysplit-db", { ...schema, name: "licketysplit-db" }, { projects: [] });
    source.failNextBatch = new DOMException("Could not clone handle", "DataCloneError");

    await expect(copyIndexedDatabase(source, destination, journal, {
      sourceName: "openreel-db", destinationName: "licketysplit-db", runId: "handle-error-v1",
    })).rejects.toThrow("retry after relinking the affected item");
    expect(await source.readRecord("openreel-db", "projects", 1)).toEqual({ id: 1, assetHandle: "fixture-only-handle" });
    expect(await destination.readRecord("licketysplit-db", "projects", 1)).toBeUndefined();
    expect(journal.entries.size).toBe(0);
  });

  it("skips one known uncloneable source row and still copies later cloneable records", async () => {
    const destination = new MemoryDatabase();
    const schema: IndexedDatabaseSchema = { name: "legacy-media", version: 1, stores: [{ name: "media", keyPath: "id", autoIncrement: false, indexes: [] }] };
    const requested: IDBValidKey[] = [];
    const source = {
      listDatabases: async () => [{ name: "legacy-media", version: 1 }],
      readSchema: async () => schema,
      readBatch: async () => { throw new Error("keys-first reader must not request a full batch"); },
      readKeysBatch: async (_name: string, _store: string, afterKey: IDBValidKey | undefined) => afterKey === undefined ? [1, 2] : [3],
      readRecord: async (_name: string, _store: string, key: IDBValidKey) => {
        requested.push(key);
        if (key === 1) throw new UncopyableIndexedDatabaseRecordError("legacy-media", "media", key);
        if (key === 2) return { id: 2, label: "source row that destination already has" };
        return { id: 3, label: "cloneable row" };
      },
    } as unknown as IndexedDatabaseReader;
    destination.seed("legacy-media", schema, { media: [{ key: 2, value: { id: 2, label: "new destination row" } }] });
    const unavailable: Array<{ databaseName: string; storeName: string; key: IDBValidKey }> = [];

    const result = await copyIndexedDatabase(source, destination, journal, {
      sourceName: "legacy-media", runId: "skip-handle-v1", batchSize: 2,
      onUncopyableRecord: (record) => unavailable.push(record),
    });

    expect(result).toEqual({ databaseName: "legacy-media", destinationName: "legacy-media", copied: 1, preserved: 1 });
    expect(requested).toEqual([1, 3]);
    expect(unavailable).toEqual([{ databaseName: "legacy-media", storeName: "media", key: 1 }]);
    expect(await destination.readRecord("legacy-media", "media", 2)).toEqual({ id: 2, label: "new destination row" });
    expect(await destination.readRecord("legacy-media", "media", 3)).toEqual({ id: 3, label: "cloneable row" });
  });

  it("detects same-size Blob content changes in bounded readback slices", async () => {
    const source = new MemoryDatabase();
    const destination = new MemoryDatabase();
    const schema: IndexedDatabaseSchema = { name: "openreel-db", version: 1, stores: [{ name: "media", keyPath: "id", autoIncrement: false, indexes: [] }] };
    const original = new NodeBlob(["orig"], { type: "video/test" });
    source.seed("openreel-db", schema, { media: [{ key: 1, value: { id: 1, blob: original } }] });
    destination.seed("licketysplit-db", { ...schema, name: "licketysplit-db" }, { media: [] });
    destination.transformOnWrite = (record) => ({ ...record, value: { id: 1, blob: new NodeBlob(["evil"], { type: "video/test" }) } });

    await expect(copyIndexedDatabase(source, destination, journal, {
      sourceName: "openreel-db", destinationName: "licketysplit-db", runId: "blob-readback-v1",
    })).rejects.toThrow("readback did not match");
    expect(await original.text()).toBe("orig");
  });

  it("rejects a different AES-GCM key with matching metadata", async () => {
    const originalKey = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, ["encrypt", "decrypt"]);
    const differentKey = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, ["encrypt", "decrypt"]);
    vi.stubGlobal("crypto", webcrypto);
    const source = new MemoryDatabase();
    const destination = new MemoryDatabase();
    const schema: IndexedDatabaseSchema = { name: "openreel-db", version: 1, stores: [{ name: "secure", keyPath: "id", autoIncrement: false, indexes: [] }] };
    source.seed("openreel-db", schema, { secure: [{ key: 1, value: { id: 1, key: originalKey } }] });
    destination.seed("licketysplit-db", { ...schema, name: "licketysplit-db" }, { secure: [] });
    destination.transformOnWrite = (record) => ({ ...record, value: { id: 1, key: differentKey } });

    await expect(copyIndexedDatabase(source, destination, journal, {
      sourceName: "openreel-db", destinationName: "licketysplit-db", runId: "crypto-key-readback-v1",
    })).rejects.toThrow("readback did not match");
  });

  it("rejects a different file-system entry with the same handle type", async () => {
    const source = new MemoryDatabase();
    const destination = new MemoryDatabase();
    const schema: IndexedDatabaseSchema = { name: "openreel-db", version: 1, stores: [{ name: "fileHandles", keyPath: "id", autoIncrement: false, indexes: [] }] };
    source.seed("openreel-db", schema, { fileHandles: [{ key: 1, value: { id: 1, handle: new FakeFileSystemHandle("source-entry") } }] });
    destination.seed("licketysplit-db", { ...schema, name: "licketysplit-db" }, { fileHandles: [] });
    destination.transformOnWrite = (record) => ({ ...record, value: { id: 1, handle: new FakeFileSystemHandle("different-entry") } });

    await expect(copyIndexedDatabase(source, destination, journal, {
      sourceName: "openreel-db", destinationName: "licketysplit-db", runId: "handle-identity-v1",
    })).rejects.toThrow("readback did not match");
  });

  it("does not replace a destination row created during an interrupted retry", async () => {
    const source = new MemoryDatabase();
    const destination = new MemoryDatabase();
    const schema: IndexedDatabaseSchema = { name: "openreel-db", version: 1, stores: [{ name: "projects", keyPath: "id", autoIncrement: false, indexes: [] }] };
    source.seed("openreel-db", schema, { projects: [{ key: 2, value: { id: 2, value: "source" } }] });
    destination.seed("licketysplit-db", { ...schema, name: "licketysplit-db" }, { projects: [] });
    destination.failBeforeWriteForKey = 2;
    const options = { sourceName: "openreel-db", destinationName: "licketysplit-db", runId: "row-race-v1" };

    await expect(copyIndexedDatabase(source, destination, journal, options)).rejects.toThrow("simulated interruption before destination write");
    destination.raceAfterHasRecord = { key: 2, value: { id: 2, value: "raced destination" } };

    await expect(copyIndexedDatabase(source, destination, journal, options)).rejects.toThrow("it was preserved");
    expect(await destination.readRecord("licketysplit-db", "projects", 2)).toEqual({ id: 2, value: "raced destination" });
  });

  it("does not silently skip a source database whose name matches the destination journal", async () => {
    const source = new MemoryDatabase();
    const destination = new MemoryDatabase();
    const schema: IndexedDatabaseSchema = { name: IDENTITY_MIGRATION_JOURNAL_DB, version: 1, stores: [{ name: "userData", keyPath: "id", autoIncrement: false, indexes: [] }] };
    source.seed(IDENTITY_MIGRATION_JOURNAL_DB, schema, { userData: [{ key: 1, value: { id: 1, label: "legacy user data" } }] });

    await expect(copyIndexedDatabases(source, destination, journal, {
      runId: "inventory-complete-v1",
      mapDatabaseName: () => "licketysplit-user-data",
    })).resolves.toEqual({ databases: 1, copied: 1, preserved: 0 });
    expect(await destination.readRecord("licketysplit-user-data", "userData", 1)).toEqual({ id: 1, label: "legacy user data" });
  });
});
