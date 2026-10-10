import React, { useState, useEffect, useCallback } from "react";
import { Keyboard, Search, RotateCcw, ChevronDown } from "@/icons/lucide-compat";
import { ToolcraftSegmentedControl } from "@licketysplit/ui";
import { ToolcraftButton as Button } from "@licketysplit/ui";
import { ToolcraftCard as Card } from "@licketysplit/ui";
import { ToolcraftClickableCard as ClickableCard } from "@licketysplit/ui";
import { ToolcraftDialog as Dialog, ToolcraftDialogHeader as DialogHeader } from "@licketysplit/ui";
import { ToolcraftEmptyState as EmptyState } from "@licketysplit/ui";
import { ToolcraftIconButton as IconButton } from "@licketysplit/ui";
import { ToolcraftKbd as Kbd } from "@licketysplit/ui";
import { ToolcraftLayout as Layout, ToolcraftLayoutContent as LayoutContent, ToolcraftLayoutFooter as LayoutFooter } from "@licketysplit/ui";
import { ToolcraftText as Text } from "@licketysplit/ui";
import { ToolcraftTextInputControl } from "@licketysplit/ui";
import {
  keyboardShortcuts,
  formatKeyComboDisplay,
  captureKeyCombo,
  type ShortcutCategory,
  type ShortcutDefinition,
} from "../../services/keyboard-shortcuts";
import {
  buildResolveShortcutComparisonRows,
  searchResolveShortcutComparison,
} from "../../services/resolve-shortcut-comparison";

interface KeyboardShortcutsOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

export const KeyboardShortcutsOverlay: React.FC<
  KeyboardShortcutsOverlayProps
