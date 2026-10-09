import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../shared/channels";

const state = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>(),
  userData: "",
  sourceId: "550e8400-e29b-41d4-a716-446655440099",
  mediaId: "registered-media-id",
}));

vi.mock("electron", () => ({
  app: { getPath: () => state.userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: (channel: string, handler: (_event: unknown, payload: unknown) => Promise<unknown>) => state.handlers.set(channel, handler) },
}));
vi.mock("./lickety", () => ({
  getAssetRegistry: () => ({
    originalUri: async (mediaId: string) => mediaId === state.mediaId ? `licketysplit-media://${state.sourceId}/original` : undefined,
    resolve: async (assetId: string) => assetId === state.sourceId ? { path: path.join(process.cwd(), "src/main/lickety/podcast/fixtures/shifted-aac-priming.mka"), mime: "audio/x-matroska" } : Promise.reject(new Error("Unknown source")),
    findMedia: async () => undefined,
  }),
}));

import { installPodcastIpc } from "./podcast";

describe("podcast IPC setup creation", () => {
  beforeEach(() => state.handlers.clear());

  it("creates the first setup through the validated renderer handler without treating its new ID as an existing setup", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "podcast-ipc-setup-"));
    state.userData = userData;
    try {
      installPodcastIpc();
      const handler = state.handlers.get(CHANNELS.podcastInspect);
      expect(handler).toBeTypeOf("function");
      const setup = await handler!(undefined, { projectId: "episode-project", mediaIds: [state.mediaId], requestId: "550e8400-e29b-41d4-a716-446655440098" }) as { setupId: string; state: string; analysis: { assets: unknown[] } };
      expect(setup.setupId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(setup.state).toBe("draft");
      expect(setup.analysis.assets).toHaveLength(1);
      await expect(handler!(undefined, { projectId: "episode-project", mediaIds: [state.mediaId], setupId: "550e8400-e29b-41d4-a716-446655440097", requestId: "550e8400-e29b-41d4-a716-446655440096" })).rejects.toThrow();
    } finally { await rm(userData, { recursive: true, force: true }); }
  });
});
