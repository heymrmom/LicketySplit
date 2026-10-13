import FFT from 'fft.js';

import { SYNC_PARAMETERS } from './parameters';
export const DSP_VERSION = SYNC_PARAMETERS.algorithmVersion;
export const FEATURE_VERSION = SYNC_PARAMETERS.featureVersion;
export const ANALYSIS_RATE = 8000;
export const HOP = 256;
export type Peak = [number, number];
export type Hash = [number, number];

// Adapted from Dan Ellis audfprint_analyze.py at cb03ba99feafd41b8874307f0f4e808a6ce34362 (MIT).
// Exact integer pairing/packing semantics; separate bounded peak extraction below.
export function peaksToHashes(peaks: Peak[]): Hash[] {
  if (!peaks.length) return [];
  const columns = new Map<number, number[]>();
  for (const [t, f] of peaks) columns.set(t, [...(columns.get(t) || []), f]);
  const end = peaks[peaks.length - 1][0] + 1;
  const hashes: Hash[] = [];
  for (const [col, peak] of peaks) {
    let pairs = 0;
    for (let col2 = col + 2; col2 < Math.min(end, col + 63) && pairs < 3; col2++) {
      for (const peak2 of columns.get(col2) || []) {
        if (Math.abs(peak2 - peak) < 31 && pairs < 3) {
          hashes.push([col, ((peak & 255) << 12) | (((peak2 - peak) & 63) << 6) | ((col2 - col) & 63)]);
          pairs++;
        }
      }
    }
  }
  return hashes;
}

/** Bounded adaptation of audfprint's log spectrum, onset high pass and two-pass
 * decaying Gaussian masking. Caller supplies overlap context between blocks.
 * No full-recording PCM array or full-recording FFT is required.
 */
export function fingerprintBlock(pcm: Float32Array): Hash[] {
  const size = 512, bins = 256, cols = Math.floor((pcm.length - size) / HOP) + 1;
  if (cols < 12) return [];
  const fft = new FFT(size), input = new Float64Array(size), spectrum = new Float64Array(size * 2);
  const gram = new Float32Array(cols * bins);
  let max = 0, sum = 0;
  for (let c = 0; c < cols; c++) {
    for (let j = 0; j < size; j++) input[j] = pcm[c * HOP + j] * (0.5 - 0.5 * Math.cos(2 * Math.PI * (j + 1) / (size + 1)));
    fft.realTransform(spectrum, input);
    for (let f = 0; f < bins; f++) { const v = Math.hypot(spectrum[f * 2], spectrum[f * 2 + 1]); gram[c * bins + f] = v; max = Math.max(max, v); }
  }
  if (max < 1e-6) return [];
  for (let i = 0; i < gram.length; i++) { gram[i] = Math.log(Math.max(gram[i], max / 1e6)); sum += gram[i]; }
  const mean = sum / gram.length;
  for (let f = 0; f < bins; f++) {
    let previous = 0, y = 0;
    for (let c = 0; c < cols; c++) { const i = c * bins + f, x = gram[i] - mean; y = x - previous + 0.98 * y; previous = x; gram[i] = y; }
  }
  const gaussian = Float64Array.from({ length: bins * 2 + 1 }, (_, i) => Math.exp(-0.5 * ((i - bins) / 30) ** 2));
  const spread = (threshold: Float64Array, f: number, value: number) => {
    for (let j = 0; j < bins; j++) threshold[j] = Math.max(threshold[j], value * gaussian[j - f + bins]);
  };
  const localMax = (v: ArrayLike<number>, start = 0) => {
    const result: number[] = [];
    for (let f = 0; f < bins; f++) if ((f === 0 || v[start + f] >= v[start + f - 1]) && (f === bins - 1 || v[start + f] > v[start + f + 1])) result.push(f);
    return result;
  };
  const threshold = new Float64Array(bins), initial = new Float64Array(bins);
  for (let f = 0; f < bins; f++) initial[f] = Math.max(...Array.from({ length: 10 }, (_, c) => gram[c * bins + f]));
  for (const f of localMax(initial)) spread(threshold, f, initial[f]);
  const marked = new Uint8Array(cols * bins), decay = 1 - 0.01 * (20 * Math.sqrt(HOP / 352.8) / 35);
  for (let c = 0; c < cols; c++) {
    const start = c * bins;
    const candidates = localMax(gram, start).filter((f) => gram[start + f] > threshold[f]).sort((a, b) => gram[start + b] - gram[start + a]);
    for (const f of candidates.slice(0, 5)) { marked[start + f] = 1; spread(threshold, f, gram[start + f]); }
    for (let f = 0; f < bins; f++) threshold[f] *= decay;
  }
  threshold.fill(0);
  for (const f of localMax(gram, (cols - 1) * bins)) spread(threshold, f, gram[(cols - 1) * bins + f]);
  for (let c = cols - 1; c >= 0; c--) {
    const fs = Array.from({ length: bins }, (_, f) => f).filter((f) => marked[c * bins + f]).sort((a, b) => gram[c * bins + b] - gram[c * bins + a]);
    for (const f of fs) {
      if (gram[c * bins + f] >= threshold[f]) { spread(threshold, f, gram[c * bins + f]); if (c + 1 < cols) marked[(c + 1) * bins + f] = 0; }
      else marked[c * bins + f] = 0;
    }
    for (let f = 0; f < bins; f++) threshold[f] *= decay;
  }
  const peaks: Peak[] = [];
  for (let c = 0; c < cols; c++) for (let f = 0; f < bins; f++) if (marked[c * bins + f]) peaks.push([c, f]);
  return peaksToHashes(peaks);
}

