import { describe, expect, it, vi } from "vitest";
import {
  forwardIdentityMigrationPort,
  IDENTITY_MIGRATION_CHANNELS,
  IDENTITY_MIGRATION_ENVELOPE,
  parseLegacyMigrationNonce,
} from "./identity-migration";

const NONCE = "c2cbf947-57a1-4ef8-81ba-264a2f863fff";

function makePort() {
  return { close: vi.fn() } as unknown as MessagePort;
}

function makeWindow(origin = "app://openreel") {
  return {
    location: { origin, protocol: "app:", host: origin.slice("app://".length) },
    postMessage: vi.fn(),
  };
}

describe("identity migration port relay", () => {
  it("uses dedicated channels and forwards one authenticated endpoint to the exact origin", () => {
    const port = makePort();
    const target = makeWindow();
    const accepted = forwardIdentityMigrationPort(
      { ports: [port] },
      { version: 1, nonce: NONCE },
      target,
      "app://openreel",
      NONCE,
      "source",
    );

    expect(accepted).toBe(true);
    expect(target.postMessage).toHaveBeenCalledWith({
      type: IDENTITY_MIGRATION_ENVELOPE,
      version: 1,
      nonce: NONCE,
      role: "source",
    }, "app://openreel", [port]);
    expect(port.close).not.toHaveBeenCalled();
    expect(IDENTITY_MIGRATION_CHANNELS).toEqual({
      start: "licketysplit:identity-migration:start",
      stop: "licketysplit:identity-migration:stop",
      port: "licketysplit:identity-migration:port",
    });
  });

  it("closes ports for wrong origin, nonce, version, or port count", () => {
    const cases: Array<{ origin: string; payload: unknown; ports: ReturnType<typeof makePort>[] }> = [
      { origin: "app://attacker", payload: { version: 1, nonce: NONCE }, ports: [makePort()] },
      { origin: "app://openreel", payload: { version: 1, nonce: "wrong" }, ports: [makePort()] },
      { origin: "app://openreel", payload: { version: 2, nonce: NONCE }, ports: [makePort()] },
      { origin: "app://openreel", payload: { version: 1, nonce: NONCE }, ports: [makePort(), makePort()] },
    ];

    for (const item of cases) {
      const target = makeWindow(item.origin);
      expect(forwardIdentityMigrationPort({ ports: item.ports }, item.payload, target, "app://openreel", NONCE, "destination")).toBe(false);
      expect(target.postMessage).not.toHaveBeenCalled();
      for (const port of item.ports) expect(port.close).toHaveBeenCalledOnce();
    }
  });

  it("closes a port when the postMessage relay throws", () => {
    const port = makePort();
    const target = makeWindow();
    target.postMessage.mockImplementation(() => { throw new Error("no target"); });
    expect(forwardIdentityMigrationPort({ ports: [port] }, { version: 1, nonce: NONCE }, target, "app://openreel", NONCE, "source")).toBe(false);
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("accepts only the exact legacy reader URL with one UUID nonce", () => {
    expect(parseLegacyMigrationNonce(`app://openreel/migration.html?nonce=${NONCE}`)).toBe(NONCE);
    expect(parseLegacyMigrationNonce(`app://openreel/other.html?nonce=${NONCE}`)).toBeUndefined();
    expect(parseLegacyMigrationNonce(`app://openreel/migration.html?nonce=${NONCE}&nonce=${NONCE}`)).toBeUndefined();
    expect(parseLegacyMigrationNonce(`app://openreel/migration.html?nonce=${NONCE}#redirect`)).toBeUndefined();
    expect(parseLegacyMigrationNonce(`app://attacker/migration.html?nonce=${NONCE}`)).toBeUndefined();
  });
});
