/* global IDBValidKey */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectLegacyMigrationReader, LegacyMigrationReader } from "./transport";
import { UncopyableIndexedDatabaseRecordError } from "./storage-copy";
import { NEW_APP_ORIGIN } from "./transport-protocol";

type PortMessage = { version: number; nonce: string; requestId: number; operation: string; payload: Record<string, unknown> };

class RecordingPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly sent: PortMessage[] = [];
  start(): void {}
  close(): void {}
  postMessage(value: unknown): void { this.sent.push(value as PortMessage); }
  respond(request: PortMessage, result: unknown = null): void {
    this.onmessage?.({ data: { version: request.version, nonce: request.nonce, requestId: request.requestId, ok: true, result } } as MessageEvent<unknown>);
  }
  failIncomingRecord(): void { this.onmessageerror?.({ data: null } as MessageEvent<unknown>); }
}

const nonce = "migration-test-nonce";
const databaseFactory = window.indexedDB;
const previousCompare = Object.getOwnPropertyDescriptor(databaseFactory, "cmp");

beforeEach(() => {
  Object.defineProperty(databaseFactory, "cmp", { configurable: true, value: (left: IDBValidKey, right: IDBValidKey) => left === right ? 0 : 1 });
});

afterEach(() => {
  if (previousCompare) Object.defineProperty(databaseFactory, "cmp", previousCompare);
  else Reflect.deleteProperty(databaseFactory, "cmp");
});

describe("legacy migration record acknowledgements", () => {
  it("clears the outstanding request timeout when the migration reader closes", async () => {
    vi.useFakeTimers();
    try {
      const port = new RecordingPort();
      const reader = new LegacyMigrationReader(port as unknown as MessagePort, nonce);
      const request = reader.listDatabases();
      expect(vi.getTimerCount()).toBe(1);

      await reader.close();

      await expect(request).rejects.toThrow("connection was closed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires destination acknowledgement before the next source read", async () => {
    const port = new RecordingPort();
    const reader = new LegacyMigrationReader(port as unknown as MessagePort, nonce);
    const key = "project-1";
    const transfer = reader.readRecord("projects", "items", key);
    const readRequest = port.sent[0]!;
    port.respond(readRequest, { id: key, name: "Episode" });

    await expect(transfer).resolves.toEqual({ id: key, name: "Episode" });
    await expect(reader.listDatabases()).rejects.toThrow("verify or skip the current source record");
    await expect(reader.finishRecordTransfer("projects", "items", "other", "verified")).rejects.toThrow("different record acknowledgement");

    const acknowledgement = reader.finishRecordTransfer("projects", "items", key, "verified");
    const ackRequest = port.sent[1]!;
    expect(ackRequest.operation).toBe("database.finishRecord");
    expect(ackRequest.payload).toEqual({ name: "projects", storeName: "items", key, outcome: "verified" });
    port.respond(ackRequest, { accepted: true });
    await acknowledgement;

    const databases = reader.listDatabases();
    port.respond(port.sent[2]!, [{ name: "projects", version: 1 }]);
    await expect(databases).resolves.toEqual([{ name: "projects", version: 1 }]);
    await reader.close();
  });

  it("treats a structured-clone messageerror as an unavailable source record that can be acknowledged", async () => {
    const port = new RecordingPort();
    const reader = new LegacyMigrationReader(port as unknown as MessagePort, nonce);
    const key = 9;
    const transfer = reader.readRecord("media", "assets", key);
    port.failIncomingRecord();
    await expect(transfer).rejects.toBeInstanceOf(UncopyableIndexedDatabaseRecordError);

    const acknowledgement = reader.finishRecordTransfer("media", "assets", key, "unavailable");
    const ackRequest = port.sent[1]!;
    expect(ackRequest.operation).toBe("database.finishRecord");
    expect(ackRequest.payload.outcome).toBe("unavailable");
    port.respond(ackRequest, { accepted: true });
    await acknowledgement;
    await reader.close();
  });
});

describe("native top-level migration bridge", () => {
  it("installs the destination listener before starting and stops the hidden reader on close", async () => {
    const port = new RecordingPort();
    const stop = vi.fn(async () => undefined);
    const control = {
      start: vi.fn(async (requestedNonce: string) => {
        window.dispatchEvent(new MessageEvent("message", {
          origin: NEW_APP_ORIGIN,
          source: window,
          data: { type: "licketysplit-native-migration-port", version: 1, nonce: requestedNonce, role: "destination" },
          ports: [port as unknown as MessagePort],
        }));
      }),
      stop,
    };

    const reader = await connectLegacyMigrationReader(nonce, window, control);
    expect(control.start).toHaveBeenCalledWith(nonce);
    const databases = reader.listDatabases();
    port.respond(port.sent[0]!, [{ name: "openreel-projects", version: 3 }]);
    await expect(databases).resolves.toEqual([{ name: "openreel-projects", version: 3 }]);

    await reader.close();
    expect(stop).toHaveBeenCalledWith(nonce);
  });

  it("ignores a mismatched envelope until the native bridge supplies the exact destination port", async () => {
    const port = new RecordingPort();
    const control = {
      start: vi.fn(async (requestedNonce: string) => {
        window.dispatchEvent(new MessageEvent("message", {
          origin: "app://evil",
          source: window,
          data: { type: "licketysplit-native-migration-port", version: 1, nonce: requestedNonce, role: "destination" },
          ports: [port as unknown as MessagePort],
        }));
        window.dispatchEvent(new MessageEvent("message", {
          origin: NEW_APP_ORIGIN,
          source: window,
          data: { type: "licketysplit-native-migration-port", version: 1, nonce: "wrong", role: "destination" },
          ports: [port as unknown as MessagePort],
        }));
        window.dispatchEvent(new MessageEvent("message", {
          origin: NEW_APP_ORIGIN,
          source: window,
          data: { type: "licketysplit-native-migration-port", version: 1, nonce: requestedNonce, role: "destination" },
          ports: [port as unknown as MessagePort],
        }));
      }),
      stop: vi.fn(async () => undefined),
    };

    const reader = await connectLegacyMigrationReader(nonce, window, control);
    await reader.close();
  });
});
