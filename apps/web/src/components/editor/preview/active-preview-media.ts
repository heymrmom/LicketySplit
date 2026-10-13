type PreviewClip = { mediaId: string; startTime: number; duration: number };
type PreviewTrack<TClip extends PreviewClip> = {
  hidden: boolean;
  clips: TClip[];
};

/** Match the first visual clip selected by Preview's renderer at the playhead. */
export function getActivePreviewMediaId<TClip extends PreviewClip, TMedia extends { type: string }>(
  tracks: PreviewTrack<TClip>[],
  playhead: number,
  getMediaItem: (mediaId: string) => TMedia | undefined,
  hasVisual: (clip: TClip) => boolean,
): string | null {
  for (const track of tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (
        playhead >= clip.startTime &&
        playhead < clip.startTime + clip.duration &&
        hasVisual(clip)
      ) {
        return getMediaItem(clip.mediaId)?.type === "video" ? clip.mediaId : null;
      }
    }
  }
  return null;
}
