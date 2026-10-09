import type {
  PodcastAsset,
  PodcastPlacement,
  PodcastSetup,
  PodcastSyncChannel,
  PodcastWaveformSummary,
} from "@licketysplit/core/lickety/podcast-types";

/**
 * Adapted from the legacy renderer helpers in src/sync-review-state.ts and
 * src/sync-timeline.ts. The podcast setup DTO keeps their mapping, region,
 * channel, and revision fields; this adapter supplies the legacy presentation
 * behavior without introducing its filesystem-backed SyncProject type.
 */

export const PACKET_TIMING_WARNING = "VFR or packet timeline discontinuity: region mapping required before approval.";

export function unwaivedTimingBlockers(placement: PodcastPlacement): string[] {
  const waiver = placement.timingWaiver;
  return (placement.unsupported ?? []).filter((reason) =>
    reason !== PACKET_TIMING_WARNING || !waiver?.note.trim() || !waiver.reasons.includes(reason),
  );
}

function regionAtProject(placement: PodcastPlacement, projectSeconds: number): boolean {
  if (!placement.regions) {
    const sourceSeconds = (projectSeconds - placement.mapping.offsetSeconds) / placement.mapping.scale;
    return Number.isFinite(sourceSeconds);
  }
  return placement.regions.filter((region) => region.status !== "excluded" &&
    projectSeconds >= region.sourceStartSeconds * region.mapping.scale + region.mapping.offsetSeconds &&
    projectSeconds < region.sourceEndSeconds * region.mapping.scale + region.mapping.offsetSeconds).length === 1;
}

export function clipReview(placement: PodcastPlacement): { label: string; attention: boolean; reason: string } {
  if (placement.status === "excluded") return { label: "Left out", attention: false, reason: "This clip is excluded from the synchronized timeline." };
  if (unwaivedTimingBlockers(placement).length) return { label: "Timing needs attention", attention: true, reason: "This timing cannot be safely applied yet. Review the reason below, adjust it, or leave this clip out." };
  if (placement.status === "unresolved" || placement.regions?.some((region) => region.status === "unresolved")) {
    const label = placement.component && !placement.provenance.includes("disconnected-component") ? "Check these moments" : "Needs placement";
    const reason = placement.reviewReason === "small-discrepancy"
      ? "The match has small disagreements beyond the 5 ms precision target. Listen to the flagged moments before accepting or adjusting it."
      : placement.reviewReason === "conflicting-timing"
        ? "Some checks disagree with the proposed timing. Compare the flagged moments to distinguish a constant offset from a change over time."
        : "There is not enough independent shared sound to confirm this timing. Check playback, retry matching, or place it from a known cue.";
    return { label, attention: true, reason };
  }
  if (placement.humanAcceptance) return { label: "Accepted by you", attention: false, reason: `${placement.humanAcceptance.note} Automatic evidence remains unchanged.` };
  if (placement.status === "manual" || placement.regions?.some((region) => region.status === "manual")) return { label: "Placed manually", attention: false, reason: "Your saved placement is in use. Check playback before applying." };
  if (placement.timingWaiver) return { label: "Timing warning waived", attention: false, reason: "The current timing is retained with your saved exception note. Check picture and sound before applying." };
  if (placement.status === "reference") return { label: "Timing reference", attention: false, reason: "This clip sets the timeline’s timing. Check its placement before applying." };
  return { label: "Aligned", attention: false, reason: "Matching sound was found. Listen to the comparison and check picture and sound before applying." };
}

export function podcastReviewState(setup: PodcastSetup) {
  const attention = setup.placements.filter((placement) => clipReview(placement).attention);
  const hasResults = setup.placements.length > 0;
  const approved = hasResults && setup.state === "approved" && setup.approval?.revision === setup.revision && Boolean(setup.approval.mappingDigest);
  const resumable = ["draft", "canceled", "error", "analyzing"].includes(setup.state) || !hasResults || (setup.state === "approved" && !approved);
  const title = setup.state === "canceled" ? "Sync stopped"
    : setup.state === "error" ? "Sync needs another try"
      : resumable ? "Ready to sync"
        : approved ? "Timing approved"
          : attention.length ? `${attention.length} ${attention.length === 1 ? "recording needs" : "recordings need"} your help`
            : "Check playback, then apply";
  const message = setup.state === "canceled"
    ? hasResults ? "A later synchronization run was stopped. Your prior completed placements are still saved; review them without running analysis again." : "Synchronization stopped before placements were available. Continue when you’re ready."
    : setup.state === "analyzing"
      ? `Your saved decisions and completed analysis are kept.${hasResults ? " The results below are from an incomplete run." : ""} Continue when you’re ready.`
      : setup.state === "error" ? "Saved work is kept. Try again, or open the details to check the source that caused the problem."
        : !hasResults ? "Match video and audio that share sound. For independent takes or a single file, choose manual setup."
          : approved ? "This saved version is approved. Apply it as an editable timeline; this does not start a paid service."
            : attention.length ? "Choose a recording below. Review its playback, then adjust it or leave it out."
              : "Review the included recordings using playback. Apply when their timing is right.";
  const action = setup.state === "canceled" && hasResults ? "Review saved alignment"
    : resumable ? setup.state === "draft" ? "Line up recordings" : "Continue syncing"
      : approved ? "Apply as one timeline edit"
        : attention.length ? "Review next recording" : "Apply as one timeline edit";
  return { attention, hasResults, approved, resumable, title, message, action };
}

