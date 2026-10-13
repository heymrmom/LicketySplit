/* global IDBValidKey */

export const IDENTITY_MIGRATION_JOURNAL_DB = "__licketysplit_identity_migration__";
const JOURNAL_STORE = "entries";
const DEFAULT_BATCH_SIZE = 128;
const MAX_BATCH_SIZE = 512;

export type MigrationJournalState = "pending" | "conflict";

export interface IdentityMigrationJournal {
  get(id: string): Promise<MigrationJournalState | undefined>;
  set(id: string, state: MigrationJournalState): Promise<void>;
  delete(id: string): Promise<void>;
}

export type LocalStoragePort = Pick<Storage, "length" | "key" | "getItem" | "setItem">;

export type IndexedIndexSchema = {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
};

export type IndexedStoreSchema = {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IndexedIndexSchema[];
};

export type IndexedDatabaseSchema = {
  name: string;
  version: number;
  stores: IndexedStoreSchema[];
};

export type IndexedDatabaseRecord = { key: IDBValidKey; value: unknown };

export interface IndexedDatabaseReader {
  listDatabases(): Promise<Array<{ name: string; version: number }>>;
  readSchema(name: string): Promise<IndexedDatabaseSchema>;
  readBatch(name: string, storeName: string, afterKey: IDBValidKey | undefined, limit: number): Promise<IndexedDatabaseRecord[]>;
  readKeysBatch?(name: string, storeName: string, afterKey: IDBValidKey | undefined, limit: number): Promise<IDBValidKey[]>;
  readRecord?(name: string, storeName: string, key: IDBValidKey): Promise<unknown>;
  finishRecordTransfer?(name: string, storeName: string, key: IDBValidKey, outcome: "verified" | "unavailable"): Promise<void>;
}

export interface IndexedDatabaseWriter {
  ensureSchema(name: string, sourceSchema: IndexedDatabaseSchema): Promise<void>;
  hasRecord(name: string, storeName: string, key: IDBValidKey): Promise<boolean>;
  writeRecord(name: string, storeName: string, record: IndexedDatabaseRecord, replaceOwned: boolean): Promise<boolean>;
  readRecord(name: string, storeName: string, key: IDBValidKey): Promise<unknown>;
}

export class IdentityStorageMigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IdentityStorageMigrationError";
  }
}

export class UncopyableIndexedDatabaseRecordError extends IdentityStorageMigrationError {
  constructor(readonly databaseName: string, readonly storeName: string, readonly key: IDBValidKey, options?: ErrorOptions) {
    super(`The stored value in ${databaseName}/${storeName} could not cross the migration boundary.`, options);
    this.name = "UncopyableIndexedDatabaseRecordError";
  }
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Storage migration was canceled.", "AbortError");
}

