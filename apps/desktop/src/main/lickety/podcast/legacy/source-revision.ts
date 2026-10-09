import { createHash } from "node:crypto";
import type { PodcastAnalysis, PodcastGroup, PodcastSetup, PodcastParticipant } from "../../../../../../../packages/core/src/lickety/podcast-types";
import { nativeSetupMappingDigest } from "./approval";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Native adaptation of legacy reviseSyncSources: source identity comes from the managed-media registry ID. */
export function revisePodcastSources(previous: PodcastSetup, analysisInput: PodcastAnalysis, groupInput: PodcastGroup[], participantInput: PodcastParticipant[]): PodcastSetup {
  if (previous.analysisProposal) throw new Error("Apply or discard the proposed retry before changing Setup.");
  const analysis = structuredClone(analysisInput), groups = structuredClone(groupInput), participants = structuredClone(participantInput);
  const ids = groups.flatMap((group) => group.assetIds), assets = new Map(analysis.assets.map((asset) => [asset.id, asset]));
  if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !assets.has(id))) throw new Error("Source groups must contain unique inventoried recordings.");

  const oldIds = previous.groups.flatMap((group) => group.assetIds);
  const essential = (asset: PodcastAnalysis["assets"][number]) => ({
    kind: asset.kind, nativeRate: asset.nativeRate, nativeVideoFrames: asset.nativeVideoFrames,
    nativeVideoDurationSeconds: asset.nativeVideoDurationSeconds,
    streams: asset.streams?.map((stream) => ({ index: stream.index, kind: stream.kind, codec: stream.codec, channelLayout: stream.channelLayout,
      rate: stream.rate, declaredRate: stream.declaredRate, timeBase: stream.timeBase, startSeconds: stream.startSeconds,
      durationSeconds: stream.durationSeconds, sampleRate: stream.sampleRate, channels: stream.channels, frameCount: stream.frameCount,
      initialPadding: stream.initialPadding, discontinuities: stream.discontinuities })),
  });
  const unchanged = new Set<string>();
  for (const id of ids) {
    const next = assets.get(id)!, old = previous.analysis.assets.find((asset) => asset.id === id);
    if (!old) continue;
    // Registry IDs rotate when a managed original is replaced. Streams are compared
    // without timestampStatus so an inspector classification upgrade alone keeps timing authority.
    const sameIdentity = old.sourceId === next.sourceId && old.sizeBytes === next.sizeBytes;
    const sameFacts = digest(essential(old)) === digest(essential(next));
    if (sameIdentity && sameFacts) unchanged.add(id);
  }
  if (previous.placements.length && !unchanged.has(previous.referenceAssetId ?? "")) {
    throw new Error("Choose an unchanged connected recording as the project reference before removing or replacing the current reference. Saved timing has not changed.");
  }

  const next = structuredClone(previous), changedIds = oldIds.filter((id) => !unchanged.has(id));
  const priorApproval = previous.approval ? structuredClone(previous.approval) : undefined;
  const semanticSetup = (rows: PodcastGroup[]) => rows.map((group) => ({
    id: group.id, name: group.name, role: group.role, framing: group.framing,
    participantIds: group.participantIds, audioMode: group.audioMode, audioParticipantIds: group.audioParticipantIds,
  })).sort((a, b) => a.id.localeCompare(b.id)).map(({ id: _id, ...fields }) => fields);
  const priorSetup = digest(semanticSetup(previous.groups)), nextSetup = digest(semanticSetup(groups));
  const links = (rows: PodcastGroup[]) => rows.filter((group) => group.recordingLink).map((group) => [group.id, group.assetIds, group.recordingLink]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const linksChanged = digest(links(previous.groups)) !== digest(links(groups));
  const bindingSignature = (group: PodcastGroup | undefined) => group ? digest({ assetIds: group.assetIds, audioBindings: group.audioBindings ?? [] }) : "absent";
  const oldGroupById = new Map(previous.groups.map((group) => [group.id, group])), nextGroupById = new Map(groups.map((group) => [group.id, group]));
  const bindingAffected = new Set<string>();
  for (const id of new Set([...oldGroupById.keys(), ...nextGroupById.keys()])) if (bindingSignature(oldGroupById.get(id)) !== bindingSignature(nextGroupById.get(id))) {
    for (const group of [oldGroupById.get(id), nextGroupById.get(id)]) for (const assetId of group?.assetIds ?? []) bindingAffected.add(assetId);
  }
  const bindingsChanged = bindingAffected.size > 0;
  const semanticChange = priorSetup !== nextSetup;
  const affected = new Set<string>(changedIds);
  if (linksChanged) {
    const oldClocks = previous.clockGroups.filter((group) => group.sourceStarts);
    const nextClocks = setupClockGroups(analysis, groups).filter((group) => group.sourceStarts);
    for (const group of [...oldClocks, ...nextClocks]) for (const id of group.assetIds) affected.add(id);
  }
  for (const id of bindingAffected) affected.add(id);

  next.sourceHistory ??= [];
  for (const id of changedIds) {
    const oldAsset = previous.analysis.assets.find((asset) => asset.id === id);
    if (!oldAsset) continue;
    const replaced = ids.includes(id);
    next.sourceHistory.push({ revision: previous.revision + 1,
      reason: replaced ? "Registered source identity or stream facts changed; previous decision retained for review." : "Source removed from Setup; previous decision retained for review.",
      assetId: id, asset: structuredClone(oldAsset), ...(previous.placements.find((placement) => placement.assetId === id) ? { placement: structuredClone(previous.placements.find((placement) => placement.assetId === id)!) } : {}) });
  }
  if (affected.has(previous.referenceAssetId ?? "") && previous.placements.length) {
    throw new Error("Choose an unchanged connected recording as the reference before changing its recording relationship or audio binding. Saved timing has not changed.");
  }

  next.analysis = analysis; next.groups = groups; next.participants = participants; next.analysis.groups = structuredClone(groups);
  next.channels = next.channels.filter((channel) => unchanged.has(channel.assetId) && !affected.has(channel.assetId));
  next.edges = next.edges.filter((edge) => unchanged.has(edge.a) && unchanged.has(edge.b) && !affected.has(edge.a) && !affected.has(edge.b));
  next.reviewChecks = next.reviewChecks?.filter((check) => unchanged.has(check.assetId) && !affected.has(check.assetId) && next.channels.some((channel) => channel.id === check.referenceChannelId));
  next.regionEvidence = next.regionEvidence?.filter((evidence) => unchanged.has(evidence.assetId) && !affected.has(evidence.assetId) && next.channels.some((channel) => channel.id === evidence.referenceChannelId));
  next.validationReservations = next.validationReservations?.filter((row) => unchanged.has(row.assetId) && !affected.has(row.assetId));
  for (const id of [...affected].filter((assetId) => !changedIds.includes(assetId))) {
    const placement = previous.placements.find((item) => item.assetId === id), asset = previous.analysis.assets.find((item) => item.id === id);
    if (placement && asset) next.sourceHistory.push({ revision: previous.revision + 1, reason: linksChanged && !bindingsChanged ? "Recording relationship changed in Setup; previous timing archived." : "Audio binding changed in Setup; previous timing archived.", assetId: id, asset: structuredClone(asset), placement: structuredClone(placement) });
  }
  next.placements = next.placements.filter((placement) => unchanged.has(placement.assetId) && !affected.has(placement.assetId));
  next.clockGroups = next.clockGroups.map((group) => ({ ...group, assetIds: group.assetIds.filter((id) => unchanged.has(id) && !affected.has(id)) })).filter((group) => group.assetIds.length);
  const nextClocks = setupClockGroups(analysis, groups);
  for (const id of ids.filter((assetId) => !unchanged.has(assetId))) next.clockGroups.push({ id, assetIds: [id], confirmed: true, provenance: "Channels within this source share its mapping; no cross-file clock assumption." });
  if (linksChanged || bindingsChanged) next.clockGroups = [...next.clockGroups.filter((group) => !group.assetIds.some((id) => affected.has(id))), ...nextClocks.filter((group) => group.assetIds.some((id) => affected.has(id)))];

  const inventoryChanged = oldIds.length !== ids.length || ids.some((id) => !unchanged.has(id));
  const timingChanged = linksChanged || bindingsChanged || inventoryChanged || !next.placements.length;
  next.analysisProposal = undefined; next.timingUndo = undefined;
  if (!next.placements.length) next.referenceAssetId = analysis.assets.filter((asset) => ids.includes(asset.id)).sort((a, b) => b.durationSeconds - a.durationSeconds)[0].id;
  next.revision++; next.updatedAt = new Date().toISOString(); next.approval = undefined;
  if (!timingChanged && !semanticChange && priorApproval && previous.state === "approved") {
    next.state = "approved";
    next.approval = { ...priorApproval, revision: next.revision, mappingDigest: nativeSetupMappingDigest(next) };
    next.warnings.push(`Setup revision ${next.revision}: recording names or display order changed. Approved timing was preserved.`);
  } else {
    next.state = timingChanged || previous.state === "draft" ? "draft" : "review";
    next.warnings.push(`Source revision ${next.revision}: ${unchanged.size} unchanged sources retain their mappings and reusable evidence; ${changedIds.length} prior source decisions archived. Review the updated setup.`);
  }
  if (next.transcriptCompatibility !== "unbound" && (timingChanged || semanticChange)) next.transcriptCompatibility = "stale";
  return next;
}

