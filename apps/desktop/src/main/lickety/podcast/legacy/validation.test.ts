import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { independentCheckStatus } from "./validation";
import { SYNC_PARAMETERS } from "../parameters";
import { cachedPodcastWork } from "../work-cache";

describe("independent post-alignment allowance", () => {
  it("keeps fitting, regional validation and drift limits separate from review allowance", () => {
    expect(SYNC_PARAMETERS.independentReviewResidualAllowanceMs).toBe(15);
    expect(SYNC_PARAMETERS.pairResidualTargetMs).toBe(5);
    expect(SYNC_PARAMETERS.graphResidualTargetMs).toBe(5);
    expect(SYNC_PARAMETERS.regionalFitMaxResidualMs).toBe(3);
    expect(SYNC_PARAMETERS.regionalValidationTargetMs).toBe(5);
    expect(SYNC_PARAMETERS.maxAbsolutePairDriftPpm).toBe(2000);
  });
  it("passes inclusive positive and negative 15 ms residuals", () => {
    for (const residualMs of [-15, 15]) {
      expect(independentCheckStatus({ residualMs, usable: true, competing: false, fitOverlap: false })).toBe("pass");
    }
  });

  it("fails residuals just beyond either 15 ms boundary", () => {
    for (const residualMs of [-15.001, 15.001]) {
      expect(independentCheckStatus({ residualMs, usable: true, competing: false, fitOverlap: false })).toBe("failed");
    }
  });

  it("keeps non-finite, weak, competing, and fitting-overlap evidence from passing", () => {
    for (const residualMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(independentCheckStatus({ residualMs, usable: true, competing: false, fitOverlap: false })).toBe("unverified");
    }
    expect(independentCheckStatus({ residualMs: 2, usable: false, competing: false, fitOverlap: false })).toBe("unverified");
    expect(independentCheckStatus({ residualMs: 2, usable: true, competing: true, fitOverlap: false })).toBe("unverified");
    expect(independentCheckStatus({ residualMs: 2, usable: true, competing: false, fitOverlap: true })).toBe("overlaps-training");
  });

  it("does not reuse a cached result produced under the previous validation identity", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "podcast-independent-identity-"));
    try {
      const previousIdentity: Record<string, unknown> = { ...SYNC_PARAMETERS, algorithmVersion: "landmarks-ncc-network-9" };
      delete previousIdentity.independentReviewResidualAllowanceMs;
      await cachedPodcastWork(folder, "channel-match", previousIdentity, async () => ({ status: "old-result" }));
      const current = await cachedPodcastWork(folder, "channel-match", SYNC_PARAMETERS, async () => ({ status: "recomputed" }));
      expect(current.cacheHit).toBe(false);
      expect(current.value.status).toBe("recomputed");
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
