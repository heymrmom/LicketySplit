/* global MessageEventSource */
export const IDENTITY_MIGRATION_PROTOCOL_VERSION = 1;
export const IDENTITY_MIGRATION_STATUS_KEY = "__licketysplit_identity_migration_control_v2__";
export const IDENTITY_MIGRATION_JOURNAL_DB_NAME = "__licketysplit_identity_migration__";
export const LEGACY_APP_ORIGIN = "app://openreel";
export const NEW_APP_ORIGIN = "app://licketysplit";

export type MigrationRequestOperation =
  | "localStorage.listKeys"
  | "localStorage.readValue"
  | "database.list"
  | "database.readSchema"
  | "database.readKeys"
  | "database.readRecord"
  | "database.finishRecord";

type EventLike = { origin: string; source: MessageEventSource | null; data: unknown; ports?: readonly MessagePort[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNativeMigrationPortEvent(
  event: EventLike,
  expectedOrigin: string,
  expectedSource: MessageEventSource,
  nonce: string,
  role: "destination" | "source",
): boolean {
  if (event.origin !== expectedOrigin || event.source !== expectedSource || !Array.isArray(event.ports) || event.ports.length !== 1) return false;
  return isRecord(event.data)
    && event.data.type === "licketysplit-native-migration-port"
    && event.data.version === IDENTITY_MIGRATION_PROTOCOL_VERSION
    && event.data.nonce === nonce
    && event.data.role === role;
}

const OPERATIONS = new Set<MigrationRequestOperation>([
  "localStorage.listKeys",
  "localStorage.readValue",
  "database.list",
  "database.readSchema",
  "database.readKeys",
  "database.readRecord",
  "database.finishRecord",
]);

export function isSequentialMigrationRequest(
  value: unknown,
  nonce: string,
  expectedRequestId: number,
  awaitingRecordAcknowledgement: boolean,
): boolean {
  if (!isRecord(value)
    || value.version !== IDENTITY_MIGRATION_PROTOCOL_VERSION
    || value.nonce !== nonce
    || value.requestId !== expectedRequestId
    || typeof value.operation !== "string"
    || !OPERATIONS.has(value.operation as MigrationRequestOperation)) return false;
  return awaitingRecordAcknowledgement
    ? value.operation === "database.finishRecord"
    : value.operation !== "database.finishRecord";
}

export function parseMigrationStatus(value: string | null):
  | { status: "complete"; version: 2; completedAt: number }
  | { status: "accepted-incomplete"; version: 2; acceptedAt: number; unavailable: Array<{ databaseName: string; storeName: string }> }
  | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== 2) return undefined;
    if (parsed.status === "complete" && Number.isFinite(parsed.completedAt)) {
      return { status: "complete", version: 2, completedAt: parsed.completedAt as number };
    }
    if (parsed.status === "accepted-incomplete" && Number.isFinite(parsed.acceptedAt) && Array.isArray(parsed.unavailable)) {
      const unavailable = parsed.unavailable.filter((entry): entry is { databaseName: string; storeName: string } =>
        isRecord(entry) && typeof entry.databaseName === "string" && typeof entry.storeName === "string");
      if (unavailable.length !== parsed.unavailable.length) return undefined;
      return { status: "accepted-incomplete", version: 2, acceptedAt: parsed.acceptedAt as number, unavailable };
    }
  } catch { /* malformed marker is handled as incomplete and retried */ }
  return undefined;
}
