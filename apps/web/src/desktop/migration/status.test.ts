import { describe, expect, it } from "vitest";
import { acceptIncompleteMigration, recordMigrationComplete, readMigrationStatus } from "./status";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

describe("origin migration completion marker", () => {
  it("writes completion only after every source record was accounted for", () => {
    const storage = new MemoryStorage();
    const unavailable = [{ databaseName: "legacy-assets", storeName: "media" }];

    expect(() => recordMigrationComplete(storage, unavailable, 1234)).toThrow("records are still unavailable");
    expect(storage.length).toBe(0);

    recordMigrationComplete(storage, [], 5678);
    expect(readMigrationStatus(storage)).toEqual({ status: "complete", version: 1, completedAt: 5678 });
  });

  it("persists accepted relink details without changing the state to complete", () => {
    const storage = new MemoryStorage();
    const unavailable = [{ databaseName: "legacy-assets", storeName: "media" }];

    acceptIncompleteMigration(storage, unavailable, 9876);

    expect(readMigrationStatus(storage)).toEqual({ status: "accepted-incomplete", version: 1, acceptedAt: 9876, unavailable });
  });

  it("treats malformed state as incomplete instead of assuming success", () => {
    const storage = new MemoryStorage();
    storage.setItem("__licketysplit_identity_migration_control_v1__", "{broken");
    expect(readMigrationStatus(storage)).toBeUndefined();
  });
});