export function reviewLabel(setup: PodcastSetup, assetId: string): string {
  return setup.groups.find((group) => group.assetIds.includes(assetId))?.name || setup.analysis.assets.find((asset) => asset.id === assetId)?.name || "Recording";
}

/** Choose a saved connected pair, prefer held-out checks, and never imply evidence for an unrelated comparison. */
export function reviewComparison(setup: PodcastSetup, assetId: string): { channelA: string; channelB: string; start: number; evidence: boolean } {
  const usable = (id: string) => setup.channels.find((channel) => channel.id === id && channel.usable && setup.placements.some((placement) => placement.assetId === channel.assetId && placement.status !== "excluded"));
  const owner = setup.placements.find((placement) => placement.assetId === assetId);
  const defaultStart = Math.max(0, owner?.regions?.[0]
    ? owner.regions[0].sourceStartSeconds * owner.regions[0].mapping.scale + owner.regions[0].mapping.offsetSeconds
    : owner?.mapping.offsetSeconds || 0);
  const checks = setup.reviewChecks?.filter((check) => check.assetId === assetId && usable(check.channelId) && usable(check.referenceChannelId) && usable(check.channelId)!.assetId !== usable(check.referenceChannelId)!.assetId) ?? [];
  const check = checks.find((item) => item.status === "failed" && !item.fitOverlap) || checks[0];
  if (check) return { channelA: check.referenceChannelId, channelB: check.channelId, start: Math.max(0, check.projectSeconds - 3), evidence: true };
  const edges = setup.edges.filter((edge) => (edge.a === assetId || edge.b === assetId) && edge.a !== edge.b && usable(edge.channelA) && usable(edge.channelB));
  const edge = edges.find((item) => item.status === "measured") || edges[0];
  if (edge) {
    const anchor = edge.anchors.find((item) => item.role === "validation") || edge.anchors[0];
    // Edges map B source time to A reference time.
    const seconds = anchor && (edge.a === assetId ? anchor.referenceSeconds : anchor.sourceSeconds);
    const part = owner?.regions?.find((region) => seconds !== undefined && seconds >= region.sourceStartSeconds && seconds < region.sourceEndSeconds);
    const mapping = part?.mapping || owner?.mapping;
    return {
      channelA: edge.a === assetId ? edge.channelB : edge.channelA,
      channelB: edge.a === assetId ? edge.channelA : edge.channelB,
      start: Math.max(0, seconds !== undefined && mapping ? seconds * mapping.scale + mapping.offsetSeconds - 3 : defaultStart),
      evidence: Boolean(anchor),
    };
  }
  const channel = setup.channels.find((item) => item.assetId === assetId && item.usable);
  const other = setup.channels.find((item) => item.assetId !== assetId && usable(item.id) && regionAtProject(setup.placements.find((placement) => placement.assetId === item.assetId)!, defaultStart));
  return { channelA: other?.id || "", channelB: channel?.id || "", start: defaultStart, evidence: false };
}

export function formatReviewTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms / 60000) % 60;
  const tail = `${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${tail}` : `${minutes}:${tail}`;
}

export function parseReviewTime(text: string): number {
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(text.trim())) return Number.NaN;
  const seconds = text.trim().split(":").map(Number).reduce((total, value) => total * 60 + value, 0);
  return Number.isFinite(seconds) ? seconds : Number.NaN;
}

export type PodcastTimelineClipModel = {
  id: string;
  assetId: string;
  regionId?: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  status: "not-aligned" | "reference" | "measured" | "unresolved" | "manual" | "excluded";
  locked: boolean;
  attention: boolean;
  channelId?: string;
};

