export interface VideoDecoderLease {
  readonly active: boolean;
  readonly pinned: number;
  pin(): void;
  unpin(): void;
  touch(): void;
  release(): void;
}

interface BudgetEntry {
  id: number;
  dispose: () => void;
  pins: number;
  lastUsed: number;
  active: boolean;
}

/** A single LRU budget shared by cached native and MediaBunny video decoders. */
export class VideoDecoderBudget {
  private readonly entries = new Map<number, BudgetEntry>();
  private nextId = 1;
  private clock = 0;

  constructor(readonly limit = 4) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("Video decoder budget must be a positive integer.");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  reserve(dispose: () => void): VideoDecoderLease | null {
    if (this.entries.size >= this.limit) {
      const evictable = [...this.entries.values()]
        .filter((entry) => entry.pins === 0)
        .sort((a, b) => a.lastUsed - b.lastUsed || a.id - b.id)[0];
      if (!evictable) return null;
      this.disposeEntry(evictable);
    }

    const entry: BudgetEntry = {
      id: this.nextId++,
      dispose,
      pins: 1,
      lastUsed: ++this.clock,
      active: true,
    };
    this.entries.set(entry.id, entry);

    return {
      get active() { return entry.active; },
      get pinned() { return entry.pins; },
      pin: () => {
        if (!entry.active) return;
        entry.pins += 1;
        entry.lastUsed = ++this.clock;
      },
      unpin: () => {
        if (!entry.active || entry.pins === 0) return;
        entry.pins -= 1;
        entry.lastUsed = ++this.clock;
      },
      touch: () => {
        if (entry.active) entry.lastUsed = ++this.clock;
      },
      release: () => this.disposeEntry(entry),
    };
  }

  private disposeEntry(entry: BudgetEntry): void {
    if (!entry.active) return;
    entry.active = false;
    entry.pins = 0;
    this.entries.delete(entry.id);
    try {
      entry.dispose();
    } catch {
      // A failed media-element teardown must not leave a capacity slot held.
    }
  }
}

export interface BudgetedVideoElement {
  video: HTMLVideoElement;
  url: string;
  lease: VideoDecoderLease;
}

export interface BudgetedVideoElementOptions {
  budget?: VideoDecoderBudget;
  isCurrent?: () => boolean;
  onDispose?: () => void;
  preload?: "none" | "metadata" | "auto";
  crossOrigin?: string;
  urlTimeoutMs?: number;
  videoFactory?: () => HTMLVideoElement;
}

/** Reserve before awaiting the media URI so stale requests cannot over-allocate. */
export async function createBudgetedVideoElement(
  getUrl: () => Promise<string>,
  options: BudgetedVideoElementOptions = {},
): Promise<BudgetedVideoElement | null> {
  const budget = options.budget ?? videoDecoderBudget;
  let video: HTMLVideoElement | null = null;
  let url: string | null = null;
  const lease = budget.reserve(() => {
    try {
      options.onDispose?.();
    } finally {
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.onloadedmetadata = null;
        video.onloadeddata = null;
        video.oncanplay = null;
        video.onerror = null;
        video.load();
      }
      if (url?.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // Revocation is best-effort; the lease is already released.
        }
      }
    }
  });
  if (!lease) return null;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    let sourceExpired = false;
    const urlPromise = getUrl().then((resolvedUrl) => {
      if (
        sourceExpired ||
        !lease.active ||
        (options.isCurrent !== undefined && !options.isCurrent())
      ) {
        if (resolvedUrl.startsWith("blob:")) URL.revokeObjectURL(resolvedUrl);
        return null;
      }
      url = resolvedUrl;
      return resolvedUrl;
    });
    const timeoutMs = options.urlTimeoutMs ?? 10000;
    const resolvedUrl = await Promise.race([
      urlPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          sourceExpired = true;
          reject(new Error("Video source URL timed out."));
        }, timeoutMs);
      }),
    ]);
    if (!resolvedUrl || !lease.active || (options.isCurrent && !options.isCurrent())) {
      lease.release();
      return null;
    }
    url = resolvedUrl;

    video = options.videoFactory?.() ?? document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = options.preload ?? "metadata";
    if (options.crossOrigin !== undefined) video.crossOrigin = options.crossOrigin;
    return { video, url, lease };
  } catch (error) {
    lease.release();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export const videoDecoderBudget = new VideoDecoderBudget(4);
