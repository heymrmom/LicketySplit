interface TimelineHitTarget {
  id: string;
  startTime: number;
  duration: number;
}

const MIN_POINTER_TARGET_PIXELS = 12;

/** Find a nearby short clip for overview clicks without changing its timeline width. */
export function findNearestShortClipHitTarget<T extends TimelineHitTarget>(
  clips: readonly T[],
  contentX: number,
  pixelsPerSecond: number,
  tolerancePixels = MIN_POINTER_TARGET_PIXELS / 2,
): T | null {
  if (pixelsPerSecond <= 0 || tolerancePixels < 0) return null;

  let nearest: T | null = null;
  let nearestDistance = tolerancePixels;
  for (const clip of clips) {
    const clipWidth = clip.duration * pixelsPerSecond;
    if (clipWidth >= MIN_POINTER_TARGET_PIXELS) continue;
    const center = (clip.startTime + clip.duration / 2) * pixelsPerSecond;
    const distance = Math.abs(contentX - center);
    if (distance <= nearestDistance) {
      nearest = clip;
      nearestDistance = distance;
    }
  }
  return nearest;
}
