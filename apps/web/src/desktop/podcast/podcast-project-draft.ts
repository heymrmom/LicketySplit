import type { Project } from "@licketysplit/core";
import type { PodcastSetup } from "@licketysplit/core/lickety/podcast-types";
import { useProjectStore } from "../../stores/project-store";
import { readPodcastWizardCheckpoint, type PodcastWizardCheckpoint, type ProjectWithPodcastCheckpoint } from "./podcast-ui-model";

/** Save UI resume state beside, never inside, native approval authority. */
export function savePodcastCheckpoint(
  projectId: string,
  checkpoint: PodcastWizardCheckpoint,
  nativeSetup?: PodcastSetup,
): boolean {
  const current = useProjectStore.getState().project;
  if (current.id !== projectId) return false;
  const next = {
    ...current,
    lickety: {
      ...current.lickety,
      schemaVersion: 1 as const,
      ...(nativeSetup ? { podcastSetup: structuredClone(nativeSetup) } : {}),
      podcastWizard: structuredClone(checkpoint),
    },
  } as ProjectWithPodcastCheckpoint;
  useProjectStore.setState({ project: next as Project });
  return readPodcastWizardCheckpoint(next) !== undefined;
}

export function loadPodcastCheckpoint(project: Project): PodcastWizardCheckpoint | undefined {
  const checkpoint = readPodcastWizardCheckpoint(project);
  if (!checkpoint || !checkpoint.setupId) return checkpoint;
  const portable = project.lickety?.podcastSetup;
  return portable?.setupId === checkpoint.setupId ? checkpoint : { ...checkpoint, setupId: portable?.setupId };
}
