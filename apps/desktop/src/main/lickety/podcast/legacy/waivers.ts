import type { SyncPlacement } from "./types";

export const PACKET_TIMING_WARNING = "VFR or packet timeline discontinuity: region mapping required before approval.";
export function isWaivableTimingBlocker(reason: string) { return reason === PACKET_TIMING_WARNING; }
export function unwaivedTimingBlockers(placement: SyncPlacement) {
  const waiver = placement.timingWaiver;
  return (placement.unsupported ?? []).filter((reason) => !isWaivableTimingBlocker(reason) || !waiver?.note.trim() || !waiver.reasons.includes(reason));
}
export function waivableTimingBlockers(placement: SyncPlacement) { return unwaivedTimingBlockers(placement).filter(isWaivableTimingBlocker); }