function copyReadError(context: string, error: unknown): IdentityStorageMigrationError {
  if (error instanceof IdentityStorageMigrationError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  if (error && typeof error === "object" && "name" in error && error.name === "DataCloneError") {
    return new IdentityStorageMigrationError(
      `Could not copy ${context}: the browser could not clone a stored file handle or another structured value. The original data remains available; retry after relinking the affected item in the destination.`,
      { cause: error },
    );
  }
  return new IdentityStorageMigrationError(`Could not copy ${context}; the source remains available for retry. ${detail}`, { cause: error });
}

function journalKey(parts: string[]): string {
  return `copy:${JSON.stringify(parts)}`;
}

/** Copies raw localStorage strings. Existing destination values win unless a pending row is owned by this run. */
export async function copyLocalStorage(
  source: LocalStoragePort,
  destination: LocalStoragePort,
  journal: IdentityMigrationJournal,
  options: {
    runId: string;
    mapKey?: (sourceKey: string) => string;
    mapValue?: (sourceKey: string, sourceValue: string) => string;
    signal?: AbortSignal;
    onProgress?: (progress: { copied: number; preserved: number; total: number; key: string }) => void;
  },
): Promise<{ copied: number; preserved: number; total: number }> {
  const sourceEntries: Array<{ sourceKey: string; destinationKey: string }> = [];
  const destinationKeys = new Set<string>();
  for (let index = 0; index < source.length; index += 1) {
    const key = source.key(index);
    if (key === null) throw new IdentityStorageMigrationError("Source local storage changed while it was being inventoried.");
    const destinationKey = options.mapKey?.(key) ?? key;
    if (!destinationKey) throw new IdentityStorageMigrationError(`No destination key was provided for ${key}.`);
    if (destinationKeys.has(destinationKey)) throw new IdentityStorageMigrationError(`Multiple source keys map to the same destination key: ${destinationKey}.`);
    destinationKeys.add(destinationKey);
    sourceEntries.push({ sourceKey: key, destinationKey });
  }

  let copied = 0;
  let preserved = 0;
  for (const { sourceKey, destinationKey } of sourceEntries) {
    ensureNotAborted(options.signal);
    const value = source.getItem(sourceKey);
    if (value === null) throw new IdentityStorageMigrationError(`Source local storage key disappeared during migration: ${sourceKey}`);
    const destinationValue = options.mapValue?.(sourceKey, value) ?? value;
    const id = journalKey([options.runId, "localStorage", sourceKey, destinationKey]);
    const state = await journal.get(id);
    if (state === "conflict") throw new IdentityStorageMigrationError(`A previous migration attempt found a conflicting destination value for ${destinationKey}.`);

    if (state === "pending") {
      const current = destination.getItem(destinationKey);
      if (current === destinationValue) {
        await journal.delete(id);
        copied += 1;
        options.onProgress?.({ copied, preserved, total: sourceEntries.length, key: sourceKey });
        continue;
      }
      if (current !== null) {
        await journal.set(id, "conflict");
        throw new IdentityStorageMigrationError(`A destination value changed while migration was interrupted: ${destinationKey}; it was preserved.`);
      }
    }

    if (!state) {
      if (destination.getItem(destinationKey) !== null) {
        preserved += 1;
        options.onProgress?.({ copied, preserved, total: sourceEntries.length, key: sourceKey });
        continue;
      }
      await journal.set(id, "pending");
      // Recheck after the awaited journal write so a concurrent destination write is never replaced.
      if (destination.getItem(destinationKey) !== null) {
        await journal.set(id, "conflict");
        throw new IdentityStorageMigrationError(`Destination local storage changed during migration: ${destinationKey}`);
      }
    }

    try {
      destination.setItem(destinationKey, destinationValue);
      if (destination.getItem(destinationKey) !== destinationValue) {
        throw new IdentityStorageMigrationError(`Destination local storage readback did not match ${destinationKey}.`);
      }
      await journal.delete(id);
      copied += 1;
      options.onProgress?.({ copied, preserved, total: sourceEntries.length, key: sourceKey });
    } catch (error) {
      if (error instanceof IdentityStorageMigrationError) throw error;
      throw new IdentityStorageMigrationError(`Could not copy local storage key ${sourceKey}; the source remains available for retry.`, { cause: error });
    }
  }
  return { copied, preserved, total: sourceEntries.length };
}

export interface LocalStorageReader {
  listKeys(): Promise<string[]>;
  readValue(key: string): Promise<string | null>;
}

/** Sequential counterpart for a legacy-origin reader; destination values are checked before requesting source values. */
export async function copyLocalStorageFromReader(
  source: LocalStorageReader,
  destination: LocalStoragePort,
  journal: IdentityMigrationJournal,
  options: {
    runId: string;
    excludeKeys?: string[];
    mapKey?: (sourceKey: string) => string;
    mapValue?: (sourceKey: string, sourceValue: string) => string;
    signal?: AbortSignal;
    onProgress?: (progress: { copied: number; preserved: number; total: number; key: string }) => void;
  },
): Promise<{ copied: number; preserved: number; total: number }> {
  const excluded = new Set(options.excludeKeys ?? []);
  const sourceKeys = (await source.listKeys()).filter((key) => !excluded.has(key));
  const destinationKeys = new Set<string>();
  const entries = sourceKeys.map((sourceKey) => {
    const destinationKey = options.mapKey?.(sourceKey) ?? sourceKey;
    if (!destinationKey) throw new IdentityStorageMigrationError(`No destination key was provided for ${sourceKey}.`);
    if (destinationKeys.has(destinationKey)) throw new IdentityStorageMigrationError(`Multiple source keys map to the same destination key: ${destinationKey}.`);
    destinationKeys.add(destinationKey);
    return { sourceKey, destinationKey };
  });

  let copied = 0;
  let preserved = 0;
  for (const { sourceKey, destinationKey } of entries) {
    ensureNotAborted(options.signal);
    const id = journalKey([options.runId, "localStorage", sourceKey, destinationKey]);
    const state = await journal.get(id);
    if (state === "conflict") throw new IdentityStorageMigrationError(`A previous migration attempt found a conflicting destination value for ${destinationKey}.`);
    let sourceValue: string | null | undefined;
    const readValue = async (): Promise<string> => {
      sourceValue ??= await source.readValue(sourceKey);
      if (sourceValue === null) throw new IdentityStorageMigrationError(`Source local storage key disappeared during migration: ${sourceKey}`);
      if (sourceValue === undefined) throw new IdentityStorageMigrationError(`Source local storage returned no value for ${sourceKey}.`);
      return options.mapValue?.(sourceKey, sourceValue) ?? sourceValue;
    };

    if (state === "pending") {
      const value = await readValue();
      const current = destination.getItem(destinationKey);
      if (current === value) {
        await journal.delete(id);
        copied += 1;
        options.onProgress?.({ copied, preserved, total: entries.length, key: sourceKey });
        continue;
      }
      if (current !== null) {
        await journal.set(id, "conflict");
        throw new IdentityStorageMigrationError(`A destination value changed while migration was interrupted: ${destinationKey}; it was preserved.`);
      }
    } else if (destination.getItem(destinationKey) !== null) {
      preserved += 1;
      options.onProgress?.({ copied, preserved, total: entries.length, key: sourceKey });
      continue;
    }

    if (!state) {
      await journal.set(id, "pending");
      if (destination.getItem(destinationKey) !== null) {
        await journal.set(id, "conflict");
        throw new IdentityStorageMigrationError(`Destination local storage changed during migration: ${destinationKey}`);
      }
    }

    try {
      const value = await readValue();
      destination.setItem(destinationKey, value);
      if (destination.getItem(destinationKey) !== value) throw new IdentityStorageMigrationError(`Destination local storage readback did not match ${destinationKey}.`);
      await journal.delete(id);
      copied += 1;
      options.onProgress?.({ copied, preserved, total: entries.length, key: sourceKey });
    } catch (error) {
      if (error instanceof IdentityStorageMigrationError) throw error;
      throw new IdentityStorageMigrationError(`Could not copy local storage key ${sourceKey}; the source remains available for retry.`, { cause: error });
    }
  }
  return { copied, preserved, total: entries.length };
}

export type IndexedDatabaseCopyProgress = {
  databaseName: string;
  storeName: string;
  copied: number;
  preserved: number;
  batchRecords: number;
};

/** Reads each store in bounded pages, verifies destination readback, and never mutates the source database. */
export async function copyIndexedDatabase(
  source: IndexedDatabaseReader,
  destination: IndexedDatabaseWriter,
  journal: IdentityMigrationJournal,
  options: {
    sourceName: string;
    destinationName?: string;
    runId: string;
    batchSize?: number;
    signal?: AbortSignal;
    onUncopyableRecord?: (record: { databaseName: string; storeName: string; key: IDBValidKey }) => void;
    onProgress?: (progress: IndexedDatabaseCopyProgress) => void;
  },
): Promise<{ databaseName: string; destinationName: string; copied: number; preserved: number }> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new IdentityStorageMigrationError(`IndexedDB batch size must be between 1 and ${MAX_BATCH_SIZE}.`);
  }
  const destinationName = options.destinationName ?? options.sourceName;
  if (!options.sourceName || !destinationName) {
    throw new IdentityStorageMigrationError("IndexedDB source and destination names must be non-empty.");
  }
  if (destinationName === IDENTITY_MIGRATION_JOURNAL_DB) {
    throw new IdentityStorageMigrationError("The migration journal database cannot be used as a destination.");
  }
  const schema = await source.readSchema(options.sourceName);
  await destination.ensureSchema(destinationName, schema);

  let copied = 0;
  let preserved = 0;
  const keysOnly = Boolean(source.readKeysBatch && source.readRecord);
  for (const store of schema.stores) {
    let afterKey: IDBValidKey | undefined;
    while (true) {
      ensureNotAborted(options.signal);
      let records: IndexedDatabaseRecord[] = [];
      let keys: IDBValidKey[] = [];
      try {
        if (keysOnly) keys = await source.readKeysBatch!(options.sourceName, store.name, afterKey, batchSize);
        else records = await source.readBatch(options.sourceName, store.name, afterKey, batchSize);
      } catch (error) {
        throw copyReadError(`${options.sourceName}/${store.name}`, error);
      }
      const batchKeys = keysOnly ? keys : records.map((record) => record.key);
      if (!batchKeys.length) break;
      for (let index = 0; index < batchKeys.length; index += 1) {
        const key = batchKeys[index]!;
        ensureNotAborted(options.signal);
        const id = journalKey([options.runId, "indexedDB", options.sourceName, destinationName, store.name, encodeIndexedDbKey(key)]);
        const state = await journal.get(id);
        if (state === "conflict") throw new IdentityStorageMigrationError(`A previous migration attempt found a conflicting row in ${destinationName}/${store.name}.`);

        if (!state && await destination.hasRecord(destinationName, store.name, key)) {
          preserved += 1;
          continue;
        }
        if (state === "pending" && await destination.hasRecord(destinationName, store.name, key)) {
          let sourceValue: unknown;
          try {
            sourceValue = keysOnly ? await source.readRecord!(options.sourceName, store.name, key) : records[index]!.value;
          } catch (error) {
            if (error instanceof UncopyableIndexedDatabaseRecordError && options.onUncopyableRecord) {
              await source.finishRecordTransfer?.(options.sourceName, store.name, key, "unavailable");
              options.onUncopyableRecord({ databaseName: options.sourceName, storeName: store.name, key });
              continue;
            }
            throw copyReadError(`${options.sourceName}/${store.name}/${encodeIndexedDbKey(key)}`, error);
          }
          const current = await destination.readRecord(destinationName, store.name, key);
          if (await sameStructuredValue(sourceValue, current)) {
            await source.finishRecordTransfer?.(options.sourceName, store.name, key, "verified");
            await journal.delete(id);
            copied += 1;
            continue;
          }
          await journal.set(id, "conflict");
          throw new IdentityStorageMigrationError(`A destination row changed while migration was interrupted in ${destinationName}/${store.name}; it was preserved.`);
        }
        if (!state) await journal.set(id, "pending");

        let value: unknown;
        try {
          value = keysOnly ? await source.readRecord!(options.sourceName, store.name, key) : records[index]!.value;
        } catch (error) {
          if (error instanceof UncopyableIndexedDatabaseRecordError && options.onUncopyableRecord) {
            await journal.delete(id);
            await source.finishRecordTransfer?.(options.sourceName, store.name, key, "unavailable");
            options.onUncopyableRecord({ databaseName: options.sourceName, storeName: store.name, key });
            continue;
          }
          throw copyReadError(`${options.sourceName}/${store.name}/${encodeIndexedDbKey(key)}`, error);
        }
        const record = { key, value };

        let written: boolean;
        try {
          written = await destination.writeRecord(destinationName, store.name, record, false);
        } catch (error) {
          throw copyReadError(`${destinationName}/${store.name}`, error);
        }
        if (!written) {
          await journal.set(id, "conflict");
          throw new IdentityStorageMigrationError(`A destination row appeared while migrating ${destinationName}/${store.name}; it was preserved.`);
        }
        let readback: unknown;
        try {
          readback = await destination.readRecord(destinationName, store.name, key);
        } catch (error) {
          throw copyReadError(`${destinationName}/${store.name} readback`, error);
        }
        if (!await sameStructuredValue(record.value, readback)) {
          throw new IdentityStorageMigrationError(`IndexedDB readback did not match ${destinationName}/${store.name}; the row remains marked for retry.`);
        }
        await source.finishRecordTransfer?.(options.sourceName, store.name, key, "verified");
        await journal.delete(id);
        copied += 1;
      }
      afterKey = batchKeys[batchKeys.length - 1]!;
      options.onProgress?.({ databaseName: destinationName, storeName: store.name, copied, preserved, batchRecords: batchKeys.length });
      if (batchKeys.length < batchSize) break;
    }
  }
  return { databaseName: options.sourceName, destinationName, copied, preserved };
}

