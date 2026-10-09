import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MediaItem } from "@openreel/core";
import type { PodcastBridge, PodcastGroup, PodcastSetup, PodcastSetupStep, PodcastSyncChannel, PodcastWaveformSummary } from "@openreel/core/lickety/podcast-types";
import { ToolcraftButton as Button } from "@openreel/ui";
import { ToolcraftDialog as Dialog, ToolcraftDialogHeader as DialogHeader } from "@openreel/ui";
import { ToolcraftLayout as Layout, ToolcraftLayoutContent as LayoutContent, ToolcraftLayoutFooter as LayoutFooter } from "@openreel/ui";
import { AlertTriangle, ArrowLeft, ArrowRight, Clock3, Pause, Play, Plus, Trash2 } from "@/icons/lucide-compat";
import { useProjectStore } from "../../stores/project-store";
import { applyPodcastSetup } from "../../services/lickety/podcast";
import { resolveDesktopMedia, registerDesktopMedia } from "../../services/lickety/desktop-media";
import { readPodcastWizardCheckpoint, resolvePodcastPictureGapPolicy, selectablePodcastMedia, buildPodcastReviewPoints, type PodcastPictureGapPolicy } from "./podcast-ui-model";
import { loadPodcastCheckpoint, savePodcastCheckpoint } from "./podcast-project-draft";
import { moveGroupAsset, splitPodcastGroup, mergePodcastGroups, excludePodcastAsset, simultaneousPodcastSuggestions, podcastRecorderTimingLinked, setPodcastRecorderTimingLinked } from "./podcast-group-edits";
import { clipReview, formatReviewTime, PACKET_TIMING_WARNING, podcastReviewState, podcastTimelineModel, reviewComparison, reviewLabel, timelinePercent, timelineWaveformPath, unwaivedTimingBlockers } from "./podcast-review-model";
import { advancePreviewClock, episodeSecondsForSource, PREVIEW_HARD_DRIFT_SECONDS, PREVIEW_UI_INTERVAL_MS, previewCorrection, sourceSecondsForEpisode } from "./podcast-preview-playback";

type PodcastUpdatePatch = Omit<Parameters<PodcastBridge["update"]>[0], "setupId">;

const STEPS: Array<{ id: PodcastSetupStep; title: string }> = [
  { id: "recordings", title: "Recordings" },
  { id: "setup", title: "Setup" },
  { id: "lineup", title: "Line up" },
  { id: "check", title: "Check" },
];

type PreviewSource = { assetId: string; streamIndex: number; channel?: number };

function friendlyError(error: unknown): string {
  return error instanceof Error ? error.message : "Please try again.";
}