export function coarseCandidates(a: Hash[], b: Hash[], limit = 4) {
  const index = new Map<number, number[]>();
  for (const [t, h] of a) { const ts = index.get(h) || []; if (ts.length < 101) ts.push(t); index.set(h, ts); }
  const histogram = new Map<number, number>();
  for (const [t, h] of b) {
    const ts = index.get(h);
    if (!ts || ts.length > 100) continue; // Repetitive/common hashes are not evidence.
    for (const at of ts) { const bin = Math.round((at - t) / 4); histogram.set(bin, (histogram.get(bin) || 0) + 1); }
  }
  const ranked = [...histogram].map(([bin, count]) => ({ offsetSeconds: bin * 4 * HOP / ANALYSIS_RATE, votes: count + (histogram.get(bin - 1) || 0) + (histogram.get(bin + 1) || 0) })).sort((a, b) => b.votes - a.votes);
  const selected: typeof ranked = [];
  for (const candidate of ranked) if (candidate.votes >= 6 && selected.every((s) => Math.abs(s.offsetSeconds - candidate.offsetSeconds) > 0.6)) { selected.push(candidate); if (selected.length >= limit) break; }
  return selected;
}

/** Same votes/order as coarseCandidates, with cancellation and event-loop yields. */
export async function coarseCandidatesYielding(a: Hash[], b: Hash[], signal: AbortSignal, limit = 4) {
  const index = new Map<number, number[]>();
  let work = 0;
  for (const [t, h] of a) {
    signal.throwIfAborted();
    const ts = index.get(h) || []; if (ts.length < 101) ts.push(t); index.set(h, ts);
    if ((++work & 0x1fff) === 0) { signal.throwIfAborted(); await new Promise<void>((resolve) => setImmediate(resolve)); }
  }
  const histogram = new Map<number, number>();
  for (const [t, h] of b) {
    signal.throwIfAborted();
    const ts = index.get(h);
    if (ts && ts.length <= 100) for (const at of ts) {
      const bin = Math.round((at - t) / 4); histogram.set(bin, (histogram.get(bin) || 0) + 1);
      if ((++work & 0x1fff) === 0) { signal.throwIfAborted(); await new Promise<void>((resolve) => setImmediate(resolve)); }
    }
    if ((++work & 0x1fff) === 0) { signal.throwIfAborted(); await new Promise<void>((resolve) => setImmediate(resolve)); }
  }
  signal.throwIfAborted();
  const ranked = [...histogram].map(([bin, count]) => ({ offsetSeconds: bin * 4 * HOP / ANALYSIS_RATE, votes: count + (histogram.get(bin - 1) || 0) + (histogram.get(bin + 1) || 0) })).sort((x, y) => y.votes - x.votes);
  const selected: typeof ranked = [];
  for (const candidate of ranked) if (candidate.votes >= 6 && selected.every((item) => Math.abs(item.offsetSeconds - candidate.offsetSeconds) > 0.6)) { selected.push(candidate); if (selected.length >= limit) break; }
  signal.throwIfAborted();
  return selected;
}

