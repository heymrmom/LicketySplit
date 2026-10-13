import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PreviewPreparationStatus } from "./PreviewPreparationStatus";

describe("PreviewPreparationStatus", () => {
  it("announces preview preparation while the media source is loading", () => {
    render(<PreviewPreparationStatus entry={{ status: "encoding" }} onRetry={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("Preparing preview");
  });

  it("exposes an actionable retry when original preparation fails", () => {
    const onRetry = vi.fn();
    render(
      <PreviewPreparationStatus
        entry={{ status: "error", error: "Temporary media service failure" }}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Temporary media service failure");
    fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
