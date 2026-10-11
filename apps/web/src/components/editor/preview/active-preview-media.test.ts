import { describe, expect, it } from "vitest";
import { getActivePreviewMediaId } from "./active-preview-media";

describe("active preview media", () => {
  it("uses the first visible visual clip when video clips overlap", () => {
    const tracks = [
      { hidden: false, clips: [{ mediaId: "under", startTime: 0, duration: 8 }] },
      { hidden: false, clips: [{ mediaId: "over", startTime: 1, duration: 4 }] },
    ];
    const media = new Map([["under", { type: "video" }], ["over", { type: "video" }]]);

    expect(getActivePreviewMediaId(tracks, 2, (id) => media.get(id), () => true)).toBe("under");
  });

  it("does not report a covered video when the renderer's first visual clip is not video", () => {
    const tracks = [
      { hidden: false, clips: [{ mediaId: "still", startTime: 0, duration: 8 }] },
      { hidden: false, clips: [{ mediaId: "under", startTime: 0, duration: 8 }] },
    ];
    const media = new Map([["still", { type: "image" }], ["under", { type: "video" }]]);

    expect(getActivePreviewMediaId(tracks, 2, (id) => media.get(id), () => true)).toBeNull();
  });
});
