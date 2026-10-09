import { describe, expect, it, vi } from "vitest";
import type { PodcastSetup, Project } from "@openreel/core";
import { makeWorkflowFixture } from "@openreel/core/lickety/test-fixtures";
import { applyPodcastSetup, type PodcastApplyDependencies } from "./podcast";

function setup(projectId: string, state: "review" | "approved" = "approved"): PodcastSetup {
  const now = "2026-10-09T00:00:00.000Z";
  return {
    schemaVersion: 1,
    setupId: "11111111-1111-4111-8111-111111111111",
    projectId,
    revision: 2,
    createdAt: now,
    updatedAt: now,
    step: "check",
    analysis: {
      version: 1,
      generatedAt: now,
      projectName: "Episode",
      fps: 30,
      assets: [{ id: "cam", mediaId: "cam-a", sourceId: "source-a", name: "Camera", kind: "video", durationSeconds: 8, streams: [{ index: 0, kind: "video" }] }],
      groups: [],
      warnings: [],
    },
    groups: [{ id: "camera", name: "Wide camera", kind: "video", role: "camera", confidence: "high", assetIds: ["cam"], warnings: [], framing: "everyone" }],
    participants: [],
    clockGroups: [],
    channels: [],
    edges: [],
    placements: [{ assetId: "cam", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "reference", component: "episode", locked: true, provenance: ["reference"] }],
    state,
    ...(state === "approved" ? { approval: { revision: 2, mappingDigest: "digest", approvedAt: now } } : {}),
    warnings: [],
  };
}

function deps(project: Project, setupValue: PodcastSetup) {
  const getProject = vi.fn(() => project);
  const executeAction = vi.fn(async (_action: unknown) => ({ success: true }));
  const bridge = {
    inspect: vi.fn(), revise: vi.fn(), analyze: vi.fn(), update: vi.fn(), getWaveform: vi.fn(), cancel: vi.fn(), onProgress: vi.fn(),
    get: vi.fn(async () => setupValue),
    approve: vi.fn(async () => setupValue),
  } as unknown as PodcastApplyDependencies["bridge"];
  return { dependencies: { bridge, getProject, executeAction }, getProject, executeAction, bridge };
}

describe("applyPodcastSetup", () => {
  it("revalidates an existing approval and applies all generated state in one undoable action", async () => {
    const project = makeWorkflowFixture();
    const value = setup(project.id);
    const { dependencies, bridge, executeAction } = deps(project, value);
    const result = await applyPodcastSetup({ setup: value, expectedTimeline: JSON.stringify(project.timeline), expectedRevision: value.revision }, dependencies);

    expect(bridge.get).toHaveBeenCalledWith({ setupId: value.setupId });
    expect(bridge.approve).not.toHaveBeenCalled();
    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(executeAction.mock.calls[0]?.[0]).toMatchObject({
      type: "lickety/applyEdit",
      params: { snapshot: { lickety: { podcastSetup: value, podcastAssembly: { setupId: value.setupId } }, multicamGroups: [expect.objectContaining({ angles: [expect.objectContaining({ sourceSegments: [expect.any(Object)] })] })] } },
    });
    expect(result.project.lickety?.podcastAssembly?.originShiftSeconds).toBe(0);
  });

  it("uses native approval for review state and rejects a timeline that changed while awaiting it", async () => {
    const project = makeWorkflowFixture();
    const review = setup(project.id, "review");
    const approved = setup(project.id);
    const { dependencies, bridge, getProject, executeAction } = deps(project, approved);
    bridge.approve = vi.fn(async () => approved);
    getProject.mockImplementationOnce(() => project).mockImplementation(() => ({ ...project, timeline: { ...project.timeline, duration: project.timeline.duration + 1 } }));

    await expect(applyPodcastSetup({ setup: review, expectedTimeline: JSON.stringify(project.timeline), expectedRevision: review.revision }, dependencies)).rejects.toThrow(/timeline changed/i);
    expect(bridge.approve).toHaveBeenCalledWith({ setupId: review.setupId, expectedRevision: review.revision });
    expect(bridge.get).not.toHaveBeenCalled();
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("stops after cancellation before applying the timeline", async () => {
    const project = makeWorkflowFixture();
    const value = setup(project.id);
    const { dependencies, executeAction } = deps(project, value);
    const controller = new AbortController();
    const bridge = dependencies.bridge;
    bridge.get = vi.fn(async () => { controller.abort(); return value; });

    await expect(applyPodcastSetup({ setup: value, expectedTimeline: JSON.stringify(project.timeline), expectedRevision: value.revision, signal: controller.signal }, dependencies)).rejects.toThrow();
    expect(executeAction).not.toHaveBeenCalled();
  });
});
