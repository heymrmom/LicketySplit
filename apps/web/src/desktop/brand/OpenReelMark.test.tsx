import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { OpenReelMark } from "./OpenReelMark";

describe("OpenReelMark", () => {
  it("uses the supplied original LicketySplit mark at the requested size", () => {
    const { container } = render(<OpenReelMark size={48} />);
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("/icons/licketysplit-mark.png");
    expect(image?.getAttribute("alt")).toBe("LicketySplit");
    expect(image?.getAttribute("width")).toBe("48");
    expect(image?.getAttribute("height")).toBe("48");
  });
});
