import type { MediaItem, Project } from "@licketysplit/core";
import type { PodcastGroup, PodcastSetup, PodcastSetupStep } from "@licketysplit/core/lickety/podcast-types";
import { podcastTimelineModel } from "./podcast-review-model";

export type PodcastPictureGapPolicy = "keep-picture-gaps" | "available-camera-fallback";

export type PodcastWizardCheckpoint = {
  setupId?: string;
  step: PodcastSetupStep;
  selectedMediaIds: string[];
  groups?: PodcastGroup[];
  participants?: PodcastSetup["participants"];
  pictureGapPolicy?: PodcastPictureGapPolicy;
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
  const checkpoint = (project as ProjectWithPodcastCheckpoint).lickety?.podcastWizard;
  if (!checkpoint) return undefined;
  const policy = (checkpoint as PodcastWizardCheckpoint & { pictureGapPolicy?: unknown }).pictureGapPolicy;
  if (isPodcastPictureGapPolicy(policy) || policy === undefined) return checkpoint;
  const { pictureGapPolicy: _invalidPolicy, ...validCheckpoint } = checkpoint;
  return validCheckpoint;
}

export function isPodcastPictureGapPolicy(value: unknown): value is PodcastPictureGapPolicy {
  return value === "keep-picture-gaps" || value === "available-camera-fallback";
}

export function resolvePodcastPictureGapPolicy(project: Project): PodcastPictureGapPolicy | null {
  const savedPolicy = readPodcastWizardCheckpoint(project)?.pictureGapPolicy;
  if (savedPolicy) return savedPolicy;
  const assemblyPolicy = project.lickety?.podcastAssembly?.pictureGapPolicy;
  return isPodcastPictureGapPolicy(assemblyPolicy) ? assemblyPolicy : null;
}

export function podcastProgressFraction(progress: { completed: number; total: number }): number | null {
  if (!Number.isFinite(progress.completed) || !Number.isFinite(progress.total) || progress.total <= 0 || progress.completed < 0 || progress.completed > progress.total) return null;
  return progress.completed / progress.total;
}

export function buildPodcastReviewPoints(setup: PodcastSetup): Array<{ label: string; projectSeconds: number; assetId?: string; assetIds?: string[] }> {
  const points: Array<{ label: string; projectSeconds: number; assetId?: string; assetIds?: string[] }> = [];
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
    const group = setup.groups.find((item) => item.assetIds.includes(clip.assetId));
    const index = group?.assetIds.indexOf(clip.assetId) ?? -1;
    const rolePart = group ? `${group.name} · part ${index + 1} of ${group.assetIds.length}` : "Recording";
    points.push({ label: `${rolePart} start`, projectSeconds: clip.startSeconds, assetId: clip.assetId });
    points.push({ label: `${rolePart} end`, projectSeconds: clip.endSeconds, assetId: clip.assetId });
  }
  const ordered = points.sort((a, b) => a.projectSeconds - b.projectSeconds);
  const grouped: Array<{ label: string; projectSeconds: number; assetId?: string; assetIds?: string[] }> = [];
  for (let index = 0; index < ordered.length;) {
    const cluster = [ordered[index]];
    let next = index + 1;
    while (next < ordered.length && ordered[next].projectSeconds - ordered[index].projectSeconds <= 0.02) cluster.push(ordered[next++]);
    const episodeLabels = cluster.filter((point) => !point.assetId).map((point) => point.label);
    const sourceLabels = cluster.filter((point) => point.assetId).map((point) => point.label);
    const uniqueSources = [...new Set(sourceLabels)];
    const episode = episodeLabels[0];
    const label = episode && uniqueSources.length === 0 ? episode
      : episode && uniqueSources.length === 1 ? `${episode} · ${uniqueSources[0]}`
      : episode ? `${episode} · ${uniqueSources.length} recording boundaries`
        : uniqueSources.length > 2 ? `${uniqueSources[0]} · ${uniqueSources.length} recording boundaries`
          : uniqueSources.join(" · ");
    const assetIds = [...new Set(cluster.flatMap((point) => point.assetId ? [point.assetId] : point.assetIds ?? []))];
    grouped.push({ label: label || cluster[0].label, projectSeconds: cluster[0].projectSeconds, ...(assetIds.length ? { assetId: assetIds[0], assetIds } : {}) });
    index = next;
  }
  return grouped;
}
