import { describe, expect, it, vi } from "vitest";
import { HeavyJobQueue, ManagedMediaJobs } from "./media-jobs";
import type { ManagedAssetRegistry } from "./asset-registry";

function abortSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("ManagedMediaJobs audio preview cache", () => {
  it("returns a validated completed preview while another job holds the heavy queue", async () => {
    const queue = new HeavyJobQueue();
    let releaseBlocker!: () => void;
    let signalStarted!: () => void;
    const blockerStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const blocker = queue.run(async () => {
      signalStarted();
      await new Promise<void>((resolve) => { releaseBlocker = resolve; });
    }, abortSignal());
    await blockerStarted;

    const registry = {
      audioPreview: vi.fn(async () => ({ path: "/managed/cache/source.m4a", mime: "audio/mp4" })),
      resolve: vi.fn(),
      get: vi.fn(),
    } as unknown as ManagedAssetRegistry;
    const run = vi.fn();
    const jobs = new ManagedMediaJobs(registry, queue, { run });

    await expect(jobs.ensureAudioStream("asset-1", 0, abortSignal(), 1))
      .resolves.toBe("licketysplit-media://asset-1/audio-0-channel-1");
    expect(registry.audioPreview).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(registry.resolve).not.toHaveBeenCalled();

    releaseBlocker();
    await blocker;
  });

  it("rechecks a queued cache miss before starting another transcode", async () => {
    const queue = new HeavyJobQueue();
    let releaseBlocker!: () => void;
    let signalStarted!: () => void;
    const blockerStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const blocker = queue.run(async () => {
      signalStarted();
      await new Promise<void>((resolve) => { releaseBlocker = resolve; });
    }, abortSignal());
    await blockerStarted;

    const registry = {
      audioPreview: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ path: "/managed/cache/source.m4a", mime: "audio/mp4" }),
      resolve: vi.fn(),
      get: vi.fn(),
    } as unknown as ManagedAssetRegistry;
    const run = vi.fn();
    const jobs = new ManagedMediaJobs(registry, queue, { run });
    const result = jobs.ensureAudioStream("asset-2", 0, abortSignal());
    expect(registry.audioPreview).toHaveBeenCalledTimes(1);

    releaseBlocker();
    await expect(result).resolves.toBe("licketysplit-media://asset-2/audio-0");
    expect(registry.audioPreview).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(registry.resolve).not.toHaveBeenCalled();
    await blocker;
  });
});
