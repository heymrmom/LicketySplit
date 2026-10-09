/* global IDBValidKey */
import {
  IdentityStorageMigrationError,
  UncopyableIndexedDatabaseRecordError,
  type IndexedDatabaseReader,
  type IndexedDatabaseSchema,
  type LocalStorageReader,
} from "./storage-copy";
import {
  IDENTITY_MIGRATION_PROTOCOL_VERSION,
  isLegacyReadyEvent,
  type MigrationRequestOperation,
  LEGACY_APP_ORIGIN,
} from "./transport-protocol";

const HANDSHAKE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;

type RpcPayload = Record<string, unknown>;
type PendingRequest = {
  requestId: number;
  operation: MigrationRequestOperation;
  payload: RpcPayload;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IdentityStorageMigrationError("The legacy profile returned an invalid migration response.");
  return value as Record<string, unknown>;
}

function sameIdbKey(left: IDBValidKey, right: IDBValidKey): boolean {
  try { return indexedDB.cmp(left, right) === 0; }
  catch { return false; }
}

export class LegacyMigrationReader implements IndexedDatabaseReader, LocalStorageReader {
  private nextRequestId = 1;
  private pending: PendingRequest | undefined;
  private awaitingRecord: { databaseName: string; storeName: string; key: IDBValidKey } | undefined;
  private closed = false;

  constructor(private readonly port: MessagePort, private readonly nonce: string) {
    port.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
    port.onmessageerror = () => this.receiveMessageError();
    port.start();
  }

  listKeys(): Promise<string[]> {
    return this.request<string[]>("localStorage.listKeys", {});
  }

  readValue(key: string): Promise<string | null> {
    return this.request<string | null>("localStorage.readValue", { key });
  }

  listDatabases(): Promise<Array<{ name: string; version: number }>> {
    return this.request<Array<{ name: string; version: number }>>("database.list", {});
  }

  readSchema(name: string): Promise<IndexedDatabaseSchema> {
    return this.request<IndexedDatabaseSchema>("database.readSchema", { name });
  }

  readKeysBatch(name: string, storeName: string, afterKey: IDBValidKey | undefined, limit: number): Promise<IDBValidKey[]> {
    return this.request<IDBValidKey[]>("database.readKeys", { name, storeName, afterKey, limit });
  }

  readRecord(name: string, storeName: string, key: IDBValidKey): Promise<unknown> {
    return this.request("database.readRecord", { name, storeName, key });
  }

  async finishRecordTransfer(name: string, storeName: string, key: IDBValidKey, outcome: "verified" | "unavailable"): Promise<void> {
    const current = this.awaitingRecord;
    if (!current || current.databaseName !== name || current.storeName !== storeName || !sameIdbKey(current.key, key)) {
      throw new IdentityStorageMigrationError("The legacy profile is waiting for a different record acknowledgement.");
    }
    await this.request("database.finishRecord", { name, storeName, key, outcome });
    this.awaitingRecord = undefined;
  }

  /** The coordinator uses keys-first reads so an existing destination row never transfers its old value. */
  readBatch(): Promise<never> {
    return Promise.reject(new IdentityStorageMigrationError("The legacy migration reader requires bounded keys-first reads."));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new IdentityStorageMigrationError("The legacy migration connection was closed.");
    this.pending?.reject(error);
    this.pending = undefined;
    this.port.close();
  }

