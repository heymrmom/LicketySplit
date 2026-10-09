import "../../test/install-local-storage-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { MediaItem } from "@licketysplit/core";
import type { PodcastBridge, PodcastSetup, PodcastSyncChannel } from "@licketysplit/core/lickety/podcast-types";
import { useProjectStore } from "../../stores/project-store";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { registerDesktopMedia } from "../../services/lickety/desktop-media";
import { PodcastSetupDialog } from "./PodcastSetupDialog";
import { readPodcastWizardCheckpoint } from "./podcast-ui-model";

const { applyPodcastSetupMock } = vi.hoisted(() => ({ applyPodcastSetupMock: vi.fn() }));

vi.mock("../../services/lickety/podcast", () => ({
  applyPodcastSetup: applyPodcastSetupMock,
}));

vi.mock("../../services/lickety/desktop-media", () => ({
  resolveDesktopMedia: vi.fn(async () => "file:///preview.mp4"),
  registerDesktopMedia: vi.fn(async (item: MediaItem) => ({ identity: { assetId: item.id, mediaId: item.id, sha256: "digest", byteLength: 1 }, originalUri: `licketysplit-media://${item.id}/original`, durationMs: 1000 })),
}));

const projectId = "8cb1934c-52a8-4cce-93c6-60ed14f670c2";
const media: MediaItem[] = ["camera-a.mp4", "camera-b.mp4"].map((name, index) => ({
  id: `media-${index + 1}`, name, type: "video", fileHandle: null, blob: null,
  thumbnailUrl: null, waveformData: null,
  metadata: { duration: 10, width: 1920, height: 1080, frameRate: 30, codec: "h264", sampleRate: 0, channels: 0, fileSize: 10 },
}));

function makeSetup(id = projectId): PodcastSetup {
  const assets = media.map((item, index) => ({ id: `asset-${index + 1}`, mediaId: item.id, sourceId: `source-${index + 1}`, name: item.name, kind: "video" as const, durationSeconds: 10, streams: [{ index: 0, kind: "video" as const, durationSeconds: 10 }] }));
  const group = { id: "camera-group", name: "Main camera", kind: "video" as const, role: "camera" as const, confidence: "high" as const, assetIds: assets.map((asset) => asset.id), warnings: [], recordingLink: { id: "continuous-confirmation", kind: "continuous" as const }, framing: "everyone" as const, audioMode: "reference" as const };
  return {
    schemaVersion: 1, setupId: "9f533b70-0d66-4f35-b26e-717027bef161", projectId: id, revision: 0,
    createdAt: "2026-10-09T12:00:00.000Z", updatedAt: "2026-10-09T12:00:00.000Z", step: "setup",
    analysis: { version: 1, generatedAt: "2026-10-09T12:00:00.000Z", projectName: "Episode", fps: 30, assets, groups: [group], warnings: [] },
    groups: [group], participants: [], clockGroups: [], channels: [], edges: [], placements: [], state: "draft", warnings: [],
  };
}

function setProject(): void {
  const empty = createEmptyProject("Episode");
  useProjectStore.setState({ hasOpenProject: true, project: { ...empty, id: projectId, mediaLibrary: { items: media } } });
}

function restoreSetupForStep(setup: PodcastSetup, step: "setup" | "check", pictureGapPolicy?: "keep-picture-gaps" | "available-camera-fallback"): void {
  const current = useProjectStore.getState().project;
  useProjectStore.setState({ project: {
    ...current,
    lickety: {
      schemaVersion: 1,
      podcastSetup: setup,
      podcastWizard: { setupId: setup.setupId, step, selectedMediaIds: setup.analysis.assets.map((asset) => asset.mediaId), groups: setup.groups, participants: setup.participants, ...(pictureGapPolicy ? { pictureGapPolicy } : {}), updatedAt: "2026-10-09T12:00:00.000Z" },
    },
  } as typeof current });
}

