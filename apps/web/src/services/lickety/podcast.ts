import {
  assertPodcastSetup,
  buildPodcastAssembly,
  type Action,
  type PodcastBridge,
  type PodcastSetup,
  type Project,
} from "@licketysplit/core";
import { useProjectStore } from "../../stores/project-store";

export interface PodcastApplyOptions {
  setup: PodcastSetup;
  expectedTimeline: string;
  expectedRevision: number;
  pictureGapPolicy?: "keep-picture-gaps" | "available-camera-fallback";
  signal?: AbortSignal;
}

export interface PodcastApplyDependencies {
  bridge: PodcastBridge;
  getProject(): Project;
  executeAction(action: Action): Promise<{ success: boolean; error?: { message: string } }>;
}

/** Use the native approval record as authority; renderer state alone cannot authorize apply. */
export async function getAuthoritativelyApprovedSetup(
  bridge: PodcastBridge,
  setup: PodcastSetup,
): Promise<PodcastSetup> {
  assertPodcastSetup(setup);
  if (setup.state === "approved") {
    const current = await bridge.get({ setupId: setup.setupId });
    assertPodcastSetup(current);
    if (current.state !== "approved" || current.revision !== setup.revision || current.approval?.revision !== current.revision || !current.approval.mappingDigest) {
      throw new Error("Podcast approval is no longer valid. Review and approve the current timing again.");
    }
    return current;
  }
  if (setup.state !== "review") throw new Error("Review the podcast timing before applying it.");
  const approvalRequest = { setupId: setup.setupId, expectedRevision: setup.revision };
  const approved = await bridge.approve(approvalRequest);
  assertPodcastSetup(approved);
  if (approved.state !== "approved" || approved.revision !== setup.revision || approved.approval?.revision !== approved.revision || !approved.approval.mappingDigest) {
    throw new Error("Native approval did not cover the current podcast timing revision.");
  }
  return approved;
}

/** Apply as one undoable project action after native approval and stale-state checks. */
export async function applyPodcastSetup(
  options: PodcastApplyOptions,
  dependencies?: PodcastApplyDependencies,
): Promise<{ project: Project; originShiftSeconds: number; coverageGaps: ReturnType<typeof buildPodcastAssembly>["coverageGaps"] }> {
  const bridge = dependencies?.bridge ?? window.licketysplit?.podcast;
  if (!bridge) throw new Error("Podcast timeline apply is available in the desktop app.");
  const initialProject = dependencies?.getProject() ?? useProjectStore.getState().project;
  const expectedProjectId = initialProject.id;
  if (options.setup.projectId !== expectedProjectId) throw new Error("Podcast setup belongs to a different project.");
  if (options.setup.revision !== options.expectedRevision) throw new Error("Podcast setup changed. Review the current timing before applying.");

  const approved = await getAuthoritativelyApprovedSetup(bridge, options.setup);
  options.signal?.throwIfAborted();
  const latestProject = dependencies?.getProject() ?? useProjectStore.getState().project;
  if (latestProject.id !== expectedProjectId || approved.projectId !== expectedProjectId) throw new Error("The active project changed while podcast approval was pending.");
  if (approved.revision !== options.expectedRevision) throw new Error("Podcast timing changed while approval was pending. Review it again before applying.");
  if (JSON.stringify(latestProject.timeline) !== options.expectedTimeline) throw new Error("The timeline changed while podcast approval was pending. Review the edit before applying.");
  options.signal?.throwIfAborted();

  const assembly = buildPodcastAssembly(latestProject, approved, { pictureGapPolicy: options.pictureGapPolicy });
  const action: Action = {
    type: "lickety/applyEdit",
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    params: {
      projectId: latestProject.id,
      expectedTimeline: options.expectedTimeline,
      snapshot: {
        timeline: assembly.project.timeline,
        multicamGroups: assembly.project.multicamGroups,
        lickety: assembly.project.lickety,
        minimumReaderVersion: assembly.project.minimumReaderVersion,
        capabilities: assembly.project.capabilities,
      },
    },
  };
  const result = await (dependencies?.executeAction ?? ((next) => useProjectStore.getState().executeAction(next)))(action);
  if (!result.success) throw new Error(result.error?.message ?? "Could not apply the podcast timeline.");
  return assembly;
}
