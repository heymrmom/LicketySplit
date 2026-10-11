import { describe, expect, it } from "vitest";
import { getKeyboardScrubTarget } from "./scrub-controls";

describe("getKeyboardScrubTarget", () => {
  it("steps the playhead and clamps at the timeline ends", () => {
    expect(getKeyboardScrubTarget("ArrowRight", 4, 20)).toBe(5);
    expect(getKeyboardScrubTarget("ArrowLeft", 0, 20)).toBe(0);
    expect(getKeyboardScrubTarget("ArrowRight", 20, 20)).toBe(20);
  });

  it("supports larger, page, home, and end jumps", () => {
    expect(getKeyboardScrubTarget("ArrowLeft", 12, 20, true)).toBe(7);
    expect(getKeyboardScrubTarget("PageUp", 10, 20)).toBe(12);
    expect(getKeyboardScrubTarget("PageDown", 2, 20)).toBe(0);
    expect(getKeyboardScrubTarget("Home", 12, 20)).toBe(0);
    expect(getKeyboardScrubTarget("End", 12, 20)).toBe(20);
    expect(getKeyboardScrubTarget("Tab", 12, 20)).toBeNull();
  });
});
