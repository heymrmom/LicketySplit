import "../../test/install-local-storage-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useUIStore } from "../../stores/ui-store";

vi.mock("../../components/editor/AssetsPanel", () => ({
  AssetsPanel: () => <div>Media panel</div>,
}));
vi.mock("../../components/editor/InspectorPanel", () => ({
  InspectorPanel: () => <div>Inspector panel</div>,
}));
vi.mock("../../components/editor/Preview", () => ({
  Preview: () => <div>Preview panel</div>,
}));
vi.mock("../../components/editor/Timeline", () => ({
  Timeline: () => <div>Timeline panel</div>,
}));
vi.mock("../../components/editor/chat/ChatPanel", () => ({
  ChatPanel: ({ onClose }: { onClose?: () => void }) => (
    <div data-testid="desktop-ai-editor">
      <button type="button" onClick={onClose}>Close AI Editor</button>
    </div>
  ),
}));

import { EditPage, getResponsiveTimelineHeight } from "./EditPage";

const originalResizeObserver = globalThis.ResizeObserver;

describe("EditPage AI Editor dock", () => {
  beforeEach(() => {
    const panels = useUIStore.getState().panels;
    useUIStore.setState({
      panels: {
        ...panels,
        agentChat: { ...panels.agentChat, visible: true },
      },
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.ResizeObserver = originalResizeObserver;
    window.localStorage.clear();
  });

  it("renders the chat as a resizable right-side panel and closes it", async () => {
    render(<EditPage />);

    expect(await screen.findByTestId("desktop-ai-editor")).toBeTruthy();
    expect(screen.getByTestId("desktop-edit-page").style.gridTemplateAreas).toContain(
      "chat",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close AI Editor" }));

    await waitFor(() => {
      expect(screen.queryByTestId("desktop-ai-editor")).toBeNull();
    });
    expect(useUIStore.getState().panels.agentChat.visible).toBe(false);
    expect(screen.getByTestId("desktop-edit-page").style.gridTemplateAreas).not.toContain(
      "chat",
    );
  });

  it.each([
    [1080, 680, 439, "220px minmax(0, 1fr) 260px 320px"],
    [1440, 900, 640, "320px minmax(0, 1fr) 340px 380px"],
  ])("fits the saved layout into a %i px editor viewport", async (width, height, expectedTimelineHeight, expectedColumns) => {
    window.localStorage.setItem("openreel-desktop-timeline-h", "640");
    const TestResizeObserver = class {
      private callback: ConstructorParameters<typeof ResizeObserver>[0];
      constructor(callback: ConstructorParameters<typeof ResizeObserver>[0]) { this.callback = callback; }
      observe(target: Element) {
        const contentRect = { width, height } as DOMRectReadOnly;
        this.callback([{ target, contentRect } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    };
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

    render(<EditPage />);
    const page = screen.getByTestId("desktop-edit-page");
    await waitFor(() => {
      expect(page.style.gridTemplateRows).toBe(`minmax(0, 1fr) ${expectedTimelineHeight}px`);
    });

    expect(page.style.gridTemplateColumns).toBe(expectedColumns);
    expect(window.localStorage.getItem("openreel-desktop-timeline-h")).toBe("640");
  });

  it("clamps only the live timeline row and preserves the saved preference", () => {
    expect(getResponsiveTimelineHeight(640, 680)).toBe(439);
    expect(getResponsiveTimelineHeight(640, 900)).toBe(640);
    expect(getResponsiveTimelineHeight(200, 680)).toBe(200);
  });
});
