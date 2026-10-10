/** Elapsed time is independent of timecode labels and recorder clock estimates. */
export interface RationalRate { numerator: number; denominator: number }
export interface TimeMapping { version: 1; scale: number; offsetSeconds: number }

export function rational(numerator: number, denominator = 1): RationalRate {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0) throw new Error('Rate must be a positive integer ratio.');
  let a = numerator, b = denominator;
  while (b) { const next = a % b; a = b; b = next; }
  return { numerator: numerator / a, denominator: denominator / a };
}
export const rateValue = (rate: RationalRate) => rate.numerator / rate.denominator;
export function parseRate(value: string | number): RationalRate {
  const parts = String(value).split('/').map(Number);
  if (parts.length === 2) return rational(parts[0], parts[1]);
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid rate: ${value}`);
  // A decimal is exactly that decimal. Never infer NTSC from a fractional rate.
  // Recover the smallest exact-enough ratio for a computed numeric rate too
  // (e.g. 24000 / 1001). 23.976 stays 2997/125, not 24000/1001.
  let x = n, h0 = 0, h1 = 1, k0 = 1, k1 = 0;
  for (let i = 0; i < 32; i++) {
    const a = Math.floor(x), h = a * h1 + h0, k = a * k1 + k0;
    if (!Number.isSafeInteger(h) || k > 1e9) break;
    if (Math.abs(h / k - n) < 1e-10) return rational(h, k);
    [h0, h1, k0, k1] = [h1, h, k1, k];
    x = 1 / (x - a);
  }
  return rational(Math.round(n * 1_000_000), 1_000_000);
}
export function xmemlRate(timebase: number, ntsc: boolean): RationalRate {
  if (!Number.isSafeInteger(timebase)) throw new Error('XMEML timebase must be an integer.');
  return rational(timebase * (ntsc ? 1000 : 1), ntsc ? 1001 : 1);
}
export function xmemlRateFields(rate: RationalRate) {
  if (rate.denominator === 1) return { timebase: rate.numerator, ntsc: false };
  const nominal = rateValue(rate) * 1001 / 1000;
  if (Math.abs(nominal - Math.round(nominal)) < 1e-10) return { timebase: Math.round(nominal), ntsc: true };
  throw new Error(`XMEML cannot label native rate ${rate.numerator}/${rate.denominator} exactly. Choose a supported sequence rate; source metadata must not be relabeled.`);
}
export const framesToSeconds = (frames: number, rate: RationalRate) => frames * rate.denominator / rate.numerator;
export const secondsToFrames = (seconds: number, rate: RationalRate) => seconds * rate.numerator / rate.denominator;
export const frameAtSeconds = (seconds: number, rate: RationalRate, rounding: 'round' | 'floor' | 'ceil' = 'round') => Math[rounding](secondsToFrames(seconds, rate));
export function projectTime(sourceSeconds: number, mapping: TimeMapping) { validateMapping(mapping); return mapping.scale * sourceSeconds + mapping.offsetSeconds; }
export function sourceTime(projectSeconds: number, mapping: TimeMapping) { validateMapping(mapping); return (projectSeconds - mapping.offsetSeconds) / mapping.scale; }
export function validateMapping(mapping: TimeMapping) {
  if (mapping.version !== 1 || !Number.isFinite(mapping.scale) || mapping.scale <= 0 || !Number.isFinite(mapping.offsetSeconds)) throw new Error('Invalid source-to-project time mapping.');
}
export function timecodeToFrames(label: string, rate: RationalRate): number | undefined {
  const match = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/.exec(label);
  if (!match) return undefined;
  const [, h, m, s, separator, f] = match;
  const nominal = Math.round(rateValue(rate));
  if (+h > 23 || +m > 59 || +s > 59 || +f >= nominal) return undefined;
  let frames = ((+h * 3600 + +m * 60 + +s) * nominal) + +f;
  if (separator === ';') {
    const fields = xmemlRateFields(rate);
    if (!fields.ntsc || ![30, 60].includes(fields.timebase)) return undefined;
    const drop = nominal === 60 ? 4 : 2;
    if (+m % 10 !== 0 && +s === 0 && +f < drop) return undefined;
    const minutes = +h * 60 + +m;
    frames -= drop * (minutes - Math.floor(minutes / 10));
  }
  return frames;
}
