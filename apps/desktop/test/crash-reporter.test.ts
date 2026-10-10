import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { appOn, appGetVersion } = vi.hoisted(() => ({ appOn: vi.fn(), appGetVersion: vi.fn(() => "0.1.0-alpha.test") }));

vi.mock("electron", () => ({ app: { on: appOn, getVersion: appGetVersion } }));

import { initCrashReporter, reportError } from "../src/main/crash-reporter";

describe("crash reporter endpoint policy", () => {
  const originalLicketyEndpoint = process.env.LICKETYSPLIT_CRASH_ENDPOINT;
  const originalLegacyEndpoint = process.env.OPENREEL_CRASH_ENDPOINT;
  const originalExceptionListeners = process.listeners("uncaughtException");
  const originalRejectionListeners = process.listeners("unhandledRejection");
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    delete process.env.OPENREEL_CRASH_ENDPOINT;
    delete process.env.LICKETYSPLIT_CRASH_ENDPOINT;
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    for (const listener of process.listeners("uncaughtException")) {
      if (!originalExceptionListeners.includes(listener)) process.removeListener("uncaughtException", listener);
    }
    for (const listener of process.listeners("unhandledRejection")) {
      if (!originalRejectionListeners.includes(listener)) process.removeListener("unhandledRejection", listener);
    }
    if (originalLicketyEndpoint === undefined) delete process.env.LICKETYSPLIT_CRASH_ENDPOINT;
    else process.env.LICKETYSPLIT_CRASH_ENDPOINT = originalLicketyEndpoint;
    if (originalLegacyEndpoint === undefined) delete process.env.OPENREEL_CRASH_ENDPOINT;
    else process.env.OPENREEL_CRASH_ENDPOINT = originalLegacyEndpoint;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends only to an explicitly configured valid HTTP or HTTPS endpoint", async () => {
    process.env.OPENREEL_CRASH_ENDPOINT = "https://api.openreel.video/crash";
    reportError({ type: "test", source: "test", message: "disabled by default" });
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    for (const invalid of ["", "file:///tmp/crash", "javascript:alert(1)", "not a URL"]) {
      process.env.LICKETYSPLIT_CRASH_ENDPOINT = invalid;
      reportError({ type: "test", source: "test", message: "invalid endpoint" });
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
    }

    process.env.LICKETYSPLIT_CRASH_ENDPOINT = "http://127.0.0.1:43129/crash";
    reportError({ type: "test", source: "test", message: "configured endpoint" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:43129/crash");
  });

  it("keeps local exception logging active while remote reporting is disabled", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    initCrashReporter();
    const handler = process.listeners("uncaughtException").find((listener) => !originalExceptionListeners.includes(listener));
    expect(handler).toBeDefined();
    (handler as (error: Error) => void)(new Error("local diagnostic"));
    await Promise.resolve();
    expect(consoleError).toHaveBeenCalledWith("[main] uncaughtException:", expect.any(Error));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