> = ({ isOpen, onClose }) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<
    ShortcutCategory | "all"
  >("all");
  const [shortcuts, setShortcuts] = useState<ShortcutDefinition[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [activeView, setActiveView] = useState<"shortcuts" | "comparison">("shortcuts");
  const [activePreset, setActivePreset] = useState(
    keyboardShortcuts.getActivePreset(),
  );

  useEffect(() => {
    if (isOpen) {
      setShortcuts(keyboardShortcuts.getAllShortcuts());
      setActivePreset(keyboardShortcuts.getActivePreset());
      setShortcutError(null);
    } else {
      setEditingId(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const refresh = () => {
      setShortcuts(keyboardShortcuts.getAllShortcuts());
      setActivePreset(keyboardShortcuts.getActivePreset());
    };
    return keyboardShortcuts.subscribe(refresh);
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        if (editingId) {
          setEditingId(null);
        } else {
          onClose();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, editingId]);

  const filteredShortcuts = shortcuts.filter((shortcut) => {
    const matchesCategory =
      activeCategory === "all" || shortcut.category === activeCategory;
    const matchesSearch =
      searchQuery === "" ||
      shortcut.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      shortcut.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      shortcut.currentKey.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const groupedShortcuts = filteredShortcuts.reduce(
    (acc, shortcut) => {
      if (!acc[shortcut.category]) {
        acc[shortcut.category] = [];
      }
      acc[shortcut.category].push(shortcut);
      return acc;
    },
    {} as Record<ShortcutCategory, ShortcutDefinition[]>,
  );

  const handleShortcutCapture = useCallback(
    (e: React.KeyboardEvent, shortcutId: string) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setEditingId(null);
        return;
      }

      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
        return;
      }

      const newKey = captureKeyCombo(e);
      const conflict = keyboardShortcuts.findConflict(newKey, shortcutId);

      if (conflict) {
        setShortcutError(`This shortcut is used by ${conflict.name}. Choose a different key.`);
        return;
      }

      keyboardShortcuts.setShortcut(shortcutId, newKey);
      setShortcuts(keyboardShortcuts.getAllShortcuts());
      setEditingId(null);
      setShortcutError(null);
    },
    [],
  );

  const handleResetShortcut = (id: string) => {
    const shortcut = keyboardShortcuts.getShortcut(id);
    const conflict = shortcut && keyboardShortcuts.findConflict(shortcut.defaultKey, id);
    if (conflict) {
      setShortcutError(`The default key is used by ${conflict.name}. Change that shortcut first or reset all shortcuts.`);
      return;
    }
    keyboardShortcuts.resetShortcut(id);
    setShortcuts(keyboardShortcuts.getAllShortcuts());
    setShortcutError(null);
  };

  const handleResetAll = () => {
    keyboardShortcuts.resetAllShortcuts();
    setShortcuts(keyboardShortcuts.getAllShortcuts());
    setActivePreset(keyboardShortcuts.getActivePreset());
    setShortcutError(null);
  };

  const handleApplyPreset = (presetId: string) => {
    keyboardShortcuts.applyPreset(presetId);
    setShortcuts(keyboardShortcuts.getAllShortcuts());
    setActivePreset(presetId);
    setShowPresets(false);
    setShortcutError(null);
  };

  const categories = keyboardShortcuts.getCategories();
  const categoryOptions: Array<{ label: string; value: ShortcutCategory | "all" }> = [
    { value: "all", label: "All" },
    ...categories.map((category) => ({
      value: category,
      label: keyboardShortcuts.getCategoryName(category),
    })),
  ];
  const presets = keyboardShortcuts.getPresets();
  const viewOptions = [
    { value: "shortcuts", label: "Shortcuts" },
    { value: "comparison", label: "Resolve 21.1 comparison" },
  ] as const;
  const comparisonRows = searchResolveShortcutComparison(
    buildResolveShortcutComparisonRows(shortcuts),
    searchQuery,
  );

  if (!isOpen) return null;

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      width={768}
      purpose="form"
    >
      <Layout
        header={
          <DialogHeader
            title="Keyboard Shortcuts"
            subtitle="Find shortcuts, choose a preset, or customize your keys."
            onOpenChange={(open) => !open && onClose()}
            startContent={<Keyboard size={20} className="text-primary" aria-hidden />}
          />
        }
        content={
          <LayoutContent className="max-h-[65vh] overflow-y-auto">
        <div className="space-y-4">
        {shortcutError && <p role="status" className="text-sm text-red-400">{shortcutError}</p>}
        <div className="overflow-x-auto">
          <ToolcraftSegmentedControl<"shortcuts" | "comparison">
            ariaLabel="Shortcut view"
            className="min-w-[360px]"
            value={activeView}
            onChange={setActiveView}
            options={viewOptions}
          />
        </div>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <ToolcraftTextInputControl
              label={activeView === "comparison" ? "Search shortcut comparison" : "Search shortcuts"}
              isLabelHidden
              type="text"
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={activeView === "comparison" ? "Search actions, keys, or behavior..." : "Search shortcuts..."}
              startIcon={<Search size={16} aria-hidden />}
              width="100%"
            />
          </div>

          <div className="relative">
            <Button
              label={presets.find((p) => p.id === activePreset)?.name || "Preset"}
              onClick={() => setShowPresets(!showPresets)}
              variant="secondary"
              icon={<ChevronDown size={14} aria-hidden />}
            />
            {showPresets && (
              <Card
                variant="default"
                padding={1}
                className="absolute top-full right-0 z-10 mt-1 w-56 border border-border shadow-lg"
              >
                {presets.map((preset) => (
                  <ClickableCard
                    key={preset.id}
                    label={`Apply ${preset.name} preset`}
                    onClick={() => handleApplyPreset(preset.id)}
                    padding={2}
                    variant={activePreset === preset.id ? "green" : "transparent"}
                  >
                    <Text type="label" weight="bold" color={activePreset === preset.id ? "active" : "primary"} display="block">
                      {preset.name}
                    </Text>
                    <Text type="supporting" color="secondary" display="block" className="text-[10px]">
                      {preset.description}
                    </Text>
                  </ClickableCard>
                ))}
              </Card>
            )}
          </div>

          <Button
            label="Reset All"
            onClick={handleResetAll}
            variant="ghost"
            icon={<RotateCcw size={14} aria-hidden />}
          />
        </div>

        {activeView === "shortcuts" && <div className="overflow-x-auto">
          <ToolcraftSegmentedControl<ShortcutCategory | "all">
            ariaLabel="Shortcut category"
            className="min-w-[640px]"
            value={activeCategory}
            onChange={setActiveCategory}
            options={categoryOptions}
          />
        </div>}

        {activeView === "shortcuts" ? <div className="space-y-6">
          {Object.entries(groupedShortcuts).map(
            ([category, categoryShortcuts]) => (
              <div key={category}>
                <Text
                  as="h3"
                  type="supporting"
                  weight="bold"
                  color="secondary"
                  display="block"
                  className="mb-3 text-xs uppercase"
                >
                  {keyboardShortcuts.getCategoryName(
                    category as ShortcutCategory,
                  )}
                </Text>
                <div className="space-y-1">
                  {categoryShortcuts.map((shortcut) => (
                    <Card
                      key={shortcut.id}
                      variant="transparent"
                      padding={2}
                      className="group flex items-center justify-between hover:bg-background-tertiary"
                    >
                      <div className="flex-1">
                        <Text type="body" display="block">
                          {shortcut.name}
                        </Text>
                        <Text type="supporting" color="secondary" display="block" className="text-[10px]">
                          {shortcut.description}
                        </Text>
                      </div>
                      <div className="flex items-center gap-2">
                        {editingId === shortcut.id ? (
                          <ToolcraftTextInputControl
                            label={`Set shortcut for ${shortcut.name}`}
                            isLabelHidden
                            value=""
                            onKeyDown={(e) =>
                              handleShortcutCapture(e, shortcut.id)
                            }
                            placeholder="Press keys..."
                            hasAutoFocus
                            width={128}
                            size="sm"
                          />
                        ) : (
                          <Button
                            label={shortcut.currentKey ? formatKeyComboDisplay(shortcut.currentKey) : "Unassigned"}
                            onClick={() => { setEditingId(shortcut.id); setShortcutError(null); }}
                            variant="secondary"
                            size="sm"
                            className="min-w-[80px] font-mono"
                          />
                        )}
                        {shortcut.currentKey !== shortcut.defaultKey && (
                          <IconButton
                            label="Reset to default"
                            onClick={() => handleResetShortcut(shortcut.id)}
                            variant="ghost"
                            size="sm"
                            icon={<RotateCcw size={12} aria-hidden />}
                            className="opacity-0 transition-opacity group-hover:opacity-100"
                          />
                        )}
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            ),
          )}

          {filteredShortcuts.length === 0 && (
            <EmptyState
              title="No shortcuts found"
              icon={<Keyboard size={32} className="text-text-muted opacity-30" aria-hidden />}
              isCompact
            />
          )}
        </div> : <div className="space-y-3">
          <Text type="supporting" color="secondary" display="block" className="text-xs">
            LicketySplit bindings reflect the current app keymap. Resolve bindings are 21.1 macOS defaults; a customized Resolve keymap may differ.
          </Text>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="min-w-[980px] w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-background-secondary text-fg-muted">
                <tr>
                  <th scope="col" className="px-3 py-2">Action</th>
                  <th scope="col" className="px-3 py-2">LicketySplit binding</th>
                  <th scope="col" className="px-3 py-2">Resolve default</th>
                  <th scope="col" className="px-3 py-2">Compatibility</th>
                  <th scope="col" className="px-3 py-2">Behavior notes</th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row) => (
                  <tr key={row.id} data-testid={`shortcut-comparison-${row.id}`} className="border-t border-border align-top">
                    <th scope="row" className="px-3 py-2 font-medium text-fg-1">{row.action}</th>
                    <td className="px-3 py-2 font-mono text-fg-1">
                      {row.licketySplitBinding === "Not implemented"
                        ? "Not implemented"
                        : row.licketySplitBinding === "Unassigned"
                          ? "Unassigned"
                          : formatKeyComboDisplay(row.licketySplitBinding)}
                      {row.bindingSource === "native menu" && <span className="ml-1 text-fg-muted">(native menu)</span>}
                    </td>
                    <td className="px-3 py-2 font-mono text-fg-1">{row.resolveDefault}</td>
                    <td className="px-3 py-2 text-fg-2">{row.compatibility}</td>
                    <td className="px-3 py-2 text-fg-muted">{row.behaviorNotes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {comparisonRows.length === 0 && (
              <EmptyState title="No matching comparison rows" icon={<Search size={32} aria-hidden />} isCompact />
            )}
          </div>
        </div>}
        </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
          <Text type="supporting" color="secondary" display="block" justify="center" className="text-[10px]">
            Click a shortcut key to customize • Press{" "}
            <Kbd keys="Esc" />{" "}
            to close
          </Text>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
};

export default KeyboardShortcutsOverlay;
