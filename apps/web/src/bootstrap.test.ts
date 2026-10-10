import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

const migration = vi.hoisted(() => ({
  status: null as unknown,
  namespaceComplete: false,
  namespaceRun: vi.fn(),
  originRun: vi.fn(),
  connect: vi.fn(),
  accept: vi.fn(),
  events: [] as string[],
}));

vi.mock("./main", () => ({}));
vi.mock("./desktop/migration/status", () => ({
  readMigrationStatus: () => migration.status,
  acceptIncompleteMigration: (_storage: unknown, unavailable: unknown) => {
    migration.accept(unavailable);
    migration.status = { status: "accepted-incomplete", unavailable };
  },
}));
vi.mock("./desktop/migration/namespace", () => ({
  readNamespaceMigrationComplete: () => migration.namespaceComplete,
  migrateLegacyNamespaceInBrowser: (...args: unknown[]) => migration.namespaceRun(...args),
}));
vi.mock("./desktop/migration/transport", () => ({
  connectLegacyMigrationReader: (...args: unknown[]) => migration.connect(...args),
}));
vi.mock("./desktop/migration/startup", () => ({
  migrateLegacyStorageInBrowser: (...args: unknown[]) => migration.originRun(...args),
}));

const unavailable = [{ databaseName: "openreel-db", storeName: "fileHandles" }];
const incompleteNamespace = {
  status: "incomplete",
  unavailable,
  localStorage: { copied: 1, preserved: 0, total: 1 },
  indexedDB: { databases: 1, copied: 0, preserved: 0 },
};
const completeNamespace = {
  status: "complete",
  localStorage: { copied: 1, preserved: 0, total: 1 },
  indexedDB: { databases: 1, copied: 1, preserved: 0 },
};

describe("migration bootstrap sequencing", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.replaceChildren();
    localStorage.clear();
    migration.status = null;
    migration.namespaceComplete = false;
    migration.namespaceRun.mockReset();
    migration.originRun.mockReset();
    migration.connect.mockReset();
    migration.accept.mockReset();
    migration.events.length = 0;
    vi.stubGlobal("location", { protocol: "app:", origin: "app://licketysplit" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("continues into the editor once when namespace migration remains incomplete", async () => {
    migration.status = { status: "complete", version: 2, completedAt: 1 };
    migration.namespaceRun.mockResolvedValue(incompleteNamespace);

    await import("./bootstrap");
    await waitFor(() => expect(document.body.textContent).toContain("Some saved items need attention"));
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((control) => control.textContent === "Continue and relink later")!.click();

    await waitFor(() => expect(document.getElementById("identity-migration-gate")).toBeNull());
    expect(migration.namespaceRun).toHaveBeenCalledTimes(1);
    expect(migration.accept).toHaveBeenCalledWith(unavailable);
    expect(localStorage.getItem("__licketysplit_namespace_migration_v1__")).toBeNull();
  });

  it("reconciles namespaced records after a successful origin retry despite an earlier complete marker", async () => {
    migration.status = { status: "accepted-incomplete", version: 2, acceptedAt: 1, unavailable };
    migration.namespaceComplete = true;
    migration.namespaceRun.mockImplementation(async () => {
      migration.events.push("namespace");
      return completeNamespace;
    });
    migration.connect.mockImplementation(async () => {
      migration.events.push("connect");
      return { close: async () => {} };
    });
    migration.originRun.mockImplementation(async () => {
      migration.events.push("origin");
      return { status: "complete", unavailable: [], localStorage: { copied: 1, preserved: 0, total: 1 }, indexedDB: { databases: 1, copied: 1, preserved: 0 } };
    });

    await import("./bootstrap");
    await waitFor(() => expect(document.body.textContent).toContain("Some saved items need attention"));
    document.querySelector<HTMLButtonElement>('button')!.click();

    await waitFor(() => expect(document.getElementById("identity-migration-gate")).toBeNull());
    expect(migration.events).toEqual(["connect", "origin", "namespace"]);
  });

  it("reconciles namespaced records after a partial origin retry despite an earlier complete marker", async () => {
    migration.status = { status: "accepted-incomplete", version: 2, acceptedAt: 1, unavailable };
    migration.namespaceComplete = true;
    migration.namespaceRun.mockImplementation(async () => {
      migration.events.push("namespace");
      return completeNamespace;
    });
    migration.connect.mockImplementation(async () => {
      migration.events.push("connect");
      return { close: async () => {} };
    });
    migration.originRun.mockImplementation(async () => {
      migration.events.push("origin");
      return { ...incompleteNamespace, unavailable };
    });

    await import("./bootstrap");
    await waitFor(() => expect(document.body.textContent).toContain("Some saved items need attention"));
    document.querySelector<HTMLButtonElement>('button')!.click();
    await waitFor(() => expect(migration.originRun).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.body.textContent).toContain("Some saved items need attention"));
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((control) => control.textContent === "Continue and relink later")!.click();

    await waitFor(() => expect(document.getElementById("identity-migration-gate")).toBeNull());
    expect(migration.events).toEqual(["connect", "origin", "namespace"]);
  });
});
