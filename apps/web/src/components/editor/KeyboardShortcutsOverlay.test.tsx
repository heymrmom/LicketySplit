import "../../test/install-local-storage-mock";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keyboardShortcuts } from "../../services/keyboard-shortcuts";
import { KeyboardShortcutsOverlay } from "./KeyboardShortcutsOverlay";

type MockProps = {
  children?: ReactNode;
  isOpen?: boolean;
  label?: string;
  onClick?: () => void;
  onOpenChange?: (open: boolean) => void;
  onChange?: (value: string) => void;
  value?: string;
  title?: string;
  subtitle?: string;
  header?: ReactNode;
  content?: ReactNode;
  footer?: ReactNode;
  as?: "h3" | "span";
  ariaLabel?: string;
  options?: readonly { value: string; label?: string }[];
};

vi.mock("@/icons/lucide-compat", () => ({
  Keyboard: () => null,
  Search: () => null,
  RotateCcw: () => null,
  ChevronDown: () => null,
}));

vi.mock("@openreel/ui", async () => {
  const React = await import("react");
  const Button = ({ label, onClick }: MockProps) => React.createElement("button", { onClick }, label);
  return {
    ToolcraftSegmentedControl: ({ ariaLabel, options, value, onChange }: MockProps) =>
      React.createElement("div", { role: "radiogroup", "aria-label": ariaLabel },
        options?.map((option) => React.createElement("button", {
          key: option.value,
          type: "button",
          role: "radio",
          "aria-checked": value === option.value,
          onClick: () => onChange?.(option.value),
        }, option.label))),
    ToolcraftButton: Button,
    ToolcraftCard: ({ children }: MockProps) => React.createElement("div", null, children),
    ToolcraftClickableCard: Button,
    ToolcraftDialog: ({ isOpen, children }: MockProps) => isOpen
      ? React.createElement("div", { role: "dialog" }, children)
      : null,
    ToolcraftDialogHeader: ({ title, subtitle }: MockProps) => React.createElement("header", null,
      React.createElement("h1", null, title), React.createElement("p", null, subtitle)),
    ToolcraftEmptyState: ({ title }: MockProps) => React.createElement("p", null, title),
    ToolcraftIconButton: Button,
    ToolcraftKbd: ({ children }: MockProps) => React.createElement("kbd", null, children),
    ToolcraftLayout: ({ header, content, footer }: MockProps) => React.createElement(React.Fragment, null, header, content, footer),
    ToolcraftLayoutContent: ({ children }: MockProps) => React.createElement("main", null, children),
    ToolcraftLayoutFooter: ({ children }: MockProps) => React.createElement("footer", null, children),
    ToolcraftText: ({ as, children }: MockProps) => React.createElement(as ?? "span", null, children),
    ToolcraftTextInputControl: ({ label, value, onChange }: MockProps) => React.createElement("input", {
      "aria-label": label,
      value,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange?.(event.currentTarget.value),
    }),
  };
});

describe("KeyboardShortcutsOverlay Resolve comparison", () => {
  beforeEach(() => keyboardShortcuts.resetAllShortcuts());
  afterEach(() => {
    cleanup();
    keyboardShortcuts.resetAllShortcuts();
  });

  it("shows live custom bindings and searchable behavior/status rows", () => {
    render(<KeyboardShortcutsOverlay isOpen onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("radio", { name: "Resolve 21.1 comparison" }));

    const playRow = screen.getByTestId("shortcut-comparison-playback.playPause");
    expect(within(playRow).getByText("Same")).toBeTruthy();
    act(() => keyboardShortcuts.setShortcut("playback.playPause", "cmd+p"));
    expect(within(playRow).getByText("Different")).toBeTruthy();

    const fitRow = screen.getByTestId("shortcut-comparison-timeline.fitTimeline");
    act(() => keyboardShortcuts.setShortcut("timeline.fitTimeline", "alt+f"));
    expect(within(fitRow).getByText(/Alt\+F|⌥F/)).toBeTruthy();
    expect(within(fitRow).getByText("Different")).toBeTruthy();

    act(() => keyboardShortcuts.applyPreset("davinci"));
    expect(within(fitRow).getByText("Same")).toBeTruthy();
    act(() => keyboardShortcuts.setShortcut("timeline.fitTimeline", "alt+f"));

    act(() => keyboardShortcuts.setShortcut("timeline.fitTimeline", ""));
    expect(within(fitRow).getByText("Unassigned")).toBeTruthy();
    expect(within(fitRow).getByText("Different")).toBeTruthy();

    const newProjectRow = screen.getByTestId("shortcut-comparison-desktop.file.newProject");
    expect(within(newProjectRow).getByText(/native menu/)).toBeTruthy();
    expect(within(newProjectRow).getByText("Not compared")).toBeTruthy();

    const search = screen.getByRole("textbox", { name: "Search shortcut comparison" });
    fireEvent.change(search, { target: { value: "forward delete" } });
    expect(screen.getByTestId("shortcut-comparison-editing.rippleDelete")).toBeTruthy();
    expect(screen.queryByTestId("shortcut-comparison-timeline.fitTimeline")).toBeNull();
    expect(screen.queryByTestId("shortcut-comparison-resolve.bladeTool")).toBeNull();

    fireEvent.change(search, { target: { value: "blade edit mode" } });
    const bladeRow = screen.getByTestId("shortcut-comparison-resolve.bladeTool");
    expect(within(bladeRow).getByText("Not implemented")).toBeTruthy();
    expect(within(bladeRow).getByText("Unsupported in LicketySplit")).toBeTruthy();
  });
});
