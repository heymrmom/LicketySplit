import {
  createBudgetedVideoElement,
  getNativeMediaSource,
  videoDecoderBudget,
  type MediaItem,
  type VideoDecoderBudget,
} from "@licketysplit/core";

interface ThumbnailOptions {
  budget?: VideoDecoderBudget;
  videoFactory?: () => HTMLVideoElement;
  canvasFactory?: () => HTMLCanvasElement;
}

export async function generateThumbnailFromBlob(
  blob: Blob,
  type: "video" | "audio" | "image",
  options: ThumbnailOptions = {},
): Promise<string | null> {
  if (!(blob instanceof Blob)) {
    return null;
  }

  if (type === "audio") {
    return null;
  }

  if (type === "image") {
    return URL.createObjectURL(blob);
  }

  const managed = await createBudgetedVideoElement(
    async () => URL.createObjectURL(blob),
    {
      budget: options.budget ?? videoDecoderBudget,
      preload: "metadata",
      videoFactory: options.videoFactory,
    },
  );
  if (!managed) return null;

  const { video, lease } = managed;
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => finish(null), 5000);
    function finish(thumbnailUrl: string | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lease.release();
      resolve(thumbnailUrl);
    }

    video.onloadeddata = () => {
      try {
        video.currentTime = 0.1;
      } catch {
        finish(null);
      }
    };

    video.onseeked = () => {
      if (settled) return;
      try {
        const canvas = options.canvasFactory?.() ?? document.createElement("canvas");
        canvas.width = Math.min(video.videoWidth, 320);
        canvas.height = Math.min(
          video.videoHeight,
          (320 / video.videoWidth) * video.videoHeight,
        );

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          finish(null);
          return;
        }

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((thumbBlob) => {
          if (settled || !thumbBlob) {
            finish(null);
            return;
          }
          try {
            finish(URL.createObjectURL(thumbBlob));
          } catch {
            finish(null);
          }
        }, "image/jpeg", 0.7);
      } catch {
        finish(null);
      }
    };

    video.onerror = () => finish(null);
    try {
      video.src = managed.url;
      video.load();
    } catch {
      finish(null);
    }
  });
}

export function createMissingMediaItem(item: MediaItem): MediaItem {
  return {
    ...item,
    fileHandle: null,
    blob: null,
    thumbnailUrl: item.thumbnailUrl?.startsWith("blob:")
      ? null
      : item.thumbnailUrl,
    waveformData: null,
    filmstripThumbnails: undefined,
    isPlaceholder: true,
  };
}

export async function restoreMediaItem(
  item: MediaItem,
  storedBlob: Blob | undefined,
): Promise<MediaItem> {
  const blob =
    storedBlob instanceof Blob
      ? storedBlob
      : item.blob instanceof Blob
        ? item.blob
        : null;

  if (!blob) {
    return createMissingMediaItem(item);
  }

  if (await getNativeMediaSource(blob, "preview")) {
    return {
      ...item,
      fileHandle: null,
      blob,
      thumbnailUrl: item.thumbnailUrl?.startsWith("blob:")
        ? null
        : item.thumbnailUrl,
      waveformData: null,
      filmstripThumbnails: undefined,
      isPlaceholder: false,
    };
  }

  let thumbnailUrl = item.thumbnailUrl;

  if (!thumbnailUrl || thumbnailUrl.startsWith("blob:")) {
    try {
      thumbnailUrl = await generateThumbnailFromBlob(blob, item.type);
    } catch (error) {
      console.warn(
        `[MediaRecovery] Failed to regenerate thumbnail for ${item.name}:`,
        error,
      );
      thumbnailUrl = null;
    }
  }

  return {
    ...item,
    fileHandle: null,
    blob,
    thumbnailUrl,
    waveformData: null,
    filmstripThumbnails: undefined,
    isPlaceholder: false,
  };
}
