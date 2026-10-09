import "../../test/install-local-storage-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { MediaItem } from "@openreel/core";
import type { PodcastBridge, PodcastSetup, PodcastSyncChannel } from "@openreel/core/lickety/podcast-types";
import { useProjectStore } from "../../stores/project-store";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { registerDesktopMedia } from "../../services/lickety/desktop-media";
import { PodcastSetupDialog } from "./PodcastSetupDialog";
import { readPodcastWizardCheckpoint } from "./podcast-ui-model";

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

function restoreSetupForStep(setup: PodcastSetup, step: "setup" | "check"): void {
  const current = useProjectStore.getState().project;
  useProjectStore.setState({ project: {
    ...current,
    lickety: {
      schemaVersion: 1,
      podcastSetup: setup,
      podcastWizard: { setupId: setup.setupId, step, selectedMediaIds: setup.analysis.assets.map((asset) => asset.mediaId), groups: setup.groups, participants: setup.participants, updatedAt: "2026-10-09T12:00:00.000Z" },
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
    Object.assign(window, { openreel: { platform: "desktop", podcast: bridge } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { openreel?: unknown }).openreel;
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
    Object.assign(window, { openreel: { platform: "desktop", podcast: bridge, lickety: { ensureAudioStream } } });
    const current = useProjectStore.getState().project;
    useProjectStore.setState({ project: { ...current, mediaLibrary: { items: [...media, audioItem] } } });
    restoreSetupForStep(setup, "check");

    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callbacks.push(callback); return callbacks.length; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const view = render(<PodcastSetupDialog isOpen onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "Check picture and sound" });
    await vi.waitFor(() => expect(ensureAudioStream).toHaveBeenCalledWith("media-audio", 0, 0));
    expect(screen.getByRole("button", { name: "Review saved comparison" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review saved comparison" }));
    await vi.waitFor(() => expect(ensureAudioStream).toHaveBeenCalledWith("media-audio", 0, 1));
    expect((screen.getByRole("slider", { name: "Episode playhead" }) as HTMLInputElement).value).toBe("3");
    const audio = screen.getByLabelText("Soloed podcast comparison audio");
    const video = screen.getByLabelText("Muted podcast source picture preview");
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
});