/** Enumerates every source database. Callers may explicitly omit a known destination-only helper database. */
export async function copyIndexedDatabases(
  source: IndexedDatabaseReader,
  destination: IndexedDatabaseWriter,
  journal: IdentityMigrationJournal,
  options: {
    runId: string;
    mapDatabaseName?: (sourceName: string) => string;
    excludeSourceDatabaseNames?: string[];
    batchSize?: number;
    signal?: AbortSignal;
    onUncopyableRecord?: (record: { databaseName: string; storeName: string; key: IDBValidKey }) => void;
    onProgress?: (progress: IndexedDatabaseCopyProgress) => void;
  },
): Promise<{ databases: number; copied: number; preserved: number }> {
  const excluded = new Set(options.excludeSourceDatabaseNames ?? []);
  const databases = (await source.listDatabases()).filter((database) => !excluded.has(database.name));
  let copied = 0;
  let preserved = 0;
  for (const database of databases) {
    ensureNotAborted(options.signal);
    const result = await copyIndexedDatabase(source, destination, journal, {
      sourceName: database.name,
      destinationName: options.mapDatabaseName?.(database.name) ?? database.name,
      runId: options.runId,
      batchSize: options.batchSize,
      signal: options.signal,
      onUncopyableRecord: options.onUncopyableRecord,
      onProgress: options.onProgress,
    });
    copied += result.copied;
    preserved += result.preserved;
  }
  return { databases: databases.length, copied, preserved };
}