/** Port of setupClockGroups from recording-links.ts, applied only at the Setup revision boundary. */
function setupClockGroups(analysis: PodcastAnalysis, groups: PodcastGroup[]): Array<{ id: string; assetIds: string[]; confirmed: boolean; provenance: string; sourceStarts?: Record<string, number> }> {
  const links = new Map<string, PodcastGroup[]>();
  for (const group of groups) if (group.recordingLink) links.set(group.recordingLink.id, [...(links.get(group.recordingLink.id) ?? []), group]);
  const clocks: Array<{ id: string; assetIds: string[]; confirmed: boolean; provenance: string; sourceStarts?: Record<string, number> }> = [];
  const linked = new Set<string>();
  for (const [id, members] of links) {
    const kind = members[0].recordingLink!.kind;
    if (members.some((group) => group.recordingLink!.kind !== kind)) throw new Error("A recording relationship cannot mix simultaneous channels and consecutive files.");
    const sources = members.flatMap((group) => group.assetIds.map((assetId) => analysis.assets.find((asset) => asset.id === assetId)!));
    if (sources.length < 2) continue;
    if (sources.some((asset) => !asset)) throw new Error("Recording relationship contains an unavailable source.");
    if (kind === "simultaneous" && (sources.some((asset) => asset.kind !== "audio" || asset.sampleRate !== sources[0].sampleRate) || members.some((group) => group.assetIds.length !== 1))) throw new Error("Same-recorder channels must be individual audio files with the same sample rate.");
    if (kind === "continuous" && (members.length !== 1 || sources.some((asset) => asset.kind !== "video"))) throw new Error("Continuous recording must be one ordered camera group.");
    const sourceStarts: Record<string, number> = {}; let start = 0;
    for (const asset of sources) {
      sourceStarts[asset.id] = kind === "simultaneous" ? 0 : start - (asset.streams?.find((stream) => stream.kind === "video")?.startSeconds ?? 0);
      const duration = asset.nativeVideoDurationSeconds ?? asset.durationSeconds;
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("A linked recording needs a known positive duration.");
      start += duration; linked.add(asset.id);
    }
    clocks.push({ id: `setup:${id}`, assetIds: sources.map((asset) => asset.id), confirmed: true, sourceStarts,
      provenance: kind === "simultaneous" ? "Confirmed in Setup: separate channels of the same recorder, started together; preserve original sample timing." : "Confirmed in Setup: one continuous camera recording split into consecutive files, with no pauses or missing files." });
  }
  return [...clocks, ...groups.flatMap((group) => group.assetIds).filter((id) => !linked.has(id)).map((id) => ({ id, assetIds: [id], confirmed: true, provenance: "Channels within one media asset share its clock." }))];
}
