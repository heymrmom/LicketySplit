import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('image service worker cache ownership', () => {
  it('uses the new cache and deletes only app-owned old or new image caches', async () => {
    type WorkerEvent = { waitUntil: (promise: Promise<unknown>) => void };
    const listeners: Record<string, (event: WorkerEvent) => void> = {};
    const removed: string[] = [];
    const existing = [
      'licketysplit-image-v1',
      'openreel-image-v1',
      'openreel-image-v0',
      'other-app-runtime',
    ];
    const caches = {
      keys: vi.fn(async () => existing),
      delete: vi.fn(async (name: string) => {
        removed.push(name);
        return true;
      }),
      open: vi.fn(async () => ({ addAll: vi.fn() })),
    };
    const self = {
      addEventListener: (name: string, callback: (event: WorkerEvent) => void) => {
        listeners[name] = callback;
      },
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn() },
    };
    const source = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8');
    runInNewContext(source, { self, caches, Promise });

    const installWaits: Promise<unknown>[] = [];
    listeners.install({ waitUntil: (promise: Promise<unknown>) => installWaits.push(promise) });
    await Promise.all(installWaits);
    expect(caches.open).toHaveBeenCalledWith('licketysplit-image-v1');

    const activateWaits: Promise<unknown>[] = [];
    listeners.activate({ waitUntil: (promise: Promise<unknown>) => activateWaits.push(promise) });
    await Promise.all(activateWaits);

    expect(removed.sort()).toEqual(['openreel-image-v0', 'openreel-image-v1']);
    expect(removed).not.toContain('other-app-runtime');
    expect(self.clients.claim).toHaveBeenCalledOnce();
  });
});
