import { describe, expect, it, vi } from "vitest";
import { installLegacyMigrationSource } from "./source-entry";
import { LEGACY_APP_ORIGIN } from "./transport-protocol";

const nonce = "source-window-nonce";

class MemoryStorage {
  private readonly values = new Map([["legacy-preference", "preserved"]]);
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
}

class TestPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly messages: unknown[] = [];
  readonly start = vi.fn();
  readonly close = vi.fn();
  postMessage(value: unknown): void { this.messages.push(value); }
}

function sourceWindow(topLevel = true): Window {
  const target = new EventTarget() as unknown as Window;
  Object.defineProperties(target, {
    location: { value: { origin: LEGACY_APP_ORIGIN, search: `?nonce=${nonce}` } },
    parent: { value: topLevel ? target : ({} as Window) },
    indexedDB: { value: window.indexedDB },
    localStorage: { value: new MemoryStorage() },
  });
  return target;
}

function dispatchPort(target: Window, port: TestPort, role: "source" | "destination" = "source", origin = LEGACY_APP_ORIGIN): void {
  const event = new Event("message") as MessageEvent<unknown>;
  Object.defineProperties(event, {
    origin: { value: origin },
    source: { value: target },
    data: { value: { type: "licketysplit-native-migration-port", version: 1, nonce, role } },
    ports: { value: [port as unknown as MessagePort] },
  });
  target.dispatchEvent(event);
}

describe("legacy top-level migration source", () => {
  it("serves the original profile's local storage through the native source port", () => {
    const target = sourceWindow();
    const port = new TestPort();
    const dispose = installLegacyMigrationSource(target, nonce);

    dispatchPort(target, port);
    expect(port.start).toHaveBeenCalledOnce();
    port.onmessage?.({ data: { version: 1, nonce, requestId: 1, operation: "localStorage.listKeys", payload: {} } } as MessageEvent<unknown>);

    expect(port.messages).toEqual([{ version: 1, nonce, requestId: 1, ok: true, result: ["legacy-preference"] }]);
    dispose();
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("does not install a reader in an iframe or accept a non-source envelope", () => {
    const iframe = sourceWindow(false);
    const iframePort = new TestPort();
    const disposeIframe = installLegacyMigrationSource(iframe, nonce);
    dispatchPort(iframe, iframePort);
    expect(iframePort.start).not.toHaveBeenCalled();
    disposeIframe();

    const topLevel = sourceWindow();
    const wrongPort = new TestPort();
    const disposeTopLevel = installLegacyMigrationSource(topLevel, nonce);
    dispatchPort(topLevel, wrongPort, "destination");
    dispatchPort(topLevel, wrongPort, "source", "app://evil");
    expect(wrongPort.start).not.toHaveBeenCalled();
    disposeTopLevel();
  });
});
