import type { PodcastAnalysis, PodcastGroup } from "@openreel/core/lickety/podcast-types";

const reviewGroup = (group: PodcastGroup, assetIds: string[]): PodcastGroup => ({
  ...group,
  assetIds,
  recordingLink: undefined,
  confidence: "review",
  audioBindings: group.audioBindings?.filter((binding) => assetIds.includes(binding.assetId)),
  warnings: [...new Set([...group.warnings, "This group changed manually; confirm its order and timing relationship."])],
});

/** Port of legacy shared/recording-links.ts simultaneousSuggestions. Metadata asks for confirmation; it never confirms a recorder relationship itself. */
export function simultaneousPodcastSuggestions(analysis: PodcastAnalysis, groups: PodcastGroup[]): string[][] {
  const buckets = new Map<string, string[]>();
  for (const group of groups.filter((candidate) => candidate.kind === "audio" && candidate.assetIds.length === 1)) {
    const asset = analysis.assets.find((candidate) => candidate.id === group.assetIds[0]);
    if (!asset?.bwfTimeReferenceSamples || !asset.sampleRate) continue;
    const key = `${asset.sampleRate}:${asset.bwfTimeReferenceSamples}:${Math.round(asset.durationSeconds * asset.sampleRate)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), group.id]);
  }
  return [...buckets.values()].filter((ids) => ids.length > 1);
}

/** Port of legacy recorder-timing-state.ts, adapted to portable group IDs. */
export function podcastRecorderTimingLinked(groups: PodcastGroup[], ids: string[]): boolean {
  const members = ids.map((id) => groups.find((group) => group.id === id));
  const link = members[0]?.recordingLink;
  return ids.length > 1 && link?.kind === "simultaneous" && members.every((group) =>
    group?.recordingLink?.kind === "simultaneous" && group.recordingLink.id === link.id,
  );
}

export function setPodcastRecorderTimingLinked(groups: PodcastGroup[], ids: string[], linked: boolean): PodcastGroup[] {
  const recordingLink = linked ? { id: `recorder:${[...ids].sort().join(":")}`, kind: "simultaneous" as const } : undefined;
  return groups.map((group) => ids.includes(group.id) ? { ...group, recordingLink } : group);
}

export function moveGroupAsset(group: PodcastGroup, assetIndex: number, delta: -1 | 1): PodcastGroup {
  const nextIndex = assetIndex + delta;
  if (assetIndex < 0 || assetIndex >= group.assetIds.length || nextIndex < 0 || nextIndex >= group.assetIds.length) return group;
  const assetIds = [...group.assetIds];
  [assetIds[assetIndex], assetIds[nextIndex]] = [assetIds[nextIndex], assetIds[assetIndex]];
  return reviewGroup(group, assetIds);
}

export function movePodcastGroupAsset(groups: PodcastGroup[], groupIndex: number, assetIndex: number, delta: -1 | 1): PodcastGroup[] {
  return groups.map((group, index) => index === groupIndex ? moveGroupAsset(group, assetIndex, delta) : group);
}

export function splitPodcastGroup(groups: PodcastGroup[], groupIndex: number, splitBeforeIndex: number, makeId: () => string = () => crypto.randomUUID()): PodcastGroup[] | null {
  const group = groups[groupIndex];
  if (!group || splitBeforeIndex <= 0 || splitBeforeIndex >= group.assetIds.length) return null;
  const left = reviewGroup(group, group.assetIds.slice(0, splitBeforeIndex));
  const right = reviewGroup(group, group.assetIds.slice(splitBeforeIndex));
  const next = [...groups];
  next.splice(groupIndex, 1, { ...left, id: makeId(), name: `${group.name} A` }, { ...right, id: makeId(), name: `${group.name} B` });
  return next;
}

export function mergePodcastGroups(groups: PodcastGroup[], currentIndex: number, makeId: () => string = () => crypto.randomUUID()): PodcastGroup[] | null {
  const previous = groups[currentIndex - 1];
  const current = groups[currentIndex];
  if (!previous || !current || previous.kind !== current.kind) return null;
  const merged: PodcastGroup = reviewGroup({
    ...previous,
    id: makeId(),
    name: `${previous.name} + ${current.name}`,
    assetIds: [...previous.assetIds, ...current.assetIds],
    audioBindings: [...(previous.audioBindings ?? []), ...(current.audioBindings ?? [])],
    audioParticipantIds: [...new Set([...(previous.audioParticipantIds ?? []), ...(current.audioParticipantIds ?? [])])],
    participantIds: [...new Set([...(previous.participantIds ?? []), ...(current.participantIds ?? [])])],
    warnings: [...previous.warnings, ...current.warnings],
  }, [...previous.assetIds, ...current.assetIds]);
  const next = [...groups];
  next.splice(currentIndex - 1, 2, merged);
  return next;
}

export function excludePodcastAsset(groups: PodcastGroup[], groupIndex: number, assetId: string): PodcastGroup[] {
  const group = groups[groupIndex];
  if (!group || !group.assetIds.includes(assetId)) return groups;
  const assetIds = group.assetIds.filter((id) => id !== assetId);
  const next = [...groups];
  if (!assetIds.length) next.splice(groupIndex, 1);
  else next[groupIndex] = reviewGroup(group, assetIds);
  return next;
}
