import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { MediaItem, Project } from "@licketysplit/core";
import type { ProjectState } from "../project-store";
import { createEmptyProject } from "./project-helpers";
import { createMediaSlice } from "./media-slice";

const { bridge, saveMediaBlob, warning } = vi.hoisted(() => ({
  bridge: {
    isInitialized: vi.fn(() => true),
    importFile: vi.fn(),
    generateThumbnailsForMedia: vi.fn(async () => []),
  },
  saveMediaBlob: vi.fn(async () => {}),
  warning: vi.fn(),
}));

vi.mock("../../bridges/media-bridge", () => ({
  getMediaBridge: () => bridge,
  initializeMediaBridge: vi.fn(async () => {}),
}));
vi.mock("../../services/media-storage", () => ({
  saveMediaBlob,
  deleteMediaBlob: vi.fn(async () => {}),
}));
vi.mock("../notification-store", () => ({ toast: { warning } }));

const decodedAudio = () => ({
  success: true,
  media: {
    metadata: {
      duration: 12,
      width: 0,
      height: 0,
      frameRate: 0,
      codec: "pcm",
      sampleRate: 48_000,
      channels: 2,
      hasVideo: false,
      hasAudio: true,
    },
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function createMediaStore(initial: Project = createEmptyProject("Original")) {
  return createStore<ProjectState>((set, get) => ({
    project: initial,
    ...createMediaSlice(set, get),
  } as ProjectState));
}

function originalMedia(): MediaItem {
  return {
    id: "existing-media",
    name: "missing.wav",
    type: "audio",
    blob: null,
    fileHandle: null,
    metadata: { ...decodedAudio().media.metadata, fileSize: 3 },
    thumbnailUrl: null,
    waveformData: null,
    isPlaceholder: true,
  };
}

describe("Media slice asynchronous imports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { licketysplit?: unknown }).licketysplit;
    bridge.importFile.mockReset();
    saveMediaBlob.mockReset().mockResolvedValue(undefined);
  });

  it("retains every concurrent import and edits made while files decode", async () => {
    const first = deferred<ReturnType<typeof decodedAudio>>();
    const second = deferred<ReturnType<typeof decodedAudio>>();
    bridge.importFile
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const store = createMediaStore();
    const importingFirst = store.getState().importMedia(new File(["a"], "first.wav"));
    const importingSecond = store.getState().importMedia(new File(["b"], "second.wav"));
    store.setState({ project: { ...store.getState().project, name: "Edited while importing" } });

    second.resolve(decodedAudio());
    expect((await importingSecond).success).toBe(true);
    first.resolve(decodedAudio());
    expect((await importingFirst).success).toBe(true);

    expect(store.getState().project.name).toBe("Edited while importing");
    expect(store.getState().project.mediaLibrary.items.map((item) => item.name))
      .toEqual(["second.wav", "first.wav"]);
    expect(saveMediaBlob).toHaveBeenCalledTimes(2);
  });

  it("does not reopen an old project when its media finishes importing", async () => {
    const decoding = deferred<ReturnType<typeof decodedAudio>>();
    bridge.importFile.mockReturnValueOnce(decoding.promise);
    const store = createMediaStore();
    const importing = store.getState().importMedia(new File(["a"], "first.wav"));
    const newProject = createEmptyProject("New project");
    store.setState({ project: newProject });
    decoding.resolve(decodedAudio());

    expect((await importing).success).toBe(false);
    expect(store.getState().project).toBe(newProject);
    expect(saveMediaBlob).not.toHaveBeenCalled();
  });

  it("reuses an existing project media identity for the same unchanged native original", async () => {
    const identity = { identity: "opaque-source-id", size: 4, mtimeMs: 1234 };
    Object.assign(window, { licketysplit: { platform: "desktop", lickety: { identifyOriginalFile: vi.fn(async () => identity) } } });
    const initial = createEmptyProject("Existing original");
    initial.mediaLibrary.items.push({ ...originalMedia(), id: "canonical-media", isPlaceholder: false, sourceFile: { name: "same.wav", size: 4, lastModified: 1234, identity: { id: identity.identity, size: 4, mtimeMs: 1234 } } });
    const store = createMediaStore(initial);

    const result = await store.getState().importMedia(new File(["same"], "same.wav", { lastModified: 1234 }));

    expect(result).toMatchObject({ success: true, actionId: "canonical-media" });
    expect(bridge.importFile).not.toHaveBeenCalled();
    expect(store.getState().project.mediaLibrary.items).toHaveLength(1);
  });

  it("coalesces concurrent imports of the same native file identity", async () => {
    const identity = { identity: "opaque-source-id", size: 4, mtimeMs: 1234 };
    Object.assign(window, { licketysplit: { platform: "desktop", lickety: { identifyOriginalFile: vi.fn(async () => identity) } } });
    const decoding = deferred<ReturnType<typeof decodedAudio>>();
    bridge.importFile.mockReturnValueOnce(decoding.promise);
    const store = createMediaStore();
    const fileA = new File(["same"], "same.wav", { lastModified: 1234 });
    const fileB = new File(["same"], "same.wav", { lastModified: 1234 });

    const first = store.getState().importMedia(fileA);
    const second = store.getState().importMedia(fileB);
    await vi.waitFor(() => expect(bridge.importFile).toHaveBeenCalledOnce());
    decoding.resolve(decodedAudio());

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.actionId).toBe(secondResult.actionId);
    expect(store.getState().project.mediaLibrary.items).toHaveLength(1);
    expect(store.getState().project.mediaLibrary.items[0].sourceFile?.identity).toEqual({ id: identity.identity, size: 4, mtimeMs: 1234 });
  });

  it("stops after a native identity lookup if the active project changes", async () => {
    const lookup = deferred<string | undefined>();
    Object.assign(window, { licketysplit: { platform: "desktop", lickety: {
      identifyOriginalFile: vi.fn(async () => ({ identity: "opaque-source-id", size: 4, mtimeMs: 1234 })),
      findOriginalMediaId: vi.fn(() => lookup.promise),
    } } });
    const initial = createEmptyProject("Before switch");
    initial.mediaLibrary.items.push({ ...originalMedia(), id: "legacy-media", isPlaceholder: false });
    const store = createMediaStore(initial);
    const importing = store.getState().importMedia(new File(["same"], "same.wav", { lastModified: 1234 }));
    await vi.waitFor(() => expect(window.licketysplit?.lickety?.findOriginalMediaId).toHaveBeenCalledOnce());
    const changed = createEmptyProject("After switch");
    store.setState({ project: changed });
    lookup.resolve("legacy-media");

    expect(await importing).toMatchObject({ success: false, error: { code: "INVALID_PARAMS" } });
    expect(store.getState().project).toBe(changed);
    expect(bridge.importFile).not.toHaveBeenCalled();
  });

  it("rechecks project identity after a slow registry lookup so concurrent imports cannot duplicate", async () => {
    const lateLookup = deferred<string | undefined>();
    let lookupCount = 0;
    Object.assign(window, { licketysplit: { platform: "desktop", lickety: {
      identifyOriginalFile: vi.fn(async () => ({ identity: "opaque-source-id", size: 4, mtimeMs: 1234 })),
      findOriginalMediaId: vi.fn(() => ++lookupCount === 1 ? Promise.resolve(undefined) : lateLookup.promise),
    } } });
    const decoding = deferred<ReturnType<typeof decodedAudio>>();
    bridge.importFile.mockReturnValueOnce(decoding.promise);
    const store = createMediaStore();
    const first = store.getState().importMedia(new File(["same"], "same.wav", { lastModified: 1234 }));
    await vi.waitFor(() => expect(bridge.importFile).toHaveBeenCalledOnce());
    const second = store.getState().importMedia(new File(["same"], "same.wav", { lastModified: 1234 }));
    await vi.waitFor(() => expect(lookupCount).toBe(2));

    decoding.resolve(decodedAudio());
    const firstResult = await first;
    lateLookup.resolve(undefined);
    const secondResult = await second;
    expect(firstResult.actionId).toBe(secondResult.actionId);
    expect(bridge.importFile).toHaveBeenCalledOnce();
    expect(store.getState().project.mediaLibrary.items).toHaveLength(1);
  });

  it("settles every coalesced caller when the canonical import fails", async () => {
    Object.assign(window, { licketysplit: { platform: "desktop", lickety: { identifyOriginalFile: vi.fn(async () => ({ identity: "opaque-failed-source", size: 4, mtimeMs: 1234 })) } } });
    const failing = deferred<{ success: false; error: string }>();
    bridge.importFile.mockReturnValueOnce(failing.promise);
    const store = createMediaStore();
    const fileA = new File(["same"], "broken.wav", { lastModified: 1234 });
    const first = store.getState().importMedia(fileA);
    await vi.waitFor(() => expect(bridge.importFile).toHaveBeenCalledOnce());
    const second = store.getState().importMedia(new File(["same"], "broken.wav", { lastModified: 1234 }));
    failing.resolve({ success: false, error: "Unsupported audio fixture" });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ success: false, error: { message: "Unsupported audio fixture" } });
    expect(secondResult).toEqual(firstResult);
    expect(store.getState().project.mediaLibrary.items).toHaveLength(0);
  });

  it("persists replacement media and retains edits made while relinking", async () => {
    const decoding = deferred<ReturnType<typeof decodedAudio>>();
    bridge.importFile.mockReturnValueOnce(decoding.promise);
    const initial = createEmptyProject("Relink");
    initial.mediaLibrary.items.push(originalMedia());
    const store = createMediaStore(initial);
    const file = new File(["replacement"], "relinked.wav");
    const replacing = store.getState().replaceMediaAsset("existing-media", file);
    store.setState({ project: { ...store.getState().project, name: "Renamed while relinking" } });
    decoding.resolve(decodedAudio());

    expect((await replacing).success).toBe(true);
    expect(store.getState().project.name).toBe("Renamed while relinking");
    expect(store.getState().project.mediaLibrary.items[0]).toMatchObject({
      name: "relinked.wav",
      blob: file,
      isPlaceholder: false,
    });
    expect(saveMediaBlob).toHaveBeenCalledWith(
      initial.id,
      "existing-media",
      file,
      expect.objectContaining({ fileSize: file.size }),
    );
  });

  it("updates the opaque canonical identity when a desktop original is relinked", async () => {
    const identity = { identity: "relinked-canonical-id", size: 8, mtimeMs: 4321 };
    Object.assign(window, { licketysplit: { platform: "desktop", lickety: { identifyOriginalFile: vi.fn(async () => identity) } } });
    bridge.importFile.mockResolvedValue(decodedAudio());
    const initial = createEmptyProject("Native relink identity");
    initial.mediaLibrary.items.push(originalMedia());
    const store = createMediaStore(initial);
    const file = new File(["replacement"], "relinked.wav", { lastModified: 4321 });

    expect((await store.getState().replaceMediaAsset("existing-media", file)).success).toBe(true);
    expect(store.getState().project.mediaLibrary.items[0].sourceFile?.identity).toEqual({ id: identity.identity, size: identity.size, mtimeMs: identity.mtimeMs });
  });

  it("does not resurrect media removed while a replacement decodes", async () => {
    const decoding = deferred<ReturnType<typeof decodedAudio>>();
    bridge.importFile.mockReturnValueOnce(decoding.promise);
    const initial = createEmptyProject("Relink");
    initial.mediaLibrary.items.push(originalMedia());
    const store = createMediaStore(initial);
    const replacing = store.getState().replaceMediaAsset(
      "existing-media",
      new File(["replacement"], "relinked.wav"),
    );
    store.setState({ project: { ...initial, mediaLibrary: { items: [] } } });
    decoding.resolve(decodedAudio());

    expect((await replacing).success).toBe(false);
    expect(store.getState().project.mediaLibrary.items).toEqual([]);
    expect(saveMediaBlob).not.toHaveBeenCalled();
  });

  it("keeps the most recently requested replacement when decoding completes out of order", async () => {
    const older = deferred<ReturnType<typeof decodedAudio>>();
    const newer = deferred<ReturnType<typeof decodedAudio>>();
    bridge.importFile
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const initial = createEmptyProject("Relink");
    initial.mediaLibrary.items.push(originalMedia());
    const store = createMediaStore(initial);
    const replacingOlder = store.getState().replaceMediaAsset(
      "existing-media", new File(["older"], "older.wav"),
    );
    const replacingNewer = store.getState().replaceMediaAsset(
      "existing-media", new File(["newer"], "newer.wav"),
    );
    newer.resolve(decodedAudio());
    expect((await replacingNewer).success).toBe(true);
    older.resolve(decodedAudio());
    expect((await replacingOlder).success).toBe(false);

    expect(store.getState().project.mediaLibrary.items[0].name).toBe("newer.wav");
    expect(saveMediaBlob).toHaveBeenCalledOnce();
  });

  it("warns when media is usable but cannot survive a reload", async () => {
    bridge.importFile.mockResolvedValueOnce(decodedAudio());
    saveMediaBlob.mockRejectedValueOnce(new Error("Storage quota exceeded"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createMediaStore();

    const result = await store.getState().importMedia(new File(["a"], "clip.wav"));

    expect(result.success).toBe(true);
    expect(store.getState().project.mediaLibrary.items).toHaveLength(1);
    expect(warning).toHaveBeenCalledWith(
      "Media could not be saved in browser storage",
      expect.stringContaining("clip.wav"),
    );
    consoleError.mockRestore();
  });
});
it('desktop publishes basic media without waiting for thumbnail decoding',async()=>{Object.assign(window,{licketysplit:{platform:'desktop'}});bridge.importFile.mockResolvedValue({success:true,media:{...decodedAudio().media,blob:new Blob(['video']),metadata:{...decodedAudio().media.metadata,hasVideo:true,hasAudio:true,width:3840,height:2160}}});bridge.generateThumbnailsForMedia.mockImplementationOnce(()=>new Promise(()=>{}));const store=createMediaStore();const importing=store.getState().importMedia(new File(['x'],'camera.mov',{type:'video/quicktime'}));const result=await Promise.race([importing,new Promise(resolve=>setTimeout(()=>resolve('blocked by thumbnails'),100))]);expect(result).toMatchObject({success:true});expect(store.getState().project.mediaLibrary.items).toHaveLength(1);expect(bridge.importFile).toHaveBeenCalledWith(expect.any(File),true,true);delete window.licketysplit;});
it('native relink preserves edits made while its reference is being persisted',async()=>{saveMediaBlob.mockClear();Object.assign(window,{licketysplit:{platform:'desktop'}});bridge.importFile.mockResolvedValue(decodedAudio());const persisted=deferred<void>();saveMediaBlob.mockReturnValueOnce(persisted.promise);const initial=createEmptyProject('Relink source');initial.mediaLibrary.items.push(originalMedia());const store=createMediaStore(initial);const replacing=store.getState().replaceMediaAsset('existing-media',new File(['new'],'new.wav'));await vi.waitFor(()=>expect(saveMediaBlob).toHaveBeenCalled());store.setState({project:{...store.getState().project,name:'Latest edit',timeline:{...store.getState().project.timeline,markers:[{id:'user',time:1,label:'Keep',color:'#fff'}]}}});persisted.resolve();await replacing;expect(store.getState().project.name).toBe('Latest edit');expect(store.getState().project.timeline.markers[0].id).toBe('user');delete window.licketysplit;});
