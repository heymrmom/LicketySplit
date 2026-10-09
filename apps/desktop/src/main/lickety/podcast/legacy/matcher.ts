import { ANALYSIS_RATE, coarseCandidatesYielding, fineCorrelation, fitClock, type Hash } from "../dsp";
import { mediaCheckpoint } from "./resource-control.js";
import { audioSpans } from "./regions.js";
import { refineClockNetwork } from "./graph-fit.js";
import { projectTime } from "./time.js";
import type { PcmReader, SyncAnchor, SyncChannel, SyncEdge, SyncPlacement, SyncProject } from "./types.js";

export async function matchChannels(a: SyncChannel, b: SyncChannel, readFeatures: FeatureReader, readPcm: PcmReader, signal?: AbortSignal): Promise<SyncEdge> {
  const [fa, fb] = await Promise.all([readFeatures(a), readFeatures(b)]);
  const originDelta = a.receipt.firstPTSSeconds - b.receipt.firstPTSSeconds;
  const candidates = (await coarseCandidatesYielding(fa.hashes, fb.hashes, signal ?? new AbortController().signal)).map((c) => ({ ...c, offsetSeconds: c.offsetSeconds + originDelta, acceptedWindows: 0 }));
  const edge: SyncEdge = { a: a.assetId, b: b.assetId, channelA: a.id, channelB: b.id, candidates, anchors: [], status: 'unmatched', reason: 'No supported common-signal candidate.' };
  if (!a.usable || !b.usable) { edge.reason = 'Silence, unusable signal or timestamp discontinuity.'; return edge; }
  const accepted: Array<{ anchors: SyncAnchor[]; mapping: ReturnType<typeof fitClock>; residual: number; overlap: number; index: number }> = [];
  for (let index = 0; index < candidates.length; index++) {
    await mediaCheckpoint(signal);
    const offset = candidates[index].offsetSeconds;
    const lo = Math.max(b.receipt.firstPTSSeconds, a.receipt.firstPTSSeconds - offset) + 0.5;
    const hi = Math.min(Math.max(...audioSpans(b.receipt).map(s=>s.hi)), Math.max(...audioSpans(a.receipt).map(s=>s.hi)) - offset) - 0.5;
    const overlap = hi - lo, window = Math.min(6, overlap / 12);
    if (window < 1) continue;
    // Validation centers are disjoint from fitting centers; no refitting on validation.
    const fractions = [0.06, 0.18, 0.30, 0.42, 0.54, 0.66, 0.78, 0.9];
    const anchors: SyncAnchor[] = [];
    for (let i = 0; i < fractions.length; i++) {
      await mediaCheckpoint(signal);
      const bStart = lo + (overlap - window) * fractions[i], pad = 0.35;
      const aStart = bStart + offset - pad;
      const [apcm, bpcm] = await Promise.all([readPcm(a, aStart, window + 2 * pad), readPcm(b, bStart, window)]);
      if (apcm.length < bpcm.length || !bpcm.length) continue;
      const result = fineCorrelation(apcm, bpcm);
      if (result.score < 0.18 || result.score < result.competingScore * 1.35 || result.rms < 1e-5) continue;
      anchors.push({ role: i % 2 === 0 ? 'fit' : 'validation', sourceSeconds: bStart + window / 2,
        referenceSeconds: aStart + result.lagSamples / ANALYSIS_RATE + window / 2,
        score: result.score, competingScore: result.competingScore, polarity: result.polarity, windowSeconds: window });
    }
    candidates[index].acceptedWindows = anchors.length;
    if (anchors.length > edge.anchors.length) edge.anchors = anchors;
    const fit = anchors.filter((p) => p.role === 'fit'), validation = anchors.filter((p) => p.role === 'validation');
    if (fit.length < 3 || validation.length < 3) continue;
    const mapping = fitClock(fit);
    for (const anchor of anchors) anchor.residualMs = (anchor.referenceSeconds - projectTime(anchor.sourceSeconds, mapping)) * 1000;
    const residual = Math.max(...validation.map((p) => Math.abs(p.residualMs!)));
    const fitResidual = Math.max(...fit.map((p) => Math.abs(p.residualMs!)));
    if (residual > 5 || fitResidual > 5 || Math.abs(mapping.scale - 1) > 0.002) continue;
    accepted.push({ anchors, mapping, residual, overlap, index });
  }
  if (accepted.length > 1) { edge.status = 'ambiguous'; edge.reason = 'Multiple distinct offsets pass window validation; repeated content needs review.'; return edge; }
  if (accepted.length === 1) {
    const match = accepted[0]; edge.anchors = match.anchors; edge.mapping = match.mapping;
    edge.maxValidationResidualMs = match.residual; edge.driftPpm = (match.mapping.scale - 1) * 1e6; edge.overlapSeconds = match.overlap;
    edge.status = 'measured'; edge.reason = 'Distributed fitting and separate validation windows agree within 5 ms.';
  } else if (edge.anchors.length >= 2) { edge.status = 'needs-review'; edge.reason = 'Some common signal found, but independent windows, drift fit or 5 ms validation gate failed.'; }
  return edge;
}

