import "../test/install-local-storage-mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaImportService, getMediaEngine, type MediaItem } from "@licketysplit/core";
import { createEmptyProject } from "./project/project-helpers";
import { useProjectStore } from "./project-store";
import { previewProxyCache } from "./preview-proxy-store";

afterEach(() => {
  useProjectStore.setState({ hasOpenProject: false, project: createEmptyProject("Reset") });
  vi.restoreAllMocks();
});

describe("project/export proxy isolation", () => {
  it("passes original library blobs through getFullProject for export and clears session proxies on relink/close", async () => {
    const original = new Blob(["original-source"]);
    const proxy = new Blob(["proxy"]);
    const item: MediaItem = {
      id: "source", name: "Source.mp4", type: "video", blob: original, fileHandle: null, waveformData: null, thumbnailUrl: null,
      metadata: { width: 1920, height: 1080, duration: 2, frameRate: 30, codec: "avc", sampleRate: 48000, channels: 2, fileSize: original.size },
    };
    const project = createEmptyProject("Proxy export");
    const loaded = { ...project, mediaLibrary: { ...project.mediaLibrary, items: [item] } };
    vi.spyOn(MediaImportService.prototype, "initialize").mockResolvedValue();
    vi.spyOn(MediaImportService.prototype, "generateProxyWithPreset").mockResolvedValue(proxy);
    vi.spyOn(getMediaEngine(), "extractMetadata").mockResolvedValue({ ...item.metadata, hasVideo: true, hasAudio: true, canDecode: true, canDecodeVideo: true, rotation: 0, mimeType: "video/mp4", width: 1280, height: 720 });
    useProjectStore.setState({ hasOpenProject: true, project: loaded });
    previewProxyCache.request(item, "medium");
    await vi.waitFor(() => expect(previewProxyCache.store.getState().entries[item.id]?.status).toBe("ready"));
    expect(previewProxyCache.resolve(loaded.id, useProjectStore.getState().getMediaItem(item.id)!).blob).toBe(proxy);
    expect(useProjectStore.getState().getFullProject().mediaLibrary.items[0].blob).toBe(original);
    expect(useProjectStore.getState().getMediaItem(item.id)?.blob).toBe(original);
    // This is the same path as double-clicking a library thumbnail. Both the
    // new track and its clip must retain the existing proxy/source identity.
    const added = await useProjectStore.getState().addClipToNewTrack(item.id, 0);
    expect(added.success).toBe(true);
    expect(previewProxyCache.store.getState().entries[item.id]?.status).toBe("ready");
    expect(previewProxyCache.resolve(loaded.id, useProjectStore.getState().getMediaItem(item.id)!).blob).toBe(proxy);
    expect(useProjectStore.getState().getFullProject().mediaLibrary.items[0].blob).toBe(original);
    const track = useProjectStore.getState().project.timeline.tracks.find((track) => track.clips.length > 0)!;
    const duplicated = await useProjectStore.getState().duplicateTrack(track.id);
    expect(duplicated.success).toBe(true);
    const placed = await useProjectStore.getState().placeMediaClip(item.id, track.id, 2);
    expect(placed.success).toBe(true);
    const duplicate = await useProjectStore.getState().duplicateClip(track.clips[0].id);
    expect(duplicate.success).toBe(true);
    await useProjectStore.getState().undo();
    await useProjectStore.getState().redo();
    expect(previewProxyCache.resolve(loaded.id, useProjectStore.getState().getMediaItem(item.id)!).blob).toBe(proxy);
    // Identical names/metadata do not make a relinked Blob the same source.
    const replacement = { ...item, blob: new Blob(["relinked"]) };
    useProjectStore.setState({ project: { ...loaded, mediaLibrary: { ...loaded.mediaLibrary, items: [replacement] } } });
    expect(previewProxyCache.store.getState().entries[item.id]).toBeUndefined();
    expect(previewProxyCache.resolve(loaded.id, replacement)).toBe(replacement);
    useProjectStore.setState({ hasOpenProject: false });
    expect(previewProxyCache.store.getState().projectId).toBeNull();
  });
});
it('desktop defers unused library identities until a current or selected clip needs preparation',async()=>{const {makeWorkflowFixture}=await import('@licketysplit/core/lickety/test-fixtures');const {useUIStore}=await import('./ui-store');const fixture=makeWorkflowFixture();const findAsset=vi.fn(async(mediaId:string)=>({identity:{assetId:mediaId,mediaId,sha256:'sha',byteLength:1},originalUri:`licketysplit-media://${mediaId}/original`,durationMs:20000}));Object.assign(window,{licketysplit:{platform:'desktop',lickety:{findAsset,originalUri:async(mediaId:string)=>`licketysplit-media://${mediaId}/original`,resourceProfile:async()=>({lowMemory:true}),resolve:async(id:string)=>`licketysplit-media://${id}/original`,ensureProxy:async(id:string)=>({assetId:id,sourceSha256:'sha',proxyUri:`licketysplit-media://${id}/proxy`,version:1,width:960,height:540,sourceStartPTS:0,proxyStartPTS:0,durationMs:20000})}}});useUIStore.setState({selectedItems:[]});useProjectStore.setState({hasOpenProject:true,project:{...fixture,timeline:{...fixture.timeline,tracks:[]}}});await new Promise(resolve=>setTimeout(resolve,20));expect(findAsset).not.toHaveBeenCalled();useUIStore.setState({selectedItems:[{type:'clip',id:'cam-b'}]});await vi.waitFor(()=>expect(findAsset).toHaveBeenCalledWith('cam-b'));expect(findAsset).not.toHaveBeenCalledWith('cam-a');await vi.waitFor(()=>expect(previewProxyCache.store.getState().entries['cam-b']?.status).toBe('ready'));delete window.licketysplit;useUIStore.setState({selectedItems:[]});});
