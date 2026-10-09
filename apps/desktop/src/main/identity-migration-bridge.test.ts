import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY_MIGRATION_CHANNELS,
  installIdentityMigrationBridge,
} from "./identity-migration-bridge";

const NONCE = "c2cbf947-57a1-4ef8-81ba-264a2f863fff";

class FakePort {
  closed = 0;
  close(): void { this.closed += 1; }
}

class FakeSender extends EventEmitter {
  mainFrame = { url: "app://licketysplit/index.html" };
  sent: Array<{ channel: string; message: unknown; ports: FakePort[] }> = [];
  destroyed = false;

  postMessage(channel: string, message: unknown, ports: FakePort[]): void {
    this.sent.push({ channel, message, ports });
  }

  isDestroyed(): boolean { return this.destroyed; }
}

class FakeReaderContents extends EventEmitter {
  currentUrl = "";
  sent: Array<{ channel: string; message: unknown; ports: FakePort[] }> = [];
  destroyed = false;
  openHandler?: () => { action: "deny" };

  postMessage(channel: string, message: unknown, ports: FakePort[]): void {
    this.sent.push({ channel, message, ports });
  }

  getURL(): string { return this.currentUrl; }
  isDestroyed(): boolean { return this.destroyed; }
  setWindowOpenHandler(handler: () => { action: "deny" }): void { this.openHandler = handler; }
}

class FakeReaderWindow extends EventEmitter {
  readonly webContents = new FakeReaderContents();
  destroyed = false;
  loadResult: "success" | "reject" | "stall" = "success";
  preventNavigate?: (url: string) => boolean;
  options?: Record<string, unknown>;

  async loadURL(url: string): Promise<void> {
    if (this.loadResult === "reject") throw new Error("protocol failed");
    if (this.loadResult === "stall") return new Promise<void>(() => {});
    this.webContents.currentUrl = url;
  }

  isDestroyed(): boolean { return this.destroyed; }
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
}

function harness(loadTimeoutMs = 100) {
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  const sender = new FakeSender();
  const reader = new FakeReaderWindow();
  const ports = [new FakePort(), new FakePort()];
  const createReaderWindow = vi.fn((options: any) => {
    reader.options = options;
    return reader as never;
  });
  const createMessageChannel = vi.fn(() => ({ port1: ports[0], port2: ports[1] }) as never);
  const dispose = installIdentityMigrationBridge({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    createReaderWindow,
    createMessageChannel,
    sourcePreloadPath: "/test/dist/preload/migration-reader.js",
    loadTimeoutMs,
  });
  const invoke = async (channel: string, caller: FakeSender, raw: unknown, senderFrame = caller.mainFrame) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler({ sender: caller, senderFrame } as never, raw);
  };
  return { handlers, sender, reader, ports, createReaderWindow, createMessageChannel, invoke, dispose };
}

afterEach(() => { vi.useRealTimers(); });