function mediaName(items: readonly MediaItem[], id: string): string {
  return items.find((item) => item.id === id)?.name ?? id;
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const whole = Math.floor(safe);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const ms = Math.floor((safe - whole) * 1000);
  return `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function audioPreviewChoices(setup: PodcastSetup): Array<{ id: string; label: string; source: PreviewSource }> {
  const choices: Array<{ id: string; label: string; source: PreviewSource }> = [];
  for (const group of setup.groups) {
    for (const assetId of group.assetIds) {
      const asset = setup.analysis.assets.find((candidate) => candidate.id === assetId);
      if (!asset) continue;
      const sourceLabel = group.assetIds.length > 1 ? `${group.name} · ${asset.name}` : group.name;
      for (const stream of asset.streams ?? []) {
        if (stream.kind !== "audio") continue;
        const channelCount = Math.max(1, stream.channels ?? asset.channels ?? 1);
        if (group.audioMode === "shared-mix") {
          choices.push({ id: `${asset.id}:${stream.index}:shared`, label: `${sourceLabel} · shared recording`, source: { assetId: asset.id, streamIndex: stream.index } });
          continue;
        }
        for (let channel = 0; channel < channelCount; channel += 1) {
          const binding = group.audioBindings?.find((candidate) => candidate.assetId === asset.id && candidate.streamIndex === stream.index && candidate.channel === channel);
          const participant = setup.participants.find((candidate) => candidate.id === binding?.participantId)?.name;
          choices.push({ id: `${asset.id}:${stream.index}:${channel}`, label: `${sourceLabel} · ${participant || `channel ${channel + 1}`}`, source: { assetId: asset.id, streamIndex: stream.index, channel } });
        }
      }
    }
  }
  return choices;
}

export function PodcastSetupDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }): JSX.Element | null {
  const project = useProjectStore((state) => state.project);
  const executeAction = useProjectStore((state) => state.executeAction);
  const allMedia = project.mediaLibrary.items;
  const mediaItems = useMemo(() => selectablePodcastMedia(allMedia), [allMedia]);
  const bridge = window.openreel?.podcast as PodcastBridge | undefined;
  const [step, setStep] = useState<PodcastSetupStep>("recordings");
  const [setup, setSetup] = useState<PodcastSetup | null>(null);
  const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([]);
  const [groups, setGroups] = useState<PodcastGroup[]>([]);
  const [participants, setParticipants] = useState<PodcastSetup["participants"]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [pictureGapPolicy, setPictureGapPolicy] = useState<PodcastPictureGapPolicy | null>(null);
  const requestIdRef = useRef<string | null>(null);

  const persist = useCallback((next: { step?: PodcastSetupStep; setup?: PodcastSetup | null; groups?: PodcastGroup[]; participants?: PodcastSetup["participants"]; selectedMediaIds?: string[]; pictureGapPolicy?: PodcastPictureGapPolicy }) => {
    const current = useProjectStore.getState().project;
    if (current.id !== project.id) return false;
    const nextStep = next.step ?? step;
    const nextSetup = next.setup === undefined ? setup : next.setup;
    const nextGroups = next.groups ?? groups;
    const nextParticipants = next.participants ?? participants;
    const nextMediaIds = next.selectedMediaIds ?? selectedMediaIds;
    const nextPictureGapPolicy = next.pictureGapPolicy ?? pictureGapPolicy;
    return savePodcastCheckpoint(project.id, {
      ...(nextSetup ? { setupId: nextSetup.setupId } : {}),
      step: nextStep,
      selectedMediaIds: [...nextMediaIds],
      groups: structuredClone(nextGroups),
      participants: structuredClone(nextParticipants),
      ...(nextPictureGapPolicy ? { pictureGapPolicy: nextPictureGapPolicy } : {}),
      updatedAt: new Date().toISOString(),
    }, next.setup === undefined ? undefined : nextSetup ?? undefined);
  }, [project.id, step, setup, groups, participants, selectedMediaIds, pictureGapPolicy]);

  const changePictureGapPolicy = useCallback((policy: PodcastPictureGapPolicy) => {
    setPictureGapPolicy(policy);
    persist({ pictureGapPolicy: policy });
  }, [persist]);

  const acceptNativeSetup = useCallback((next: PodcastSetup, nextStep?: PodcastSetupStep) => {
    if (next.projectId !== project.id) throw new Error("This podcast setup belongs to a different project.");
    if (useProjectStore.getState().project.id !== project.id) throw new Error("The active project changed before this podcast setup could be loaded.");
    setSetup(next);
    setGroups(structuredClone(next.groups));
    setParticipants(structuredClone(next.participants));
    setSelectedMediaIds(next.analysis.assets.map((asset) => asset.mediaId));
    if (nextStep) setStep(nextStep);
    persist({ setup: next, groups: next.groups, participants: next.participants, selectedMediaIds: next.analysis.assets.map((asset) => asset.mediaId), ...(nextStep ? { step: nextStep } : {}) });
  }, [project.id, persist]);

  useEffect(() => {
    if (!isOpen) return;
    setBusy(false);
    const activeProject = useProjectStore.getState().project;
    const projectId = activeProject.id;
    setError(null); setNotice(null); setProgress(null); setSetup(null); setGroups([]); setParticipants([]);
    const checkpoint = loadPodcastCheckpoint(activeProject);
    setPictureGapPolicy(resolvePodcastPictureGapPolicy(activeProject));
    if (checkpoint) {
      setStep(checkpoint.step);
      setSelectedMediaIds(checkpoint.selectedMediaIds.filter((id) => mediaItems.some((item) => item.id === id)));
      setGroups(structuredClone(checkpoint.groups ?? []));
      setParticipants(structuredClone(checkpoint.participants ?? []));
    } else {
      setStep("recordings");
      setSelectedMediaIds([]);
    }
    const setupId = checkpoint?.setupId ?? activeProject.lickety?.podcastSetup?.setupId;
    const activeBridge = window.openreel?.podcast as PodcastBridge | undefined;
    if (!setupId || !activeBridge) return;
    let active = true;
    void activeBridge.get({ setupId }).then((restored) => {
      if (!active || restored.projectId !== projectId || useProjectStore.getState().project.id !== projectId) return;
      setSetup(restored);
      if (!checkpoint?.groups) setGroups(structuredClone(restored.groups));
      if (!checkpoint?.participants) setParticipants(structuredClone(restored.participants));
      const restoredMediaIds = restored.analysis.assets.map((asset) => asset.mediaId);
      setSelectedMediaIds(restoredMediaIds);
      savePodcastCheckpoint(projectId, {
        setupId: restored.setupId,
        step: checkpoint?.step ?? (restored.placements.length ? "check" : "setup"),
        selectedMediaIds: restoredMediaIds,
        groups: structuredClone(checkpoint?.groups ?? restored.groups),
        participants: structuredClone(checkpoint?.participants ?? restored.participants),
        ...(resolvePodcastPictureGapPolicy(activeProject) ? { pictureGapPolicy: resolvePodcastPictureGapPolicy(activeProject)! } : {}),
        updatedAt: new Date().toISOString(),
      }, restored);
    }).catch((cause: unknown) => {
      if (active) setError(`Saved podcast draft could not be resumed from the native workspace. ${friendlyError(cause)}`);
    });
    return () => { active = false; };
  }, [isOpen, project.id]);

  useEffect(() => () => {
    const requestId = requestIdRef.current;
    requestIdRef.current = null;
    if (requestId && bridge) void bridge.cancel({ requestId }).catch(() => undefined);
  }, [project.id, bridge]);

  useEffect(() => {
    if (!isOpen || !bridge) return;
    return bridge.onProgress((event) => {
      if (event.requestId !== requestIdRef.current) return;
      setProgress(event.message);
    });
  }, [isOpen, bridge]);

  useEffect(() => {
    if (isOpen) return;
    const requestId = requestIdRef.current;
    requestIdRef.current = null;
    if (requestId && bridge) void bridge.cancel({ requestId }).catch(() => undefined);
    setBusy(false);
  }, [isOpen, bridge]);

  const requestClose = useCallback(() => {
    const requestId = requestIdRef.current;
    requestIdRef.current = null;
    if (requestId && bridge) void bridge.cancel({ requestId }).catch(() => undefined);
    setBusy(false);
    onClose();
  }, [bridge, onClose]);

  const checkpoint = readPodcastWizardCheckpoint(project);
  const groupsDirty = Boolean(setup && (JSON.stringify(groups) !== JSON.stringify(setup.groups) || JSON.stringify(participants) !== JSON.stringify(setup.participants)));
  const canEnterSetup = Boolean(setup && groups.length);
  const canEnterLineup = Boolean(setup && groups.some((group) => group.assetIds.length));
  const canEnterCheck = Boolean(setup && setup.placements.length);

  const startInspection = useCallback(async () => {
    if (!bridge) { setError("Podcast preparation requires the desktop app."); return; }
    if (!selectedMediaIds.length) { setError("Choose at least one imported video or audio recording first."); return; }
    setBusy(true); setError(null); setNotice(null); setProgress("Preparing selected originals");
    const requestId = crypto.randomUUID(); requestIdRef.current = requestId;
    try {
      const missingMediaId = selectedMediaIds.find((mediaId) => !mediaItems.some((candidate) => candidate.id === mediaId));
      if (missingMediaId) throw new Error(`Recording ${missingMediaId} is no longer in this project.`);
      const current = useProjectStore.getState().project;
      if (current.id !== project.id) throw new Error("The active project changed before source inspection finished.");
      const restored = await bridge.inspect({ projectId: project.id, mediaIds: [...selectedMediaIds], requestId, ...(setup?.setupId ? { setupId: setup.setupId } : {}) });
      if (requestIdRef.current !== requestId) return;
      acceptNativeSetup(restored, "setup");
      setNotice("Selected original recordings are ready to name and assign.");
    } catch (cause) {
      if (requestIdRef.current === requestId) setError(friendlyError(cause));
    } finally {
      if (requestIdRef.current === requestId) { requestIdRef.current = null; setBusy(false); setProgress(null); }
    }
  }, [bridge, selectedMediaIds, mediaItems, project.id, setup?.setupId, acceptNativeSetup]);

  const saveGroups = useCallback(async (nextStep: PodcastSetupStep) => {
    if (!setup || !bridge) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const latest = await bridge.get({ setupId: setup.setupId });
      if (latest.projectId !== project.id) throw new Error("This podcast setup belongs to a different project.");
      if (latest.revision !== setup.revision) {
        acceptNativeSetup(latest);
        throw new Error("The native setup changed. Its current revision was reloaded; review those changes before continuing.");
      }
      const revised = await bridge.revise({ setupId: setup.setupId, groups: structuredClone(groups), participants: structuredClone(participants) });
      if (useProjectStore.getState().project.id !== project.id) throw new Error("The active project changed while saving podcast setup.");
      acceptNativeSetup(revised, nextStep);
      setNotice("Setup saved to this project.");
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setBusy(false); }
  }, [setup, bridge, project.id, groups, participants, acceptNativeSetup]);

  const runAnalysis = useCallback(async () => {
    if (!setup || !bridge) return;
    setBusy(true); setError(null); setNotice(null); setProgress("Checking original recordings");
    const requestId = crypto.randomUUID(); requestIdRef.current = requestId;
    try {
      const latest = await bridge.get({ setupId: setup.setupId });
      if (latest.projectId !== project.id || latest.revision !== setup.revision) {
        acceptNativeSetup(latest);
        throw new Error("The native setup changed. Review its current groups before lining it up.");
      }
      if (requestIdRef.current !== requestId) return;
      const revised = groupsDirty
        ? await bridge.revise({ setupId: setup.setupId, groups: structuredClone(groups), participants: structuredClone(participants) })
        : latest;
      if (requestIdRef.current !== requestId) return;
      acceptNativeSetup(revised, "lineup");
      const result = await bridge.analyze({ setupId: revised.setupId, requestId });
      if (requestIdRef.current !== requestId) return;
      acceptNativeSetup(result, result.placements.length ? "check" : "lineup");
      setNotice(result.placements.length ? "Analysis is ready for picture-and-sound review." : "Analysis completed without an automatic placement; use the timing controls below.");
    } catch (cause) {
      if (requestIdRef.current === requestId) setError(friendlyError(cause));
    } finally {
      if (requestIdRef.current === requestId) { requestIdRef.current = null; setBusy(false); setProgress(null); }
    }
  }, [setup, bridge, project.id, groupsDirty, groups, participants, acceptNativeSetup]);

  const cancelAnalysis = useCallback(() => {
    const requestId = requestIdRef.current;
    if (!requestId || !bridge) return;
    requestIdRef.current = null;
    setBusy(false); setProgress(null); setNotice("Analysis cancellation requested. Completed bounded caches remain reusable.");
    void bridge.cancel({ requestId }).catch((cause: unknown) => setError(friendlyError(cause)));
  }, [bridge]);

  const updateTiming = useCallback(async (request: PodcastUpdatePatch) => {
    if (!setup || !bridge) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const latest = await bridge.get({ setupId: setup.setupId });
      if (latest.projectId !== project.id || latest.revision !== setup.revision) {
        acceptNativeSetup(latest);
        throw new Error("Timing changed in the native workspace. Current timing has been reloaded.");
      }
      const updated = await bridge.update({ ...request, setupId: setup.setupId });
      acceptNativeSetup(updated, "check");
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setBusy(false); }
  }, [setup, bridge, project.id, acceptNativeSetup]);

  const applyToTimeline = useCallback(async () => {
    if (!setup || !bridge) return;
    if (!pictureGapPolicy) {
      setError("Choose what to show when no camera covers part of the timeline.");
      return;
    }
    setBusy(true); setError(null); setNotice(null);
    try {
      const latest = await bridge.get({ setupId: setup.setupId });
      if (latest.projectId !== project.id || latest.revision !== setup.revision) {
        acceptNativeSetup(latest);
        throw new Error("Timing changed before apply. Review the current native revision before applying.");
      }
      await applyPodcastSetup({ setup: latest, expectedRevision: latest.revision, expectedTimeline: JSON.stringify(useProjectStore.getState().project.timeline), pictureGapPolicy }, {
        bridge,
        getProject: () => useProjectStore.getState().project,
        executeAction,
      });
      requestClose();
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setBusy(false); }
  }, [setup, bridge, project.id, executeAction, acceptNativeSetup, requestClose, pictureGapPolicy]);

  const setStage = useCallback((next: PodcastSetupStep) => {
    setStep(next);
    persist({ step: next });
  }, [persist]);

  const updateGroup = (index: number, update: Partial<PodcastGroup>) => {
    const next = groups.map((group, groupIndex) => groupIndex === index ? { ...group, ...update } : group);
    setGroups(next); persist({ groups: next });
  };
  const updateParticipants = (next: PodcastSetup["participants"]) => {
    setParticipants(next); persist({ participants: next });
  };

  const addParticipant = () => updateParticipants([...participants, { id: `person-${crypto.randomUUID()}`, name: "" }]);
  const renameParticipant = (id: string, name: string) => updateParticipants(participants.map((person) => person.id === id ? { ...person, name } : person));
  const removeParticipant = (id: string) => {
    const nextParticipants = participants.filter((person) => person.id !== id);
    updateParticipants(nextParticipants);
    const nextGroups = groups.map((group) => ({
      ...group,
      participantIds: group.participantIds?.filter((candidate) => candidate !== id),
      audioParticipantIds: group.audioParticipantIds?.filter((candidate) => candidate !== id),
      audioBindings: group.audioBindings?.filter((binding) => binding.participantId !== id),
    }));
    setGroups(nextGroups); persist({ groups: nextGroups, participants: nextParticipants });
  };

  const audioChoices = useMemo(() => setup ? audioPreviewChoices({ ...setup, groups }) : [], [setup, groups]);
  const recorderSuggestions = useMemo(() => setup ? simultaneousPodcastSuggestions(setup.analysis, groups) : [], [setup, groups]);
  const setupTimelineModel = useMemo(() => setup ? podcastTimelineModel({ ...setup, groups }) : null, [setup, groups]);
  const setupReviewState = useMemo(() => setup ? podcastReviewState(setup) : null, [setup]);

  if (!isOpen) return null;
  return (
    <Dialog isOpen onOpenChange={(open) => !open && requestClose()} width={1100} purpose="form" className="openreel-desktop max-h-[calc(100vh-24px)]">
      <Layout className="h-[90vh] min-h-0"
        header={<DialogHeader title="Podcast preparation" subtitle={<span className="text-fg-2">Keep original recordings, group sources, review timing, then add one editable timeline.</span>} onOpenChange={(open) => !open && requestClose()} />}
        content={
          <LayoutContent className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
            <nav aria-label="Podcast preparation steps" className="grid grid-cols-4 border-b border-border">
              {STEPS.map((item, index) => {
                const isCurrent = step === item.id;
                const enabled = index < STEPS.findIndex((candidate) => candidate.id === step) || item.id === "recordings" || (item.id === "setup" && canEnterSetup) || (item.id === "lineup" && canEnterLineup && !groupsDirty) || (item.id === "check" && canEnterCheck && !groupsDirty);
                return <button key={item.id} type="button" aria-current={isCurrent ? "step" : undefined} disabled={busy || !enabled} onClick={() => setStage(item.id)} className={`min-h-14 border-b-2 px-3 py-2 text-left ${isCurrent ? "border-accent bg-accent-soft text-fg" : `border-transparent ${enabled ? "text-fg-2" : "text-fg-muted"}`}`}><span className="mr-2 text-xs">{index + 1}</span><strong className="text-sm">{item.title}</strong></button>;
              })}
            </nav>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {error && <div role="alert" className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm">{error}</div>}
              {notice && <div role="status" className="mb-4 rounded-md border border-border bg-bg-2 p-3 text-sm">{notice}</div>}
              {!bridge && <p role="alert" className="mb-4 rounded-md border border-yellow-500/40 p-3 text-sm">Podcast preparation is available in the desktop app.</p>}
              {step === "recordings" && <section aria-labelledby="podcast-recordings-title" className="space-y-4">
                <div><h2 id="podcast-recordings-title" className="text-lg font-semibold">Choose recordings already in this project</h2><p className="mt-1 text-sm text-fg-2">Only selected originals are inspected. Import footage and microphones in Assets → Media, then return here. Nothing is copied or placed on the timeline yet.</p></div>
                {mediaItems.length ? <div className="grid gap-2 sm:grid-cols-2">{mediaItems.map((item) => <label key={item.id} className="flex min-h-12 items-center gap-3 rounded-md border border-border p-3"><input type="checkbox" checked={selectedMediaIds.includes(item.id)} disabled={busy} onChange={(event) => {
                  const next = event.target.checked ? [...selectedMediaIds, item.id] : selectedMediaIds.filter((id) => id !== item.id);
                  setSelectedMediaIds(next); persist({ selectedMediaIds: next });
                }} /><span className="min-w-0 flex-1"><strong className="block truncate text-sm">{item.name}</strong><span className="text-xs text-fg-muted">{item.type === "video" ? "Video recording" : "Audio recording"} · {formatClock(item.metadata.duration)}</span></span>{item.isPlaceholder && <span className="text-xs text-yellow-400">Relink first</span>}</label>)}</div> : <div className="rounded-md border border-border border-dashed p-6 text-sm"><strong>No imported recordings yet.</strong><p className="mt-1 text-fg-2">Close this window and use the Assets panel to import video and audio, then choose Podcast setup again.</p></div>}
                {checkpoint?.setupId && <p className="text-xs text-fg-2">A saved setup is attached to this project. Re-inspection keeps its group names and decisions.</p>}
              </section>}
              {step === "setup" && setup && <section className="space-y-5" aria-labelledby="podcast-groups-title">
                <div className="flex items-start justify-between gap-4"><div><h2 id="podcast-groups-title" className="text-lg font-semibold">Name groups and assign sound</h2><p className="mt-1 text-sm text-fg-2">Grouping suggests which files belong together; it does not prove their timing. Unknown people stay unknown until you identify them.</p></div><Button label="Add person" variant="secondary" size="sm" icon={<Plus size={14} aria-hidden />} onClick={addParticipant} /></div>
                <div className="grid gap-2 sm:grid-cols-2">{participants.map((person) => <label key={person.id} className="flex items-center gap-2 rounded border border-border p-2"><span className="text-xs text-fg-muted">Person</span><input aria-label="Participant name" className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1.5 text-sm" value={person.name ?? ""} disabled={busy} placeholder="Name (leave blank to keep unknown)" onChange={(event) => renameParticipant(person.id, event.target.value)} /><button type="button" aria-label={`Remove ${person.name || "unnamed person"}`} disabled={busy} onClick={() => removeParticipant(person.id)} className="rounded p-1 text-fg-muted hover:text-fg"><Trash2 size={14} /></button></label>)}</div>
                <div className="space-y-3">{groups.map((group, index) => {
                  const sources = group.assetIds.map((assetId) => setup.analysis.assets.find((asset) => asset.id === assetId)).filter((asset): asset is NonNullable<typeof asset> => Boolean(asset));
                  const availableChannels = sources.flatMap((asset) => (asset.streams ?? []).filter((stream) => stream.kind === "audio").flatMap((stream) => Array.from({ length: Math.max(1, stream.channels ?? asset.channels ?? 1) }, (_, channel) => ({ asset, stream, channel }))));
                  const recorderSuggestion = recorderSuggestions.find((ids) => ids.includes(group.id));
                  return <article key={group.id} className="space-y-3 rounded-lg border border-border bg-bg-1 p-4">
                    <div className="flex items-center gap-2"><span className="rounded bg-bg-3 px-2 py-1 text-xs">{group.kind === "video" ? "Camera" : "Sound"}</span><input aria-label={`Name this ${group.kind === "video" ? "camera" : "sound"}`} className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1.5 text-sm" value={group.name} disabled={busy} onChange={(event) => updateGroup(index, { name: event.target.value })} /><button type="button" aria-label={`Move ${group.name} up`} disabled={busy || index === 0} onClick={() => { const next = [...groups]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setGroups(next); persist({ groups: next }); }} className="rounded border border-border px-2 py-1 text-xs">↑</button><button type="button" aria-label={`Move ${group.name} down`} disabled={busy || index === groups.length - 1} onClick={() => { const next = [...groups]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; setGroups(next); persist({ groups: next }); }} className="rounded border border-border px-2 py-1 text-xs">↓</button><button type="button" aria-label={`Exclude group ${group.name}`} disabled={busy} onClick={() => { const next = groups.filter((_, groupIndex) => groupIndex !== index); setGroups(next); persist({ groups: next }); }} className="rounded border border-border px-2 py-1 text-xs">Exclude</button></div>
                    {group.kind === "video" && <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-xs"><span>Picture framing</span><select aria-label={`Framing for ${group.name}`} disabled={busy} className="block w-full rounded border border-border bg-bg px-2 py-2 text-sm" value={group.framing ?? "other"} onChange={(event) => updateGroup(index, { framing: event.target.value as PodcastGroup["framing"], participantIds: event.target.value === "everyone" ? participants.filter((person) => person.name?.trim()).map((person) => person.id) : [] })}><option value="everyone">Everyone / wide view</option><option value="person">One person</option><option value="other">Something else / unknown</option></select></label>{group.framing === "person" && <label className="space-y-1 text-xs"><span>Person shown</span><select aria-label={`Person shown by ${group.name}`} disabled={busy} className="block w-full rounded border border-border bg-bg px-2 py-2 text-sm" value={group.participantIds?.[0] ?? ""} onChange={(event) => updateGroup(index, { participantIds: event.target.value ? [event.target.value] : [] })}><option value="">Unknown</option>{participants.filter((person) => person.name?.trim()).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>}</div>}
                    <label className="block space-y-1 text-xs"><span>Audio role</span><select aria-label={`Audio role for ${group.name}`} disabled={busy || !availableChannels.length} className="block w-full rounded border border-border bg-bg px-2 py-2 text-sm" value={group.audioMode ?? (group.kind === "video" ? "reference" : "isolated")} onChange={(event) => {
                      const mode = event.target.value as PodcastGroup["audioMode"];
                      const bindings = mode === "shared-mix" ? [...new Map(availableChannels.map(({ asset, stream }) => [`${asset.id}:${stream.index}`, { assetId: asset.id, streamIndex: stream.index }])).values()] : mode === "isolated" ? group.audioBindings ?? [] : [];
                      updateGroup(index, { audioMode: mode, role: group.kind === "audio" ? mode === "isolated" || mode === "shared-mix" ? "dialogue" : mode === "reference" ? "scratch" : "other" : "camera", audioBindings: bindings, audioParticipantIds: mode === "isolated" ? group.audioParticipantIds ?? [] : [] });
                    }}><option value="isolated">Individual microphone channels</option><option value="shared-mix">One shared conversation (no isolated speaker proof)</option><option value="reference">Sound for timing only (muted in program)</option><option value="none">No useful sound</option></select></label>
                    {group.audioMode === "isolated" && availableChannels.length > 0 && <div className="space-y-2 rounded border border-border p-3"><strong className="text-xs">Map each source channel explicitly</strong>{availableChannels.map(({ asset, stream, channel }) => {
                      const binding = group.audioBindings?.find((candidate) => candidate.assetId === asset.id && candidate.streamIndex === stream.index && candidate.channel === channel);
                      return <label key={`${asset.id}:${stream.index}:${channel}`} className="grid grid-cols-[minmax(0,1fr)_minmax(140px,220px)] items-center gap-3 text-xs"><span className="truncate">{asset.name} · stream {stream.index} · channel {channel + 1}</span><select aria-label={`Participant for ${asset.name} channel ${channel + 1}`} className="rounded border border-border bg-bg px-2 py-2 text-sm" disabled={busy} value={binding?.participantId ?? ""} onChange={(event) => {
                        const all = (group.audioBindings ?? []).filter((candidate) => !(candidate.assetId === asset.id && candidate.streamIndex === stream.index && candidate.channel === channel));
                        if (event.target.value) all.push({ assetId: asset.id, streamIndex: stream.index, channel, participantId: event.target.value });
                        updateGroup(index, { audioBindings: all, audioParticipantIds: [...new Set(all.flatMap((candidate) => candidate.participantId ? [candidate.participantId] : []))] });
                      }}><option value="">Unassigned / unknown</option>{participants.filter((person) => person.name?.trim()).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>;
                    })}</div>}
                    {group.kind === "video" && <div className="space-y-2 rounded border border-border p-3"><label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={busy || group.assetIds.length < 2} checked={group.recordingLink?.kind === "continuous"} onChange={(event) => updateGroup(index, { recordingLink: event.target.checked ? { id: `continuous:${group.id}`, kind: "continuous" } : undefined })} /><span><strong>These files are one uninterrupted camera recording</strong><span className="mt-1 block text-xs text-fg-2">Confirm only if the camera split one take into consecutive files with no pause or missing segment.</span></span></label></div>}
                    {recorderSuggestion && <label className="flex items-start gap-2 rounded border border-border p-3 text-sm"><input type="checkbox" disabled={busy} checked={podcastRecorderTimingLinked(groups, recorderSuggestion)} onChange={(event) => { const next = setPodcastRecorderTimingLinked(groups, recorderSuggestion, event.target.checked); setGroups(next); persist({ groups: next }); }} /><span><strong>These separate sound files came from the same recorder at the same time</strong><span className="mt-1 block text-xs text-fg-2">Metadata suggests a shared recorder clock with {recorderSuggestion.filter((id) => id !== group.id).map((id) => groups.find((candidate) => candidate.id === id)?.name ?? id).join(", ")}. Confirm only if these are separate simultaneous channels; matching time metadata alone is not proof.</span></span></label>}
                    <ul className="space-y-1">{group.assetIds.map((assetId, assetIndex) => { const sourceName = mediaName(mediaItems, setup.analysis.assets.find((asset) => asset.id === assetId)?.mediaId ?? assetId); return <li key={assetId} className="flex min-h-9 items-center gap-2 rounded bg-bg-2 px-2 text-xs"><span className="min-w-0 flex-1 truncate">{sourceName}</span><button type="button" aria-label={`Move ${sourceName} up in ${group.name}`} disabled={busy || assetIndex === 0} className="rounded border border-border px-2 py-1" onClick={() => { const next = groups.map((candidate, at) => at === index ? moveGroupAsset(candidate, assetIndex, -1) : candidate); setGroups(next); persist({ groups: next }); }}>↑</button><button type="button" aria-label={`Move ${sourceName} down in ${group.name}`} disabled={busy || assetIndex === group.assetIds.length - 1} className="rounded border border-border px-2 py-1" onClick={() => { const next = groups.map((candidate, at) => at === index ? moveGroupAsset(candidate, assetIndex, 1) : candidate); setGroups(next); persist({ groups: next }); }}>↓</button><button type="button" aria-label={`Split ${group.name} before ${sourceName}`} disabled={busy || assetIndex === 0} className="rounded border border-border px-2 py-1" onClick={() => { const next = splitPodcastGroup(groups, index, assetIndex); if (next) { setGroups(next); persist({ groups: next }); } }}>Split before</button><button type="button" aria-label={`Exclude ${sourceName}`} disabled={busy} onClick={() => { const next = excludePodcastAsset(groups, index, assetId); setGroups(next); persist({ groups: next }); }} className="rounded border border-border px-2 py-1">Exclude</button></li>; })}</ul>
                    {index > 0 && groups[index - 1].kind === group.kind && <button type="button" disabled={busy} className="min-h-9 rounded border border-border px-3 text-xs" onClick={() => { const next = mergePodcastGroups(groups, index); if (next) { setGroups(next); persist({ groups: next }); } }}>Join with previous {group.kind === "video" ? "camera" : "sound"} group</button>}
                    <p className="text-xs text-fg-2">{group.confidence === "review" ? "Check this suggested group." : "Suggested physical group; timing remains unverified."} {group.warnings.join(" ")}</p>
                  </article>;
                })}</div>
              </section>}
              {step === "lineup" && setup && <section className="space-y-4" aria-labelledby="podcast-lineup-title"><div><h2 id="podcast-lineup-title" className="text-lg font-semibold">Line up the original recordings</h2><p className="mt-1 text-sm text-fg-2">Native analysis uses bounded source windows. A canceled or failed run keeps completed cache work for retry; it never applies source tracks.</p></div><PodcastTimelineOverview setup={setup} model={setupTimelineModel!} playheadSeconds={0} /><div className="rounded border border-border bg-bg-1 p-4"><p className="text-sm">{setup.placements.length ? `${setup.placements.length} saved placements are available to review.` : "Analysis has not been run for these groups."}</p><p className="mt-1 text-xs text-fg-2">Analysis can return unmatched sources. Those remain visibly unresolved until you adjust or exclude them.</p>{setup.warnings.map((warning, index) => <p key={`${warning}-${index}`} className="mt-2 text-xs text-yellow-300">{warning}</p>)}</div>{busy && <div className="rounded border border-border p-3 text-sm" role="status">{progress ?? "Working…"}<button type="button" onClick={cancelAnalysis} className="ml-3 underline">Cancel this run</button></div>}</section>}
              {step === "check" && setup && <PodcastTimingReview setup={setup} groups={groups} mediaItems={mediaItems} audioChoices={audioChoices} busy={busy} pictureGapPolicy={pictureGapPolicy} onPictureGapPolicyChange={changePictureGapPolicy} onUpdate={updateTiming} onRetry={() => void runAnalysis()} />}
            </div>
          </LayoutContent>
        }
        footer={<LayoutFooter hasDivider><div className="flex w-full items-center justify-between gap-4"><div className="flex min-w-0 items-center gap-2 text-xs text-fg-2">{busy ? <><Clock3 size={14} aria-hidden />{progress ?? "Working…"}</> : groupsDirty ? <><AlertTriangle size={14} aria-hidden />Setup edits are saved as a draft; save them before continuing.</> : <span>Project draft autosaves. After creating the timeline, one undo restores the project before it.</span>}</div><div className="flex shrink-0 items-center gap-2"><Button label="Close" variant="secondary" size="sm" onClick={requestClose} isDisabled={busy} />{step !== "recordings" && <Button label="Back" variant="secondary" size="sm" icon={<ArrowLeft size={14} aria-hidden />} onClick={() => setStage(STEPS[Math.max(0, STEPS.findIndex((item) => item.id === step) - 1)].id)} isDisabled={busy} />}{step === "recordings" && <Button label="Inspect selected originals" variant="primary" size="sm" onClick={() => void startInspection()} isDisabled={busy || !selectedMediaIds.length} />}{step === "setup" && <Button label="Save setup and continue" variant="primary" size="sm" icon={<ArrowRight size={14} aria-hidden />} onClick={() => void saveGroups("lineup")} isDisabled={busy || !groups.length || participants.some((person) => !person.name?.trim())} />}{step === "lineup" && <Button label={setup?.placements.length ? "Review saved timing" : "Line up recordings"} variant="primary" size="sm" icon={<ArrowRight size={14} aria-hidden />} onClick={() => setup?.placements.length ? setStage("check") : void runAnalysis()} isDisabled={busy || !canEnterLineup} />}{step === "check" && <Button label="Create timeline" variant="primary" size="sm" onClick={() => void applyToTimeline()} isDisabled={busy || !pictureGapPolicy || !setup?.placements.length || (setupReviewState?.attention.length ?? 0) > 0} />}</div></div></LayoutFooter>}
      />
    </Dialog>
  );
}

function PodcastTimelineOverview({ model, playheadSeconds, waveform, waveformChannel, setup, onSelectClip }: {
  model: ReturnType<typeof podcastTimelineModel>;
  playheadSeconds: number;
  waveform?: PodcastWaveformSummary;
  waveformChannel?: PodcastSyncChannel;
  setup?: PodcastSetup;
  onSelectClip?: (clip: ReturnType<typeof podcastTimelineModel>["lanes"][number]["clips"][number], kind: "video" | "audio") => void;
}): JSX.Element {
  return <section className="space-y-2 rounded border border-border bg-bg-1 p-3" aria-label="Recording timing lanes">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-semibold">{model.aligned ? "Lined-up timeline" : "Recordings before line-up"}</h3><span className="text-xs text-fg-2">Blank space is a gap; overlapping recordings stay on separate lanes.</span></div>
    <div className="space-y-2">
      {model.lanes.map((lane) => <div key={lane.id} className="grid gap-2 sm:grid-cols-[minmax(120px,0.32fr)_minmax(0,1fr)] sm:items-center">
        <span className="truncate text-xs" title={`${lane.label} · ${lane.role}`}>{lane.kind === "video" ? "V" : "A"}{lane.index} · {lane.label}</span>
        <div className="relative h-9 rounded bg-bg-2" aria-label={`Timeline lane for ${lane.label}`}>
          {lane.clips.map((clip) => {
            const left = timelinePercent(model, clip.startSeconds);
            const width = Math.max(0, ((clip.endSeconds - clip.startSeconds) / model.durationSeconds) * 100);
            const fill = clip.status === "unresolved" || clip.attention ? "bg-yellow-500/60" : clip.status === "excluded" ? "bg-bg-3" : clip.status === "not-aligned" ? "bg-fg-muted/45" : "bg-accent/60";
            const placement = setup?.placements.find((item) => item.assetId === clip.assetId);
            const review = placement ? clipReview(placement) : undefined;
            const label = setup ? reviewLabel(setup, clip.assetId) : clip.name;
            const reason = review?.reason ?? "Source timing has not been analyzed yet.";
            return <button key={clip.id} type="button" disabled={!onSelectClip} title={`${label} · ${review?.label ?? clip.status} · ${formatReviewTime(clip.startSeconds)}–${formatReviewTime(clip.endSeconds)}. ${reason}`} aria-label={`Select ${label}, ${review?.label ?? clip.status}, ${formatReviewTime(clip.startSeconds)} to ${formatReviewTime(clip.endSeconds)}. ${reason}`} onClick={() => onSelectClip?.(clip, lane.kind)} className={`absolute inset-y-1 overflow-hidden rounded text-left text-[10px] text-fg ${fill} disabled:cursor-default`} style={{ left: `${left}%`, width: `${width}%` }}><span className="relative z-10 truncate px-1">{clip.name}</span></button>;
          })}
          {waveform && waveformChannel && lane.kind === "audio" && lane.clips.filter((clip) => clip.channelId === waveformChannel.id).map((clip) => {
            const left = timelinePercent(model, clip.startSeconds);
            const width = Math.max(0, ((clip.endSeconds - clip.startSeconds) / model.durationSeconds) * 100);
            const path = timelineWaveformPath(waveform, waveformChannel, clip.sourceStartSeconds, clip.sourceEndSeconds, 480, 24);
            return path ? <svg key={`${clip.id}:waveform`} aria-label={`Prepared waveform for ${lane.label}`} role="img" viewBox="0 0 480 24" preserveAspectRatio="none" className="pointer-events-none absolute inset-y-1 h-6" style={{ left: `${left}%`, width: `${width}%` }}><path d={path} fill="none" stroke="currentColor" strokeWidth="1" className="text-fg" /></svg> : null;
          })}
          <span aria-hidden="true" className="absolute inset-y-0 z-20 border-l border-dashed border-fg" style={{ left: `${timelinePercent(model, playheadSeconds)}%` }} />
        </div>
      </div>)}
    </div>
    <div className="flex justify-between text-[10px] tabular-nums text-fg-muted"><span>{formatReviewTime(model.startSeconds)}</span><span>{formatReviewTime(model.endSeconds)}</span></div>
  </section>;
}

function PodcastTimingReview({ setup, groups, mediaItems, audioChoices, busy, pictureGapPolicy, onPictureGapPolicyChange, onUpdate, onRetry }: {
  setup: PodcastSetup;
  groups: PodcastGroup[];
  mediaItems: MediaItem[];
  audioChoices: ReturnType<typeof audioPreviewChoices>;
  busy: boolean;
  pictureGapPolicy: PodcastPictureGapPolicy | null;
  onPictureGapPolicyChange: (policy: PodcastPictureGapPolicy) => void;
  onUpdate: (request: PodcastUpdatePatch) => Promise<void>;
  onRetry: () => void;
}): JSX.Element {
  const placementRows = setup.placements.filter((placement) => groups.some((group) => group.assetIds.includes(placement.assetId)));
  const videoAssets = setup.analysis.assets.filter((asset) => asset.kind === "video" && groups.some((group) => group.assetIds.includes(asset.id)));
  const [videoAssetId, setVideoAssetId] = useState(videoAssets[0]?.id ?? "");
  const [audioChoiceId, setAudioChoiceId] = useState(audioChoices[0]?.id ?? "");
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioPreparing, setAudioPreparing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [mappingDrafts, setMappingDrafts] = useState<Record<string, { offsetSeconds: string; scale: string }>>({});
  const [splitDrafts, setSplitDrafts] = useState<Record<string, string>>({});
  const [selectedRegion, setSelectedRegion] = useState<{ assetId: string; regionId?: string } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewClockRef = useRef({ timelineSeconds: 0, wallMs: 0 });
  const previewDriftStartedRef = useRef(new Map<string, number>());
  const previewLastPaintRef = useRef(0);
  const activeVideo = videoAssets.find((asset) => asset.id === videoAssetId);
  const activeAudio = audioChoices.find((choice) => choice.id === audioChoiceId);
  const videoMedia = activeVideo ? mediaItems.find((item) => item.id === activeVideo.mediaId) : undefined;
  const audioMedia = activeAudio ? mediaItems.find((item) => item.id === setup.analysis.assets.find((asset) => asset.id === activeAudio.source.assetId)?.mediaId) : undefined;
  const points = useMemo(() => buildPodcastReviewPoints({ ...setup, groups }), [setup, groups]);
  const timelineModel = useMemo(() => podcastTimelineModel({ ...setup, groups }), [setup, groups]);
  const reviewState = useMemo(() => podcastReviewState(setup), [setup]);
  const comparison = useMemo(() => activeAudio ? reviewComparison(setup, activeAudio.source.assetId) : undefined, [setup, activeAudio]);
  const comparisonChannel = comparison?.channelB ? setup.channels.find((channel) => channel.id === comparison.channelB) : undefined;
  const comparisonChoice = comparisonChannel ? audioChoices.find((choice) => choice.source.assetId === comparisonChannel.assetId && choice.source.streamIndex === comparisonChannel.streamIndex && choice.source.channel === comparisonChannel.channel) : undefined;
  const currentReference = setup.placements.find((placement) => placement.assetId === setup.referenceAssetId);
  const referenceOptionDisabled = (placement: PodcastSetup["placements"][number]) => Boolean(placement.regions?.length) || placement.status === "unresolved" || placement.status === "excluded" || Boolean(currentReference?.component && placement.component !== currentReference.component);
  const hasAlternativeReference = setup.placements.some((placement) => placement.assetId !== setup.referenceAssetId && !referenceOptionDisabled(placement));
  const activeChannel = activeAudio?.source.channel === undefined ? undefined : setup.channels.find((channel) => channel.assetId === activeAudio.source.assetId && channel.streamIndex === activeAudio.source.streamIndex && channel.channel === activeAudio.source.channel);
  const [waveform, setWaveform] = useState<PodcastWaveformSummary | undefined>();

  useEffect(() => {
    setPreviewError(null);
    videoRef.current?.pause();
    videoRef.current?.removeAttribute("src");
    videoRef.current?.load();
    setVideoUrl(null);
    if (!videoMedia) return;
    let active = true;
    void resolveDesktopMedia(videoMedia, "preview").then((url) => { if (active) setVideoUrl(url); }).catch((cause: unknown) => { if (active) setPreviewError(friendlyError(cause)); });
    return () => { active = false; };
  }, [videoMedia]);

  useEffect(() => {
    setPreviewError(null);
    setAudioPreparing(false);
    audioRef.current?.pause();
    audioRef.current?.removeAttribute("src");
    audioRef.current?.load();
    setAudioUrl(null);
    if (!audioMedia || !activeAudio) return;
    let active = true;
    setAudioPreparing(true);
    const bridge = window.openreel?.lickety;
    if (!bridge?.ensureAudioStream) { setAudioUrl(null); setAudioPreparing(false); setPreviewError("The selected original audio is not registered for preview yet."); return; }
    const selectedAsset = setup.analysis.assets.find((asset) => asset.id === activeAudio.source.assetId);
    const audioOrdinal = selectedAsset?.streams?.filter((stream) => stream.kind === "audio").findIndex((stream) => stream.index === activeAudio.source.streamIndex) ?? -1;
    if (audioOrdinal < 0) {
      setAudioPreparing(false);
      setPreviewError("The selected audio stream is no longer available in this original.");
      return () => { active = false; };
    }
    void registerDesktopMedia(audioMedia).then((asset) => bridge.ensureAudioStream(asset.identity.assetId, audioOrdinal, activeAudio.source.channel)).then((url) => { if (active) { setAudioUrl(url); setAudioPreparing(false); } }).catch((cause: unknown) => { if (active) { setAudioPreparing(false); setPreviewError(friendlyError(cause)); } });
    return () => { active = false; };
  }, [audioMedia, activeAudio, setup.analysis.assets]);

  useEffect(() => {
    if (!activeChannel) { setWaveform(undefined); return; }
    const bridge = window.openreel?.podcast;
    if (!bridge?.getWaveform) { setWaveform(undefined); return; }
    const channelClip = timelineModel.lanes.flatMap((lane) => lane.clips).find((clip) => clip.channelId === activeChannel.id);
    const sourceStart = channelClip?.sourceStartSeconds ?? activeChannel.firstPTSSeconds ?? 0;
    const sourceEnd = channelClip?.sourceEndSeconds ?? sourceStart + activeChannel.frames / activeChannel.sampleRate;
    if (!(sourceEnd > sourceStart)) { setWaveform(undefined); return; }
    let live = true;
    setWaveform(undefined);
    void bridge.getWaveform({ setupId: setup.setupId, channelId: activeChannel.id, startSeconds: sourceStart, durationSeconds: sourceEnd - sourceStart, maxPoints: 1600 })
      .then((summary) => { if (live) setWaveform(summary); })
      .catch(() => { if (live) setWaveform(undefined); });
    return () => { live = false; };
  }, [setup.setupId, setup.revision, activeChannel, timelineModel]);

  const mapToSource = (assetId: string, timelineSeconds: number, laneKind: "video" | "audio") => {
    const placement = setup.placements.find((candidate) => candidate.assetId === assetId);
    const asset = setup.analysis.assets.find((candidate) => candidate.id === assetId);
    if (!placement || !asset) return null;
    const channelId = laneKind === "audio" && activeAudio?.source.assetId === assetId ? activeChannel?.id : undefined;
    const clip = timelineModel.lanes.filter((lane) => lane.kind === laneKind).flatMap((lane) => lane.clips).find((candidate) => candidate.assetId === assetId && (laneKind !== "audio" || !channelId || candidate.channelId === channelId) && candidate.status !== "excluded" && timelineSeconds >= candidate.startSeconds && timelineSeconds < candidate.endSeconds);
    if (!clip) return null;
    const region = clip.regionId ? placement.regions?.find((candidate) => candidate.id === clip.regionId) : undefined;
    const mapping = region?.mapping ?? placement.mapping;
    if (mapping.scale <= 0) return null;
    const rawSource = sourceSecondsForEpisode(timelineSeconds, mapping.scale, mapping.offsetSeconds);
    const fileRelative = rawSource - (asset.containerStartSeconds ?? 0);
    return { rawSource, fileRelative, rate: 1 / mapping.scale, inBounds: rawSource >= clip.sourceStartSeconds && rawSource <= clip.sourceEndSeconds && fileRelative >= 0 && fileRelative <= asset.durationSeconds };
  };

  const mapSourceToEpisode = (assetId: string, rawSource: number, kind: "video" | "audio"): number | null => {
    const placement = setup.placements.find((candidate) => candidate.assetId === assetId);
    if (!placement) return null;
    const channelId = kind === "audio" && activeAudio?.source.assetId === assetId ? activeChannel?.id : undefined;
    const clip = timelineModel.lanes.filter((lane) => lane.kind === kind).flatMap((lane) => lane.clips).find((candidate) => candidate.assetId === assetId && (kind !== "audio" || !channelId || candidate.channelId === channelId) && candidate.status !== "excluded" && rawSource >= candidate.sourceStartSeconds && rawSource < candidate.sourceEndSeconds);
    if (!clip) return null;
    const mapping = (clip.regionId ? placement.regions?.find((candidate) => candidate.id === clip.regionId)?.mapping : undefined) ?? placement.mapping;
    return episodeSecondsForSource(rawSource, mapping.scale, mapping.offsetSeconds);
  };

  const seek = (seconds: number) => {
    const next = Math.max(0, seconds);
    setPlayheadSeconds(next);
    previewClockRef.current = { timelineSeconds: next, wallMs: performance.now() };
    previewDriftStartedRef.current.clear();
    const videoTime = activeVideo ? mapToSource(activeVideo.id, next, "video") : null;
    const audioTime = activeAudio ? mapToSource(activeAudio.source.assetId, next, "audio") : null;
    if (videoRef.current && videoTime?.inBounds) { videoRef.current.currentTime = videoTime.fileRelative; videoRef.current.playbackRate = videoTime.rate; }
    else videoRef.current?.pause();
    if (audioRef.current && audioTime?.inBounds) { audioRef.current.currentTime = audioTime.fileRelative; audioRef.current.playbackRate = audioTime.rate; }
    else audioRef.current?.pause();
    setPreviewError(null);
  };

  const togglePlayback = async () => {
    const video = videoRef.current; const audio = audioRef.current;
    if (!video && !audio) return;
    if (previewPlaying) { video?.pause(); audio?.pause(); setPreviewPlaying(false); return; }
    seek(playheadSeconds);
    const videoSource = activeVideo ? mapToSource(activeVideo.id, playheadSeconds, "video") : null;
    const audioSource = activeAudio ? mapToSource(activeAudio.source.assetId, playheadSeconds, "audio") : null;
    const playPromises = [videoSource?.inBounds ? video?.play() : undefined, audioSource?.inBounds ? audio?.play() : undefined].filter((promise): promise is Promise<void> => Boolean(promise));
    await Promise.allSettled(playPromises);
    setPreviewPlaying(Boolean(videoUrl || audioUrl));
  };

  useEffect(() => {
    if (!previewPlaying) return;
    let frame = 0;
    const tick = (now: number) => {
      const video = videoRef.current; const audio = audioRef.current;
      const videoRaw = activeVideo && video && !video.paused ? video.currentTime + (activeVideo.containerStartSeconds ?? 0) : undefined;
      const audioAsset = activeAudio ? setup.analysis.assets.find((candidate) => candidate.id === activeAudio.source.assetId) : undefined;
      const audioRaw = activeAudio && audio && !audio.paused ? audio.currentTime + (audioAsset?.containerStartSeconds ?? 0) : undefined;
      const audioClock = audioRaw === undefined || !activeAudio ? undefined : mapSourceToEpisode(activeAudio.source.assetId, audioRaw, "audio") ?? undefined;
      const videoClock = videoRaw === undefined || !activeVideo ? undefined : mapSourceToEpisode(activeVideo.id, videoRaw, "video") ?? undefined;
      const nextClock = advancePreviewClock(previewClockRef.current, now, 1, audioClock, videoClock);
      previewClockRef.current = nextClock;
      if (now - previewLastPaintRef.current >= PREVIEW_UI_INTERVAL_MS) {
        previewLastPaintRef.current = now;
        setPlayheadSeconds(nextClock.timelineSeconds);
      }

      const correctSecondary = (key: string, element: HTMLMediaElement | null, expected: ReturnType<typeof mapToSource>, isMaster: boolean) => {
        if (!element) return;
        if (!expected?.inBounds) { element.pause(); previewDriftStartedRef.current.delete(key); return; }
        if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        const baseRate = expected.rate;
        if (element.paused) {
          element.currentTime = expected.fileRelative;
          element.playbackRate = baseRate;
          void element.play().catch(() => setPreviewError("The selected source could not start playback."));
          return;
        }
        if (isMaster) { if (Math.abs(element.playbackRate - baseRate) > 0.001) element.playbackRate = baseRate; return; }
        const drift = expected.fileRelative - element.currentTime;
        const started = previewDriftStartedRef.current.get(key);
        if (Math.abs(drift) >= PREVIEW_HARD_DRIFT_SECONDS && started === undefined) previewDriftStartedRef.current.set(key, now);
        if (Math.abs(drift) < PREVIEW_HARD_DRIFT_SECONDS) previewDriftStartedRef.current.delete(key);
        const correction = previewCorrection(expected.fileRelative, element.currentTime, baseRate, started === undefined ? 0 : now - started);
        if (correction.kind === "seek") { element.currentTime = expected.fileRelative; previewDriftStartedRef.current.delete(key); }
        if (Math.abs(element.playbackRate - correction.playbackRate) > 0.001) element.playbackRate = correction.playbackRate;
      };
      const videoExpected = activeVideo ? mapToSource(activeVideo.id, nextClock.timelineSeconds, "video") : null;
      const audioExpected = activeAudio ? mapToSource(activeAudio.source.assetId, nextClock.timelineSeconds, "audio") : null;
      correctSecondary("video", videoUrl ? video : null, videoExpected, !audioClock && Boolean(videoClock));
      correctSecondary("audio", audioUrl ? audio : null, audioExpected, Boolean(audioClock));
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [previewPlaying, activeVideo, activeAudio, setup, timelineModel, videoUrl, audioUrl]);

  useEffect(() => {
    if (!videoUrl && !audioUrl) return;
    const videoSource = activeVideo ? mapToSource(activeVideo.id, playheadSeconds, "video") : null;
    const audioSource = activeAudio ? mapToSource(activeAudio.source.assetId, playheadSeconds, "audio") : null;
    if (videoUrl && videoRef.current && videoSource?.inBounds) { videoRef.current.currentTime = videoSource.fileRelative; videoRef.current.playbackRate = videoSource.rate; }
    if (audioUrl && audioRef.current && audioSource?.inBounds) { audioRef.current.currentTime = audioSource.fileRelative; audioRef.current.playbackRate = audioSource.rate; }
  }, [videoUrl, audioUrl, activeVideo, activeAudio]);

  const videoAtPlayhead = activeVideo ? mapToSource(activeVideo.id, playheadSeconds, "video") : null;
  const audioAtPlayhead = activeAudio ? mapToSource(activeAudio.source.assetId, playheadSeconds, "audio") : null;

  const updatePlacement = (assetId: string, patch: PodcastUpdatePatch) => onUpdate({ ...patch, assetId });
  const noteKey = (assetId: string, regionId?: string) => `${assetId}${regionId ? `:${regionId}` : ""}`;
  const noteFor = (assetId: string, regionId?: string) => {
    const placement = setup.placements.find((item) => item.assetId === assetId);
    const region = regionId ? placement?.regions?.find((item) => item.id === regionId) : undefined;
    return reviewNotes[noteKey(assetId, regionId)] ?? region?.note ?? placement?.humanAcceptance?.note ?? placement?.exception ?? "";
  };
  const hasUnsavedTimingEdits = Object.keys(mappingDrafts).length > 0 || Object.values(splitDrafts).some((value) => value.trim().length > 0);
  const mappingDraft = (assetId: string, mapping: { offsetSeconds: number; scale: number }, regionId?: string) => mappingDrafts[noteKey(assetId, regionId)] ?? { offsetSeconds: String(mapping.offsetSeconds), scale: String(mapping.scale) };
  const saveMapping = async (assetId: string, mapping: { offsetSeconds: number; scale: number }, regionId?: string) => {
    const draft = mappingDraft(assetId, mapping, regionId);
    const offsetSeconds = Number(draft.offsetSeconds); const scale = Number(draft.scale);
    if (!Number.isFinite(offsetSeconds) || !Number.isFinite(scale) || scale <= 0) { setPreviewError("Enter a finite offset and a positive clock scale."); return; }
    const note = noteFor(assetId, regionId).trim();
    if (!note) { setPreviewError("Add a review note before saving a timing change."); return; }
    await updatePlacement(assetId, { offsetSeconds, scale, ...(regionId ? { regionId } : {}), note });
    setMappingDrafts((current) => { const next = { ...current }; delete next[noteKey(assetId, regionId)]; return next; });
  };
  const focusAsset = (assetId: string, regionId?: string) => {
    const asset = setup.analysis.assets.find((item) => item.id === assetId);
    if (!asset) return;
    if (asset.kind === "video") setVideoAssetId(assetId);
    else {
      const choice = audioChoices.find((item) => item.source.assetId === assetId);
      if (choice) setAudioChoiceId(choice.id);
    }
    setSelectedRegion({ assetId, ...(regionId ? { regionId } : {}) });
    const clip = timelineModel.lanes.flatMap((lane) => lane.clips).find((item) => item.assetId === assetId && (!regionId || item.regionId === regionId));
    if (clip) seek(clip.startSeconds);
  };
  const selectClip = (clip: ReturnType<typeof podcastTimelineModel>["lanes"][number]["clips"][number], kind: "video" | "audio") => {
    if (kind === "video") setVideoAssetId(clip.assetId);
    else {
      const sourceChannel = clip.channelId ? setup.channels.find((channel) => channel.id === clip.channelId) : undefined;
      const choice = audioChoices.find((item) => item.source.assetId === clip.assetId && (!sourceChannel || item.source.streamIndex === sourceChannel.streamIndex && (item.source.channel === undefined || item.source.channel === sourceChannel.channel)));
      if (choice) setAudioChoiceId(choice.id);
    }
    setSelectedRegion({ assetId: clip.assetId, ...(clip.regionId ? { regionId: clip.regionId } : {}) });
    seek(clip.startSeconds);
  };
  return <section className="space-y-5" aria-labelledby="podcast-check-title">
    <div><h2 id="podcast-check-title" className="text-lg font-semibold">Check picture and sound</h2><p className="mt-1 text-xs font-semibold text-fg-2">{reviewState.title}</p><p role="status" className="mt-1 text-sm text-fg-2">{setup.analysisProposal ? "A new timing proposal is waiting for your apply or discard choice." : reviewState.message}</p></div>
    {setup.analysisProposal && <div className="flex flex-wrap items-center gap-3 rounded border border-yellow-500/40 bg-yellow-500/5 p-3"><p className="min-w-0 flex-1 text-sm">New timing results are staged. Existing placements stay in use until you apply this proposal.</p><button type="button" disabled={busy} onClick={() => void onUpdate({ analysisDecision: "apply" })} className="min-h-9 rounded bg-accent px-3 text-sm text-white">Use new timing</button><button type="button" disabled={busy} onClick={() => void onUpdate({ analysisDecision: "discard" })} className="min-h-9 rounded border border-border px-3 text-sm">Keep previous timing</button></div>}
    <fieldset disabled={busy} className="space-y-2 rounded border border-border bg-bg-1 p-3">
      <legend className="px-1 text-sm font-medium">When the selected camera has no picture</legend>
      <p className="text-xs text-fg-2">Choose what the timeline should show during gaps. Select one before creating the timeline.</p>
      <label className="flex items-start gap-2 text-sm"><input type="radio" name="picture-gap-policy" value="keep-picture-gaps" checked={pictureGapPolicy === "keep-picture-gaps"} onChange={() => onPictureGapPolicyChange("keep-picture-gaps")} /><span><strong>Keep picture gaps</strong><span className="mt-0.5 block text-xs text-fg-2">Leave missing camera coverage blank.</span></span></label>
      <label className="flex items-start gap-2 text-sm"><input type="radio" name="picture-gap-policy" value="available-camera-fallback" checked={pictureGapPolicy === "available-camera-fallback"} onChange={() => onPictureGapPolicyChange("available-camera-fallback")} /><span><strong>Use another available camera</strong><span className="mt-0.5 block text-xs text-fg-2">Show another camera that has coverage at that time.</span></span></label>
    </fieldset>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
      <section className="space-y-3 rounded border border-border bg-bg-1 p-3" aria-label="Synchronized source preview">
        <div className="grid gap-2 sm:grid-cols-2"><label className="space-y-1 text-xs"><span>Camera to check</span><select aria-label="Camera source to preview" className="block w-full rounded border border-border bg-bg px-2 py-2 text-sm" value={videoAssetId} onChange={(event) => setVideoAssetId(event.target.value)}>{videoAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label><label className="space-y-1 text-xs"><span>Microphone or comparison channel</span><select aria-label="Audio channel to preview" className="block w-full rounded border border-border bg-bg px-2 py-2 text-sm" value={audioChoiceId} onChange={(event) => setAudioChoiceId(event.target.value)}>{audioChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label></div>
        <div className="relative flex aspect-video max-h-[44vh] min-h-[180px] items-center justify-center overflow-hidden rounded bg-black"><video ref={videoRef} src={videoUrl ?? undefined} muted preload="metadata" playsInline aria-label="Muted podcast source picture preview" className="max-h-full max-w-full object-contain" />{activeVideo && !videoAtPlayhead?.inBounds ? <div role="status" className="absolute inset-0 z-10 flex items-center justify-center bg-black px-4 text-center text-sm text-white">No picture from this source at this time.</div> : !videoUrl && <span className="text-xs text-white/70">{activeVideo ? "Loading camera preview…" : "Choose a camera source"}</span>}</div>
        <audio ref={audioRef} src={audioUrl ?? undefined} preload="metadata" aria-label="Soloed podcast comparison audio" />
        {waveform && activeChannel && <svg viewBox="0 0 480 34" role="img" aria-label="Prepared audio waveform summary" className="h-8 w-full text-accent"><path d={timelineWaveformPath(waveform, activeChannel, waveform.sourceStartSeconds, waveform.sourceStartSeconds + waveform.durationSeconds, 480, 34)} fill="none" stroke="currentColor" strokeWidth="1" /></svg>}
        {comparison && <div className="flex flex-wrap items-center gap-2 text-xs text-fg-2"><span>{comparison.evidence ? "Connected timing evidence is saved for this recording." : "Comparison channel is for listening only; no timing evidence is implied."}</span>{comparison.evidence && comparisonChoice && <button type="button" disabled={busy} onClick={() => { setAudioChoiceId(comparisonChoice.id); seek(comparison.start); }} className="min-h-8 rounded border border-border px-2 underline">Review saved comparison</button>}</div>}
        {activeAudio && !audioAtPlayhead?.inBounds && <p role="status" className="text-xs text-fg-2">No selected sound from this source at this time.</p>}
        {audioPreparing && <p role="status" className="text-xs text-fg-2">Preparing selected sound…</p>}
        <div className="flex flex-wrap items-center gap-3"><button type="button" disabled={(!videoUrl && !audioUrl) || audioPreparing} aria-label={previewPlaying ? "Pause picture and selected sound" : "Play picture and selected sound"} onClick={() => void togglePlayback()} className="flex min-h-9 items-center gap-2 rounded bg-accent px-3 text-sm text-white">{previewPlaying ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}{previewPlaying ? "Pause" : "Play picture and selected sound"}</button><button type="button" disabled={!videoUrl && !audioUrl} onClick={() => { videoRef.current?.pause(); audioRef.current?.pause(); setPreviewPlaying(false); }} className="flex min-h-9 items-center gap-2 rounded border border-border px-3 text-sm"><Pause size={14} aria-hidden />Stop</button><span className="text-xs tabular-nums text-fg-muted">Episode {formatClock(playheadSeconds)}</span></div>
        <label className="flex items-center gap-3 text-xs"><span className="w-12">Position</span><input aria-label="Episode playhead" type="range" min={0} max={Math.max(1, ...points.map((point) => point.projectSeconds))} step={0.01} value={Math.min(playheadSeconds, Math.max(1, ...points.map((point) => point.projectSeconds)))} onChange={(event) => seek(Number(event.target.value))} className="min-w-0 flex-1" /><span>{formatClock(playheadSeconds)}</span></label>
        {previewError && <p role="status" className="text-xs text-yellow-300">{previewError}</p>}
      </section>
      <section className="space-y-3 rounded border border-border bg-bg-1 p-3" aria-label="Review checkpoints"><div><h3 className="text-sm font-semibold">Quick review points</h3><p className="mt-1 text-xs text-fg-2">Jump to the episode beginning, middle, end, and source or region boundaries.</p></div><div className="max-h-[420px] space-y-1 overflow-y-auto">{points.map((point, index) => <button key={`${point.assetId ?? "episode"}:${point.projectSeconds}:${index}`} type="button" onClick={() => { if (point.assetId) focusAsset(point.assetId); seek(point.projectSeconds); }} className="flex min-h-9 w-full items-center justify-between gap-2 rounded px-2 text-left text-xs hover:bg-bg-2"><span className="truncate">{point.label}</span><span className="shrink-0 tabular-nums text-fg-muted">{formatClock(point.projectSeconds)}</span></button>)}</div></section>
    </div>
    {reviewState.attention.length > 0 && <div className="flex flex-wrap items-center gap-3 rounded border border-yellow-500/40 bg-yellow-500/5 p-3"><div className="min-w-0 flex-1"><strong className="text-sm">Next: review {reviewLabel(setup, reviewState.attention[0].assetId)}</strong><p className="mt-1 text-xs text-fg-muted">{clipReview(reviewState.attention[0]).reason}</p></div><button type="button" className="min-h-9 rounded border border-border px-3 text-sm" onClick={() => focusAsset(reviewState.attention[0].assetId)}>Review next recording</button></div>}
    <PodcastTimelineOverview setup={setup} model={timelineModel} playheadSeconds={playheadSeconds} waveform={waveform} waveformChannel={activeChannel} onSelectClip={selectClip} />
    <details className="rounded border border-border p-3"><summary className="min-h-8 cursor-pointer text-sm font-medium">Technical details</summary><div className="mt-2 max-w-xl"><label className="block text-sm">Project reference clock<select aria-label="Project reference clock" className="mt-1 block w-full rounded border border-border bg-bg px-2 py-2 text-sm" value={setup.referenceAssetId ?? ""} disabled={busy || hasUnsavedTimingEdits || Boolean(setup.analysisProposal) || !hasAlternativeReference} onChange={(event) => void onUpdate({ referenceAssetId: event.target.value })}><option value="">Choose a connected recording</option>{setup.placements.map((placement) => <option key={placement.assetId} value={placement.assetId} disabled={referenceOptionDisabled(placement)}>{reviewLabel(setup, placement.assetId)}</option>)}</select></label><p className="mt-1 text-xs text-fg-2">Choose a connected, reviewed recording as the episode clock. Excluded, unresolved, and region-split recordings cannot be references.</p></div></details>
    <section className="space-y-3" aria-label="Placement decisions"><h3 className="text-sm font-semibold">Review timing and evidence</h3><div className="space-y-3">{placementRows.map((placement) => {
      const asset = setup.analysis.assets.find((candidate) => candidate.id === placement.assetId);
      const label = reviewLabel(setup, placement.assetId);
      const status = clipReview(placement);
      const note = noteFor(placement.assetId);
      const draft = mappingDraft(placement.assetId, placement.mapping);
      const blockers = unwaivedTimingBlockers(placement);
      const canAccept = placement.component === setup.referenceAssetId && placement.status !== "excluded" && !placement.locked && !blockers.length;
      const selected = selectedRegion?.assetId === placement.assetId;
      return <article key={placement.assetId} className={`space-y-3 rounded border p-3 ${selected ? "border-accent" : "border-border"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><strong className="block truncate text-sm">{asset?.name ?? label}</strong><span className={`text-xs ${status.attention ? "text-yellow-300" : "text-fg-muted"}`}>{status.label} · {placement.status}</span><p className="mt-1 text-xs text-fg-muted">{status.reason}</p>{placement.reviewReason && <p className="mt-1 text-xs text-yellow-300">{placement.reviewReason.replaceAll("-", " ")}</p>}{placement.exception && <p className="mt-1 text-xs text-fg-muted">Saved note: {placement.exception}</p>}</div><button type="button" className="min-h-8 rounded border border-border px-2 text-xs" onClick={() => focusAsset(placement.assetId)}>Preview recording</button></div>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end text-xs"><label>Offset (seconds)<input aria-label={`Offset for ${label}`} type="number" step="0.001" value={draft.offsetSeconds} disabled={busy || placement.locked || Boolean(placement.regions?.length)} className="mt-1 block w-full rounded border border-border bg-bg px-2 py-1.5" onChange={(event) => setMappingDrafts((current) => ({ ...current, [noteKey(placement.assetId)]: { ...draft, offsetSeconds: event.target.value } }))} /></label><label>Clock scale<input aria-label={`Clock scale for ${label}`} type="number" min="0.9" max="1.1" step="0.0001" value={draft.scale} disabled={busy || placement.locked || Boolean(placement.regions?.length)} className="mt-1 block w-full rounded border border-border bg-bg px-2 py-1.5" onChange={(event) => setMappingDrafts((current) => ({ ...current, [noteKey(placement.assetId)]: { ...draft, scale: event.target.value } }))} /></label><button type="button" className="min-h-9 rounded border border-border px-3" disabled={busy || placement.locked || Boolean(placement.regions?.length) || !note.trim() || Number(draft.offsetSeconds) === placement.mapping.offsetSeconds && Number(draft.scale) === placement.mapping.scale} onClick={() => void saveMapping(placement.assetId, placement.mapping)}>Save timing</button></div>
        {placement.regions?.length ? <div className="space-y-2 rounded border border-border p-3"><strong className="text-xs">Timing sections</strong>{placement.regions.map((region, index) => {
          const regionDraft = mappingDraft(placement.assetId, region.mapping, region.id);
          const regionNote = noteFor(placement.assetId, region.id);
          const regionSelected = selectedRegion?.assetId === placement.assetId && selectedRegion.regionId === region.id;
          return <div key={region.id} className={`space-y-2 rounded p-2 ${regionSelected ? "bg-accent-soft" : "bg-bg-2"}`}><div className="flex flex-wrap items-center justify-between gap-2"><button type="button" className="text-left text-xs font-medium underline" onClick={() => focusAsset(placement.assetId, region.id)}>Section {index + 1}: {formatClock(region.sourceStartSeconds)}–{formatClock(region.sourceEndSeconds)} source · {region.status}</button><span className="text-xs text-fg-muted">{region.note || region.provenance.at(-1) || "No section note saved"}</span></div><div className="grid gap-2 sm:grid-cols-2"><label className="text-xs">Offset (seconds)<input aria-label={`Offset for ${label} section ${index + 1}`} type="number" step="0.001" value={regionDraft.offsetSeconds} disabled={busy || placement.locked || region.locked} className="mt-1 block w-full rounded border border-border bg-bg px-2 py-1.5" onChange={(event) => setMappingDrafts((current) => ({ ...current, [noteKey(placement.assetId, region.id)]: { ...regionDraft, offsetSeconds: event.target.value } }))} /></label><label className="text-xs">Clock scale<input aria-label={`Clock scale for ${label} section ${index + 1}`} type="number" min="0.9" max="1.1" step="0.0001" value={regionDraft.scale} disabled={busy || placement.locked || region.locked} className="mt-1 block w-full rounded border border-border bg-bg px-2 py-1.5" onChange={(event) => setMappingDrafts((current) => ({ ...current, [noteKey(placement.assetId, region.id)]: { ...regionDraft, scale: event.target.value } }))} /></label></div><label className="block text-xs">Section review note<input aria-label={`Review note for ${label} section ${index + 1}`} type="text" value={regionNote} disabled={busy} placeholder="What did you hear or see at this section?" className="mt-1 block w-full rounded border border-border bg-bg px-2 py-1.5" onChange={(event) => setReviewNotes((current) => ({ ...current, [noteKey(placement.assetId, region.id)]: event.target.value }))} /></label><div className="flex flex-wrap gap-2"><button type="button" className="min-h-8 rounded border border-border px-2 text-xs" disabled={busy || region.locked || placement.locked || !regionNote.trim()} onClick={() => void saveMapping(placement.assetId, region.mapping, region.id)}>Save section timing</button><button type="button" className="min-h-8 rounded border border-border px-2 text-xs" disabled={busy} onClick={() => void updatePlacement(placement.assetId, { regionId: region.id, locked: !region.locked })}>{region.locked ? "Unlock section" : "Lock section"}</button><button type="button" className="min-h-8 rounded border border-border px-2 text-xs" disabled={busy || region.locked || placement.locked || !regionNote.trim()} onClick={() => void updatePlacement(placement.assetId, { regionId: region.id, excluded: region.status !== "excluded", note: regionNote })}>{region.status === "excluded" ? "Include section" : "Leave out section"}</button>{canAccept && <button type="button" className="min-h-8 rounded border border-border px-2 text-xs" disabled={busy || !regionNote.trim()} onClick={() => void updatePlacement(placement.assetId, { regionId: region.id, acceptTiming: true, note: regionNote })}>Accept section timing</button>}</div></div>;
        })}</div> : null}
        <label className="block text-xs">Review note<input aria-label={`Review note for ${label}`} type="text" value={note} disabled={busy} placeholder="Describe what you checked before changing or accepting timing." className="mt-1 block w-full rounded border border-border bg-bg px-2 py-1.5" onChange={(event) => setReviewNotes((current) => ({ ...current, [noteKey(placement.assetId)]: event.target.value }))} /></label>
        <div className="flex flex-wrap gap-2"><button type="button" className="min-h-8 rounded border border-border px-2 text-xs" disabled={busy} onClick={() => void updatePlacement(placement.assetId, { locked: !placement.locked })}>{placement.locked ? "Unlock recording" : "Lock recording"}</button><button type="button" className="min-h-8 rounded border border-border px-2 text-xs" disabled={busy || placement.locked || placement.regions?.some((region) => region.locked) || placement.status === "excluded" && !note.trim()} onClick={() => void updatePlacement(placement.assetId, { excluded: placement.status !== "excluded", note: note.trim() || undefined })}>{placement.status === "excluded" ? "Include recording" : "Leave out recording"}</button>{canAccept && <button type="button" className="min-h-8 rounded border border-border px-2 text-xs" disabled={busy || !note.trim()} onClick={() => void updatePlacement(placement.assetId, { acceptTiming: true, note })}>Accept reviewed timing</button>}{blockers.includes(PACKET_TIMING_WARNING) && <button type="button" className="min-h-8 rounded border border-yellow-500/50 px-2 text-xs" disabled={busy || placement.locked || !note.trim()} onClick={() => void updatePlacement(placement.assetId, { waiveUnsupported: true, note })}>Save timing warning exception</button>}</div>
        <div className="grid gap-2 sm:grid-cols-[minmax(140px,0.4fr)_minmax(0,1fr)_auto] sm:items-end rounded border border-border p-2"><label className="text-xs">Split at source time (seconds)<input aria-label={`Split ${label} at source time`} type="number" min="0" step="0.001" value={splitDrafts[placement.assetId] ?? ""} disabled={busy || placement.locked} className="mt-1 block w-full rounded border border-border bg-bg px-2 py-1.5" onChange={(event) => setSplitDrafts((current) => ({ ...current, [placement.assetId]: event.target.value }))} /></label><span className="text-xs text-fg-muted">Use a visible sync change or recording break as the boundary. The saved note records your reason.</span><button type="button" className="min-h-9 rounded border border-border px-3 text-xs" disabled={busy || placement.locked || !note.trim() || !Number.isFinite(Number(splitDrafts[placement.assetId])) || !splitDrafts[placement.assetId]} onClick={() => void updatePlacement(placement.assetId, { splitSourceSeconds: Number(splitDrafts[placement.assetId]), note })}>Split timing section</button></div>
      </article>;
    })}</div>{!placementRows.length && <p className="rounded border border-yellow-500/40 p-3 text-sm">No placements are saved yet. Return to Line up and run analysis or choose a manual reference.</p>}</section>
    <details className="rounded border border-border p-3"><summary className="min-h-8 cursor-pointer text-sm font-medium">Timing evidence and unresolved checks</summary><div className="mt-2 space-y-2">{setup.reviewChecks?.map((check, index) => <div key={`${check.assetId}:${index}`} className="flex flex-wrap items-center gap-2 border-t border-border py-2 text-xs"><span className="font-medium">{setup.analysis.assets.find((asset) => asset.id === check.assetId)?.name ?? check.assetId}</span><span>{check.status}</span><span>residual {check.residualMs.toFixed(2)} ms</span><span>score {check.score.toFixed(3)}</span>{check.reason && <span>{check.reason}</span>}</div>)}{setup.warnings.map((warning, index) => <p key={`${warning}:${index}`} className="text-xs text-yellow-300">{warning}</p>)}</div></details>
    {(setup.state === "canceled" || setup.state === "error" || !setup.placements.length) && <Button label="Retry or continue analysis" variant="secondary" size="sm" onClick={onRetry} isDisabled={busy} />}
    <p className="text-xs text-fg-2">The timeline stays editable after creation, and one undo restores the project before it. Resolve every recording marked as needing attention first.</p>
  </section>;
}
