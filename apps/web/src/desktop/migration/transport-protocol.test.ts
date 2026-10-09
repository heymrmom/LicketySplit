/* global WindowProxy */
import { describe, expect, it } from "vitest";
import { isLegacyReadyEvent, isLegacyStartEvent, isSequentialMigrationRequest } from "./transport-protocol";

const nonce = "fixture-run-29";
const receiver = {} as WindowProxy;
const source = {} as WindowProxy;

describe("legacy storage migration transport", () => {
  it("accepts readiness only from the exact old host and iframe window", () => {
    const data = { type: "licketysplit-migration-ready", version: 1, nonce };
    expect(isLegacyReadyEvent({ origin: "app://openreel", source, data }, "app://openreel", source, nonce)).toBe(true);
    expect(isLegacyReadyEvent({ origin: "app://other", source, data }, "app://openreel", source, nonce)).toBe(false);
    expect(isLegacyReadyEvent({ origin: "app://openreel", source: receiver, data }, "app://openreel", source, nonce)).toBe(false);
    expect(isLegacyReadyEvent({ origin: "app://openreel", source, data: { ...data, nonce: "other" } }, "app://openreel", source, nonce)).toBe(false);
  });

  it("accepts the start port only from the exact new host parent", () => {
    const port = {} as MessagePort;
    const event = {
      origin: "app://licketysplit",
      source: receiver,
      data: { type: "licketysplit-migration-start", version: 1, nonce },
      ports: [port],
    };
    expect(isLegacyStartEvent(event, "app://licketysplit", receiver, nonce)).toBe(true);
    expect(isLegacyStartEvent({ ...event, origin: "app://evil" }, "app://licketysplit", receiver, nonce)).toBe(false);
    expect(isLegacyStartEvent({ ...event, ports: [] }, "app://licketysplit", receiver, nonce)).toBe(false);
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
