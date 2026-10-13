import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TimeRuler } from "./TimeRuler";

describe("TimeRuler full extent overview", () => {
  afterEach(cleanup);

  it("uses readable hour labels and keeps long-overview labels sparse", () => {
    const view = render(
      <div>
        <div>
          <TimeRuler
            duration={61 * 60 + 33}
            pixelsPerSecond={900 / (61 * 60 + 33)}
            scrollX={0}
            viewportWidth={900}
            onSeek={() => undefined}
          />
        </div>
      </div>,
    );

    expect(view.getByText("01:00:00")).toBeTruthy();
    expect(view.container.querySelectorAll("[data-ruler-time-label]").length).toBeLessThanOrEqual(14);
  });

  it("keeps detail labels unique at high zoom", () => {
    const view = render(
      <div>
        <div>
          <TimeRuler
            duration={10}
            pixelsPerSecond={250}
            scrollX={0}
            viewportWidth={500}
            onSeek={() => undefined}
          />
        </div>
      </div>,
    );
    const labels = [...view.container.querySelectorAll("[data-ruler-time-label]")]
      .map((element) => element.textContent);
    expect(labels.length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