describe("native identity migration bridge", () => {
  it("accepts only a top-frame caller on the exact new app origin", async () => {
    const h = harness();
    await expect(h.invoke(IDENTITY_MIGRATION_CHANNELS.start, h.sender, "not-a-uuid"))
      .rejects.toThrow(/nonce/);
    await expect(h.invoke(IDENTITY_MIGRATION_CHANNELS.start, h.sender, NONCE, { url: "app://licketysplit/iframe.html" }))
      .rejects.toThrow(/top-level/);
    h.sender.mainFrame.url = "app://attacker/index.html";
    await expect(h.invoke(IDENTITY_MIGRATION_CHANNELS.start, h.sender, NONCE))
      .rejects.toThrow(/top-level/);
    expect(h.createReaderWindow).not.toHaveBeenCalled();
    h.dispose();
  });

  it("loads an isolated default-session reader and transfers opaque ports only after load", async () => {
    const h = harness();
    await h.invoke(IDENTITY_MIGRATION_CHANNELS.start, h.sender, NONCE);
    expect(h.reader.options).toMatchObject({
      show: false,
      webPreferences: {
        preload: "/test/dist/preload/migration-reader.js",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    expect(h.reader.options?.partition).toBeUndefined();
    expect(h.reader.webContents.getURL()).toBe(`app://openreel/migration.html?nonce=${NONCE}`);
    expect(h.sender.sent).toEqual([{
      channel: IDENTITY_MIGRATION_CHANNELS.port,
      message: { version: 1, nonce: NONCE },
      ports: [h.ports[0]],
    }]);
    expect(h.reader.webContents.sent).toEqual([{
      channel: IDENTITY_MIGRATION_CHANNELS.port,
      message: { version: 1, nonce: NONCE },
      ports: [h.ports[1]],
    }]);
    expect(h.reader.webContents.openHandler?.()).toEqual({ action: "deny" });

    let prevented = false;
    h.reader.webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, "app://openreel/");
    expect(prevented).toBe(true);
    prevented = false;
    h.reader.webContents.emit("will-redirect", { preventDefault: () => { prevented = true; } }, "app://openreel/");
    expect(prevented).toBe(true);
    h.reader.webContents.emit("did-navigate-in-page", {}, "app://openreel/other?nonce=" + NONCE, true, true);
    expect(h.reader.destroyed).toBe(true);
    h.dispose();
  });

  it("closes both ports and the reader when the old page fails or redirects", async () => {
    const failed = harness();
    failed.reader.loadResult = "reject";
    await expect(failed.invoke(IDENTITY_MIGRATION_CHANNELS.start, failed.sender, NONCE))
      .rejects.toThrow(/reader failed to load/);
    expect(failed.reader.destroyed).toBe(true);
    expect(failed.ports.map((port) => port.closed)).toEqual([1, 1]);

    const redirected = harness();
    redirected.reader.loadURL = async () => { redirected.reader.webContents.currentUrl = "app://openreel/other?nonce=" + NONCE; };
    await expect(redirected.invoke(IDENTITY_MIGRATION_CHANNELS.start, redirected.sender, NONCE))
      .rejects.toThrow(/unexpected migration page/);
    expect(redirected.reader.destroyed).toBe(true);
    expect(redirected.ports.map((port) => port.closed)).toEqual([1, 1]);
    failed.dispose();
    redirected.dispose();
  });

  it("times out stalled loads and tears down a caller-owned session when its sender is destroyed", async () => {
    const stalled = harness(5);
    stalled.reader.loadResult = "stall";
    await expect(stalled.invoke(IDENTITY_MIGRATION_CHANNELS.start, stalled.sender, NONCE))
      .rejects.toThrow(/timed out/);
    expect(stalled.reader.destroyed).toBe(true);
    expect(stalled.ports.map((port) => port.closed)).toEqual([1, 1]);

    const closing = harness(1000);
    closing.reader.loadResult = "stall";
    const starting = closing.invoke(IDENTITY_MIGRATION_CHANNELS.start, closing.sender, NONCE);
    closing.sender.destroyed = true;
    closing.sender.emit("destroyed");
    await expect(starting).rejects.toThrow(/caller closed/);
    expect(closing.reader.destroyed).toBe(true);
    expect(closing.ports.map((port) => port.closed)).toEqual([1, 1]);
    stalled.dispose();
    closing.dispose();
  });

  it("allows one session per caller, requires the matching stop nonce, and tears down idempotently", async () => {
    const h = harness();
    await h.invoke(IDENTITY_MIGRATION_CHANNELS.start, h.sender, NONCE);
    await expect(h.invoke(IDENTITY_MIGRATION_CHANNELS.start, h.sender, NONCE))
      .rejects.toThrow(/already has/);
    await expect(h.invoke(IDENTITY_MIGRATION_CHANNELS.stop, h.sender, "ffffffff-ffff-4fff-8fff-ffffffffffff"))
      .rejects.toThrow(/nonce does not match/);
    await h.invoke(IDENTITY_MIGRATION_CHANNELS.stop, h.sender, NONCE);
    expect(h.reader.destroyed).toBe(true);
    expect(h.ports.map((port) => port.closed)).toEqual([1, 1]);
    await h.invoke(IDENTITY_MIGRATION_CHANNELS.stop, h.sender, NONCE);
    h.dispose();
  });

  it("closes the hidden reader if native port creation fails", async () => {
    const h = harness();
    h.createMessageChannel.mockImplementation(() => { throw new Error("port unavailable"); });
    await expect(h.invoke(IDENTITY_MIGRATION_CHANNELS.start, h.sender, NONCE))
      .rejects.toThrow(/message channel could not be created/);
    expect(h.reader.destroyed).toBe(true);
    expect(h.handlers.has(IDENTITY_MIGRATION_CHANNELS.start)).toBe(true);
    h.dispose();
  });

  it("releases a session on caller reload or top-frame navigation, but not same-document changes", async () => {
    const h = harness();
    await h.invoke(IDENTITY_MIGRATION_CHANNELS.start, h.sender, NONCE);
    h.sender.emit("did-start-navigation", {}, `app://licketysplit/index.html#panel`, true, true);
    expect(h.reader.destroyed).toBe(false);
    h.sender.emit("did-start-navigation", {}, "app://attacker.example/", false, false);
    expect(h.reader.destroyed).toBe(false);
    h.sender.emit("did-start-navigation", {}, "app://licketysplit/index.html", false, true);
    expect(h.reader.destroyed).toBe(true);
    expect(h.ports.map((port) => port.closed)).toEqual([1, 1]);
    expect(h.sender.listenerCount("did-start-navigation")).toBe(0);
    h.dispose();
  });

  it("releases the source reader when the caller renderer process exits", async () => {
    const h = harness();
    await h.invoke(IDENTITY_MIGRATION_CHANNELS.start, h.sender, NONCE);
    h.sender.emit("render-process-gone", {}, { reason: "crashed" });
    expect(h.reader.destroyed).toBe(true);
    expect(h.ports.map((port) => port.closed)).toEqual([1, 1]);
    h.dispose();
  });
});
