// Same-input drift thresholds as .superpowers/work/takeover/legacy-baseline/src/preview-playback.test.ts:
// 10.04s jitter stays untouched, 10.18s uses rate correction, and 1s drift
// seeks only after PREVIEW_HARD_DRIFT_HOLD_MS. The episode clock adds source-map
// conversion and gap advancement around that preserved correction behavior.
import { describe, expect, it, vi } from "vitest";
import { advancePreviewClock, PREVIEW_HARD_DRIFT_HOLD_MS, previewCorrection, sourceSecondsForEpisode, episodeSecondsForSource, takeOverPreviewSourceAtBoundary } from "./podcast-preview-playback";

describe("podcast preview playback clock", () => {
  it("prefers the selected sound clock, then picture, and advances only across uncovered gaps", () => {
    const initial = { timelineSeconds: 12, wallMs: 1000 };
    expect(advancePreviewClock(initial, 1100, 1, 18, 19)).toEqual({ timelineSeconds: 18, wallMs: 1100 });
    expect(advancePreviewClock(initial, 1100, 1, undefined, 19)).toEqual({ timelineSeconds: 19, wallMs: 1100 });
    expect(advancePreviewClock(initial, 1500, 1.25)).toEqual({ timelineSeconds: 12.625, wallMs: 1500 });
  });

  it("corrects modest decoder drift by rate and seeks only after a sustained large drift", () => {
    expect(previewCorrection(10.04, 10, 1, 2000).kind).toBe("none");
    expect(previewCorrection(10.18, 10, 1, 2000)).toMatchObject({ kind: "rate" });
    expect(previewCorrection(11, 10, 1, PREVIEW_HARD_DRIFT_HOLD_MS - 1).kind).toBe("rate");
    expect(previewCorrection(11, 10, 1, PREVIEW_HARD_DRIFT_HOLD_MS).kind).toBe("seek");
  });

  it("round-trips affine source and episode clocks", () => {
    const episode = episodeSecondsForSource(17.25, 1.0001, -3.5);
    expect(sourceSecondsForEpisode(episode, 1.0001, -3.5)).toBeCloseTo(17.25, 10);
  });

  it("only swaps a newly ready source at a paused boundary and ignores stale resolution", async () => {
    const publish = vi.fn();
    let finish!: (url: string) => void;
    let current = true;
    const pending = takeOverPreviewSourceAtBoundary({
      isPlaying: () => false,
      isCurrent: () => current,
      currentUrl: "licketysplit-media://camera/original",
      resolve: () => new Promise<string>((resolve) => { finish = resolve; }),
      publish,
    });
    current = false;
    finish("file:///ready-proxy.mp4");
    await expect(pending).resolves.toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not resolve or swap a proxy while playback is live", async () => {
    const resolve = vi.fn(async () => "file:///ready-proxy.mp4");
    const publish = vi.fn();
    await expect(takeOverPreviewSourceAtBoundary({ isPlaying: () => true, isCurrent: () => true, currentUrl: "original", resolve, publish })).resolves.toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
