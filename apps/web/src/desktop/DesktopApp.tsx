import { projectManager } from "../services/project-manager";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { DesktopTitleBar } from "./shell/DesktopTitleBar";
import { Workspace } from "./shell/Workspace";
import { DesktopStartScreen } from "./start/DesktopStartScreen";
import { DesktopExportButton } from "./editor/DesktopExportButton";
import { PodcastSetupDialog } from "./podcast/PodcastSetupDialog";
import { KeyboardShortcutsOverlay } from "../components/editor/KeyboardShortcutsOverlay";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { EditorBootstrapGate } from "./editor/EditorBootstrapGate";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { useProjectStore } from "../stores/project-store";
import { useTimelineStore } from "../stores/timeline-store";
import { autoSaveManager } from "../services/auto-save";
import { UpdateBanner } from "./UpdateBanner";
import { installRendererCrashHandlers, reportRendererCrash } from "./crash-reporting";
import { installMcpListener } from "../services/agent/mcp-listener";
import { getLiveEditorHost } from "../services/agent/host-singleton";
import { createExportJobRunner } from "../services/agent/export-job-runner";
import { useUIStore } from "../stores/ui-store";
import { useSettingsStore } from "../stores/settings-store";
import { SettingsDialog } from "../components/editor/settings/SettingsDialog";
import { ToolcraftButton as Button } from "@licketysplit/ui";
import { ToolcraftDialog as Dialog, ToolcraftDialogHeader as DialogHeader } from "@licketysplit/ui";
import { ToolcraftLayout as Layout, ToolcraftLayoutContent as LayoutContent, ToolcraftLayoutFooter as LayoutFooter } from "@licketysplit/ui";
import { Settings, Sparkles, Keyboard } from "@/icons/lucide-compat";
import { deleteTimelineItem } from "../utils/timeline-item-actions";
import { DESKTOP_FORMATS, startNewProject } from "./start/desktop-project-actions";

function isTextEditingFocused(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && (active.isContentEditable || Boolean(active.closest('input, textarea, select, [role="textbox"], [contenteditable="true"]')));
}

function hasBlockingDialog(): boolean {
  return Boolean(document.querySelector('[role="dialog"]') || useUIStore.getState().activeModal || useSettingsStore.getState().settingsOpen);
}

async function handleNativeEditMenuAction(id: "cut" | "copy" | "paste"): Promise<void> {
  if (isTextEditingFocused()) {
    document.execCommand(id);
    return;
  }
  if (hasBlockingDialog()) return;
  const store = useProjectStore.getState();
  const ui = useUIStore.getState();
  const clipIds = ui.getSelectedClipIds();
  if (id === "copy") {
    if (clipIds.length) store.copyClips(clipIds);
    return;
  }
  if (id === "cut") {
    if (!clipIds.length) return;
    store.beginHistoryGroup("Cut clips");
    try {
      store.copyClips(clipIds);
      for (const clipId of clipIds) await deleteTimelineItem(useProjectStore.getState(), clipId);
      useUIStore.getState().clearSelection();
    } finally { store.endHistoryGroup(); }
    return;
  }
  const selectedTrackId = ui.selectedItems[0]?.trackId;
  const destination = store.project.timeline.tracks.find((track) => track.id === selectedTrackId && !track.locked)
    ?? store.project.timeline.tracks.find((track) => !track.locked);
  if (!destination) return;
  store.beginHistoryGroup("Paste clips");
  try { await store.pasteClips(destination.id, useTimelineStore.getState().playheadPosition); }
  finally { store.endHistoryGroup(); }
}

function DesktopKeyboardShortcuts(): JSX.Element {
  const { showShortcutsOverlay, setShowShortcutsOverlay } = useKeyboardShortcuts();
  return <>
    <Button label="Keyboard shortcuts" variant="secondary" size="sm" icon={<Keyboard size={15} aria-hidden />} onClick={() => setShowShortcutsOverlay(true)} className="mr-2" />
    <KeyboardShortcutsOverlay isOpen={showShortcutsOverlay} onClose={() => setShowShortcutsOverlay(false)} />
  </>;
}

function NewProjectMenuDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }): JSX.Element | null {
  const [mode, setMode] = useState<"manual" | "podcast" | "narrative">("manual");
  const [saving, setSaving] = useState(false);
  const choose = async (saveCurrent: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      if (saveCurrent) {
        const saved = await projectManager.saveProject(useProjectStore.getState().getFullProject());
        if (!saved) return;
      }
      const format = DESKTOP_FORMATS[1];
      startNewProject(format);
      useUIStore.getState().setDesktopPage("edit");
      if (mode === "podcast") window.dispatchEvent(new CustomEvent("licketysplit:podcast:open"));
      if (mode === "narrative") useUIStore.getState().setInspectorActiveTab("lickety-narrative");
      onClose();
    } catch (error) {
      reportRendererCrash({ message: error instanceof Error ? error.message : String(error) });
    } finally { setSaving(false); }
  };
  if (!isOpen) return null;
  return <Dialog isOpen onOpenChange={(open) => !open && onClose()} width={520} purpose="form">
    <Layout
      header={<DialogHeader title="Start a new project" subtitle="Choose how to start. Your current project stays open until you make this choice." onOpenChange={(open) => !open && onClose()} />}
      content={<LayoutContent><div className="space-y-4"><fieldset><legend className="mb-2 text-sm font-medium">Starting workflow</legend><div className="grid gap-2">{([["manual", "Blank edit"], ["podcast", "Podcast preparation"], ["narrative", "Narrative"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)} className={`min-h-10 rounded border px-3 text-left text-sm ${mode === value ? "border-accent bg-accent-soft" : "border-border"}`}>{label}</button>)}</div></fieldset><p className="text-sm text-fg-muted">You can save the current project first, discard its unsaved edits explicitly, or cancel and keep working in it.</p></div></LayoutContent>}
      footer={<LayoutFooter hasDivider><div className="flex flex-wrap justify-end gap-2"><Button label="Cancel" variant="secondary" size="sm" onClick={onClose} isDisabled={saving} /><Button label="Don't save current project" variant="secondary" size="sm" onClick={() => void choose(false)} isDisabled={saving} /><Button label={saving ? "Saving…" : "Save and start new"} variant="primary" size="sm" onClick={() => void choose(true)} isDisabled={saving} /></div></LayoutFooter>}
    />
  </Dialog>;
}
import "./theme/desktop-theme.css";

function detectPlatform(): string {
  if (typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)) return "darwin";
  if (typeof navigator !== "undefined" && /Win/i.test(navigator.platform)) return "win32";
  return "linux";
}