export type PodcastTimelineLaneModel = { id: string; kind: "video" | "audio"; index: number; label: string; role: string; clips: PodcastTimelineClipModel[] };
export type PodcastTimelineModel = { aligned: boolean; startSeconds: number; endSeconds: number; durationSeconds: number; lanes: PodcastTimelineLaneModel[] };

function audioSpans(channel: PodcastSyncChannel) {
  const boundaries = [{ frame: 0, pts: channel.firstPTSSeconds ?? 0 }, ...(channel.discontinuities ?? []).map((group) => ({ frame: Math.round(group.decodedFrame), pts: group.atSeconds }))];
  return boundaries.map((boundary, index) => ({
    firstFrame: boundary.frame,
    frames: (boundaries[index + 1]?.frame ?? channel.frames) - boundary.frame,
    lo: boundary.pts,
    hi: boundary.pts + ((boundaries[index + 1]?.frame ?? channel.frames) - boundary.frame) / channel.sampleRate,
  })).filter((span) => span.frames > 0);
}

function sourceBounds(asset: PodcastAsset, channel?: PodcastSyncChannel): Array<{ start: number; end: number }> {
  if (channel) return audioSpans(channel).map((span) => ({ start: span.lo, end: span.hi }));
  const start = asset.kind === "video" ? asset.streams?.find((stream) => stream.kind === "video")?.startSeconds || 0 : 0;
  return [{ start, end: start + (asset.nativeVideoDurationSeconds || asset.durationSeconds) }];
}

function mappingRegions(placement: PodcastPlacement, lo: number, hi: number) {
  const regions = placement.regions || [{ id: "whole", sourceStartSeconds: lo, sourceEndSeconds: hi, mapping: placement.mapping, status: placement.status === "reference" ? "measured" as const : placement.status, locked: placement.locked, provenance: placement.provenance, note: placement.exception }];
  return regions.map((region) => ({ ...region, sourceStartSeconds: Math.max(lo, region.sourceStartSeconds), sourceEndSeconds: Math.min(hi, region.sourceEndSeconds) })).filter((region) => region.sourceEndSeconds > region.sourceStartSeconds);
}

function provisionalClips(setup: PodcastSetup, assetIds: string[], kind: "video" | "audio"): PodcastTimelineClipModel[] {
  let cursor = 0;
  return assetIds.flatMap((assetId) => {
    const asset = setup.analysis.assets.find((item) => item.id === assetId);
    if (!asset || (kind === "video" && asset.kind !== "video")) return [];
    const duration = Math.max(0.001, asset.durationSeconds);
    const clip: PodcastTimelineClipModel = { id: `${assetId}:${kind}:not-aligned`, assetId, name: asset.name, startSeconds: cursor, endSeconds: cursor + duration, sourceStartSeconds: 0, sourceEndSeconds: duration, status: "not-aligned", locked: false, attention: false };
    cursor += duration;
    return [clip];
  });
}

function alignedClips(setup: PodcastSetup, assetIds: string[], kind: "video" | "audio", streamIndex?: number, channelIndex?: number): PodcastTimelineClipModel[] {
  return assetIds.flatMap((assetId) => {
    const asset = setup.analysis.assets.find((item) => item.id === assetId);
    const placement = setup.placements.find((item) => item.assetId === assetId);
    if (!asset || !placement || (kind === "video" && asset.kind !== "video")) return [];
    const channel = kind === "audio" ? setup.channels.find((item) => item.assetId === assetId && item.streamIndex === streamIndex && item.channel === channelIndex) : undefined;
    if (kind === "audio" && !channel) return [];
    let part = 0;
    return sourceBounds(asset, channel).flatMap((bounds) => mappingRegions(placement, bounds.start, bounds.end).map((region) => {
      const status = region.status === "measured" && placement.status === "reference" ? "reference" : region.status;
      return {
        id: `${assetId}:${kind}:${streamIndex || 0}:${channelIndex || 0}:${region.id}:${part++}`,
        assetId,
        regionId: placement.regions?.some((item) => item.id === region.id) ? region.id : undefined,
        name: asset.name,
        startSeconds: region.mapping.scale * region.sourceStartSeconds + region.mapping.offsetSeconds,
        endSeconds: region.mapping.scale * region.sourceEndSeconds + region.mapping.offsetSeconds,
        sourceStartSeconds: region.sourceStartSeconds,
        sourceEndSeconds: region.sourceEndSeconds,
        status,
        locked: placement.locked || region.locked,
        attention: status === "unresolved" || unwaivedTimingBlockers(placement).length > 0,
        channelId: channel?.id,
      } satisfies PodcastTimelineClipModel;
    }));
  });
}

