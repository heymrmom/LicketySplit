import {
  BrowserIdentityMigrationJournal,
  BrowserIndexedDatabaseReader,
  BrowserIndexedDatabaseWriter,
  copyIndexedDatabase,
  copyLocalStorage,
  type IdentityMigrationJournal,
  type IndexedDatabaseReader,
  type IndexedDatabaseWriter,
  type LocalStoragePort,
  type IndexedDatabaseCopyProgress,
} from "./storage-copy";
import { IdentityStorageMigrationError } from "./storage-copy";
import type { UnavailableMigrationRecords } from "./status";

export const NAMESPACE_MIGRATION_STATUS_KEY = "__licketysplit_namespace_migration_v1__";
const RUN_ID = "storage-namespace-v1";

export const LEGACY_DATABASE_NAME_MAP = [
  ["openreel-db", "licketysplit-db"],
  ["openreel-projects", "licketysplit-projects"],
  ["openreel-autosave", "licketysplit-autosave"],
  ["openreel-secure", "licketysplit-secure"],
  ["openreel-motion-presets", "licketysplit-motion-presets"],
  ["openreel-templates", "licketysplit-templates"],
  ["openreel-custom-fonts", "licketysplit-custom-fonts"],
  ["openreel-multicam-analysis", "licketysplit-multicam-analysis"],
] as const;

export const LEGACY_LOCAL_STORAGE_KEY_MAP = [
  ["openreel-settings", "licketysplit-settings"],
  ["openreel-theme", "licketysplit-theme"],
  ["openreel-ui-preferences", "licketysplit-ui-preferences"],
  ["openreel-ai-chat-history", "licketysplit-ai-chat-history"],
  ["openreel-timeline-workspace", "licketysplit-timeline-workspace"],
  ["openreel_shortcuts", "licketysplit_shortcuts"],
  ["openreel_shortcut_preset", "licketysplit_shortcut_preset"],
  ["openreel_device_profile", "licketysplit_device_profile"],
  ["openreel-custom-export-presets", "licketysplit-custom-export-presets"],
  ["openreel-onboarding-complete", "licketysplit-onboarding-complete"],
  ["openreel-mograph-tour-complete", "licketysplit-mograph-tour-complete"],
  ["openreel-desktop-media-w", "licketysplit-desktop-media-w"],
  ["openreel-desktop-inspector-w", "licketysplit-desktop-inspector-w"],
  ["openreel-desktop-chat-w", "licketysplit-desktop-chat-w"],
  ["openreel-desktop-timeline-h", "licketysplit-desktop-timeline-h"],
  ["openreel.motionCreator.leftPanelWidth.v2", "licketysplit.motionCreator.leftPanelWidth.v2"],
  ["openreel.motionCreator.rightPanelWidth.v2", "licketysplit.motionCreator.rightPanelWidth.v2"],
  ["openreel.motionCreator.timelineHeight.v2", "licketysplit.motionCreator.timelineHeight.v2"],
] as const;

const legacyLocalStorageKeys = new Set<string>(LEGACY_LOCAL_STORAGE_KEY_MAP.map(([key]) => key));
const localStorageDestinationBySource = new Map<string, string>(LEGACY_LOCAL_STORAGE_KEY_MAP);

export type NamespaceMigrationResult =
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

class LegacyLocalStorageView implements LocalStoragePort {
  constructor(private readonly storage: LocalStoragePort) {}
  private keys(): string[] {
    const keys: string[] = [];
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (key === null) throw new IdentityStorageMigrationError("Local storage changed while its saved settings were being checked.");
      if (legacyLocalStorageKeys.has(key)) keys.push(key);
    }
    return keys;
  }
  get length(): number { return this.keys().length; }
  key(index: number): string | null { return this.keys()[index] ?? null; }
  getItem(key: string): string | null { return legacyLocalStorageKeys.has(key) ? this.storage.getItem(key) : null; }
  setItem(): void { throw new IdentityStorageMigrationError("The original profile is read-only during namespace migration."); }
}

