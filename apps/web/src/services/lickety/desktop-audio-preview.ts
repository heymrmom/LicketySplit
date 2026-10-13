import type { MediaItem } from "@licketysplit/core";
import { registerDesktopMedia, resolveDesktopOriginalPreview } from "./desktop-media";

const MONO_PCM_CODECS = new Set(["pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le"]);

export function isEligibleOriginalMonoWav(item: MediaItem, index: number, channel?: number): boolean {
  const metadata = item.metadata;
  return item.type === "audio"
    && metadata.container === "wav"
    && metadata.hasAudio === true
    && metadata.hasVideo === false
    && MONO_PCM_CODECS.has(metadata.codec.toLowerCase())
    && metadata.channels === 1
    && metadata.audioTrackCount === 1
    && index === 0
    && (channel === undefined || channel === 0);
}

export async function resolveDesktopAudioPreview(
  item: MediaItem,
  index: number,
  channel?: number,
  options: NativeMediaRequestOptions = { priority: "foreground" },
  isCurrent: () => boolean = () => true,
  isSelectedSoleAudioStream = true,
): Promise<string | undefined> {
  if (isSelectedSoleAudioStream && isEligibleOriginalMonoWav(item, index, channel)) {
    const uri = await resolveDesktopOriginalPreview(item);
    return isCurrent() ? uri : undefined;
  }
  const bridge = window.licketysplit?.lickety;
  if (!bridge?.ensureAudioStream) throw new Error("Desktop audio preview unavailable");
  const registered = await registerDesktopMedia(item);
  if (!isCurrent()) return undefined;
  const uri = await bridge.ensureAudioStream(registered.identity.assetId, index, channel, options);
  return isCurrent() ? uri : undefined;
}

export async function prepareTimelineNativeAudioPreview(
  item: MediaItem,
  index: number,
  channel: number | undefined,
  isStillActive: () => boolean,
  publish: (uri: string) => void,
): Promise<string | undefined> {
  const uri = await resolveDesktopAudioPreview(item, index, channel, undefined, isStillActive);
  if (!uri || !isStillActive()) return undefined;
  publish(uri);
  return uri;
}

/** Keep a slow camera/channel derivative from withholding a ready mono original. */
export async function prepareTimelineAudioInReadinessOrder<T extends { item: MediaItem; index: number; channel?: number }>(
  requests: T[],
  prepare: (request: T) => Promise<unknown>,
): Promise<void> {
  const originals = requests.filter(({ item, index, channel }) => isEligibleOriginalMonoWav(item, index, channel));
  const derivatives = requests.filter(({ item, index, channel }) => !isEligibleOriginalMonoWav(item, index, channel));
  for (const request of [...originals, ...derivatives]) await prepare(request);
}
