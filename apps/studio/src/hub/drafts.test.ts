import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { openDB } from "idb";
import { saveDraft, loadDraft, listDrafts, deleteDraft } from "./drafts";

const LEGACY_DB_NAME = "openreel-studio";
const DRAFTS_STORE = "drafts";

async function seedLegacyDraft(record: {
  id: string; kind: "effect" | "filter" | "template"; name: string; doc: unknown;
  thumbnailDataUrl: string; updatedAt: number; schemaVersion: number;
}) {
  const db = await openDB(LEGACY_DB_NAME, 1, {
    upgrade(database) {
      const store = database.createObjectStore(DRAFTS_STORE, { keyPath: "id" });
      store.createIndex("updatedAt", "updatedAt");
    },
  });
  await db.put(DRAFTS_STORE, record);
  db.close();
}

async function readLegacyDraft(id: string) {
  const databases = await indexedDB.databases();
  if (!databases.some((database) => database.name === LEGACY_DB_NAME)) return undefined;
  const db = await openDB(LEGACY_DB_NAME);
  const record = await db.get(DRAFTS_STORE, id);
  db.close();
  return record;
}

describe("drafts (IndexedDB)", () => {
  beforeEach(async () => {
    const drafts = await listDrafts();
    await Promise.all(drafts.map((d) => deleteDraft(d.id)));
  });

  it("saves and reloads a draft", async () => {
    await saveDraft({
      id: "d-1",
      kind: "effect",
      name: "My Effect",
      doc: { subjects: [], sampleClipId: "portrait-closeup-01" },
      thumbnailDataUrl: "",
      updatedAt: Date.now(),
      schemaVersion: 1,
    });
    const loaded = await loadDraft("d-1");
    expect(loaded?.name).toBe("My Effect");
  });

  it("lists drafts sorted by updatedAt desc", async () => {
    await saveDraft({
      id: "d-old", kind: "effect", name: "Old", doc: { subjects: [], sampleClipId: "x" },
      thumbnailDataUrl: "", updatedAt: 1000, schemaVersion: 1,
    });
    await saveDraft({
      id: "d-new", kind: "effect", name: "New", doc: { subjects: [], sampleClipId: "x" },
      thumbnailDataUrl: "", updatedAt: 2000, schemaVersion: 1,
    });
    const list = await listDrafts();
    expect(list.map((d) => d.id)).toEqual(["d-new", "d-old"]);
  });

  it("reads and lists legacy drafts without modifying their source records", async () => {
    const legacy = {
      id: "legacy-draft", kind: "effect" as const, name: "Legacy", doc: { preserved: true },
      thumbnailDataUrl: "data:image/png;base64,AA==", updatedAt: 1000, schemaVersion: 1,
    };
    await seedLegacyDraft(legacy);

    expect(await loadDraft(legacy.id)).toEqual(legacy);
    expect((await listDrafts()).some((draft) => draft.id === legacy.id)).toBe(true);
    expect(await readLegacyDraft(legacy.id)).toEqual(legacy);
  });

  it("prefers destination records and saves without overwriting the legacy source", async () => {
    await seedLegacyDraft({
      id: "shared", kind: "filter", name: "Old", doc: { source: "old" },
      thumbnailDataUrl: "old-image", updatedAt: 1000, schemaVersion: 1,
    });
    await saveDraft({
      id: "shared", kind: "filter", name: "New", doc: { source: "new" },
      thumbnailDataUrl: "new-image", updatedAt: 2000, schemaVersion: 1,
    });

    expect((await loadDraft("shared"))?.name).toBe("New");
    expect((await listDrafts()).filter((draft) => draft.id === "shared")).toHaveLength(1);
    expect((await readLegacyDraft("shared"))?.name).toBe("Old");
  });

  it("does not create a missing legacy database just to list drafts", async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(LEGACY_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("legacy database deletion blocked"));
    });

    await listDrafts();

    const databases = await indexedDB.databases();
    expect(databases.some((database) => database.name === LEGACY_DB_NAME)).toBe(false);
  });

  it("uses an aborting probe without creating the legacy DB when database enumeration is unavailable", async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(indexedDB, "databases");
    Object.defineProperty(indexedDB, "databases", { configurable: true, value: undefined });
    try {
      await listDrafts();
      const request = indexedDB.open(LEGACY_DB_NAME);
      const created = await new Promise<boolean>((resolve, reject) => {
        let needsCreation = false;
        request.onupgradeneeded = () => {
          needsCreation = true;
          request.transaction?.abort();
        };
        request.onsuccess = () => {
          request.result.close();
          resolve(false);
        };
        request.onerror = () => {
          if (needsCreation && request.error?.name === "AbortError") resolve(true);
          else reject(request.error);
        };
      });
      expect(created).toBe(true);
    } finally {
      if (originalDescriptor) Object.defineProperty(indexedDB, "databases", originalDescriptor);
      else Reflect.deleteProperty(indexedDB, "databases");
    }
  });

  it("surfaces an existing legacy database with an unexpected schema", async () => {
    const db = await openDB(LEGACY_DB_NAME, 1, {
      upgrade(database) {
        database.createObjectStore("unrelated", { keyPath: "id" });
      },
    });
    db.close();

    await expect(listDrafts()).rejects.toThrow("missing its drafts store");

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(LEGACY_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("legacy database deletion blocked"));
    });
  });

  it("explicit deletion removes both destination and legacy copies", async () => {
    await seedLegacyDraft({
      id: "delete-me", kind: "template", name: "Old", doc: {},
      thumbnailDataUrl: "", updatedAt: 1000, schemaVersion: 1,
    });
    await saveDraft({
      id: "delete-me", kind: "template", name: "New", doc: {},
      thumbnailDataUrl: "", updatedAt: 2000, schemaVersion: 1,
    });

    await deleteDraft("delete-me");

    expect(await loadDraft("delete-me")).toBeUndefined();
    expect(await readLegacyDraft("delete-me")).toBeUndefined();
  });
});
