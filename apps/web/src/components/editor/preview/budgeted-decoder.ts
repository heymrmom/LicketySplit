import {
  videoDecoderBudget,
  type VideoDecoderBudget,
  type VideoDecoderLease,
} from "@openreel/core";

export interface BudgetedPreviewDecoder<T> {
  value: T;
  lease: VideoDecoderLease;
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