/** Valid linear lags only: b must fully overlap a. NCC is overlap-normalized,
 * mean removed, signed polarity retained, with a separate competing peak. */
export function fineCorrelation(a: Float32Array, b: Float32Array, peakExclusionSeconds = 0.02) {
  if (b.length < 16 || a.length < b.length || a.length > ANALYSIS_RATE * 40) throw new Error('Fine correlation requires bounded valid-overlap windows.');
  const size = 2 ** Math.ceil(Math.log2(a.length + b.length - 1));
  const fft = new FFT(size), aa = new Float64Array(size), bb = new Float64Array(size);
  const sum = new Float64Array(a.length + 1), energy = new Float64Array(a.length + 1);
  let bs = 0, be = 0;
  for (let i = 0; i < a.length; i++) { aa[i] = a[i]; sum[i + 1] = sum[i] + a[i]; energy[i + 1] = energy[i] + a[i] * a[i]; }
  for (let i = 0; i < b.length; i++) { bb[i] = b[i]; bs += b[i]; be += b[i] * b[i]; }
  be -= bs * bs / b.length;
  if (be / b.length < 1e-10) return { lagSamples: 0, score: 0, competingScore: 0, polarity: 1, rms: Math.sqrt(Math.max(0, be / b.length)) };
  const fa = new Float64Array(size * 2), fb = new Float64Array(size * 2), inverse = new Float64Array(size * 2);
  fft.realTransform(fa, aa); fft.completeSpectrum(fa); fft.realTransform(fb, bb); fft.completeSpectrum(fb);
  for (let i = 0; i < fa.length; i += 2) { const r = fa[i] * fb[i] + fa[i + 1] * fb[i + 1]; fa[i + 1] = fa[i + 1] * fb[i] - fa[i] * fb[i + 1]; fa[i] = r; }
  fft.inverseTransform(inverse, fa);
  const scores = new Float64Array(a.length - b.length + 1);
  let best = 0, lagSamples = 0, polarity = 1;
  for (let lag = 0; lag < scores.length; lag++) {
    const as = sum[lag + b.length] - sum[lag];
    const ae = energy[lag + b.length] - energy[lag] - as * as / b.length;
    const signed = ae > 1e-10 ? (inverse[lag * 2] - as * bs / b.length) / Math.sqrt(ae * be) : 0;
    scores[lag] = Math.min(1, Math.abs(signed));
    if (scores[lag] > best) { best = scores[lag]; lagSamples = lag; polarity = Math.sign(signed); }
  }
  let competingScore = 0;
  for (let i = 0; i < scores.length; i++) if (Math.abs(i - lagSamples) > ANALYSIS_RATE * peakExclusionSeconds) competingScore = Math.max(competingScore, scores[i]);
  return { lagSamples, score: best, competingScore, polarity, rms: Math.sqrt(be / b.length) };
}

export const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2 : 0; };
export function fitClock(anchors: Array<{ sourceSeconds: number; referenceSeconds: number }>) {
  const slopes: number[] = [];
  for (let i = 0; i < anchors.length; i++) for (let j = i + 1; j < anchors.length; j++) {
    const dt = anchors[j].sourceSeconds - anchors[i].sourceSeconds;
    if (Math.abs(dt) >= 30) slopes.push((anchors[j].referenceSeconds - anchors[i].referenceSeconds) / dt);
  }
  // A noisy lag trend is not evidence for changing a recorder clock. Require
  // distributed pair slopes to agree on direction; otherwise retain unit scale.
  const ordered = [...slopes].sort((a,b) => a-b);
  const lower = ordered[Math.floor((ordered.length - 1) * .25)], upper = ordered[Math.ceil((ordered.length - 1) * .75)];
  const sameDirection = slopes.length >= 3 && (lower > 1 || upper < 1);
  const scale = sameDirection ? median(slopes) : 1;
  const offsetSeconds = median(anchors.map((p) => p.referenceSeconds - scale * p.sourceSeconds));
  return { version: 1 as const, scale, offsetSeconds };
}
