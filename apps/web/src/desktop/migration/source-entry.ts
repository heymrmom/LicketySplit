/* global IDBValidKey */
import { BrowserIndexedDatabaseReader, IdentityStorageMigrationError } from "./storage-copy";
import {
  IDENTITY_MIGRATION_PROTOCOL_VERSION,
  isNativeMigrationPortEvent,
  isSequentialMigrationRequest,
  LEGACY_APP_ORIGIN,
  type MigrationRequestOperation,
} from "./transport-protocol";

type SourceRequest = {
  version: number;
  nonce: string;
  requestId: number;
  operation: MigrationRequestOperation;
  payload: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IdentityStorageMigrationError("The migration request was invalid.");
  return value as Record<string, unknown>;
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function send(port: MessagePort, nonce: string, requestId: number, response: Record<string, unknown>): void {
  port.postMessage({ version: IDENTITY_MIGRATION_PROTOCOL_VERSION, nonce, requestId, ...response });
}

export function installLegacyMigrationSource(targetWindow: Window = window, requestedNonce?: string | null): () => void {
  const nonce = requestedNonce ?? new URLSearchParams(targetWindow.location.search).get("nonce");
  if (targetWindow.location.origin !== LEGACY_APP_ORIGIN || targetWindow.parent !== targetWindow || !nonce || nonce.length > 128) return () => undefined;
  const reader = new BrowserIndexedDatabaseReader(targetWindow.indexedDB);
  let port: MessagePort | undefined;
  let nextRequestId = 1;
  let pendingRecord: { name: string; storeName: string; key: IDBValidKey } | undefined;

  const onPort = (event: MessageEvent<unknown>): void => {
    if (!isNativeMigrationPortEvent(event, LEGACY_APP_ORIGIN, targetWindow, nonce, "source")) return;
    const sourcePort = event.ports[0];
    if (!sourcePort) return;
    targetWindow.removeEventListener("message", onPort);
    port = sourcePort;
    port.onmessage = (message: MessageEvent<unknown>) => {
      let request: SourceRequest;
      try {
        const parsed = record(message.data);
        if (!isSequentialMigrationRequest(parsed, nonce, nextRequestId, Boolean(pendingRecord))) throw new IdentityStorageMigrationError("The migration request was duplicated or out of order.");
        request = parsed as unknown as SourceRequest;
        request.payload = record(request.payload);
        nextRequestId += 1;
      } catch (error) {
        try { send(port!, nonce, nextRequestId, { ok: false, error: error instanceof Error ? error.message : "Invalid migration request." }); }
        catch { port?.close(); }
        return;
      }

      void (async () => {
        try {
          const args = request.payload;
          let result: unknown;
          switch (request.operation) {
            case "localStorage.listKeys": {
              const keys: string[] = [];
              for (let index = 0; index < targetWindow.localStorage.length; index += 1) {
                const key = targetWindow.localStorage.key(index);
                if (key === null) throw new IdentityStorageMigrationError("Legacy local storage changed during inventory.");
                keys.push(key);
              }
              result = keys;
              break;
            }
            case "localStorage.readValue": {
              if (!validString(args.key)) throw new IdentityStorageMigrationError("The requested local storage key was invalid.");
              result = targetWindow.localStorage.getItem(args.key);
              break;
            }
            case "database.list":
              result = await reader.listDatabases();
              break;
            case "database.readSchema": {
              if (!validString(args.name)) throw new IdentityStorageMigrationError("The requested database name was invalid.");
              result = await reader.readSchema(args.name);
              break;
            }
            case "database.readKeys": {
              if (!validString(args.name) || !validString(args.storeName) || !Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 512) {
                throw new IdentityStorageMigrationError("The requested record page was invalid.");
              }
              result = await reader.readKeysBatch(args.name, args.storeName, args.afterKey as IDBValidKey | undefined, args.limit as number);
              break;
            }
            case "database.readRecord": {
              if (!validString(args.name) || !validString(args.storeName) || args.key === undefined) throw new IdentityStorageMigrationError("The requested record key was invalid.");
              const key = args.key as IDBValidKey;
              result = await reader.readRecord(args.name, args.storeName, key);
              pendingRecord = { name: args.name, storeName: args.storeName, key };
              try { send(port!, nonce, request.requestId, { ok: true, result }); }
              catch (error) {
                if (error && typeof error === "object" && "name" in error && error.name === "DataCloneError") {
                  send(port!, nonce, request.requestId, { ok: false, code: "uncopyable-record", error: "A stored file-system handle or structured value cannot be moved between the two app origins." });
                  return;
                }
                throw error;
              }
              return;
            }
            case "database.finishRecord": {
              if (!pendingRecord || !validString(args.name) || !validString(args.storeName) || args.outcome !== "verified" && args.outcome !== "unavailable") {
                throw new IdentityStorageMigrationError("The source record acknowledgement did not match a pending record.");
              }
              let sameKey = false;
              try { sameKey = targetWindow.indexedDB.cmp(pendingRecord.key, args.key as IDBValidKey) === 0; }
              catch { sameKey = false; }
              if (pendingRecord.name !== args.name || pendingRecord.storeName !== args.storeName || !sameKey) {
                throw new IdentityStorageMigrationError("The source record acknowledgement did not match a pending record.");
              }
              pendingRecord = undefined;
              result = { accepted: true };
              break;
            }
          }
          send(port!, nonce, request.requestId, { ok: true, result });
        } catch (error) {
          if (request.operation === "database.readRecord" && error && typeof error === "object" && "name" in error && error.name === "DataCloneError") {
            const args = request.payload;
            pendingRecord = { name: args.name as string, storeName: args.storeName as string, key: args.key as IDBValidKey };
            send(port!, nonce, request.requestId, { ok: false, code: "uncopyable-record", error: "A stored file-system handle or structured value cannot be moved between the two app origins." });
            return;
          }
          send(port!, nonce, request.requestId, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    };
    port.onmessageerror = () => port?.close();
    port.start();
  };

  targetWindow.addEventListener("message", onPort);
  return () => {
    targetWindow.removeEventListener("message", onPort);
    port?.close();
  };
}

installLegacyMigrationSource();