export function DesktopApp(): JSX.Element {
  const platform = detectPlatform();
  const hasProject = useProjectStore((state) => state.hasOpenProject);
  const agentChatVisible = useUIStore(
    (state) => state.panels.agentChat?.visible ?? false,
  );
  const togglePanel = useUIStore((state) => state.togglePanel);
  const [podcastSetupOpen, setPodcastSetupOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  // Drive native-menu actions into the app: undo/redo hit the project store
  // directly; new/open/export are broadcast as events for the relevant UI to
  // pick up (e.g. the export button opens its dialog on "export").
  useEffect(() => {
    const bridge = window.licketysplit;
    if (!bridge?.onMenuAction) return;
    return bridge.onMenuAction((id) => {
      switch (id) {
        case "undo":
          if (isTextEditingFocused()) document.execCommand("undo");
          else if (!hasBlockingDialog()) void useProjectStore.getState().undo();
          break;
        case "redo":
          if (isTextEditingFocused()) document.execCommand("redo");
          else if (!hasBlockingDialog()) void useProjectStore.getState().redo();
          break;
        case "cut":
        case "copy":
        case "paste":
          void handleNativeEditMenuAction(id);
          break;
        case "open":
          if (hasBlockingDialog()) return;
          void projectManager.openProject().then(project=>{if(project){useProjectStore.getState().loadProject(project);useUIStore.getState().setDesktopPage('edit');}}).catch(error=>reportRendererCrash(error));
          break;
        case "newProject":
          if (hasBlockingDialog()) return;
          if (useProjectStore.getState().hasOpenProject) setNewProjectOpen(true);
          break;
        case "export":
          if (hasBlockingDialog()) return;
          window.dispatchEvent(new CustomEvent("licketysplit:menu:export"));
          break;
        case "settings":
          if (hasBlockingDialog()) return;
          useSettingsStore.getState().openSettings();
          break;
      }
    });
  }, []);

  useEffect(() => {
    const open = () => {
      useTimelineStore.getState().pause();
      setPodcastSetupOpen(true);
    };
    window.addEventListener("licketysplit:podcast:open", open);
    return () => window.removeEventListener("licketysplit:podcast:open", open);
  }, []);

  // Forward uncaught renderer errors + unhandled rejections to the native crash
  // collector so editor-side faults are captured alongside main-process crashes.
  useEffect(() => installRendererCrashHandlers(), []);

  // Serve main-process MCP tool calls against the live editor so external MCP
  // clients drive the open project through the same tool layer as the chat panel.
  // Also back the export_* job tools with a runner that renders via the export
  // engine and uploads the artifact to R2, returning a presigned download URL.
  useEffect(() => {
    getLiveEditorHost().setJobRunner(createExportJobRunner());
    return installMcpListener();
  }, []);

  // Answer the native unsaved-changes guard on window close / quit: report
  // dirty state and flush pending changes on request.
  useEffect(() => {
    const lifecycle = window.licketysplit?.lifecycle;
    if (!lifecycle) return;
    const offQuery = lifecycle.onQueryUnsaved(() =>
      autoSaveManager.hasUnsavedChanges(useProjectStore.getState().getFullProject()),
    );
    const offFlush = lifecycle.onFlush(() =>
      useProjectStore.getState().forceSave(),
    );
    return () => {
      offQuery();
      offFlush();
    };
  }, []);

  return (
    <div className="licketysplit-desktop isolate flex h-screen w-screen flex-col overflow-hidden bg-bg text-fg">
      <DesktopTitleBar platform={platform}>
        {hasProject ? (
          <Button
            label="AI Editor"
            variant={agentChatVisible ? "primary" : "secondary"}
            size="sm"
            icon={<Sparkles size={15} aria-hidden />}
            onClick={() => togglePanel("agentChat")}
            className="mr-2"
            aria-pressed={agentChatVisible}
          />
        ) : null}
        {hasProject ? <DesktopExportButton /> : null}
        {hasProject ? <DesktopKeyboardShortcuts /> : null}
        <Button
          label="Settings"
          variant="secondary"
          size="sm"
          icon={<Settings size={15} aria-hidden />}
          onClick={() => useSettingsStore.getState().openSettings()}
          className="mr-2"
        />
      </DesktopTitleBar>
      <div className="min-h-0 flex-1">
        <ErrorBoundary
          onError={(error, info) =>
            reportRendererCrash({
              type: "react-error",
              message: error.message,
              stack: error.stack,
              context: { componentStack: info.componentStack },
            })
          }
        >
          {hasProject ? (
            <EditorBootstrapGate>
              <Workspace suspendPreview={podcastSetupOpen} />
            </EditorBootstrapGate>
          ) : (
            <DesktopStartScreen />
          )}
        </ErrorBoundary>
      </div>
      <UpdateBanner />
      <SettingsDialog />
      {hasProject ? <PodcastSetupDialog isOpen={podcastSetupOpen} onClose={() => setPodcastSetupOpen(false)} /> : null}
      <NewProjectMenuDialog isOpen={newProjectOpen} onClose={() => setNewProjectOpen(false)} />
    </div>
  );
}
