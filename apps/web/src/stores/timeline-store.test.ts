import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getZoomFromSliderPosition,
  getZoomSliderPosition,
  TIMELINE_WORKSPACE_STORAGE_KEY,
  useTimelineStore,
  ZOOM_PRESETS,
} from "./timeline-store";

describe("TimelineStore playback locking", () => {
  beforeEach(() => {
    localStorage.removeItem(TIMELINE_WORKSPACE_STORAGE_KEY);
    useTimelineStore.setState({
      playheadPosition: 0,
      playbackState: "stopped",
      playbackLockedReason: null,
      playbackRate: 1,
      pixelsPerSecond: ZOOM_PRESETS.DEFAULT,
      fitRestore: null,
      fitDuration: null,
      scrollX: 0,
      scrollY: 0,
      viewportWidth: 800,
      viewportHeight: 400,
      trackHeight: 80,
      trackHeights: {},
      loopEnabled: false,
      loopStart: 0,
      loopEnd: 0,
      isScrubbing: false,
      scrubPosition: null,
      expandedTracks: new Set<string>(),
      expandedClipKeyframes: new Set<string>(),
      keyframeEditMode: false,
    });
  });

  it("persists global and per-track density without serializing transient timeline state", () => {
    const store = useTimelineStore.getState();
    store.setTrackHeight(64);
    store.setTrackHeightById("dialogue", 112);

    const persisted = JSON.parse(
      localStorage.getItem(TIMELINE_WORKSPACE_STORAGE_KEY) ?? "{}",
    ) as { state?: Record<string, unknown> };
    expect(persisted.state).toEqual({
      trackHeight: 64,
      trackHeights: { dialogue: 112 },
    });
    expect(persisted.state).not.toHaveProperty("playheadPosition");
    expect(persisted.state).not.toHaveProperty("selectedClipIds");
  });

  it("does not serialize or write workspace preferences during playback and scrubbing", () => {
    const store = useTimelineStore.getState();
    store.setTrackHeightById("dialogue", 112);
    const writes = vi.spyOn(localStorage, "setItem");
    const serializations = vi.spyOn(JSON, "stringify");

    try {
      store.play();
      for (let frame = 1; frame <= 120; frame++) {
        store.setPlayheadPosition(frame / 60);
      }
      store.pause();
      store.startScrubbing(3);
      store.updateScrubPosition(4);
      store.endScrubbing();
      store.setScrollX(200);
      store.setViewportDimensions(1200, 400);

      expect(writes).not.toHaveBeenCalled();
      expect(serializations).not.toHaveBeenCalled();

      store.setTrackHeightById("dialogue", 120);
      expect(writes).toHaveBeenCalledTimes(1);
      expect(serializations).toHaveBeenCalledTimes(1);
      expect(JSON.parse(localStorage.getItem(TIMELINE_WORKSPACE_STORAGE_KEY) ?? "{}").state)
        .toEqual({ trackHeight: 80, trackHeights: { dialogue: 120 } });
    } finally {
      writes.mockRestore();
      serializations.mockRestore();
    }
  });

  it("writes density preferences again after persisted workspace data is cleared", () => {
    const store = useTimelineStore.getState();
    store.setTrackHeight(64);
    useTimelineStore.persist.clearStorage();
    expect(localStorage.getItem(TIMELINE_WORKSPACE_STORAGE_KEY)).toBeNull();

    store.setTrackHeight(64);
    expect(JSON.parse(localStorage.getItem(TIMELINE_WORKSPACE_STORAGE_KEY) ?? "{}").state)
      .toEqual({ trackHeight: 64, trackHeights: {} });
  });

  it("blocks play and toggle while locked", () => {
    const store = useTimelineStore.getState();

    store.lockPlayback("Applying auto color");
    store.play();
    store.togglePlayback();

    const state = useTimelineStore.getState();
    expect(state.playbackState).toBe("stopped");
    expect(state.playbackLockedReason).toBe("Applying auto color");
  });

  it("allows playback again after unlocking", () => {
    const store = useTimelineStore.getState();

    store.lockPlayback("Applying auto color");
    store.unlockPlayback();
    store.togglePlayback();

    const state = useTimelineStore.getState();
    expect(state.playbackLockedReason).toBeNull();
    expect(state.playbackState).toBe("playing");
  });
});