export function readNamespaceMigrationComplete(storage: Pick<Storage, "getItem">): boolean {
  const raw = storage.getItem(NAMESPACE_MIGRATION_STATUS_KEY);
  if (raw === null) return false;
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch (error) { throw new IdentityStorageMigrationError("The saved-profile migration status is unreadable; the editor has not opened.", { cause: error }); }
  if (!value || typeof value !== "object" || (value as Record<string, unknown>).status !== "complete" || (value as Record<string, unknown>).version !== 1 || typeof (value as Record<string, unknown>).completedAt !== "number") {
    throw new IdentityStorageMigrationError("The saved-profile migration status could not be verified; retry before opening the editor.");
  }
  return true;
}

function writeNamespaceMigrationComplete(storage: LocalStoragePort, completedAt: number): void {
  const value = JSON.stringify({ status: "complete", version: 1, completedAt });
  try {
    storage.setItem(NAMESPACE_MIGRATION_STATUS_KEY, value);
    if (storage.getItem(NAMESPACE_MIGRATION_STATUS_KEY) !== value) throw new Error("Status readback did not match.");
  } catch (error) {
    throw new IdentityStorageMigrationError("The saved-profile migration could not be verified; the previous profile remains available.", { cause: error });
  }
}

/** Copy the explicit OpenReel storage names to LicketySplit names without deleting source data. */
export async function migrateLegacyNamespace(
  source: IndexedDatabaseReader,
  storage: LocalStoragePort,
  destination: IndexedDatabaseWriter,
  journal: IdentityMigrationJournal,
  options: {
    completedAt?: number;
    onIndexedDbProgress?: (progress: IndexedDatabaseCopyProgress) => void;
  } = {},
): Promise<NamespaceMigrationResult> {
  const localStorage = await copyLocalStorage(
    new LegacyLocalStorageView(storage),
    storage,
    journal,
    {
      runId: RUN_ID,
      mapKey: (key) => localStorageDestinationBySource.get(key) ?? "",
      mapValue: (key, value) => key === "openreel_shortcut_preset" && value === "openreel" ? "licketysplit" : value,
    },
  );

  const sourceNames = new Set((await source.listDatabases()).map(({ name }) => name));
  const mappings = LEGACY_DATABASE_NAME_MAP.filter(([sourceName]) => sourceNames.has(sourceName));
  const unavailableByLocation = new Map<string, { databaseName: string; storeName: string }>();
  let copied = 0;
  let preserved = 0;
  for (const [sourceName, destinationName] of mappings) {
    const result = await copyIndexedDatabase(source, destination, journal, {
      sourceName,
      destinationName,
      runId: RUN_ID,
      onProgress: options.onIndexedDbProgress,
      onUncopyableRecord: ({ databaseName, storeName }) => {
        unavailableByLocation.set(`${databaseName}\0${storeName}`, { databaseName, storeName });
      },
    });
    copied += result.copied;
    preserved += result.preserved;
  }
  const unavailable = [...unavailableByLocation.values()];
  if (unavailable.length) return { status: "incomplete", unavailable, localStorage, indexedDB: { databases: mappings.length, copied, preserved } };

  writeNamespaceMigrationComplete(storage, options.completedAt ?? Date.now());
  return { status: "complete", localStorage, indexedDB: { databases: mappings.length, copied, preserved } };
}

export async function migrateLegacyNamespaceInBrowser(
  storage: LocalStoragePort,
  factory: IDBFactory,
  options: Parameters<typeof migrateLegacyNamespace>[4] = {},
): Promise<NamespaceMigrationResult> {
  const source = new BrowserIndexedDatabaseReader(factory);
  const destination = new BrowserIndexedDatabaseWriter(factory);
  const journal = new BrowserIdentityMigrationJournal(factory);
  try { return await migrateLegacyNamespace(source, storage, destination, journal, options); }
  finally {
    destination.close();
    journal.close();
  }
}
