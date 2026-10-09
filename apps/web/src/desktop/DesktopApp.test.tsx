import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type React from "react";
import { Button } from "@astryxdesign/core/Button";

import { DesktopApp } from "./DesktopApp";
import { useProjectStore } from "../stores/project-store";
import type { ProjectState } from "../stores/project-store";
import { useUIStore } from "../stores/ui-store";
import { useSettingsStore } from "../stores/settings-store";
import { useTimelineStore } from "../stores/timeline-store";

vi.mock("../stores/project-store", () => ({
  useProjectStore: vi.fn(),
}));

vi.mock("./editor/EditorBootstrapGate", () => ({
  EditorBootstrapGate: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("./shell/Workspace", () => ({
  Workspace: ({ suspendPreview }: { suspendPreview?: boolean }) => (
    <div data-testid="desktop-workspace" data-preview-suspended={String(Boolean(suspendPreview))} />
  ),
}));

vi.mock("./pages/EditPage", () => ({
  EditPage: () => null,
}));

vi.mock("./podcast/PodcastSetupDialog", () => ({
  PodcastSetupDialog: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => isOpen ? <div role="dialog" aria-label="Podcast preparation test dialog"><input aria-label="Podcast dialog text field" /><button type="button" onClick={onClose}>Close podcast setup</button></div> : null,
}));

vi.mock("./editor/DesktopExportButton", () => ({
  DesktopExportButton: () => <Button label="Video Export" />,
}));

vi.mock("../components/editor/settings/SettingsDialog", () => ({
  SettingsDialog: () => <div data-testid="desktop-settings-dialog" />,
}));

const mockedUseProjectStore = vi.mocked(useProjectStore);

function mockHasProject(value: boolean): void {
  mockedUseProjectStore.mockImplementation((selector) =>
    selector({ hasOpenProject: value } as unknown as ProjectState),
  );
}

beforeEach(() => {
  useTimelineStore.getState().pause();
  useTimelineStore.getState().setPlayheadPosition(0);
  const panels = useUIStore.getState().panels;
  useUIStore.setState({
    desktopPage: "edit",
    panels: {
      ...panels,
      agentChat: { ...panels.agentChat, visible: false },
    },
  });
  useSettingsStore.setState({ settingsOpen: false, settingsTab: "general" });
  (window as unknown as { openreel: unknown }).openreel = {
    platform: "desktop",
    win: { minimize: () => {}, toggleMaximize: () => {}, close: () => {}, isMaximized: async () => false },
  };
});
afterEach(() => {
  useTimelineStore.getState().pause();
  delete (mockedUseProjectStore as unknown as { getState?: unknown }).getState;
  delete (window as unknown as { openreel?: unknown }).openreel;
  vi.clearAllMocks();
});

describe("DesktopApp", () => {
  it("applies the desktop theme class to its root", () => {
    mockHasProject(false);
    const { container } = render(<DesktopApp />);
    expect(container.querySelector(".openreel-desktop")).not.toBeNull();
  });

  it("shows the start screen and hides the workspace when no project is open", () => {
    mockHasProject(false);
    const { getByText, queryByTestId } = render(<DesktopApp />);
    expect(getByText("New Project")).toBeTruthy();
    expect(queryByTestId("desktop-workspace")).toBeNull();
  });

  it("renders the title bar and workspace when a project is open", () => {
    mockHasProject(true);
    const { getByText, getByTestId } = render(<DesktopApp />);
    expect(getByText("OpenReel")).toBeTruthy();
    expect(getByTestId("desktop-workspace")).toBeTruthy();
  });

  it("keeps video editing actions available for stale motion state", () => {
    mockHasProject(true);
    const editView = render(<DesktopApp />);
    expect(editView.getByRole("button", { name: "Video Export" })).toBeTruthy();
    editView.unmount();

    useUIStore.setState({ desktopPage: "motion" });
    const motionView = render(<DesktopApp />);
    expect(motionView.getByRole("button", { name: "Video Export" })).toBeTruthy();
    expect(motionView.getByRole("button", { name: "AI Editor" })).toBeTruthy();
  });

  it("mounts shortcut help only for an open project and opens it from the title bar", () => {
    mockHasProject(false);
    const start = render(<DesktopApp />);
    expect(start.queryByRole("button", { name: "Keyboard shortcuts" })).toBeNull();
    start.unmount();

    mockHasProject(true);
    const editor = render(<DesktopApp />);
    fireEvent.click(editor.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(editor.getByText("Keyboard Shortcuts")).toBeTruthy();
  });

  it("opens podcast preparation from the existing-project launch event", () => {
    mockHasProject(true);
    const editor = render(<DesktopApp />);
    act(() => window.dispatchEvent(new CustomEvent("openreel:podcast:open")));
    expect(editor.getByRole("dialog", { name: "Podcast preparation test dialog" })).toBeTruthy();
  });

  it("pauses editor playback while podcast setup is open and does not resume on close", () => {
    mockHasProject(true);
    useTimelineStore.getState().setPlayheadPosition(42);
    useTimelineStore.getState().play();
    const editor = render(<DesktopApp />);
    expect(editor.getByTestId("desktop-workspace").getAttribute("data-preview-suspended")).toBe("false");

    act(() => window.dispatchEvent(new CustomEvent("openreel:podcast:open")));
    expect(useTimelineStore.getState().playbackState).toBe("paused");
    expect(useTimelineStore.getState().playheadPosition).toBe(42);
    expect(editor.getByTestId("desktop-workspace").getAttribute("data-preview-suspended")).toBe("true");

    fireEvent.click(editor.getByRole("button", { name: "Close podcast setup" }));
    expect(editor.getByTestId("desktop-workspace").getAttribute("data-preview-suspended")).toBe("false");
    expect(useTimelineStore.getState().playbackState).toBe("paused");
    expect(useTimelineStore.getState().playheadPosition).toBe(42);
  });

  it("blocks native editor and file commands behind a dialog but preserves focused text editing", async () => {
    const { projectManager } = await import("../services/project-manager");
    const openProject = vi.spyOn(projectManager, "openProject").mockResolvedValue(null);
    const undo = vi.fn(); const redo = vi.fn(); const loadProject = vi.fn();
    Object.assign(mockedUseProjectStore, { getState: () => ({ hasOpenProject: true, undo, redo, loadProject }) });
    let menuAction: ((id: string) => void) | undefined;
    Object.assign(window.openreel!, { onMenuAction: (callback: (id: string) => void) => { menuAction = callback; return () => { menuAction = undefined; }; } });
    const execCommand = vi.fn();
    const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const exportEvent = vi.fn();
    window.addEventListener("openreel:menu:export", exportEvent);
    mockHasProject(true);
    const view = render(<DesktopApp />);
    act(() => window.dispatchEvent(new CustomEvent("openreel:podcast:open")));
    const input = view.getByRole("textbox", { name: "Podcast dialog text field" });
    input.focus();
    menuAction?.("cut");
    expect(execCommand).toHaveBeenCalledWith("cut");

    input.blur();
    for (const action of ["undo", "redo", "cut", "open", "newProject", "export"]) menuAction?.(action);
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    expect(openProject).not.toHaveBeenCalled();
    expect(exportEvent).not.toHaveBeenCalled();
    expect(view.queryByRole("dialog", { name: "Start a new project" })).toBeNull();
    window.removeEventListener("openreel:menu:export", exportEvent);
    if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
    else delete (document as unknown as { execCommand?: unknown }).execCommand;
    openProject.mockRestore();
    view.unmount();
  });

  it("toggles the AI Editor side panel from the desktop title bar", () => {
    mockHasProject(true);
    const view = render(<DesktopApp />);
    const button = view.getByRole("button", { name: "AI Editor" });

    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);

    expect(useUIStore.getState().panels.agentChat.visible).toBe(true);
    expect(button).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(button);
    expect(useUIStore.getState().panels.agentChat.visible).toBe(false);
  });

  it("keeps settings reachable from the desktop title bar", () => {
    mockHasProject(false);
    const view = render(<DesktopApp />);

    fireEvent.click(view.getByRole("button", { name: "Settings" }));

    expect(useSettingsStore.getState().settingsOpen).toBe(true);
    expect(view.getByTestId("desktop-settings-dialog")).toBeTruthy();
  });
});
it('native Open menu loads an editable saved project',async()=>{const {projectManager}=await import('../services/project-manager');const fixture={id:'opened',name:'Opened',settings:{},timeline:{tracks:[],duration:0},mediaLibrary:{items:[]}};const open=vi.spyOn(projectManager,'openProject').mockResolvedValue(fixture as never);const loadProject=vi.fn();let action:((id:string)=>void)|undefined;Object.assign(window.openreel!,{onMenuAction:(callback:(id:string)=>void)=>{action=callback;return ()=>{};}});mockHasProject(false);Object.assign(mockedUseProjectStore,{getState:()=>({loadProject})});const view=render(<DesktopApp/>);action?.('open');await vi.waitFor(()=>expect(loadProject).toHaveBeenCalledWith(fixture));expect(open).toHaveBeenCalledOnce();view.unmount();open.mockRestore();});
