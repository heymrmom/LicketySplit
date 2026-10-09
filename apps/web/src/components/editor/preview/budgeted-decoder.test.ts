import { describe, expect, it, vi } from "vitest";
import { VideoDecoderBudget } from "@openreel/core";
import { createBudgetedPreviewDecoder } from "./budgeted-decoder";

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
});
