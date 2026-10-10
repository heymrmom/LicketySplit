import {
  videoDecoderBudget,
  type VideoDecoderBudget,
  type VideoDecoderLease,
} from "@licketysplit/core";

export interface BudgetedPreviewDecoder<T> {
  value: T;
  lease: VideoDecoderLease;
}

/** Keep pending URL-to-decoder work cancellable by its owning preview generation. */
export class PendingVideoDecoderReservations {
  private readonly owners = new Map<object, Set<VideoDecoderLease>>();

  track(owner: object, lease: VideoDecoderLease): void {
    const leases = this.owners.get(owner) ?? new Set<VideoDecoderLease>();
    leases.add(lease);
    this.owners.set(owner, leases);
  }

  forget(owner: object, lease: VideoDecoderLease): void {
    const leases = this.owners.get(owner);
    if (!leases) return;
    leases.delete(lease);
    if (leases.size === 0) this.owners.delete(owner);
  }

  releaseOwner(owner: object): void {
    const leases = this.owners.get(owner);
    if (!leases) return;
    this.owners.delete(owner);
    for (const lease of leases) lease.release();
  }

  releaseAll(): void {
    for (const owner of [...this.owners.keys()]) this.releaseOwner(owner);
  }
}

/** Pin the exact lease a playback generation acquired, even if a cache key is reused. */
export class PinnedVideoDecoderLeases {
  private readonly leases = new Map<string, VideoDecoderLease>();

  pin(sourceId: string, lease: VideoDecoderLease): void {
    const previous = this.leases.get(sourceId);
    if (previous === lease) return;
    previous?.unpin();
    if (!lease.active) {
      this.leases.delete(sourceId);
      return;
    }
    lease.pin();
    this.leases.set(sourceId, lease);
  }

  unpin(sourceId: string): void {
    this.leases.get(sourceId)?.unpin();
    this.leases.delete(sourceId);
  }

  clear(): void {
    for (const sourceId of [...this.leases.keys()]) this.unpin(sourceId);
  }
}

export interface VideoElementReadinessWait {
  promise: Promise<void>;
  cancel(): void;
}

/** Attach readiness handlers before loading so an owning decoder lease can cancel the wait. */
export function waitForBudgetedVideoElementReadiness(
  video: HTMLVideoElement,
  url: string,
  timeoutMs = 10_000,
): VideoElementReadinessWait {
  let finishWait: (error?: Error) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finishWait(new Error("Video load timeout")), timeoutMs);
    finishWait = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      video.onloadedmetadata = null;
      video.onloadeddata = null;
      video.oncanplay = null;
      video.onerror = null;
      if (error) reject(error);
      else resolve();
    };

    video.onloadeddata = () => finishWait();
    video.oncanplay = () => finishWait();
    video.onloadedmetadata = () => {
      if (video.readyState >= 2) finishWait();
    };
    video.onerror = () => finishWait(new Error("Video load failed"));
    try {
      video.src = url;
      video.load();
      if (video.readyState >= 2) finishWait();
    } catch (error) {
      finishWait(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return {
    promise,
    cancel: () => finishWait(new Error("Video load cancelled")),
  };
}

/** Reserve a shared slot before initializing a MediaBunny input or CanvasSink. */
export async function createBudgetedPreviewDecoder<T>(
  initialize: () => Promise<T | null> | T | null,
  dispose: () => void,
  onUnavailable: () => void,
  budget: VideoDecoderBudget = videoDecoderBudget,
  onReserved?: (lease: VideoDecoderLease) => void,
): Promise<BudgetedPreviewDecoder<T> | null> {
  const lease = budget.reserve(dispose);
  if (!lease) {
    onUnavailable();
    return null;
  }

  try {
    onReserved?.(lease);
    const value = await initialize();
    if (value === null || !lease.active) {
      lease.release();
      return null;
    }
    return { value, lease };
  } catch (error) {
    lease.release();
    throw error;
  }
}
