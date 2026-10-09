import type { PodcastUpdateRequest } from "../../../../../../../packages/core/src/lickety/podcast-types";
import type { SyncProject } from "./types";
import { assertRecorderConstraints, refreshNativeTimingBlockers } from "./approval";
import { unwaivedTimingBlockers, waivableTimingBlockers } from "./waivers";
import { validateMapping } from "./time";
import { splitRegion, regionStatus, validateRegions } from "./regions";

/** Port of legacy applySyncUpdate. Persistence remains at the native service boundary. */
export function applyPodcastUpdate(project: SyncProject, update: PodcastUpdateRequest) {
  const before = timingSnapshot(project);
  if (project.analysisProposal && !update.analysisDecision) throw new Error("Apply or discard the proposed retry before editing saved timing.");
  if (update.reviewSaved) {
    if (project.state !== "canceled" || !project.placements.length) throw new Error("Saved alignment review is available only after a stopped rerun with existing placements.");
    project.state = "review"; project.updatedAt = new Date().toISOString(); project.approval = undefined;
    return project;
  }
  if (update.analysisDecision) {
    const proposal = project.analysisProposal;
    if (!proposal || proposal.baseRevision !== project.revision) throw new Error("This retry proposal is stale. Reopen the current setup.");
    if (update.analysisDecision === "apply") Object.assign(project, structuredClone(proposal.result));
    project.analysisProposal = undefined;
  } else if (update.undoTiming) {
    if (!project.timingUndo) throw new Error("No timing decision is available to undo.");
    Object.assign(project, structuredClone(project.timingUndo));
  } else if (update.clockAssetIds) {
    const ids = [...new Set(update.clockAssetIds)];
    if (ids.length < 2 || !update.note?.trim() || ids.some((id) => !project.placements.some((item) => item.assetId === id))) throw new Error("Choose at least two inventoried files and record evidence that they share a recorder clock.");
    if (ids.some((id) => project.placements.find((item) => item.assetId === id)?.locked)) throw new Error("Unlock affected sources before changing their recorder-clock group.");
    project.clockGroups = project.clockGroups.map((group) => ({ ...group, assetIds: group.assetIds.filter((id) => !ids.includes(id)) })).filter((group) => group.assetIds.length);
    project.clockGroups.push({ id: `clock-r${project.revision + 1}`, assetIds: ids, confirmed: true, provenance: update.note });
    for (const placement of project.placements.filter((item) => ids.includes(item.assetId))) {
      if (placement.status !== "reference" && placement.status !== "excluded" && placement.status !== "manual") placement.status = "unresolved";
      placement.provenance.push("Recorder clock group changed; retry to validate common rate.");
    }
  } else if (update.referenceAssetId) {
    const reference = project.placements.find((item) => item.assetId === update.referenceAssetId);
    if (!reference || reference.regions || reference.status === "unresolved" || reference.status === "excluded") throw new Error("Choose a connected source with one continuous clock as the reference.");
    const old = { ...reference.mapping };
    for (const placement of project.placements) {
      placement.mapping = { version: 1, scale: placement.mapping.scale / old.scale, offsetSeconds: (placement.mapping.offsetSeconds - old.offsetSeconds) / old.scale };
      for (const region of placement.regions ?? []) region.mapping = { version: 1, scale: region.mapping.scale / old.scale, offsetSeconds: (region.mapping.offsetSeconds - old.offsetSeconds) / old.scale };
      if (placement.status === "reference") placement.status = "measured";
      if (placement.component === project.referenceAssetId) placement.component = update.referenceAssetId;
    }
    for (const check of project.reviewChecks ?? []) check.projectSeconds = (check.projectSeconds - old.offsetSeconds) / old.scale;
    for (const evidence of project.regionEvidence ?? []) {
      evidence.projectSeconds = (evidence.projectSeconds - old.offsetSeconds) / old.scale;
      evidence.observedProjectSeconds = (evidence.observedProjectSeconds - old.offsetSeconds) / old.scale;
    }
    reference.status = "reference"; project.referenceAssetId = update.referenceAssetId;
  } else {
    const placement = project.placements.find((item) => item.assetId === update.assetId);
    if (!placement) throw new Error("Unknown source placement.");
    if (update.offsetSeconds !== undefined || update.scale !== undefined || update.excluded !== undefined || update.splitSourceSeconds !== undefined) placement.humanAcceptance = undefined;
    if (update.acceptTiming) {
      if (placement.locked || placement.regions?.some((region) => region.locked)) throw new Error("Unlock this recording before accepting its timing.");
      if (placement.component !== project.referenceAssetId || placement.provenance.includes("disconnected-component") || unwaivedTimingBlockers(placement).length) throw new Error("This recording still needs a dependable placement or a supported timing format.");
      if (!update.note?.trim()) throw new Error("Record the picture-and-sound review for this acceptance.");
      const regions = update.regionId ? placement.regions?.filter((region) => region.id === update.regionId) : placement.regions;
      if (update.regionId && !regions?.length) throw new Error("Unknown timing section.");
      placement.humanAcceptance = { scope: update.regionId ? "section" : "recording", note: update.note, at: new Date().toISOString() };
      for (const region of regions ?? []) if (region.status !== "excluded") {
        region.status = "manual"; region.note = update.note; region.provenance.push(`Accepted by editor in revision ${project.revision + 1}: ${update.note}`);
      }
      if (placement.regions) regionStatus(placement); else placement.status = "manual";
      placement.exception = update.note; placement.provenance.push(`Human acceptance in revision ${project.revision + 1}; automatic evidence unchanged.`);
    } else if (update.waiveUnsupported !== undefined) {
      if (placement.locked) throw new Error("Unlock this source before changing its timing waiver.");
      if (update.waiveUnsupported) {
        const reasons = waivableTimingBlockers(placement);
        if (!reasons.length) throw new Error("This source has no timing warning that can be waived. Unresolved placement and adapter capability blockers still require a real resolution.");
        if (!update.note?.trim()) throw new Error("Record why the current source timing is acceptable.");
        placement.timingWaiver = { reasons: [...new Set([...(placement.timingWaiver?.reasons ?? []), ...reasons])], note: update.note, waivedAt: new Date().toISOString() };
        placement.exception = update.note; placement.provenance.push(`timing warning waived in revision ${project.revision + 1}: ${reasons.join(" | ")} — ${update.note}`);
      } else {
        placement.timingWaiver = undefined; placement.provenance.push(`timing warning waiver removed in revision ${project.revision + 1}`);
      }
    } else if (update.splitSourceSeconds !== undefined) {
      const asset = project.analysis.assets.find((item) => item.id === placement.assetId)!;
      const streams = asset.streams?.filter((stream) => stream.kind === "video" || stream.kind === "audio") ?? [];
      const starts = streams.map((stream) => stream.startSeconds ?? asset.containerStartSeconds ?? 0);
      const ends = streams.map((stream, index) => starts[index] + (stream.durationSeconds ?? asset.durationSeconds));
      const lo = starts.length ? Math.min(...starts) : asset.containerStartSeconds ?? 0;
      const hi = ends.length ? Math.max(...ends) : (asset.containerStartSeconds ?? 0) + asset.durationSeconds;
      splitRegion(placement, update.splitSourceSeconds, { lo, hi }, update.note ?? "");
    } else if (update.regionId) {
      const region = placement.regions?.find((item) => item.id === update.regionId);
      if (!region) throw new Error("Unknown source region.");
      if (placement.locked || region.locked && (update.offsetSeconds !== undefined || update.scale !== undefined || update.excluded !== undefined)) throw new Error("Unlock the source and region before changing its mapping.");
      if (update.offsetSeconds !== undefined || update.scale !== undefined || update.excluded !== undefined) {
        if (!update.note?.trim()) throw new Error("Record the evidence for this region decision.");
        region.mapping = { ...region.mapping, offsetSeconds: update.offsetSeconds ?? region.mapping.offsetSeconds, scale: update.scale ?? region.mapping.scale };
        validateMapping(region.mapping); region.status = update.excluded ? "excluded" : "manual"; region.note = update.note;
        region.provenance.push(`manual region revision ${project.revision + 1}: ${update.note}`); placement.component = project.referenceAssetId;
      }
      if (update.locked !== undefined) region.locked = update.locked;
      validateRegions(placement.regions!); regionStatus(placement);
    } else {
      if (placement.regions && (update.offsetSeconds !== undefined || update.scale !== undefined)) throw new Error("Select a region before changing a segmented source mapping.");
      if (placement.locked && (update.offsetSeconds !== undefined || update.scale !== undefined)) throw new Error("Unlock this source before changing its time mapping.");
      if (update.offsetSeconds !== undefined || update.scale !== undefined) {
        if (!update.note?.trim()) throw new Error("Record why this manual alignment is appropriate.");
        placement.mapping = { ...placement.mapping, offsetSeconds: update.offsetSeconds ?? placement.mapping.offsetSeconds, scale: update.scale ?? placement.mapping.scale };
        validateMapping(placement.mapping); placement.status = "manual"; placement.component = project.referenceAssetId;
        placement.exception = update.note; placement.provenance.push(`manual revision ${project.revision + 1}: ${update.note}`);
      }
      if (update.excluded !== undefined) {
        if (update.excluded && !update.note?.trim()) throw new Error("Record why this source is excluded.");
        if (placement.locked || placement.regions?.some((region) => region.locked)) throw new Error("Unlock the source and its regions before changing inclusion.");
        for (const region of placement.regions ?? []) {
          region.status = update.excluded ? "excluded" : "unresolved"; region.note = update.note;
          region.provenance.push(`Source inclusion revision ${project.revision + 1}: ${update.note || "restored for review"}`);
        }
        placement.status = update.excluded ? "excluded" : "unresolved"; placement.exception = update.note;
      }
      if (update.locked !== undefined) placement.locked = update.locked;
    }
  }
  assertRecorderConstraints(project);
  refreshNativeTimingBlockers(project);
  project.timingUndo = before;
  project.revision++; project.updatedAt = new Date().toISOString(); project.approval = undefined;
  project.state = update.clockAssetIds || !["review", "approved"].includes(project.state) ? "draft" : "review";
  if (project.transcriptCompatibility !== "unbound") project.transcriptCompatibility = "stale";
  return project;
}

function timingSnapshot(project: SyncProject) {
  return structuredClone({
    algorithm: project.algorithm, parameters: project.parameters, referenceAssetId: project.referenceAssetId, clockGroups: project.clockGroups,
    channels: project.channels.map(({ receipt: _receipt, audioOrdinal: _ordinal, featureFile: _file, featureCacheKey: _key, ...channel }) => channel),
    edges: project.edges, placements: project.placements, reviewChecks: project.reviewChecks,
    regionEvidence: project.regionEvidence, validationReservations: project.validationReservations,
    state: project.state, warnings: project.warnings, metrics: project.metrics,
  });
}
