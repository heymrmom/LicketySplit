import { describe, expect, it } from "vitest";
import { findNearestShortClipHitTarget } from "./clip-hit-target";

const clips = [
  { id: "short-a", startTime: 20, duration: 1 },
  { id: "short-b", startTime: 21, duration: 1 },
  { id: "long", startTime: 40, duration: 60 },
];

describe("overview clip hit targets", () => {
  it("selects the nearest short clip inside the hit radius without changing its width", () => {
    const scale = 0.25;
    const target = findNearestShortClipHitTarget(clips, 21.3 * scale, scale);
    expect(target?.id).toBe("short-b");
    expect((target!.duration * scale)).toBe(0.25);
  });

  it("does not enlarge long clips or select distant content", () => {
    expect(findNearestShortClipHitTarget(clips, 55, 1)).toBeNull();
    expect(findNearestShortClipHitTarget(clips, 1000, 0.25)).toBeNull();
  });
});