export function solveGraph(assetIds: string[], reference: string, edges: SyncEdge[], previous: SyncPlacement[] = [], clockGroups: SyncProject['clockGroups'] = []): SyncPlacement[] {
  if (!assetIds.includes(reference)) throw new Error('Reference must be an included source.');
  const placements = new Map<string, SyncPlacement>();
  const seed = (id: string, component: string, anchored: boolean) => placements.set(id, { assetId: id, mapping: { version: 1, scale: 1, offsetSeconds: 0 }, component, status: anchored ? 'reference' : 'unresolved', locked: false, provenance: anchored ? ['reference-clock-choice'] : ['disconnected-component'] });
  const recorderEdges: SyncEdge[] = clockGroups.filter(g => g.confirmed && g.sourceStarts && g.assetIds.length > 1).flatMap(g => g.assetIds.slice(1).map(id => ({ a:g.assetIds[0], b:id, channelA:'', channelB:'', basis:'recorder' as const, candidates:[], anchors:[], mapping:{version:1 as const,scale:1,offsetSeconds:g.sourceStarts![id]-g.sourceStarts![g.assetIds[0]]}, status:'measured' as const, reason:g.provenance })));
  const measured = [...recorderEdges, ...edges.filter((e) => e.status === 'measured' && e.mapping).sort((a, b) => (a.maxValidationResidualMs || 0) - (b.maxValidationResidualMs || 0))];
  for (const old of previous) if (old.regions || old.locked || old.status === 'manual' || old.status === 'excluded') placements.set(old.assetId, structuredClone(old));
  if (!placements.has(reference)) seed(reference, reference, true);
  const expand = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of measured) {
        const a = placements.get(e.a), b = placements.get(e.b), m = e.mapping!;
        if(a?.regions||b?.regions)continue;
        if(e.basis !== 'recorder' && (a?.status === 'manual' && !a.locked || b?.status === 'manual' && !b.locked))continue;
        if (a?.status === 'excluded' || b?.status === 'excluded') continue;
        if (a && !b) {
          placements.set(e.b, { assetId: e.b, component: a.component, status: a.component === reference ? 'measured' : 'unresolved', locked: false,
            mapping: { version: 1, scale: a.mapping.scale * m.scale, offsetSeconds: a.mapping.scale * m.offsetSeconds + a.mapping.offsetSeconds },
            provenance: [...a.provenance, e.basis === 'recorder' ? `recorder-link:${e.reason}` : `${e.channelA}->${e.channelB}`], uncertaintyMs: (a.uncertaintyMs || 0) + (e.maxValidationResidualMs || 0) + 1000 / ANALYSIS_RATE }); changed = true;
        } else if (b && !a) {
          placements.set(e.a, { assetId: e.a, component: b.component, status: b.component === reference ? 'measured' : 'unresolved', locked: false,
            mapping: { version: 1, scale: b.mapping.scale / m.scale, offsetSeconds: b.mapping.offsetSeconds - b.mapping.scale * m.offsetSeconds / m.scale },
            provenance: [...b.provenance, e.basis === 'recorder' ? `recorder-link:${e.reason}` : `${e.channelB}->${e.channelA}`], uncertaintyMs: (b.uncertaintyMs || 0) + (e.maxValidationResidualMs || 0) + 1000 / ANALYSIS_RATE }); changed = true;
        }
      }
    }
  };
  expand();
  for (const id of assetIds) if (!placements.has(id)) { seed(id, id, false); expand(); }
  refineClockNetwork(placements, measured, clockGroups);
  // Redundant edges/cycles are independent checks, not silently discarded contradictions.
  for (const e of measured.filter(e => e.basis !== 'recorder')) {
    const a = placements.get(e.a)!, b = placements.get(e.b)!;
    if (a.component !== b.component || a.regions || b.regions || a.status === 'excluded' || b.status === 'excluded') continue;
    const worst = Math.max(...e.anchors.map((p) => Math.abs(projectTime(p.referenceSeconds, a.mapping) - projectTime(p.sourceSeconds, b.mapping)) * 1000));
    e.graphResidualMs = worst;
    if (worst > 5) for (const p of [a, b]) if (!p.locked && p.assetId !== reference && !clockGroups.some(g=>g.confirmed&&g.sourceStarts&&g.assetIds.includes(reference)&&g.assetIds.includes(p.assetId))) {
      if ((a.status==='manual'&&!a.locked || b.status==='manual'&&!b.locked) && p.status!=='manual')continue;
      if (p.status !== 'manual') p.status = 'unresolved';
      p.provenance.push(`graph-conflict:${worst.toFixed(3)}ms`);
    }
  }
  return assetIds.map((id) => placements.get(id)!);
}
type ChannelFeatures = { hashes: Hash[] };
type FeatureReader = (channel: SyncChannel) => Promise<ChannelFeatures>;