function audioChannel(assetId: string): PodcastSyncChannel {
  return { id: `${assetId}:0:0`, assetId, sourceId: `source-${assetId}`, streamIndex: 0, channel: 0, cacheKey: `cache-${assetId}`, usable: true, rms: 0.2, sampleRate: 100, frames: 1000, firstPTSSeconds: 0, timestampStatus: "continuous", discontinuities: [] };
}

describe("PodcastSetupDialog", () => {
  let bridge: PodcastBridge;
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => undefined);
    setProject();
    const setup = makeSetup();
    bridge = {
      inspect: vi.fn(async () => setup),
      revise: vi.fn(async () => ({ ...setup, revision: setup.revision + 1 })),
      analyze: vi.fn(async () => setup),
      update: vi.fn(async () => setup),
      get: vi.fn(async () => setup),
      getWaveform: vi.fn(async () => { throw new Error("unused"); }),
      cancel: vi.fn(async () => undefined),
      approve: vi.fn(async () => setup),
      onProgress: vi.fn(() => () => undefined),
    };
    Object.assign(window, { licketysplit: { platform: "desktop", podcast: bridge } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { licketysplit?: unknown }).licketysplit;
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("inspects selected imported originals, then persists reorder as a non-approved project draft", async () => {
    const view = render(<PodcastSetupDialog isOpen onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Choose recordings already in this project" })).toBeTruthy();
    const sourceCheckboxes = screen.getAllByRole("checkbox");
    fireEvent.click(sourceCheckboxes[0]);
    fireEvent.click(sourceCheckboxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "Inspect selected originals" }));
    await screen.findByRole("heading", { name: "Name groups and assign sound" });
    expect(registerDesktopMedia).not.toHaveBeenCalled();
    expect(bridge.inspect).toHaveBeenCalledWith(expect.objectContaining({ projectId, mediaIds: ["media-1", "media-2"], requestId: expect.any(String) }));
    expect(useProjectStore.getState().project.timeline.tracks).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Move camera-b.mp4 up in Main camera" }));
    const checkpoint = readPodcastWizardCheckpoint(useProjectStore.getState().project);
    expect(checkpoint?.groups?.[0].assetIds).toEqual(["asset-2", "asset-1"]);
    expect(checkpoint?.groups?.[0].recordingLink).toBeUndefined();
    expect(useProjectStore.getState().project.lickety?.podcastSetup?.state).toBe("draft");
    view.unmount();
  });

  it("cancels only the in-flight analysis request and never applies timeline tracks", async () => {
    const setup = makeSetup();
    let resolveAnalyze: ((result: PodcastSetup) => void) | undefined;
    bridge.analyze = vi.fn(() => new Promise<PodcastSetup>((resolve) => { resolveAnalyze = resolve; }));
    bridge.get = vi.fn(async () => setup);
    const current = useProjectStore.getState().project;
    useProjectStore.setState({ project: {
      ...current,
      lickety: {
        schemaVersion: 1,
        podcastSetup: setup,
        podcastWizard: { setupId: setup.setupId, step: "lineup", selectedMediaIds: media.map((item) => item.id), groups: setup.groups, participants: [], updatedAt: "2026-10-09T12:00:00.000Z" },
      },
    } as typeof current });
    const view = render(<PodcastSetupDialog isOpen onClose={vi.fn()} />);
    await vi.waitFor(() => expect(bridge.get).toHaveBeenCalledWith({ setupId: setup.setupId }));
    await screen.findByRole("heading", { name: "Line up the original recordings" });
    fireEvent.click(screen.getByRole("button", { name: "Line up recordings" }));
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "Cancel this run" }));
    await vi.waitFor(() => expect(bridge.cancel).toHaveBeenCalledWith({ requestId: expect.any(String) }));
    expect(useProjectStore.getState().project.timeline.tracks).toEqual([]);
    expect(resolveAnalyze).toBeDefined();
    await act(async () => { resolveAnalyze?.({ ...setup, state: "canceled" }); });
    expect(useProjectStore.getState().project.timeline.tracks).toEqual([]);
    view.unmount();
  });

  it("keeps a newer analysis busy when a canceled older request settles late", async () => {
    const setup = makeSetup();
    const pending: Array<(value: PodcastSetup) => void> = [];
    bridge.analyze = vi.fn(() => new Promise<PodcastSetup>((resolve) => pending.push(resolve)));
    const current = useProjectStore.getState().project;
    useProjectStore.setState({ project: {
      ...current,
      lickety: {
        schemaVersion: 1,
        podcastSetup: setup,
        podcastWizard: { setupId: setup.setupId, step: "lineup", selectedMediaIds: media.map((item) => item.id), groups: setup.groups, participants: [], updatedAt: "2026-10-09T12:00:00.000Z" },
      },
    } as typeof current });
    const view = render(<PodcastSetupDialog isOpen onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Line up the original recordings" });
    fireEvent.click(screen.getByRole("button", { name: "Line up recordings" }));
    await screen.findByRole("button", { name: "Cancel this run" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel this run" }));
    fireEvent.click(screen.getByRole("button", { name: "Line up recordings" }));
    await vi.waitFor(() => expect(bridge.analyze).toHaveBeenCalledTimes(2));
    await act(async () => { pending[0]?.({ ...setup, state: "canceled" }); });
    expect(screen.getByRole("button", { name: "Cancel this run" })).toBeTruthy();
    expect(useProjectStore.getState().project.timeline.tracks).toEqual([]);
    await act(async () => { pending[1]?.({ ...setup, state: "canceled" }); });
    view.unmount();
  });

  it("cancels a request on project switch and ignores its late setup result", async () => {
    let resolveInspect: ((value: PodcastSetup) => void) | undefined;
    let requestId = "";
    bridge.inspect = vi.fn((request) => new Promise<PodcastSetup>((resolve) => { resolveInspect = resolve; requestId = request.requestId; }));
    const view = render(<PodcastSetupDialog isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Inspect selected originals" }));
    await vi.waitFor(() => expect(bridge.inspect).toHaveBeenCalledOnce());
    const current = useProjectStore.getState().project;
    useProjectStore.setState({ project: { ...current, id: "another-project" } as typeof current });
    await vi.waitFor(() => expect(bridge.cancel).toHaveBeenCalledWith({ requestId }));
    await act(async () => { resolveInspect?.(makeSetup()); });
    expect(screen.getByRole("heading", { name: "Choose recordings already in this project" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Name groups and assign sound" })).toBeNull();
    view.unmount();
  });

  it("treats participant-only edits as setup changes and sends them before continuing", async () => {
    const setup = makeSetup();
    setup.participants = [{ id: "host", name: "Host" }];
    setup.groups[0].participantIds = ["host"];
    setup.analysis.groups = structuredClone(setup.groups);
    bridge.get = vi.fn(async () => setup);
    bridge.revise = vi.fn(async ({ groups, participants }) => ({ ...setup, revision: 1, groups, participants }));
    restoreSetupForStep(setup, "setup");
    render(<PodcastSetupDialog isOpen onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Name groups and assign sound" });

    fireEvent.change(screen.getByRole("textbox", { name: "Participant name" }), { target: { value: "Host A" } });
    expect(screen.getByRole("button", { name: /Line up/ }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save setup and continue" }));
    await screen.findByRole("heading", { name: "Line up the original recordings" });
    expect(bridge.revise).toHaveBeenCalledWith(expect.objectContaining({ participants: [{ id: "host", name: "Host A" }] }));
  });

  it("saves region timing only with the review note and the selected source section", async () => {
    const setup = makeSetup();
    setup.referenceAssetId = "asset-1";
    setup.state = "review";
    setup.placements = [{
      assetId: "asset-1", status: "unresolved", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false,
      component: "asset-1", provenance: [], regions: [{ id: "region-a", sourceStartSeconds: 0, sourceEndSeconds: 4, mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "unresolved", locked: false, provenance: [] }],
    }];
    setup.placements.push({ assetId: "asset-2", status: "reference", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "asset-1", provenance: [] });
    bridge.get = vi.fn(async () => setup);
    bridge.update = vi.fn(async () => ({ ...setup, revision: 1 }));
    restoreSetupForStep(setup, "check");
    render(<PodcastSetupDialog isOpen onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Check picture and sound" });
    fireEvent.click(screen.getByText("Technical details"));
    const referenceClock = screen.getByRole("combobox", { name: "Project reference clock" });
    expect((referenceClock as HTMLSelectElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Select Main camera, Check these moments/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Review note for Main camera section 1" }), { target: { value: "Checked the cut at the visible clap." } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Offset for Main camera section 1" }), { target: { value: "0.125" } });
    expect((referenceClock as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save section timing" }));

    await vi.waitFor(() => expect(bridge.update).toHaveBeenCalledWith(expect.objectContaining({
      setupId: setup.setupId, assetId: "asset-1", regionId: "region-a", offsetSeconds: 0.125, scale: 1, note: "Checked the cut at the visible clap.",
    })));
  });

  it("changes the project reference clock through the native update bridge", async () => {
    const setup = makeSetup();
    setup.referenceAssetId = "asset-1";
    setup.state = "review";
    setup.placements = [
      { assetId: "asset-1", status: "reference", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "connected", provenance: [] },
      { assetId: "asset-2", status: "measured", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "connected", provenance: [] },
      { assetId: "asset-3", status: "unresolved", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "connected", provenance: [], regions: [{ id: "region", sourceStartSeconds: 0, sourceEndSeconds: 2, mapping: { version: 1, scale: 1, offsetSeconds: 0 }, status: "unresolved", locked: false, provenance: [] }] },
    ];
    setup.analysis.assets.push({ ...setup.analysis.assets[1], id: "asset-3", mediaId: "media-3", sourceId: "source-3", name: "Unresolved take" });
    bridge.get = vi.fn(async () => setup);
    bridge.update = vi.fn(async (request) => ({ ...setup, revision: setup.revision + 1, referenceAssetId: request.referenceAssetId }));
    restoreSetupForStep(setup, "check");
    render(<PodcastSetupDialog isOpen onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Check picture and sound" });
    fireEvent.click(screen.getByText("Technical details"));
    const referenceClock = screen.getByRole("combobox", { name: "Project reference clock" }) as HTMLSelectElement;
    expect([...referenceClock.options].find((option) => option.value === "asset-3")?.disabled).toBe(true);
    fireEvent.change(referenceClock, { target: { value: "asset-2" } });
    await vi.waitFor(() => expect(bridge.update).toHaveBeenCalledWith(expect.objectContaining({ setupId: setup.setupId, referenceAssetId: "asset-2" })));
  });

  it("advances the review clock from selected audio source time before picture time", async () => {
    const setup = makeSetup();
    const audioItem: MediaItem = { id: "media-audio", name: "host.wav", type: "audio", fileHandle: null, blob: null, thumbnailUrl: null, waveformData: null, metadata: { duration: 10, width: 0, height: 0, frameRate: 0, codec: "wav", sampleRate: 100, channels: 1, fileSize: 100 } };
    setup.analysis.assets.push({ id: "asset-audio", mediaId: audioItem.id, sourceId: "source-audio", name: audioItem.name, kind: "audio", durationSeconds: 10, channels: 1, sampleRate: 100, streams: [{ index: 0, kind: "audio", durationSeconds: 10, sampleRate: 100, channels: 1 }] });
    setup.groups.push({ id: "mic", name: "Host microphone", kind: "audio", role: "dialogue", confidence: "high", assetIds: ["asset-audio"], warnings: [], audioMode: "isolated" });
    const audioAsset = setup.analysis.assets.find((asset) => asset.id === "asset-audio")!;
    audioAsset.channels = 2;
    audioAsset.streams = audioAsset.streams?.map((stream) => ({ ...stream, channels: 2 })) ?? [];
    setup.channels = [audioChannel("asset-1"), audioChannel("asset-audio"), { ...audioChannel("asset-audio"), id: "asset-audio:0:1", channel: 1 }];
    setup.placements = [
      { assetId: "asset-1", status: "reference", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "asset-1", provenance: [] },
      { assetId: "asset-2", status: "measured", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "asset-1", provenance: [] },
      { assetId: "asset-audio", status: "measured", mapping: { version: 1, scale: 1, offsetSeconds: 4 }, locked: false, component: "asset-1", provenance: [] },
    ];
    setup.referenceAssetId = "asset-1";
    setup.edges = [{ a: "asset-1", b: "asset-audio", channelA: "asset-1:0:0", channelB: "asset-audio:0:1", candidates: [], status: "measured", reason: "fixture", anchors: [{ role: "validation", sourceSeconds: 2, referenceSeconds: 6, score: 1, competingScore: 0, polarity: 1, windowSeconds: 6 }] }];
    setup.state = "review";
    bridge.get = vi.fn(async () => setup);
    const ensureAudioStream = vi.fn(async () => "file:///host.wav");
    Object.assign(window, { licketysplit: { platform: "desktop", podcast: bridge, lickety: { ensureAudioStream } } });
    const current = useProjectStore.getState().project;
    useProjectStore.setState({ project: { ...current, mediaLibrary: { items: [...media, audioItem] } } });
    restoreSetupForStep(setup, "check");

    const callbacks: Array<(timestamp: number) => void> = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callbacks.push(callback); return callbacks.length; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const view = render(<PodcastSetupDialog isOpen onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Check picture and sound" });
    await vi.waitFor(() => expect(ensureAudioStream).toHaveBeenCalledWith("media-audio", 0, 0));
    expect(screen.getByRole("button", { name: "Review saved comparison" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review saved comparison" }));
    await vi.waitFor(() => expect(ensureAudioStream).toHaveBeenCalledWith("media-audio", 0, 1));
    expect((screen.getByRole("slider", { name: "Episode playhead" }) as HTMLInputElement).value).toBe("3");
    const audio = screen.getByLabelText("Soloed podcast comparison audio") as HTMLAudioElement;
    const video = screen.getByLabelText("Muted podcast source picture preview") as HTMLVideoElement;
    Object.defineProperty(audio, "paused", { configurable: true, value: false });
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    Object.defineProperty(audio, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    let audioTime = 2;
    let videoTime = 4;
    Object.defineProperty(audio, "currentTime", { configurable: true, get: () => audioTime, set: (value: number) => { audioTime = value; } });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => videoTime, set: (value: number) => { videoTime = value; } });
    fireEvent.change(screen.getByRole("slider", { name: "Episode playhead" }), { target: { value: "6" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Play picture and selected sound" })); });
    await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(0));
    await act(async () => { callbacks.at(-1)?.(performance.now() + 150); });
    expect(screen.getByText("Episode 00:06.000")).toBeTruthy();
    expect((video as HTMLVideoElement).muted).toBe(true);
    view.unmount();
  });

  it("requires an explicit picture-gap choice and forwards it to timeline creation", async () => {
    const setup = makeSetup();
    setup.state = "review";
    setup.referenceAssetId = "asset-1";
    setup.placements = [
      { assetId: "asset-1", status: "reference", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "connected", provenance: [] },
      { assetId: "asset-2", status: "measured", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "connected", provenance: [] },
    ];
    bridge.get = vi.fn(async () => setup);
    applyPodcastSetupMock.mockResolvedValue(undefined);
    restoreSetupForStep(setup, "check");

    render(<PodcastSetupDialog isOpen onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Check picture and sound" });

    const createButton = screen.getByRole("button", { name: "Create timeline" });
    expect((createButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Use another available camera/ }));
    fireEvent.click(createButton);

    await vi.waitFor(() => expect(applyPodcastSetupMock).toHaveBeenCalledWith(
      expect.objectContaining({ setup, expectedRevision: setup.revision, pictureGapPolicy: "available-camera-fallback" }),
      expect.objectContaining({ bridge }),
    ));
  });

  it("persists the gap choice across reopen and restores the new project's own policy", async () => {
    const first = makeSetup();
    first.state = "review";
    first.referenceAssetId = "asset-1";
    first.placements = [
      { assetId: "asset-1", status: "reference", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "connected", provenance: [] },
      { assetId: "asset-2", status: "measured", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "connected", provenance: [] },
    ];
    bridge.get = vi.fn(async () => first);
    restoreSetupForStep(first, "check", "keep-picture-gaps");

    const view = render(<PodcastSetupDialog isOpen onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Check picture and sound" });
    const keep = screen.getByRole("radio", { name: /Keep picture gaps/ }) as HTMLInputElement;
    const fallback = screen.getByRole("radio", { name: /Use another available camera/ }) as HTMLInputElement;
    expect(keep.checked).toBe(true);
    fireEvent.click(fallback);
    expect(readPodcastWizardCheckpoint(useProjectStore.getState().project)?.pictureGapPolicy).toBe("available-camera-fallback");

    view.rerender(<PodcastSetupDialog isOpen={false} onClose={vi.fn()} />);
    view.rerender(<PodcastSetupDialog isOpen onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Check picture and sound" });
    expect((screen.getByRole("radio", { name: /Use another available camera/ }) as HTMLInputElement).checked).toBe(true);

    const second = makeSetup("project-b");
    second.setupId = "setup-project-b";
    second.state = "review";
    second.referenceAssetId = "asset-1";
    second.placements = first.placements;
    bridge.get = vi.fn(async ({ setupId }) => setupId === second.setupId ? second : first);
    const empty = createEmptyProject("Different episode");
    useProjectStore.setState({ project: {
      ...empty,
      id: "project-b",
      mediaLibrary: { items: media },
      lickety: {
        schemaVersion: 1,
        podcastSetup: second,
        podcastAssembly: { setupId: second.setupId, setupRevision: second.revision, originShiftSeconds: 0, ownedTrackIds: [], groupIds: [], pictureGapPolicy: "keep-picture-gaps" },
        podcastWizard: { setupId: second.setupId, step: "check", selectedMediaIds: media.map((item) => item.id), groups: second.groups, participants: second.participants, updatedAt: "2026-10-09T12:00:00.000Z" },
      },
    } as typeof empty });
    await vi.waitFor(() => expect((screen.getByRole("radio", { name: /Keep picture gaps/ }) as HTMLInputElement).checked).toBe(true));
    expect((screen.getByRole("radio", { name: /Use another available camera/ }) as HTMLInputElement).checked).toBe(false);
    view.unmount();
  });

  it("uses audio-stream bounds when previewing scratch sound from a video asset", async () => {
    const setup = makeSetup();
    setup.state = "review";
    setup.referenceAssetId = "asset-1";
    setup.analysis.assets[0]!.streams = [
      { index: 0, kind: "video", startSeconds: 0, durationSeconds: 10 },
      { index: 1, kind: "audio", startSeconds: 1.5, durationSeconds: 8.5, channels: 1 },
    ];
    setup.analysis.assets[0]!.channels = 1;
    setup.channels = [{ ...audioChannel("asset-1"), id: "asset-1:1:0", streamIndex: 1, firstPTSSeconds: 1.5, frames: 850 }];
    setup.placements = [
      { assetId: "asset-1", status: "reference", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "connected", provenance: [] },
      { assetId: "asset-2", status: "measured", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "connected", provenance: [] },
    ];
    bridge.get = vi.fn(async () => setup);
    const ensureAudioStream = vi.fn(async () => "file:///camera-scratch.m4a");
    Object.assign(window, { licketysplit: { platform: "desktop", podcast: bridge, lickety: { ensureAudioStream } } });
    restoreSetupForStep(setup, "check");

    render(<PodcastSetupDialog isOpen onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Check picture and sound" });
    await vi.waitFor(() => expect(ensureAudioStream).toHaveBeenCalledWith("media-1", 0, 0));
    const audio = screen.getByLabelText("Soloed podcast comparison audio") as HTMLAudioElement;
    const video = screen.getByLabelText("Muted podcast source picture preview") as HTMLVideoElement;
    const audioPlay = vi.spyOn(audio, "play").mockResolvedValue(undefined);
    const videoPlay = vi.spyOn(video, "play").mockResolvedValue(undefined);

    fireEvent.click(screen.getByRole("button", { name: "Play picture and selected sound" }));

    await vi.waitFor(() => expect(videoPlay).toHaveBeenCalled());
    expect(audioPlay).not.toHaveBeenCalled();
    expect(screen.getByText("No selected sound from this source at this time.")).toBeTruthy();
  });

  it("converts global stream indices to audio ordinals and keeps the selected channel", async () => {
    const setup = makeSetup();
    setup.state = "review";
    setup.analysis.assets[0]!.streams = [
      { index: 0, kind: "video", startSeconds: 0, durationSeconds: 10 },
      { index: 1, kind: "audio", startSeconds: 0, durationSeconds: 10, channels: 2 },
      { index: 2, kind: "audio", startSeconds: 0, durationSeconds: 10, channels: 2 },
    ];
    setup.analysis.assets[0]!.channels = 2;
    setup.channels = [1, 2].flatMap((streamIndex) => [0, 1].map((channel) => ({
      ...audioChannel("asset-1"),
      id: `asset-1:${streamIndex}:${channel}`,
      streamIndex,
      channel,
    })));
    setup.placements = [
      { assetId: "asset-1", status: "reference", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "connected", provenance: [] },
      { assetId: "asset-2", status: "measured", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "connected", provenance: [] },
    ];
    bridge.get = vi.fn(async () => setup);
    const pendingPreviews: Array<(value: string) => void> = [];
    const ensureAudioStream = vi.fn(() => new Promise<string>((resolve) => pendingPreviews.push(resolve)));
    Object.assign(window, { licketysplit: { platform: "desktop", podcast: bridge, lickety: { ensureAudioStream } } });
    restoreSetupForStep(setup, "check");

    render(<PodcastSetupDialog isOpen onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Check picture and sound" });
    fireEvent.change(screen.getByRole("combobox", { name: "Audio channel to preview" }), { target: { value: "asset-1:2:1" } });

    await vi.waitFor(() => expect(ensureAudioStream).toHaveBeenLastCalledWith("media-1", 1, 1));
    expect(screen.getByText("Preparing selected sound…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Play picture and selected sound" }) as HTMLButtonElement).disabled).toBe(true);
    pendingPreviews.at(-1)?.("file:///camera-channel.m4a");
    await vi.waitFor(() => expect(screen.queryByText("Preparing selected sound…")).toBeNull());
    expect((screen.getByRole("button", { name: "Play picture and selected sound" }) as HTMLButtonElement).disabled).toBe(false);
    pendingPreviews.forEach((resolve, index) => { if (index !== pendingPreviews.length - 1) resolve("file:///stale-camera-channel.m4a"); });
  });

  it("covers stale picture frames and labels both sources when neither covers the playhead", async () => {
    const setup = makeSetup();
    setup.state = "review";
    setup.analysis.assets[0]!.streams = [
      { index: 0, kind: "video", startSeconds: 2, durationSeconds: 2 },
      { index: 1, kind: "audio", startSeconds: 3, durationSeconds: 7, channels: 1 },
    ];
    setup.analysis.assets[0]!.nativeVideoDurationSeconds = 4;
    setup.analysis.assets[0]!.channels = 1;
    setup.channels = [{ ...audioChannel("asset-1"), id: "asset-1:1:0", streamIndex: 1, firstPTSSeconds: 3, frames: 700 }];
    setup.placements = [
      { assetId: "asset-1", status: "reference", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "connected", provenance: [] },
      { assetId: "asset-2", status: "measured", mapping: { version: 1, scale: 1, offsetSeconds: 0 }, locked: false, component: "connected", provenance: [] },
    ];
    bridge.get = vi.fn(async () => setup);
    Object.assign(window, { licketysplit: { platform: "desktop", podcast: bridge, lickety: { ensureAudioStream: vi.fn(async () => "file:///camera-scratch.m4a") } } });
    restoreSetupForStep(setup, "check");

    render(<PodcastSetupDialog isOpen onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Check picture and sound" });

    expect(screen.getByText("No picture from this source at this time.")).toBeTruthy();
    expect(screen.getByText("No selected sound from this source at this time.")).toBeTruthy();
  });
});
