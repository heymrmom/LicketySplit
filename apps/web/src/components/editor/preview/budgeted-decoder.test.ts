import { describe, expect, it, vi } from "vitest";
import {
  createBudgetedVideoElement,
  VideoDecoderBudget,
  type VideoDecoderLease,
} from "@licketysplit/core";
import {
  createBudgetedPreviewDecoder,
  PendingVideoDecoderReservations,
  PinnedVideoDecoderLeases,
  waitForBudgetedVideoElementReadiness,
} from "./budgeted-decoder";

function fakeVideo(): HTMLVideoElement {
  return {
    src: "",
    muted: false,
    playsInline: false,
    preload: "none",
    pause: vi.fn(),
    removeAttribute: vi.fn(),
    load: vi.fn(),
  } as unknown as HTMLVideoElement;
}

describe("preview MediaBunny decoder reservations", () => {
  it("counts sequential and multilayer fallbacks against the same four-slot budget", async () => {
    const budget = new VideoDecoderBudget(4);
    const existingOwners = Array.from({ length: 3 }, () => budget.reserve(vi.fn()));
    expect(existingOwners.every(Boolean)).toBe(true);

    const disposeSequential = vi.fn();
    const sequential = await createBudgetedPreviewDecoder(
      async () => ({ kind: "sequential" }),
      disposeSequential,
      vi.fn(),
      budget,
    );
    expect(sequential?.value.kind).toBe("sequential");

    const initMultilayer = vi.fn(async () => ({ kind: "multilayer" }));
    const reportCapacity = vi.fn();
    const multilayer = await createBudgetedPreviewDecoder(
      initMultilayer,
      vi.fn(),
      reportCapacity,
      budget,
    );
    expect(multilayer).toBeNull();
    expect(initMultilayer).not.toHaveBeenCalled();
    expect(reportCapacity).toHaveBeenCalledOnce();
    expect(budget.size).toBe(4);

    sequential?.lease.release();
    expect(disposeSequential).toHaveBeenCalledOnce();
    expect(budget.size).toBe(3);
  });

  it("releases partial resources when initialization fails", async () => {
    const budget = new VideoDecoderBudget(1);
    const dispose = vi.fn();

    await expect(createBudgetedPreviewDecoder(
      async () => {
        throw new Error("sink initialization failed");
      },
      dispose,
      vi.fn(),
      budget,
    )).rejects.toThrow("sink initialization failed");

    expect(dispose).toHaveBeenCalledOnce();
    expect(budget.size).toBe(0);
  });

  it("cancels URI-resolved video readiness on owner teardown without touching a newer lease", async () => {
    const budget = new VideoDecoderBudget(2);
    const reservations = new PendingVideoDecoderReservations();
    const oldOwner = {};
    const newOwner = {};
    let oldReadiness: ReturnType<typeof waitForBudgetedVideoElementReadiness> | null = null;
    const disposeOld = vi.fn(() => oldReadiness?.cancel());
    const disposeNew = vi.fn();
    let oldLease: VideoDecoderLease | null = null;
    const oldEntry = await createBudgetedVideoElement(async () => "blob:old-generation", {
      budget,
      videoFactory: fakeVideo,
      onReserved: (lease) => {
        oldLease = lease;
        reservations.track(oldOwner, lease);
      },
      onDispose: disposeOld,
    });
    expect(oldEntry).not.toBeNull();
    oldReadiness = waitForBudgetedVideoElementReadiness(oldEntry!.video, oldEntry!.url, 60_000);
    const readiness = expect(oldReadiness.promise).rejects.toThrow("Video load cancelled");
    expect(oldEntry!.video.src).toBe("blob:old-generation");
    expect(oldEntry!.video.load).toHaveBeenCalledOnce();

    const newEntry = await createBudgetedVideoElement(async () => "blob:new-generation", {
      budget,
      videoFactory: fakeVideo,
      onReserved: (lease) => reservations.track(newOwner, lease),
      onDispose: disposeNew,
    });
    expect(newEntry).not.toBeNull();
    expect(budget.size).toBe(2);

    reservations.releaseOwner(oldOwner);
    expect(oldLease!.active).toBe(false);
    expect(newEntry!.lease.active).toBe(true);
    expect(budget.size).toBe(1);

    await readiness;
    expect(disposeOld).toHaveBeenCalledOnce();
    expect(disposeNew).not.toHaveBeenCalled();
    expect(oldEntry!.video.onerror).toBeNull();
    expect(oldEntry!.video.onloadeddata).toBeNull();
    reservations.releaseOwner(newOwner);
    expect(newEntry!.lease.active).toBe(false);
    expect(budget.size).toBe(0);
  });

  it("unpins the exact old lease when a later generation reuses the same cache key", () => {
    const budget = new VideoDecoderBudget(2);
    const oldGenerationPins = new PinnedVideoDecoderLeases();
    const newGenerationPins = new PinnedVideoDecoderLeases();
    const oldLease = budget.reserve(vi.fn())!;
    oldLease.unpin();
    oldGenerationPins.pin("camera-A", oldLease);
    oldLease.release();

    const newLease = budget.reserve(vi.fn())!;
    newLease.unpin();
    newGenerationPins.pin("camera-A", newLease);
    oldGenerationPins.clear();

    expect(oldLease.active).toBe(false);
    expect(newLease.active).toBe(true);
    expect(newLease.pinned).toBe(1);
    newGenerationPins.clear();
    expect(newLease.pinned).toBe(0);
  });
});