describe("timeline full extent zoom", () => {
  beforeEach(() => {
    useTimelineStore.setState({
      pixelsPerSecond: 40,
      fitRestore: null,
      fitDuration: null,
      scrollX: 600,
      viewportWidth: 900,
      viewportHeight: 500,
    });
  });

  it.each([
    [900, 650],
    [1260, 820],
  ])("fits a 61-minute timeline in the %i px scrollport", (width, height) => {
    const store = useTimelineStore.getState();
    store.setViewportDimensions(width, height);
    store.zoomToFit(61 * 60 + 33);

    const state = useTimelineStore.getState();
    expect(state.pixelsPerSecond).toBeCloseTo(width / (61 * 60 + 33), 8);
    expect(state.scrollX).toBe(0);
  });

  it("toggles from full extent back to the previous detail zoom and scroll", () => {
    const store = useTimelineStore.getState();
    store.zoomToFit(61 * 60 + 33);
    expect(useTimelineStore.getState().pixelsPerSecond).toBeLessThan(1);

    store.zoomToFit(61 * 60 + 33);
    const restored = useTimelineStore.getState();
    expect(restored.pixelsPerSecond).toBe(40);
    expect(restored.scrollX).toBe(600);
  });

  it("keeps overview fitted as the scrollport resizes and restores detail", () => {
    const duration = 61 * 60 + 33;
    const store = useTimelineStore.getState();
    store.zoomToFit(duration);
    store.setViewportDimensions(1260, 820);

    expect(useTimelineStore.getState().pixelsPerSecond).toBeCloseTo(1260 / duration, 8);
    store.zoomToFit(duration);

    const restored = useTimelineStore.getState();
    expect(restored.pixelsPerSecond).toBe(40);
    expect(restored.scrollX).toBe(600);
  });

  it("clamps restored detail scroll when the saved timeline no longer fits", () => {
    const store = useTimelineStore.getState();
    store.zoomToFit(20);
    store.zoomToFit(20);

    expect(useTimelineStore.getState().scrollX).toBe(0);
  });

  it("keeps the overview fitted when content duration changes and exits on manual zoom", () => {
    const store = useTimelineStore.getState();
    store.zoomToFit(3600);
    store.updateFitDuration(5400);
    expect(useTimelineStore.getState().pixelsPerSecond).toBeCloseTo(900 / 5400, 8);

    store.zoomIn();
    expect(useTimelineStore.getState().fitRestore).toBeNull();
    expect(useTimelineStore.getState().fitDuration).toBeNull();
  });

  it("clears a prior detail snapshot when the overview is reset", () => {
    const store = useTimelineStore.getState();
    store.zoomToFit(3600);
    store.resetZoom();

    const state = useTimelineStore.getState();
    expect(state.pixelsPerSecond).toBe(ZOOM_PRESETS.DEFAULT);
    expect(state.scrollX).toBe(0);
    expect(state.fitRestore).toBeNull();
    expect(state.fitDuration).toBeNull();
  });

  it("maps the logarithmic zoom slider across its full overview range", () => {
    expect(getZoomSliderPosition(ZOOM_PRESETS.MIN)).toBe(0);
    expect(getZoomSliderPosition(ZOOM_PRESETS.MAX)).toBeCloseTo(1000, 8);
    const midpoint = getZoomFromSliderPosition(500);
    expect(midpoint).toBeCloseTo(Math.sqrt(ZOOM_PRESETS.MIN * ZOOM_PRESETS.MAX), 8);
    expect(getZoomSliderPosition(midpoint)).toBeCloseTo(500, 8);
  });
});