export function podcastTimelineModel(setup: PodcastSetup): PodcastTimelineModel {
  const aligned = setup.placements.length > 0;
  const lanes: PodcastTimelineLaneModel[] = [];
  let videoIndex = 0;
  let audioIndex = 0;
  for (const group of setup.groups) {
    if (group.kind === "video") {
      videoIndex += 1;
      lanes.push({ id: `${group.id}:video`, kind: "video", index: videoIndex, label: group.name, role: "camera", clips: aligned ? alignedClips(setup, group.assetIds, "video") : provisionalClips(setup, group.assetIds, "video") });
    }
    const channelKeys = [...new Set(setup.channels.filter((channel) => group.assetIds.includes(channel.assetId)).map((channel) => `${channel.streamIndex}:${channel.channel}`))];
    if (aligned && channelKeys.length) {
      for (const key of channelKeys) {
        const [streamIndex, channelIndex] = key.split(":").map(Number);
        audioIndex += 1;
        const role = group.audioMode === "shared-mix" || group.audioMode === "isolated" ? "dialogue" : group.kind === "video" ? "scratch" : group.role;
        const audioName = group.audioMode === "shared-mix" ? "conversation" : group.audioMode === "isolated" ? "microphone" : "camera sound";
        lanes.push({
          id: `${group.id}:audio:${key}`, kind: "audio", index: audioIndex,
          label: `${group.name} · ${audioName}${channelKeys.length > 1 ? ` ${channelIndex + 1}` : ""}`,
          role,
          clips: alignedClips(setup, group.assetIds, "audio", streamIndex, channelIndex),
        });
      }
    } else if (!aligned && (group.kind === "audio" || group.assetIds.some((id) => (setup.analysis.assets.find((asset) => asset.id === id)?.channels || 0) > 0))) {
      audioIndex += 1;
      const role = group.audioMode === "shared-mix" || group.audioMode === "isolated" ? "dialogue" : group.kind === "video" ? "scratch" : group.role;
      lanes.push({ id: `${group.id}:audio:pending`, kind: "audio", index: audioIndex, label: group.name, role, clips: provisionalClips(setup, group.assetIds, "audio") });
    }
  }
  const clips = lanes.flatMap((lane) => lane.clips);
  const startSeconds = Math.min(0, ...clips.map((clip) => clip.startSeconds));
  const endSeconds = Math.max(1, ...clips.map((clip) => clip.endSeconds));
  return { aligned, startSeconds, endSeconds, durationSeconds: Math.max(0.001, endSeconds - startSeconds), lanes };
}

export function timelinePercent(model: PodcastTimelineModel, seconds: number): number {
  return Math.max(0, Math.min(100, ((seconds - model.startSeconds) / model.durationSeconds) * 100));
}

export function timelineSeconds(model: PodcastTimelineModel, percent: number): number {
  return model.startSeconds + Math.max(0, Math.min(100, percent)) / 100 * model.durationSeconds;
}

export function timelineWaveformPath(waveform: PodcastWaveformSummary | undefined, channel: PodcastSyncChannel | undefined, sourceStartSeconds: number, sourceEndSeconds: number, width = 480, height = 34): string {
  if (!waveform || !channel || sourceEndSeconds <= sourceStartSeconds || waveform.secondsPerPeak <= 0) return "";
  const first = Math.max(0, Math.floor((sourceStartSeconds - waveform.sourceStartSeconds) / waveform.secondsPerPeak));
  const last = Math.min(waveform.max.length, Math.ceil((sourceEndSeconds - waveform.sourceStartSeconds) / waveform.secondsPerPeak));
  if (last <= first) return "";
  let peak = 0.02;
  for (let index = first; index < last; index += 1) peak = Math.max(peak, Math.abs(waveform.min[index] || 0), Math.abs(waveform.max[index] || 0));
  const middle = height / 2;
  const points: string[] = [];
  for (let x = 0; x < width; x += 1) {
    const index = Math.min(last - 1, first + Math.floor((x / Math.max(1, width - 1)) * (last - first)));
    points.push(`M${x},${middle - (waveform.max[index] || 0) / peak * (middle - 2)}V${middle - (waveform.min[index] || 0) / peak * (middle - 2)}`);
  }
  return points.join(" ");
}