function encodeIndexedDbKey(key: IDBValidKey): string {
  if (typeof key === "string") return `s:${JSON.stringify(key)}`;
  if (typeof key === "number") return `n:${Object.is(key, -0) ? "0" : String(key)}`;
  if (key instanceof Date) return `d:${key.getTime()}`;
  if (Array.isArray(key)) return `a:${JSON.stringify(key.map((part) => encodeIndexedDbKey(part)))}`;
  if (key instanceof ArrayBuffer) return `b:${bytesToHex(new Uint8Array(key))}`;
  if (ArrayBuffer.isView(key)) return `b:${bytesToHex(new Uint8Array(key.buffer, key.byteOffset, key.byteLength))}`;
  throw new IdentityStorageMigrationError("IndexedDB returned an unsupported primary-key type.");
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

async function sameStructuredValue(expected: unknown, actual: unknown, seen = new WeakMap<object, object>()): Promise<boolean> {
  if (Object.is(expected, actual)) return true;
  if (expected === null || actual === null || typeof expected !== "object" || typeof actual !== "object") return false;
  const previous = seen.get(expected);
  if (previous) return previous === actual;
  seen.set(expected, actual);

  const expectedTag = Object.prototype.toString.call(expected);
  if (expectedTag !== Object.prototype.toString.call(actual)) return false;
  if (expected instanceof Date) return expected.getTime() === (actual as Date).getTime();
  if (expectedTag === "[object Blob]" || expectedTag === "[object File]") {
    const a = expected as Blob & { name?: string; lastModified?: number };
    const b = actual as Blob & { name?: string; lastModified?: number };
    if (a.size !== b.size || a.type !== b.type || a.name !== b.name || a.lastModified !== b.lastModified) return false;
    const chunkSize = 1024 * 1024;
    for (let offset = 0; offset < a.size; offset += chunkSize) {
      const left = new Uint8Array(await a.slice(offset, Math.min(offset + chunkSize, a.size)).arrayBuffer());
      const right = new Uint8Array(await b.slice(offset, Math.min(offset + chunkSize, b.size)).arrayBuffer());
      if (left.byteLength !== right.byteLength) return false;
      for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
    }
    return true;
  }
  if (expectedTag === "[object CryptoKey]") {
    const a = expected as CryptoKey;
    const b = actual as CryptoKey;
    if (a.type !== b.type || a.extractable !== b.extractable || JSON.stringify(a.algorithm) !== JSON.stringify(b.algorithm) || [...a.usages].sort().join(",") !== [...b.usages].sort().join(",")) return false;
    const algorithm = a.algorithm as { name?: string };
    if (a.type !== "secret" || algorithm.name !== "AES-GCM" || !a.usages.includes("encrypt") || !b.usages.includes("decrypt")) {
      throw new IdentityStorageMigrationError("Could not verify a stored cryptographic key after copying. Its algorithm or usages do not support a safe AES-GCM challenge; the original key remains available.");
    }
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new IdentityStorageMigrationError("This browser cannot verify the copied cryptographic key; the original key remains available.");
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
    try {
      const encrypted = await subtle.encrypt({ name: "AES-GCM", iv }, a, challenge);
      const decrypted = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv }, b, encrypted));
      return decrypted.length === challenge.length && decrypted.every((byte, index) => byte === challenge[index]);
    } catch {
      return false;
    }
  }
  const expectedHandle = expected as { isSameEntry?: (other: unknown) => Promise<boolean> };
  const actualHandle = actual as { isSameEntry?: (other: unknown) => Promise<boolean> };
  if (expectedTag.includes("FileSystem") || typeof expectedHandle.isSameEntry === "function") {
    if (typeof expectedHandle.isSameEntry !== "function" || typeof actualHandle.isSameEntry !== "function") {
      throw new IdentityStorageMigrationError("Could not verify a copied file-system handle. The destination does not support isSameEntry, so migration remains incomplete and the original remains available for relinking.");
    }
    try { return await expectedHandle.isSameEntry(actual); }
    catch (error) { throw new IdentityStorageMigrationError("Could not verify a copied file-system handle. The original remains available for relinking.", { cause: error }); }
  }
  if (expectedTag === "[object ArrayBuffer]" || ArrayBuffer.isView(expected)) {
    if (expectedTag !== Object.prototype.toString.call(actual)) return false;
    const a = expected instanceof ArrayBuffer ? new Uint8Array(expected) : new Uint8Array((expected as ArrayBufferView).buffer, (expected as ArrayBufferView).byteOffset, (expected as ArrayBufferView).byteLength);
    const value = actual as ArrayBuffer | ArrayBufferView;
    const b = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (a.byteLength !== b.byteLength) return false;
    for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
    return true;
  }
  if (expected instanceof Map) {
    const other = actual as Map<unknown, unknown>;
    if (expected.size !== other.size) return false;
    const left = [...expected.entries()];
    const right = [...other.entries()];
    for (let index = 0; index < left.length; index += 1) {
      if (!await sameStructuredValue(left[index]?.[0], right[index]?.[0], seen) || !await sameStructuredValue(left[index]?.[1], right[index]?.[1], seen)) return false;
    }
    return true;
  }
  if (expected instanceof Set) {
    const other = [...(actual as Set<unknown>)];
    const values = [...expected];
    if (values.length !== other.length) return false;
    for (let index = 0; index < values.length; index += 1) if (!await sameStructuredValue(values[index], other[index], seen)) return false;
    return true;
  }
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) return false;
  for (const key of expectedKeys) {
    if (!await sameStructuredValue((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], seen)) return false;
  }
  return true;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function databaseInfos(factory: IDBFactory): Promise<Array<{ name: string; version: number }>> {
  const enumeratingFactory = factory as IDBFactory & { databases?: () => Promise<Array<{ name?: string; version?: number }>> };
  if (typeof enumeratingFactory.databases !== "function") {
    return Promise.reject(new IdentityStorageMigrationError("This browser cannot enumerate IndexedDB databases; migration cannot safely assume the inventory is complete."));
  }
  return enumeratingFactory.databases().then((items) => {
    const result: Array<{ name: string; version: number }> = [];
    for (const item of items) {
      if (typeof item.name !== "string" || !Number.isInteger(item.version) || !item.version) {
        throw new IdentityStorageMigrationError("IndexedDB returned an incomplete database inventory; migration cannot safely skip it.");
      }
      result.push({ name: item.name, version: item.version });
    }
    return result;
  });
}

