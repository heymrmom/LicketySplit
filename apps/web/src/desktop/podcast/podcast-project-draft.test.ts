import { beforeEach, describe, expect, it } from "vitest";
import type { PodcastSetup } from "@openreel/core/lickety/podcast-types";
import { useProjectStore } from "../../stores/project-store";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { loadPodcastCheckpoint, savePodcastCheckpoint } from "./podcast-project-draft";

const approvedSetup = { setupId: "setup-1", state: "approved", revision: 8, approval: { revision: 8, mappingDigest: "digest", approvedAt: "now" } } as PodcastSetup;

describe("project-scoped podcast checkpoints", () => {
  beforeEach(() => {
    const project = createEmptyProject("Checkpoint");
    useProjectStore.setState({ hasOpenProject: true, project });
  });

  it("persists stage state separately without rewriting native setup approval", () => {
    const current = useProjectStore.getState().project;
    const checkpoint = { setupId: approvedSetup.setupId, step: "check" as const, selectedMediaIds: ["media-1"], updatedAt: "2026-10-09T00:00:00.000Z" };
    expect(savePodcastCheckpoint(current.id, checkpoint, approvedSetup)).toBe(true);
    const saved = useProjectStore.getState().project;
    expect(saved.lickety?.podcastSetup).toEqual(approvedSetup);
    expect(loadPodcastCheckpoint(saved)).toEqual(checkpoint);
  });

  it("does not write a checkpoint into a different open project", () => {
    const current = useProjectStore.getState().project;
    expect(savePodcastCheckpoint("another-project", { step: "recordings", selectedMediaIds: [], updatedAt: "now" })).toBe(false);
    expect(useProjectStore.getState().project).toBe(current);
  });
});
