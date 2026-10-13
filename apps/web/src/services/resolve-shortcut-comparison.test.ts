import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keyboardShortcuts } from "./keyboard-shortcuts";
import {
  buildResolveShortcutComparisonRows,
  RESOLVE_SHORTCUT_COMPARISON,
  searchResolveShortcutComparison,
} from "./resolve-shortcut-comparison";

describe("Resolve shortcut comparison", () => {
  beforeEach(() => keyboardShortcuts.resetAllShortcuts());
  afterEach(() => keyboardShortcuts.resetAllShortcuts());

  it("covers every registered LicketySplit action and labels unimplemented Resolve actions", () => {
    const shortcuts = keyboardShortcuts.getAllShortcuts();
    const rows = buildResolveShortcutComparisonRows(shortcuts);
    const registeredIds = shortcuts.map((shortcut) => shortcut.id).sort();

    expect(Object.keys(RESOLVE_SHORTCUT_COMPARISON).sort()).toEqual(registeredIds);
    expect(rows).toHaveLength(shortcuts.length + 4);
    expect(rows.find((row) => row.id === "desktop.file.newProject")).toMatchObject({
      licketySplitBinding: "cmd+n",
      resolveDefault: "No verified default",
      compatibility: "Not compared",
      bindingSource: "native menu",
    });
    expect(rows.find((row) => row.id === "desktop.file.openProject")).toMatchObject({
      licketySplitBinding: "cmd+o",
      compatibility: "Not compared",
      bindingSource: "native menu",
    });
    expect(rows.find((row) => row.id === "resolve.bladeTool")).toMatchObject({
      licketySplitBinding: "Not implemented",
      resolveDefault: "B",
      compatibility: "Unsupported in LicketySplit",
    });
    expect(rows.find((row) => row.id === "resolve.jklTransport")?.licketySplitBinding)
      .toBe("Not implemented");
  });

  it("uses current customized and unassigned bindings at render time", () => {
    expect(keyboardShortcuts.setShortcut("timeline.fitTimeline", "alt+f")).toBe(true);
    const customRows = buildResolveShortcutComparisonRows(keyboardShortcuts.getAllShortcuts());
    expect(customRows.find((row) => row.id === "timeline.fitTimeline")?.licketySplitBinding)
      .toBe("alt+f");

    expect(keyboardShortcuts.setShortcut("timeline.fitTimeline", "")).toBe(true);
    const unassignedRows = buildResolveShortcutComparisonRows(keyboardShortcuts.getAllShortcuts());
    expect(unassignedRows.find((row) => row.id === "timeline.fitTimeline")?.licketySplitBinding)
      .toBe("Unassigned");
    expect(unassignedRows.find((row) => row.id === "timeline.fitTimeline")?.compatibility)
      .toBe("Different");
  });

  it("derives compatibility from the current binding and Resolve preset", () => {
    const rows = () => buildResolveShortcutComparisonRows(keyboardShortcuts.getAllShortcuts());
    expect(rows().find((row) => row.id === "playback.playPause")?.compatibility).toBe("Same");

    expect(keyboardShortcuts.setShortcut("playback.playPause", "cmd+p")).toBe(true);
    expect(rows().find((row) => row.id === "playback.playPause")?.compatibility).toBe("Different");
    expect(keyboardShortcuts.setShortcut("playback.playPause", "space")).toBe(true);
    expect(rows().find((row) => row.id === "playback.playPause")?.compatibility).toBe("Same");

    keyboardShortcuts.applyPreset("davinci");
    expect(rows().find((row) => row.id === "editing.split")?.compatibility).toBe("Same");
    expect(rows().find((row) => row.id === "timeline.fitTimeline")?.compatibility).toBe("Same");
    expect(rows().find((row) => row.id === "editing.trimStart")?.compatibility).toBe("Same");
  });

  it("searches actions, both keymaps, status, and behavior notes", () => {
    const rows = buildResolveShortcutComparisonRows(keyboardShortcuts.getAllShortcuts());

    expect(searchResolveShortcutComparison(rows, "forward delete").map((row) => row.id))
      .toEqual(["editing.rippleDelete"]);
    expect(searchResolveShortcutComparison(rows, "transport").map((row) => row.id))
      .toEqual(["playback.playPause", "resolve.jklTransport"]);
    expect(searchResolveShortcutComparison(rows, "blade edit mode").map((row) => row.id))
      .toEqual(["resolve.bladeTool"]);
  });
});
