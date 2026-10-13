import type { ShortcutDefinition } from "./keyboard-shortcuts";

export type ShortcutCompatibility =
  | "Same"
  | "Different"
  | "Not compared"
  | "Unsupported in LicketySplit";

interface ShortcutComparisonDefinition {
  resolveDefault: string;
  resolveKey: string | null;
  behaviorEquivalent?: boolean;
  behaviorNotes: string;
}

export interface ShortcutComparisonRow {
  id: string;
  action: string;
  licketySplitBinding: string;
  resolveDefault: string;
  compatibility: ShortcutCompatibility;
  behaviorNotes: string;
  bindingSource?: "shortcut manager" | "native menu";
}

const NATIVE_MENU_ROWS: ShortcutComparisonRow[] = [
  {
    id: "desktop.file.newProject",
    action: "New Project",
    licketySplitBinding: "cmd+n",
    resolveDefault: "No verified default",
    compatibility: "Not compared",
    behaviorNotes: "Fixed native-menu accelerator, not customizable in the shortcut manager. Resolve documents Cmd+N for New Timeline, not New Project.",
    bindingSource: "native menu",
  },
  {
    id: "desktop.file.openProject",
    action: "Open Project",
    licketySplitBinding: "cmd+o",
    resolveDefault: "No verified default",
    compatibility: "Not compared",
    behaviorNotes: "Fixed native-menu accelerator, not customizable in the shortcut manager. No matching Resolve default was verified in the reviewed manual.",
    bindingSource: "native menu",
  },
];

export const RESOLVE_SHORTCUT_COMPARISON: Record<string, ShortcutComparisonDefinition> = {
  "playback.playPause": { resolveDefault: "Space", resolveKey: "space", behaviorNotes: "Resolve also supports reverse/stop/forward transport with J/K/L; LicketySplit does not." },
  "playback.frameBack": { resolveDefault: "Left", resolveKey: "arrowleft", behaviorNotes: "Frame duration follows the project frame rate." },
  "playback.frameForward": { resolveDefault: "Right", resolveKey: "arrowright", behaviorNotes: "Frame duration follows the project frame rate." },
  "playback.secondBack": { resolveDefault: "Shift+Left", resolveKey: "shift+arrowleft", behaviorNotes: "Both seek one second." },
  "playback.secondForward": { resolveDefault: "Shift+Right", resolveKey: "shift+arrowright", behaviorNotes: "Both seek one second." },
  "playback.jump5Back": { resolveDefault: "Up = previous edit", resolveKey: "arrowup", behaviorEquivalent: false, behaviorNotes: "LicketySplit’s default jumps back five seconds. The Resolve preset moves this action to Alt+Up." },
  "playback.jump5Forward": { resolveDefault: "Down = next edit", resolveKey: "arrowdown", behaviorEquivalent: false, behaviorNotes: "LicketySplit’s default jumps forward five seconds. The Resolve preset moves this action to Alt+Down." },
  "playback.goToStart": { resolveDefault: "Home", resolveKey: "home", behaviorNotes: "Resolve goes to the first frame of the active Source or Timeline Viewer." },
  "playback.goToEnd": { resolveDefault: "End", resolveKey: "end", behaviorNotes: "Resolve goes to the last frame of the active Source or Timeline Viewer." },
  "playback.prevClip": { resolveDefault: "Up = previous edit", resolveKey: "arrowup", behaviorEquivalent: false, behaviorNotes: "The Resolve preset maps Up here; LicketySplit seeks to the previous item edge without selecting the edit point." },
  "playback.nextClip": { resolveDefault: "Down = next edit", resolveKey: "arrowdown", behaviorEquivalent: false, behaviorNotes: "The Resolve preset maps Down here; LicketySplit seeks to the next item edge without selecting the edit point." },
  "playback.markLoopStart": { resolveDefault: "I = set In point", resolveKey: "i", behaviorEquivalent: false, behaviorNotes: "LicketySplit marks a preview-loop boundary; Resolve changes the edit/viewer In point." },
  "playback.markLoopEnd": { resolveDefault: "O = set Out point", resolveKey: "o", behaviorEquivalent: false, behaviorNotes: "LicketySplit marks a preview-loop boundary; Resolve changes the edit/viewer Out point." },
  "playback.toggleLoop": { resolveDefault: "Cmd+/", resolveKey: "cmd+/", behaviorNotes: "Both toggle looped playback; Resolve uses the Command+/ binding." },
  "editing.undo": { resolveDefault: "Cmd+Z", resolveKey: "cmd+z", behaviorNotes: "—" },
  "editing.redo": { resolveDefault: "Cmd+Shift+Z", resolveKey: "cmd+shift+z", behaviorNotes: "—" },
  "editing.cut": { resolveDefault: "Cmd+X", resolveKey: "cmd+x", behaviorNotes: "Both leave a gap. Resolve also has Cmd+Shift+X for ripple cut; LicketySplit has no ripple-cut action." },
  "editing.copy": { resolveDefault: "Cmd+C", resolveKey: "cmd+c", behaviorNotes: "Copies selected clips." },
  "editing.paste": { resolveDefault: "Cmd+V", resolveKey: "cmd+v", behaviorNotes: "Paste destination and selection behavior differ by editor." },
  "editing.duplicate": { resolveDefault: "Cmd+D = change clip duration", resolveKey: "cmd+d", behaviorEquivalent: false, behaviorNotes: "The Resolve preset retains LicketySplit’s Cmd+D duplicate action." },
  "editing.delete": { resolveDefault: "Delete", resolveKey: "delete", behaviorNotes: "Deletes clips and leaves a gap. macOS may report the physical Delete key as Backspace." },
  "editing.rippleDelete": { resolveDefault: "Forward Delete", resolveKey: "delete", behaviorNotes: "LicketySplit retains Shift+Delete; ripple deletion currently applies to selected media clips." },
  "editing.split": { resolveDefault: "Cmd+Backslash", resolveKey: "cmd+\\", behaviorNotes: "The Resolve preset maps Cmd+Backslash to Split at Playhead." },
  "editing.trimStart": { resolveDefault: "Shift+Left Bracket ([)", resolveKey: "shift+[", behaviorNotes: "The Resolve preset maps Shift+[ to Trim Start to Playhead." },
  "editing.trimEnd": { resolveDefault: "Shift+Right Bracket (])", resolveKey: "shift+]", behaviorNotes: "The Resolve preset maps Shift+] to Trim End to Playhead." },
  "selection.selectAll": { resolveDefault: "Cmd+A", resolveKey: "cmd+a", behaviorNotes: "Selects timeline items in the current editing context." },
  "selection.deselect": { resolveDefault: "Cmd+Shift+A", resolveKey: "cmd+shift+a", behaviorNotes: "The Resolve preset maps Cmd+Shift+A to clear selection." },
  "timeline.toggleSnap": { resolveDefault: "N", resolveKey: "n", behaviorNotes: "Toggles timeline snapping." },
  "timeline.zoomIn": { resolveDefault: "Cmd+=", resolveKey: "cmd+=", behaviorNotes: "Resolve centers zoom on the playhead; LicketySplit changes scale without matching Resolve’s exact anchor behavior." },
  "timeline.zoomOut": { resolveDefault: "Cmd+-", resolveKey: "cmd+-", behaviorNotes: "Resolve centers zoom on the playhead; LicketySplit changes scale without matching Resolve’s exact anchor behavior." },
  "timeline.fitTimeline": { resolveDefault: "Shift+Z", resolveKey: "shift+z", behaviorNotes: "The Resolve preset maps Shift+Z. LicketySplit remains fitted through viewport/content changes while overview is active." },
  "view.showShortcuts": { resolveDefault: "No verified default", resolveKey: null, behaviorNotes: "LicketySplit opens its keyboard-help overlay; the reviewed manual did not list a matching shortcut." },
  "file.save": { resolveDefault: "Cmd+S", resolveKey: "cmd+s", behaviorNotes: "Resolve also documents Save As; LicketySplit has no Save As shortcut action." },
  "file.export": { resolveDefault: "No verified default", resolveKey: null, behaviorNotes: "LicketySplit opens its export modal; the reviewed manual did not list a matching shortcut." },
  "tools.addText": { resolveDefault: "No verified default", resolveKey: null, behaviorNotes: "The reviewed manual did not list a matching shortcut." },
  "tools.addMarker": { resolveDefault: "M", resolveKey: "m", behaviorNotes: "Resolve also documents Cmd+M to add/edit a marker while playback continues." },
};

