/** Small port of the legacy preview clock: one authoritative source plus wall time across gaps. */
export const PREVIEW_UI_INTERVAL_MS = 125;
export const PREVIEW_SOFT_DRIFT_SECONDS = 0.06;
export const PREVIEW_HARD_DRIFT_SECONDS = 0.75;
export const PREVIEW_HARD_DRIFT_HOLD_MS = 900;

export type PreviewCorrection =
  | { kind: "none"; playbackRate: number }
  | { kind: "rate"; playbackRate: number }
  | { kind: "seek"; playbackRate: number };

export type PreviewClock = { timelineSeconds: number; wallMs: number };

export function previewCorrection(expectedSeconds: number, actualSeconds: number, baseRate: number, driftHeldMs: number): PreviewCorrection {
  const drift = expectedSeconds - actualSeconds;
  const distance = Math.abs(drift);
  if (distance >= PREVIEW_HARD_DRIFT_SECONDS && driftHeldMs >= PREVIEW_HARD_DRIFT_HOLD_MS) return { kind: "seek", playbackRate: baseRate };
  if (distance >= PREVIEW_SOFT_DRIFT_SECONDS) {
    const adjustment = Math.max(-0.04, Math.min(0.04, drift * 0.12));
    return { kind: "rate", playbackRate: baseRate * (1 + adjustment) };
  }
  return { kind: "none", playbackRate: baseRate };
}

export function advancePreviewClock(clock: PreviewClock, nowMs: number, rate: number, audioSeconds?: number, videoSeconds?: number): PreviewClock {
  const sourceSeconds = Number.isFinite(audioSeconds) ? audioSeconds : Number.isFinite(videoSeconds) ? videoSeconds : undefined;
  return sourceSeconds === undefined
    ? { timelineSeconds: clock.timelineSeconds + Math.max(0, nowMs - clock.wallMs) / 1000 * rate, wallMs: nowMs }
    : { timelineSeconds: sourceSeconds, wallMs: nowMs };
}

export function episodeSecondsForSource(rawSourceSeconds: number, scale: number, offsetSeconds: number): number {
  return rawSourceSeconds * scale + offsetSeconds;
}

export function sourceSecondsForEpisode(episodeSeconds: number, scale: number, offsetSeconds: number): number {
  return (episodeSeconds - offsetSeconds) / scale;
}