  private request<T>(operation: MigrationRequestOperation, payload: RpcPayload): Promise<T> {
    if (this.closed) return Promise.reject(new IdentityStorageMigrationError("The legacy migration connection is closed."));
    if (this.pending) return Promise.reject(new IdentityStorageMigrationError("The legacy migration transport allows one outstanding request."));
    if (this.awaitingRecord && operation !== "database.finishRecord") {
      return Promise.reject(new IdentityStorageMigrationError("The destination must verify or skip the current source record before another is requested."));
    }
    if (!this.awaitingRecord && operation === "database.finishRecord") {
      return Promise.reject(new IdentityStorageMigrationError("There is no source record awaiting acknowledgement."));
    }
    const requestId = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending?.requestId !== requestId) return;
        this.pending = undefined;
        reject(new IdentityStorageMigrationError(`The legacy profile did not answer ${operation}; the original data remains available for retry.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending = { requestId, operation, payload, resolve: resolve as (value: unknown) => void, reject, timeout };
      try {
        this.port.postMessage({ version: IDENTITY_MIGRATION_PROTOCOL_VERSION, nonce: this.nonce, requestId, operation, payload });
      } catch (error) {
        clearTimeout(timeout);
        this.pending = undefined;
        reject(new IdentityStorageMigrationError(`Could not request ${operation} from the legacy profile.`, { cause: error }));
      }
    });
  }

  private receive(value: unknown): void {
    const pending = this.pending;
    if (!pending) return;
    let response: Record<string, unknown>;
    try { response = asRecord(value); }
    catch (error) {
      clearTimeout(pending.timeout);
      this.pending = undefined;
      pending.reject(error instanceof Error ? error : new IdentityStorageMigrationError("The legacy profile returned an invalid migration response."));
      return;
    }
    if (response.version !== IDENTITY_MIGRATION_PROTOCOL_VERSION || response.nonce !== this.nonce || response.requestId !== pending.requestId || typeof response.ok !== "boolean") {
      clearTimeout(pending.timeout);
      this.pending = undefined;
      pending.reject(new IdentityStorageMigrationError("The legacy profile returned an unauthenticated or out-of-order migration response."));
      return;
    }
    clearTimeout(pending.timeout);
    this.pending = undefined;
    if (pending.operation === "database.readRecord") {
      const { name, storeName, key } = pending.payload;
      this.awaitingRecord = { databaseName: name as string, storeName: storeName as string, key: key as IDBValidKey };
    }
    if (response.ok) pending.resolve(response.result);
    else if (response.code === "uncopyable-record" && pending.operation === "database.readRecord") {
      const { name, storeName, key } = pending.payload;
      pending.reject(new UncopyableIndexedDatabaseRecordError(name as string, storeName as string, key as IDBValidKey));
    } else pending.reject(new IdentityStorageMigrationError(typeof response.error === "string" ? response.error : "The legacy profile could not read this value."));
  }

  private receiveMessageError(): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending = undefined;
    if (pending.operation === "database.readRecord") {
      const { name, storeName, key } = pending.payload;
      this.awaitingRecord = { databaseName: name as string, storeName: storeName as string, key: key as IDBValidKey };
      pending.reject(new UncopyableIndexedDatabaseRecordError(name as string, storeName as string, key as IDBValidKey));
    } else pending.reject(new IdentityStorageMigrationError("The legacy profile returned an unreadable migration message; the original data remains available."));
  }
}

export async function connectLegacyMigrationReader(
  iframe: HTMLIFrameElement,
  nonce: string,
  targetWindow: Window = window,
): Promise<LegacyMigrationReader> {
  return new Promise((resolve, reject) => {
    const legacyWindow = iframe.contentWindow;
    if (!legacyWindow) {
      reject(new IdentityStorageMigrationError("The legacy migration frame could not be created."));
      return;
    }
    const timeout = setTimeout(() => finish(new IdentityStorageMigrationError("The legacy profile did not open its migration reader; retry without closing the app.")), HANDSHAKE_TIMEOUT_MS);
    const finish = (error?: Error, reader?: LegacyMigrationReader): void => {
      clearTimeout(timeout);
      targetWindow.removeEventListener("message", onReady);
      iframe.removeEventListener("error", onFrameError);
      if (error) reject(error);
      else if (reader) resolve(reader);
    };
    const onFrameError = (): void => finish(new IdentityStorageMigrationError("The legacy migration page could not be loaded; the original profile was not changed."));
    const onReady = (event: MessageEvent<unknown>): void => {
      if (!isLegacyReadyEvent(event, LEGACY_APP_ORIGIN, legacyWindow, nonce)) return;
      const channel = new MessageChannel();
      try {
        legacyWindow.postMessage({ type: "licketysplit-migration-start", version: IDENTITY_MIGRATION_PROTOCOL_VERSION, nonce }, LEGACY_APP_ORIGIN, [channel.port2]);
      } catch (error) {
        channel.port1.close();
        channel.port2.close();
        finish(new IdentityStorageMigrationError("Could not securely start the legacy migration reader.", { cause: error }));
        return;
      }
      finish(undefined, new LegacyMigrationReader(channel.port1, nonce));
    };
    targetWindow.addEventListener("message", onReady);
    iframe.addEventListener("error", onFrameError, { once: true });
    iframe.referrerPolicy = "no-referrer";
    iframe.title = "Legacy profile migration reader";
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    iframe.src = `${LEGACY_APP_ORIGIN}/migration.html?nonce=${encodeURIComponent(nonce)}`;
  });
}