function openExistingDatabase(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    let settled = false;
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      if (!settled) { settled = true; reject(new IdentityStorageMigrationError(`IndexedDB database ${name} changed during migration.`)); }
    };
    request.onblocked = () => {
      if (!settled) { settled = true; reject(new IdentityStorageMigrationError(`IndexedDB database ${name} is blocked by another open connection.`)); }
    };
    request.onerror = () => {
      if (!settled) { settled = true; reject(request.error ?? new Error(`Could not open IndexedDB database ${name}.`)); }
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      resolve(request.result);
    };
  });
}

function schemaFromDatabase(database: IDBDatabase): IndexedDatabaseSchema {
  const storeNames = [...database.objectStoreNames];
  const stores = storeNames.map((name) => {
    const store = database.transaction(name, "readonly").objectStore(name);
    const indexes = [...store.indexNames].map((indexName) => {
      const index = store.index(indexName);
      return { name: index.name, keyPath: structuredClone(index.keyPath), unique: index.unique, multiEntry: index.multiEntry };
    });
    return { name, keyPath: structuredClone(store.keyPath), autoIncrement: store.autoIncrement, indexes };
  });
  return { name: database.name, version: database.version, stores };
}

export class BrowserIndexedDatabaseReader implements IndexedDatabaseReader {
  private readonly versions = new Map<string, number>();
  constructor(private readonly factory: IDBFactory) {}

