import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBudgetedVideoElement,
  VideoDecoderBudget,
  type VideoDecoderLease,
} from "./video-decoder-budget";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeVideo(): HTMLVideoElement {
  return {
    src: "",
    muted: false,
    playsInline: false,
    preload: "none",
    crossOrigin: null,
    pause: vi.fn(),
    removeAttribute: vi.fn(),
    load: vi.fn(),
  } as unknown as HTMLVideoElement;
}

describe("shared video decoder budget", () => {
  it("keeps six sequential source switches within four live decoders and evicts the least recent idle source", async () => {
    const budget = new VideoDecoderBudget(4);
    const disposed: string[] = [];
    const entries = [];

    for (let index = 0; index < 6; index += 1) {
      const entry = await createBudgetedVideoElement(
        async () => `blob:source-${index}`,
        {
          budget,
          videoFactory: fakeVideo,
          onDispose: () => disposed.push(`source-${index}`),
        },
      );
      expect(entry).not.toBeNull();
      entries.push(entry!);
      entry!.lease.unpin();
    }

    expect(budget.size).toBe(4);
    expect(disposed).toEqual(["source-0", "source-1"]);
    expect(entries[0]!.lease.active).toBe(false);
    expect(entries[1]!.lease.active).toBe(false);
    expect(entries[5]!.lease.active).toBe(true);
  });

  it("does not evict a pinned live transition source and declines only when every slot is pinned", async () => {
    const budget = new VideoDecoderBudget(4);
    const disposed: string[] = [];
    const entries = [];

    for (let index = 0; index < 4; index += 1) {
      const entry = await createBudgetedVideoElement(
        async () => `blob:source-${index}`,
        { budget, videoFactory: fakeVideo, onDispose: () => disposed.push(`source-${index}`) },
      );
      entries.push(entry!);
      if (index !== 0) entry!.lease.unpin();
    }

    const fifth = await createBudgetedVideoElement(async () => "blob:source-4", {
      budget,
      videoFactory: fakeVideo,
      onDispose: () => disposed.push("source-4"),
    });
    expect(fifth).not.toBeNull();
    expect(entries[0]!.lease.active).toBe(true);
    expect(disposed).toEqual(["source-1"]);

    const sixth = await createBudgetedVideoElement(async () => "blob:source-5", {
      budget,
      videoFactory: fakeVideo,
      onDispose: () => disposed.push("source-5"),
    });
    expect(sixth).not.toBeNull();
    expect(disposed).toEqual(["source-1", "source-2"]);
    expect(budget.size).toBe(4);
  });

  it("releases a source whose async URL arrives after its owner was cancelled", async () => {
    const budget = new VideoDecoderBudget(4);
    let resolveUrl!: (value: string) => void;
    const makeVideo = vi.fn(fakeVideo);
    let current = true;
    const pending = createBudgetedVideoElement(
      () => new Promise<string>((resolve) => { resolveUrl = resolve; }),
      { budget, videoFactory: makeVideo, isCurrent: () => current },
    );

    current = false;
    resolveUrl("blob:late-source");

    await expect(pending).resolves.toBeNull();
    expect(makeVideo).not.toHaveBeenCalled();
    expect(budget.size).toBe(0);
  });

  it("releases a pending URL reservation immediately when its owner tears down", async () => {
    const budget = new VideoDecoderBudget(4);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const makeVideo = vi.fn(fakeVideo);
    let resolveUrl!: (value: string) => void;
    let reservation: VideoDecoderLease | null = null;
    const pending = createBudgetedVideoElement(
      () => new Promise<string>((resolve) => { resolveUrl = resolve; }),
      {
        budget,
        videoFactory: makeVideo,
        onReserved: (lease) => { reservation = lease; },
      },
    );

    expect(budget.size).toBe(1);
    reservation!.release();
    expect(budget.size).toBe(0);
    resolveUrl("blob:late-after-owner-teardown");

    await expect(pending).resolves.toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:late-after-owner-teardown");
    expect(makeVideo).not.toHaveBeenCalled();
    expect(budget.size).toBe(0);
  });

  it("revokes a blob URL that arrives after URL creation timed out", async () => {
    vi.useFakeTimers();
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const budget = new VideoDecoderBudget(4);
    let resolveUrl!: (value: string) => void;
    const pending = createBudgetedVideoElement(
      () => new Promise<string>((resolve) => { resolveUrl = resolve; }),
      { budget, videoFactory: fakeVideo, urlTimeoutMs: 5 },
    );

    const timedOut = expect(pending).rejects.toThrow("Video source URL timed out");
    await vi.advanceTimersByTimeAsync(5);
    await timedOut;
    resolveUrl("blob:late-timeout");
    await Promise.resolve();

    expect(revoke).toHaveBeenCalledWith("blob:late-timeout");
    expect(budget.size).toBe(0);
  });
});
