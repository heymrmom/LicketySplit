/* global WindowProxy */
import { describe, expect, it } from "vitest";
import { isNativeMigrationPortEvent, isSequentialMigrationRequest } from "./transport-protocol";

const nonce = "fixture-run-29";
const receiver = {} as WindowProxy;
const source = {} as WindowProxy;

describe("legacy storage migration transport", () => {
  it("accepts a native source port only from the old-origin top-level window with exact role, nonce, and one port", () => {
    const port = {} as MessagePort;
    const event = {
      origin: "app://openreel",
      source,
      data: { type: "licketysplit-native-migration-port", version: 1, nonce, role: "source" },
      ports: [port],
    };
    expect(isNativeMigrationPortEvent(event, "app://openreel", source, nonce, "source")).toBe(true);
    expect(isNativeMigrationPortEvent({ ...event, origin: "app://evil" }, "app://openreel", source, nonce, "source")).toBe(false);
    expect(isNativeMigrationPortEvent({ ...event, source: receiver }, "app://openreel", source, nonce, "source")).toBe(false);
    expect(isNativeMigrationPortEvent({ ...event, data: { ...event.data, nonce: "other" } }, "app://openreel", source, nonce, "source")).toBe(false);
    expect(isNativeMigrationPortEvent({ ...event, data: { ...event.data, version: 2 } }, "app://openreel", source, nonce, "source")).toBe(false);
    expect(isNativeMigrationPortEvent({ ...event, data: { ...event.data, role: "destination" } }, "app://openreel", source, nonce, "source")).toBe(false);
    expect(isNativeMigrationPortEvent({ ...event, ports: [] }, "app://openreel", source, nonce, "source")).toBe(false);
    expect(isNativeMigrationPortEvent({ ...event, ports: [port, port] }, "app://openreel", source, nonce, "source")).toBe(false);
  });

  it("accepts a destination port only from the exact new-origin window", () => {
    const port = {} as MessagePort;
    const event = {
      origin: "app://licketysplit",
      source: receiver,
      data: { type: "licketysplit-native-migration-port", version: 1, nonce, role: "destination" },
      ports: [port],
    };
    expect(isNativeMigrationPortEvent(event, "app://licketysplit", receiver, nonce, "destination")).toBe(true);
    expect(isNativeMigrationPortEvent({ ...event, source }, "app://licketysplit", receiver, nonce, "destination")).toBe(false);
    expect(isNativeMigrationPortEvent({ ...event, data: { ...event.data, role: "source" } }, "app://licketysplit", receiver, nonce, "destination")).toBe(false);
  });

  it("rejects duplicate or out-of-order operations and requires record acknowledgement", () => {
    const first = { version: 1, nonce, requestId: 1, operation: "database.readRecord", payload: { name: "media", store: "files", key: 3 } };
    expect(isSequentialMigrationRequest(first, nonce, 1, false)).toBe(true);
    expect(isSequentialMigrationRequest({ ...first, requestId: 2 }, nonce, 1, false)).toBe(false);
    expect(isSequentialMigrationRequest({ ...first, nonce: "other" }, nonce, 1, false)).toBe(false);
    expect(isSequentialMigrationRequest({ ...first, requestId: 2, operation: "database.readSchema" }, nonce, 2, true)).toBe(false);
    expect(isSequentialMigrationRequest({ ...first, requestId: 2, operation: "database.finishRecord" }, nonce, 2, true)).toBe(true);
  });
});
