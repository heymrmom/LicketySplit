import "../../../test/install-local-storage-mock";
import { fireEvent, render, cleanup } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clip, Track } from "@licketysplit/core";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { TrackLane } from "./TrackLane";

vi.mock("./ClipComponent", () => ({ ClipComponent: () => null }));

function shortClip(trackId: string): Clip {
  return {
    id: "short-clip",
    mediaId: "media-short",
    trackId,
    startTime: 1000,
    duration: 1,
    inPoint: 0,
    outPoint: 1,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
  };
}

function mediaTrack(locked = false): Track {
  const id = "video-track";
  return {
    id,
    type: "video",
    name: "Video",
    clips: [shortClip(id)],
    transitions: [],
    locked,
    hidden: false,
    muted: false,
    solo: false,
  };
}

function renderLane(track: Track, onSelectClip: ReturnType<typeof vi.fn>) {
  const empty = createEmptyProject("Short clip hit target");
  useProjectStore.setState({
    project: { ...empty, timeline: { ...empty.timeline, tracks: [track] } },
    hasOpenProject: true,
  });
  const timelineRef = { current: null } as RefObject<HTMLDivElement | null>;
  const view = render(
    <TrackLane
      track={track}
      allTracks={[track]}
      pixelsPerSecond={0.25}
      selectedClipIds={[]}
      textClips={[]}
      shapeClips={[]}
      trackHeights={new Map()}
      timelineRef={timelineRef}
      onSelectClip={onSelectClip}
      onDropMedia={vi.fn()}
      onMoveClip={vi.fn()}
      onMoveTextClip={vi.fn()}
      onSnapIndicator={vi.fn()}
      onTrimTextClip={vi.fn()}
      onTrimShapeClip={vi.fn()}
      scrollX={200}
      trackHeight={80}
      onResizeTrack={vi.fn()}
      onSelectTransition={vi.fn()}
    />,
  );
  const lane = view.container.querySelector("[data-track-lane]") as HTMLDivElement;
  Object.defineProperty(lane, "getBoundingClientRect", {
    value: () => ({ left: -200, right: 3800, top: 0, bottom: 80, width: 4000, height: 80 }),
  });
  return { ...view, lane };
}

describe("TrackLane short clip overview selection", () => {
  afterEach(cleanup);

  it("selects a short clip using its content coordinate after horizontal scroll", () => {
    const onSelectClip = vi.fn();
    const { lane } = renderLane(mediaTrack(), onSelectClip);

    fireEvent.click(lane, { clientX: 50 });

    expect(onSelectClip).toHaveBeenCalledWith("short-clip", false);
  });

  it("does not select a locked short clip through the overview hit target", () => {
    const onSelectClip = vi.fn();
    const { lane } = renderLane(mediaTrack(true), onSelectClip);

    fireEvent.click(lane, { clientX: 50 });

    expect(onSelectClip).not.toHaveBeenCalled();
  });
});