  async listDatabases(): Promise<Array<{ name: string; version: number }>> {
    const databases = await databaseInfos(this.factory);
    this.versions.clear();
    for (const item of databases) this.versions.set(item.name, item.version);
    return databases;
  }

  async readSchema(name: string): Promise<IndexedDatabaseSchema> {
    if (!this.versions.has(name)) await this.listDatabases();
    const version = this.versions.get(name);
    if (!version) throw new IdentityStorageMigrationError(`IndexedDB source database ${name} no longer exists.`);
    const database = await openExistingDatabase(this.factory, name, version);
    try { return schemaFromDatabase(database); }
    finally { database.close(); }
  }

  async readBatch(name: string, storeName: string, afterKey: IDBValidKey | undefined, limit: number): Promise<IndexedDatabaseRecord[]> {
    if (!this.versions.has(name)) await this.listDatabases();
    const version = this.versions.get(name);
    if (!version) throw new IdentityStorageMigrationError(`IndexedDB source database ${name} no longer exists.`);
    const database = await openExistingDatabase(this.factory, name, version);
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readonly");
        const range = afterKey === undefined ? undefined : IDBKeyRange.lowerBound(afterKey, true);
        const request = transaction.objectStore(storeName).openCursor(range);
        const records: IndexedDatabaseRecord[] = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          records.push({ key: cursor.primaryKey, value: cursor.value });
          if (records.length < limit) cursor.continue();
        };
        request.onerror = () => reject(request.error ?? new Error(`Could not read ${name}/${storeName}.`));
        transaction.onabort = () => reject(transaction.error ?? new Error(`Read transaction aborted for ${name}/${storeName}.`));
        transaction.onerror = () => reject(transaction.error ?? new Error(`Read transaction failed for ${name}/${storeName}.`));
        transaction.oncomplete = () => resolve(records);
      });
    } finally { database.close(); }
  }

  async readKeysBatch(name: string, storeName: string, afterKey: IDBValidKey | undefined, limit: number): Promise<IDBValidKey[]> {
    if (!this.versions.has(name)) await this.listDatabases();
    const version = this.versions.get(name);
    if (!version) throw new IdentityStorageMigrationError(`IndexedDB source database ${name} no longer exists.`);
    const database = await openExistingDatabase(this.factory, name, version);
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readonly");
        const range = afterKey === undefined ? undefined : IDBKeyRange.lowerBound(afterKey, true);
        const request = transaction.objectStore(storeName).openKeyCursor(range);
        const keys: IDBValidKey[] = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          keys.push(cursor.primaryKey);
          if (keys.length < limit) cursor.continue();
        };
        request.onerror = () => reject(request.error ?? new Error(`Could not read keys in ${name}/${storeName}.`));
        transaction.onabort = () => reject(transaction.error ?? new Error(`Key read transaction aborted for ${name}/${storeName}.`));
        transaction.onerror = () => reject(transaction.error ?? new Error(`Key read transaction failed for ${name}/${storeName}.`));
        transaction.oncomplete = () => resolve(keys);
      });
    } finally { database.close(); }
  }

  async readRecord(name: string, storeName: string, key: IDBValidKey): Promise<unknown> {
    if (!this.versions.has(name)) await this.listDatabases();
    const version = this.versions.get(name);
    if (!version) throw new IdentityStorageMigrationError(`IndexedDB source database ${name} no longer exists.`);
    const database = await openExistingDatabase(this.factory, name, version);
    try {
      const transaction = database.transaction(storeName, "readonly");
      return await requestResult(transaction.objectStore(storeName).get(key));
    } finally { database.close(); }
  }
}

