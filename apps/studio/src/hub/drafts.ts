import { openDB, wrap, type IDBPDatabase } from "idb";
import type { Scene } from "../effect/scene";
import type { FilterDoc } from "../filter/types";

const DB_NAME = "licketysplit-studio";
const LEGACY_DB_NAME = "openreel-studio";
const STORE = "drafts";
const DB_VERSION = 1;

export interface DraftRecord {
  id: string;
  kind: "effect" | "filter" | "template";
  name: string;
  doc: Scene | FilterDoc | unknown;
  thumbnailDataUrl: string;
  updatedAt: number;
  schemaVersion: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STORE)) {
          const store = database.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("updatedAt", "updatedAt");
        }
      },
    });
  }
  return dbPromise;
}

async function openExistingLegacyDb(): Promise<IDBPDatabase | undefined> {
  if (typeof indexedDB.databases === "function") {
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database.name === LEGACY_DB_NAME)) return undefined;
  }

  return new Promise((resolve, reject) => {
    let abortedCreation = false;
    const request = indexedDB.open(LEGACY_DB_NAME);
    request.onupgradeneeded = () => {
      abortedCreation = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      const database = request.result;
      if (abortedCreation) {
        database.close();
        resolve(undefined);
      } else {
        resolve(wrap(database));
      }
    };
    request.onerror = () => {
      if (abortedCreation && request.error?.name === "AbortError") {
        resolve(undefined);
      } else {
        reject(request.error ?? new Error("Unable to open legacy Studio drafts"));
      }
    };
  });
}

async function readLegacyDraft(id: string): Promise<DraftRecord | undefined> {
  const database = await openExistingLegacyDb();
  if (!database) return undefined;
  try {
    if (!database.objectStoreNames.contains(STORE)) {
      throw new Error("The legacy Studio database is missing its drafts store");
    }
    return (await database.get(STORE, id)) as DraftRecord | undefined;
  } finally {
    database.close();
  }
}

async function readLegacyDrafts(): Promise<DraftRecord[]> {
  const database = await openExistingLegacyDb();
  if (!database) return [];
  try {
    if (!database.objectStoreNames.contains(STORE)) {
      throw new Error("The legacy Studio database is missing its drafts store");
    }
    return (await database.getAll(STORE)) as DraftRecord[];
  } finally {
    database.close();
  }
}

async function deleteLegacyDraft(id: string): Promise<void> {
  const database = await openExistingLegacyDb();
  if (!database) return;
  try {
    if (!database.objectStoreNames.contains(STORE)) {
      throw new Error("The legacy Studio database is missing its drafts store");
    }
    await database.delete(STORE, id);
  } finally {
    database.close();
  }
}

export async function saveDraft(record: DraftRecord): Promise<void> {
  const d = await db();
  await d.put(STORE, record);
}

export async function loadDraft(id: string): Promise<DraftRecord | undefined> {
  const d = await db();
  const current = (await d.get(STORE, id)) as DraftRecord | undefined;
  return current ?? readLegacyDraft(id);
}

export async function listDrafts(): Promise<DraftRecord[]> {
  const d = await db();
  const [current, legacy] = await Promise.all([
    d.getAll(STORE) as Promise<DraftRecord[]>,
    readLegacyDrafts(),
  ]);
  const byId = new Map(legacy.map((record) => [record.id, record]));
  for (const record of current) byId.set(record.id, record);
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteDraft(id: string): Promise<void> {
  const d = await db();
  await d.delete(STORE, id);
  await deleteLegacyDraft(id);
}
