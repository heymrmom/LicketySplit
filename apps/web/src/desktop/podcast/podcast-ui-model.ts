import type { MediaItem, Project } from "@openreel/core";
import type { PodcastGroup, PodcastSetup, PodcastSetupStep } from "@openreel/core/lickety/podcast-types";
import { podcastTimelineModel } from "./podcast-review-model";

export type PodcastWizardCheckpoint = {
  setupId?: string;
  step: PodcastSetupStep;
  selectedMediaIds: string[];
  groups?: PodcastGroup[];
  participants?: PodcastSetup["participants"];
  updatedAt: string;
};

export type ProjectWithPodcastCheckpoint = Project & {
  lickety?: NonNullable<Project["lickety"]> & { podcastWizard?: PodcastWizardCheckpoint };
};

export function selectablePodcastMedia(items: readonly MediaItem[]): MediaItem[] {
  return items.filter((item) => (item.type === "video" || item.type === "audio") && !item.isPlaceholder);
}

export function getTimelineMediaIds(project: Pick<Project, "timeline">): Set<string> {
  const mediaIds = new Set<string>();
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.mediaId) mediaIds.add(clip.mediaId);
    }
  }
  return mediaIds;
}

export function readPodcastWizardCheckpoint(project: Project): PodcastWizardCheckpoint | undefined {
  return (project as ProjectWithPodcastCheckpoint).lickety?.podcastWizard;
}

export function buildPodcastReviewPoints(setup: PodcastSetup): Array<{ label: string; projectSeconds: number; assetId?: string }> {
  const points: Array<{ label: string; projectSeconds: number; assetId?: string }> = [];
  const timeline = podcastTimelineModel(setup);
  const clips = timeline.lanes.flatMap((lane) => lane.clips).filter((clip) => clip.status !== "excluded");
  const start = clips.length ? Math.min(...clips.map((clip) => clip.startSeconds)) : 0;
  const end = clips.length ? Math.max(...clips.map((clip) => clip.endSeconds)) : 0;
  if (end > start) {
    points.push({ label: "Episode beginning", projectSeconds: start });
    points.push({ label: "Episode middle", projectSeconds: (start + end) / 2 });
    points.push({ label: "Episode end", projectSeconds: end });
  }
  for (const clip of clips) {
    points.push({ label: `${clip.name} start`, projectSeconds: clip.startSeconds, assetId: clip.assetId });
    points.push({ label: `${clip.name} end`, projectSeconds: clip.endSeconds, assetId: clip.assetId });
  }
  const unique = new Map<string, { label: string; projectSeconds: number; assetId?: string }>();
  for (const point of points) {
    const key = `${point.assetId ?? "episode"}:${point.projectSeconds.toFixed(4)}`;
    if (!unique.has(key)) unique.set(key, point);
  }
  return [...unique.values()].sort((a, b) => a.projectSeconds - b.projectSeconds);
}