function keyPathsEqual(left: string | string[] | null, right: string | string[] | null): boolean {
  return Array.isArray(left) || Array.isArray(right)
    ? Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((part, index) => part === right[index])
    : left === right;
}

function mergeSchemaGaps(source: IndexedDatabaseSchema, destination: IndexedDatabaseSchema): Array<{ store: IndexedStoreSchema; missingIndexes: IndexedIndexSchema[] }> {
  const gaps: Array<{ store: IndexedStoreSchema; missingIndexes: IndexedIndexSchema[] }> = [];
  for (const sourceStore of source.stores) {
    const destinationStore = destination.stores.find((store) => store.name === sourceStore.name);
    if (!destinationStore) { gaps.push({ store: sourceStore, missingIndexes: sourceStore.indexes }); continue; }
    if (!keyPathsEqual(sourceStore.keyPath, destinationStore.keyPath) || sourceStore.autoIncrement !== destinationStore.autoIncrement) {
      throw new IdentityStorageMigrationError(`IndexedDB schema conflict in ${source.name}/${sourceStore.name}; destination schema was preserved.`);
    }
    const missingIndexes: IndexedIndexSchema[] = [];
    for (const sourceIndex of sourceStore.indexes) {
      const destinationIndex = destinationStore.indexes.find((index) => index.name === sourceIndex.name);
      if (!destinationIndex) { missingIndexes.push(sourceIndex); continue; }
      if (!keyPathsEqual(sourceIndex.keyPath, destinationIndex.keyPath) || sourceIndex.unique !== destinationIndex.unique || sourceIndex.multiEntry !== destinationIndex.multiEntry) {
        throw new IdentityStorageMigrationError(`IndexedDB index conflict in ${source.name}/${sourceStore.name}/${sourceIndex.name}; destination schema was preserved.`);
      }
    }
    if (missingIndexes.length) gaps.push({ store: sourceStore, missingIndexes });
  }
  return gaps;
}

function applySchema(database: IDBDatabase, transaction: IDBTransaction, source: IndexedDatabaseSchema): void {
  for (const sourceStore of source.stores) {
    const store = database.objectStoreNames.contains(sourceStore.name)
      ? transaction.objectStore(sourceStore.name)
      : database.createObjectStore(sourceStore.name, { keyPath: structuredClone(sourceStore.keyPath), autoIncrement: sourceStore.autoIncrement });
    for (const index of sourceStore.indexes) {
      if (!store.indexNames.contains(index.name)) {
        store.createIndex(index.name, structuredClone(index.keyPath), { unique: index.unique, multiEntry: index.multiEntry });
      }
    }
  }
}

export class BrowserIndexedDatabaseWriter implements IndexedDatabaseWriter {
  private readonly connections = new Map<string, IDBDatabase>();
  constructor(private readonly factory: IDBFactory) {}

