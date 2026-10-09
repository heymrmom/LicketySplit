import { createHash } from "node:crypto";
import path from "node:path";
import type { PodcastAsset, PodcastGroup, PodcastGroupConfidence } from "../../../../../../packages/core/src/lickety/podcast-types";
import { parseRate, rateValue, timecodeToFrames } from "./legacy/time";

interface NameSequence { familyKey: string; number: number; digits: number; display: string }

function sequence(name: string): NameSequence | undefined {
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  const match = /^(.*?)(\d+)(\D*)$/.exec(stem);
  if (!match) return undefined;
  const [, prefix, digits, suffix] = match;
  const shortPrefix = /^DJI_/i.test(prefix) ? "DJI" : /^C\d+[A-Z]?/i.test(stem) ? stem.match(/^C\d+[A-Z]?/i)?.[0] || prefix : prefix.replace(/[_\-.\s]+$/g, "") || stem;
  return {
    familyKey: `${prefix.toLowerCase().replace(/\d{8,}/g, "{timestamp}")}#${suffix.toLowerCase()}${extension.toLowerCase()}`,
    number: Number(digits), digits: digits.length, display: shortPrefix,
  };
}

function compatible(a: PodcastAsset, b: PodcastAsset): boolean {
  if (a.kind !== b.kind || a.codec !== b.codec || a.channels !== b.channels || a.sampleRate !== b.sampleRate) return false;
  if (a.kind !== "video") return true;
  return a.width === b.width && a.height === b.height && (a.fps === undefined || b.fps === undefined ? a.fps === b.fps : Math.abs(a.fps - b.fps) < 0.02);
}

function boundaryGapSeconds(left: PodcastAsset, right: PodcastAsset): number | undefined {
  const leftRate = left.sourceTimecodeRate ?? (left.fps ? parseRate(left.fps) : undefined);
  const rightRate = right.sourceTimecodeRate ?? (right.fps ? parseRate(right.fps) : undefined);
  const leftTimecode = left.timecode && leftRate ? timecodeToFrames(left.timecode, leftRate) : undefined;
  const rightTimecode = right.timecode && rightRate ? timecodeToFrames(right.timecode, rightRate) : undefined;
  if (leftTimecode !== undefined && rightTimecode !== undefined && leftRate && rightRate && rateValue(leftRate) === rateValue(rightRate)) return (rightTimecode - leftTimecode) / rateValue(leftRate) - left.durationSeconds;
  const leftCreated = left.creationTime ? Date.parse(left.creationTime) : Number.NaN;
  const rightCreated = right.creationTime ? Date.parse(right.creationTime) : Number.NaN;
  if (Number.isFinite(leftCreated) && Number.isFinite(rightCreated)) return (rightCreated - leftCreated) / 1000 - left.durationSeconds;
  return undefined;
}

function group(assets: PodcastAsset[], confidence: PodcastGroupConfidence, warnings: string[]): PodcastGroup {
  const first = assets[0];
  const stem = path.basename(first.name, path.extname(first.name));
  const mic = /^(mic|lav|iso)[ _-]*\d+/i.test(stem);
  const candidateDialogue = first.kind === "audio" && (mic || (first.channels === 1 && first.durationSeconds >= 300));
  const start = sequence(assets[0].name), end = sequence(assets.at(-1)!.name);
  const name = assets.length > 1 && start && end
    ? `${start.display || stem} ${String(start.number).padStart(start.digits, "0")}–${String(end.number).padStart(start.digits, "0")}`
    : stem;
  const id = createHash("sha256").update(assets.map((asset) => asset.id).join(":")).digest("hex").slice(0, 16);
  return {
    id: `group-${id}`, name, kind: first.kind, role: first.kind === "video" ? "camera" : candidateDialogue ? "dialogue" : "other",
    framing: first.kind === "video" ? "other" : undefined,
    participantIds: [], audioParticipantIds: [], audioMode: first.channels ? candidateDialogue ? "isolated" : "reference" : "none",
    confidence, assetIds: assets.map((asset) => asset.id), warnings,
  };
}

/** Physical grouping only; this deliberately does not assert episode timing. */
export function groupPodcastAssets(assets: PodcastAsset[]): PodcastGroup[] {
  const candidateSets = new Map<string, PodcastAsset[]>(), singles: PodcastAsset[] = [];
  for (const asset of assets) {
    const identity = sequence(asset.name);
    if (!identity) { singles.push(asset); continue; }
    const key = `${asset.kind}:${identity.familyKey}`;
    candidateSets.set(key, [...(candidateSets.get(key) ?? []), asset]);
  }
  const groups: PodcastGroup[] = [], sourceOrder = new Map(assets.map((asset, index) => [asset.id, index]));
  for (const candidates of candidateSets.values()) {
    candidates.sort((a, b) => sequence(a.name)!.number - sequence(b.name)!.number);
    const first = candidates[0], firstName = path.basename(first.name, path.extname(first.name)), digits = sequence(first.name)!.digits;
    const simultaneousMic = /^(mic|lav|iso)[ _-]*\d+$/i.test(firstName);
    const canSequenceAudio = first.kind === "video" || (!simultaneousMic && digits >= 3 && candidates.every((asset) => asset.timecode || asset.creationTime));
    if (!canSequenceAudio || candidates.length === 1) { singles.push(...candidates); continue; }
    let cluster: PodcastAsset[] = [candidates[0]], warnings: string[] = [];
    const flush = () => {
      const hasTiming = cluster.length > 1 && cluster.slice(1).every((asset, index) => boundaryGapSeconds(cluster[index], asset) !== undefined);
      groups.push(group(cluster, cluster.length > 1 && hasTiming ? "high" : cluster.length > 1 ? "medium" : warnings.length ? "review" : "medium", warnings));
      cluster = []; warnings = [];
    };
    for (const candidate of candidates.slice(1)) {
      const previous = cluster.at(-1)!;
      const consecutive = sequence(candidate.name)!.number === sequence(previous.name)!.number + 1;
      const gap = boundaryGapSeconds(previous, candidate);
      const duplicateTimecode = Boolean(previous.timecode && candidate.timecode && previous.timecode === candidate.timecode);
      const discontinuity = gap !== undefined && (gap < -2.25 || gap > 120);
      if (!consecutive || !compatible(previous, candidate) || duplicateTimecode || discontinuity) {
        const reason = duplicateTimecode
          ? `${previous.name} and ${candidate.name} report the same source timecode.`
          : discontinuity
            ? `${candidate.name} is separated from ${previous.name} by ${Math.abs(gap!).toFixed(1)} seconds.`
            : !consecutive
              ? `The sequence jumps between ${previous.name} and ${candidate.name}.`
              : `Media settings change between ${previous.name} and ${candidate.name}.`;
        warnings.push(reason); flush(); cluster = [candidate]; warnings = [];
      } else {
        cluster.push(candidate);
        if (gap !== undefined && gap < -0.25) warnings.push(`${candidate.name} overlaps the previous recording by ${Math.abs(gap).toFixed(1)} seconds according to metadata. Review the boundary using waveform evidence; lane grouping does not establish its placement.`);
      }
    }
    if (cluster.length) flush();
  }
  groups.push(...singles.map((asset) => group([asset], "medium", [])));
  return groups.sort((a, b) => a.kind !== b.kind ? a.kind === "video" ? -1 : 1 : (sourceOrder.get(a.assetIds[0]) ?? 0) - (sourceOrder.get(b.assetIds[0]) ?? 0));
}