const RESOLVE_ONLY_ACTIONS: ShortcutComparisonRow[] = [
  {
    id: "resolve.bladeTool",
    action: "Blade Edit Mode",
    licketySplitBinding: "Not implemented",
    resolveDefault: "B",
    compatibility: "Unsupported in LicketySplit",
    behaviorNotes: "LicketySplit can split selected clips at the playhead, but has no pointer-based blade mode.",
  },
  {
    id: "resolve.jklTransport",
    action: "J/K/L transport",
    licketySplitBinding: "Not implemented",
    resolveDefault: "J / K / L",
    compatibility: "Unsupported in LicketySplit",
    behaviorNotes: "Resolve uses these for reverse / stop / forward transport. LicketySplit provides Space and frame/second stepping.",
  },
];

export function buildResolveShortcutComparisonRows(
  shortcuts: readonly ShortcutDefinition[],
): ShortcutComparisonRow[] {
  const rows = shortcuts.map((shortcut) => {
    const comparison = RESOLVE_SHORTCUT_COMPARISON[shortcut.id];
    const compatibility: ShortcutCompatibility = comparison?.resolveKey === null || !comparison
      ? "Not compared"
      : comparison.behaviorEquivalent === false
        ? "Different"
        : normalizeBinding(shortcut.currentKey) === normalizeBinding(comparison.resolveKey)
          ? "Same"
          : "Different";
    return {
      id: shortcut.id,
      action: shortcut.name,
      licketySplitBinding: shortcut.currentKey || "Unassigned",
      resolveDefault: comparison?.resolveDefault ?? "Not reviewed",
      compatibility,
      behaviorNotes: comparison?.behaviorNotes ?? "No verified Resolve comparison is recorded for this action.",
      bindingSource: "shortcut manager" as const,
    };
  });
  return [...rows, ...NATIVE_MENU_ROWS, ...RESOLVE_ONLY_ACTIONS];
}

function normalizeBinding(binding: string): string {
  const parts = binding.toLowerCase().split("+").map((part) => part.trim());
  const key = parts.pop() ?? "";
  const aliases: Record<string, string> = { ctrl: "cmd", control: "cmd", meta: "cmd", backspace: "delete" };
  const modifiers = [...new Set(parts.map((part) => aliases[part] ?? part))].sort();
  return [...modifiers, aliases[key] ?? key].join("+");
}

export function searchResolveShortcutComparison(
  rows: readonly ShortcutComparisonRow[],
  query: string,
): ShortcutComparisonRow[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...rows];
  return rows.filter((row) =>
    [
      row.action,
      row.licketySplitBinding,
      row.resolveDefault,
      row.compatibility,
      row.behaviorNotes,
    ].some((field) => field.toLowerCase().includes(normalized)),
  );
}
