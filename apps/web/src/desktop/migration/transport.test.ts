/* global IDBValidKey */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LegacyMigrationReader } from "./transport";
import { UncopyableIndexedDatabaseRecordError } from "./storage-copy";

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
    reader.close();
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
    reader.close();
  });
});