  async ensureSchema(name: string, sourceSchema: IndexedDatabaseSchema): Promise<void> {
    const existing = (await databaseInfos(this.factory)).find((item) => item.name === name);
    if (!existing) {
      const database = await this.openForSchema(name, Math.max(1, sourceSchema.version), sourceSchema);
      this.connections.set(name, database);
      return;
    }
    const current = await openExistingDatabase(this.factory, name, existing.version);
    const currentSchema = schemaFromDatabase(current);
    current.close();
    const gaps = mergeSchemaGaps(sourceSchema, currentSchema);
    if (!gaps.length) {
      this.connections.set(name, await openExistingDatabase(this.factory, name, existing.version));
      return;
    }
    const nextVersion = Math.max(sourceSchema.version, existing.version + 1);
    const database = await this.openForSchema(name, nextVersion, sourceSchema);
    this.connections.set(name, database);
  }

  async hasRecord(name: string, storeName: string, key: IDBValidKey): Promise<boolean> {
    const database = this.requireConnection(name);
    const transaction = database.transaction(storeName, "readonly");
    const primaryKey = await requestResult(transaction.objectStore(storeName).getKey(key));
    return primaryKey !== undefined;
  }

  async writeRecord(name: string, storeName: string, record: IndexedDatabaseRecord, replaceOwned: boolean): Promise<boolean> {
    const database = this.requireConnection(name);
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.keyPath === null
        ? (replaceOwned ? store.put(record.value, record.key) : store.add(record.value, record.key))
        : (replaceOwned ? store.put(record.value) : store.add(record.value));
      let duplicate = false;
      request.onerror = (event) => {
        if (request.error?.name === "ConstraintError") {
          duplicate = true;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        reject(request.error ?? new Error(`Could not write ${name}/${storeName}.`));
      };
      transaction.oncomplete = () => resolve(!duplicate);
      transaction.onabort = () => reject(transaction.error ?? new Error(`Write transaction aborted for ${name}/${storeName}.`));
      transaction.onerror = () => { if (!duplicate) reject(transaction.error ?? new Error(`Write transaction failed for ${name}/${storeName}.`)); };
    });
  }

  async readRecord(name: string, storeName: string, key: IDBValidKey): Promise<unknown> {
    const database = this.requireConnection(name);
    const transaction = database.transaction(storeName, "readonly");
    return requestResult(transaction.objectStore(storeName).get(key));
  }

  close(): void {
    for (const database of this.connections.values()) database.close();
    this.connections.clear();
  }

  private requireConnection(name: string): IDBDatabase {
    const database = this.connections.get(name);
    if (!database) throw new IdentityStorageMigrationError(`Destination schema for ${name} has not been prepared.`);
    return database;
  }

  private openForSchema(name: string, version: number, source: IndexedDatabaseSchema): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.factory.open(name, version);
      request.onupgradeneeded = () => {
        try { applySchema(request.result, request.transaction!, source); }
        catch (error) { request.transaction?.abort(); reject(error); }
      };
      request.onblocked = () => reject(new IdentityStorageMigrationError(`Destination IndexedDB database ${name} is blocked by another open connection.`));
      request.onerror = () => reject(request.error ?? new Error(`Could not create destination IndexedDB database ${name}.`));
      request.onsuccess = () => resolve(request.result);
    });
  }
}

export class BrowserIdentityMigrationJournal implements IdentityMigrationJournal {
  private databasePromise: Promise<IDBDatabase> | undefined;
  constructor(private readonly factory: IDBFactory) {}

  async get(id: string): Promise<MigrationJournalState | undefined> {
    const transaction = (await this.database()).transaction(JOURNAL_STORE, "readonly");
    const entry = await requestResult(transaction.objectStore(JOURNAL_STORE).get(id)) as { state?: MigrationJournalState } | undefined;
    return entry?.state;
  }

  async set(id: string, state: MigrationJournalState): Promise<void> {
    const database = await this.database();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(JOURNAL_STORE, "readwrite");
      transaction.objectStore(JOURNAL_STORE).put({ id, state });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not write migration progress."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Migration progress write was interrupted."));
    });
  }

  async delete(id: string): Promise<void> {
    const database = await this.database();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(JOURNAL_STORE, "readwrite");
      transaction.objectStore(JOURNAL_STORE).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not clear completed migration progress."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Migration progress cleanup was interrupted."));
    });
  }

  close(): void {
    void this.databasePromise?.then((database) => database.close());
    this.databasePromise = undefined;
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = this.factory.open(IDENTITY_MIGRATION_JOURNAL_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(JOURNAL_STORE)) request.result.createObjectStore(JOURNAL_STORE, { keyPath: "id" });
      };
      request.onerror = () => reject(request.error ?? new Error("Could not open migration progress storage."));
      request.onblocked = () => reject(new IdentityStorageMigrationError("Migration progress storage is blocked by another open connection."));
      request.onsuccess = () => resolve(request.result);
    });
    return this.databasePromise;
  }
}
