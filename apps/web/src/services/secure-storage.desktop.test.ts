import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isSecureVerificationValue,
  LEGACY_SECURE_VERIFICATION_VALUE,
  SECURE_DB_NAME,
  SECURE_VERIFICATION_VALUE,
  saveSecret,
  getSecret,
  hasSecret,
  deleteSecret,
  isSessionUnlocked,
  isMasterPasswordSet,
} from "./secure-storage";

interface KeychainMock {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

let keychain: KeychainMock;

beforeEach(() => {
  keychain = {
    get: vi.fn().mockResolvedValue("stored-key"),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  (window as unknown as { licketysplit: unknown }).licketysplit = {
    platform: "desktop",
    keychain,
  };
});

afterEach(() => {
  delete (window as unknown as { licketysplit?: unknown }).licketysplit;
});

describe("secure-storage desktop branch", () => {
  it("uses the new secure-store namespace and still recognizes migrated verifier values", () => {
    expect(SECURE_DB_NAME).toBe("licketysplit-secure");
    expect(SECURE_VERIFICATION_VALUE).toBe("licketysplit-verify-v1");
    expect(isSecureVerificationValue(LEGACY_SECURE_VERIFICATION_VALUE)).toBe(true);
    expect(isSecureVerificationValue(SECURE_VERIFICATION_VALUE)).toBe(true);
    expect(isSecureVerificationValue("unrecognized-v1")).toBe(false);
  });

  it("saveSecret routes to keychain.set with id+value", async () => {
    await saveSecret("openai", "OpenAI", "sk-secret");
    expect(keychain.set).toHaveBeenCalledWith("openai", "sk-secret");
  });

  it("getSecret routes to keychain.get and returns its value", async () => {
    const value = await getSecret("openai");
    expect(keychain.get).toHaveBeenCalledWith("openai");
    expect(value).toBe("stored-key");
  });

  it("getSecret returns null when keychain has no entry", async () => {
    keychain.get.mockResolvedValueOnce(null);
    expect(await getSecret("missing")).toBeNull();
  });

  it("checks key existence without exposing it to the caller", async () => {
    await expect(hasSecret("openai")).resolves.toBe(true);
    keychain.get.mockResolvedValueOnce(null);
    await expect(hasSecret("missing")).resolves.toBe(false);
  });

  it("deleteSecret routes to keychain.delete", async () => {
    await deleteSecret("openai");
    expect(keychain.delete).toHaveBeenCalledWith("openai");
  });

  it("isSessionUnlocked is always true on desktop", () => {
    expect(isSessionUnlocked()).toBe(true);
  });

  it("isMasterPasswordSet resolves true on desktop", async () => {
    expect(await isMasterPasswordSet()).toBe(true);
  });
});
