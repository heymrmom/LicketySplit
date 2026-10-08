import {bindNativeMediaSources} from "@openreel/core";
import {desktopMediaAvailable,registerDesktopMedia,resolveDesktopMedia} from "../services/lickety/desktop-media";
import { useStore } from "zustand";
import { FFmpegFallback, MediaImportService, getMediaEngine } from "@openreel/core";
import { PreviewProxyCache, type PreviewProxyState } from "../services/preview-proxy-cache";
import { loadMediaRecord } from "../services/media-storage";
import { useProjectStore } from "./project-store";

// A dedicated fallback worker makes proxy cancellation safe during imports/exports.
export const previewProxyCache = new PreviewProxyCache({
  async loadOriginal(projectId, item) {
    if (item.blob) return item.blob;
    if (item.fileHandle) return item.fileHandle.getFile();
    const record = await loadMediaRecord(item.id);
    if (record?.projectId === projectId && record.blob) return record.blob;
    throw new Error("Relink the original media before creating a preview proxy.");
  },
  async inspect(blob) {
    const metadata = await getMediaEngine().extractMetadata(blob);
    if (!metadata.hasVideo || !(metadata.canDecodeVideo ?? metadata.canDecode)) throw new Error("This browser cannot play the generated proxy. Using the original.");
    return { width: metadata.width, height: metadata.height };
  },
  async generate(file, preset, onProgress, signal) {
    const fallback = new FFmpegFallback();
    const service = new MediaImportService(undefined, fallback);
    try {
      await service.initialize();
      return await service.generateProxyWithPreset(file, preset, (progress) => onProgress(progress.progress), signal);
    } finally {
      fallback.terminate();
    }
  },
});

const nativePrepared=new WeakMap<object, {item:import("@openreel/core").MediaItem; ready:boolean;cancelled?:boolean}>();
const nativeResolve=previewProxyCache.resolve.bind(previewProxyCache);
previewProxyCache.resolve=(projectId,item,purpose="preview")=>{if(purpose==="export"||!desktopMediaAvailable()||item.type!=="video")return nativeResolve(projectId,item,purpose);const prepared=nativePrepared.get(item);return prepared?.ready?prepared.item:{...item,blob:null};};
const sync = () => {
  const { project, hasOpenProject } = useProjectStore.getState();
  previewProxyCache.syncProject(hasOpenProject ? project : null);
  if(hasOpenProject&&desktopMediaAvailable())for(const item of project.mediaLibrary.items){
    if(item.type!=="video"||nativePrepared.has(item))continue;
    const runtime:{item:import("@openreel/core").MediaItem;ready:boolean;cancelled?:boolean}={item,ready:false};nativePrepared.set(item,runtime);
    previewProxyCache.store.setState(state=>({entries:{...state.entries,[item.id]:{source:item,preset:"low",status:"encoding",progress:0,enabled:true,createdAt:Date.now()}}}));
    void (async()=>{const asset=await registerDesktopMedia(item);const blob=item.blob??new Blob([]);runtime.item={...item,blob,nativeSource:asset,isPlaceholder:false};if(runtime.cancelled)return;
      const original=resolveDesktopMedia(runtime.item,"export");const preview=resolveDesktopMedia(runtime.item,"preview");bindNativeMediaSources(blob,original,preview);await preview;if(runtime.cancelled)return;runtime.ready=true;
      previewProxyCache.store.setState(state=>({revision:state.revision+1,entries:{...state.entries,[item.id]:{...state.entries[item.id],status:"ready",progress:100}}}));
    })().catch(error=>{previewProxyCache.store.setState(state=>({revision:state.revision+1,entries:{...state.entries,[item.id]:{...state.entries[item.id],status:"error",error:`${error.message}. Relink or retry media preparation.`}}}));});
  }
};
const nativeRequest=previewProxyCache.request.bind(previewProxyCache);
const nativeRemove=previewProxyCache.remove.bind(previewProxyCache);
previewProxyCache.request=(item,preset)=>{if(!desktopMediaAvailable())return nativeRequest(item,preset);nativePrepared.delete(item);sync();};
previewProxyCache.remove=id=>{if(desktopMediaAvailable()){const item=useProjectStore.getState().getMediaItem(id);const runtime=item&&nativePrepared.get(item);if(runtime){runtime.cancelled=true;runtime.ready=false;const assetId=runtime.item.nativeSource?.identity.assetId;if(assetId)void window.openreel?.lickety?.cancelMedia(assetId);}}nativeRemove(id);};
sync();
const unsubscribe = useProjectStore.subscribe((state, previous) => {
  if (state.project !== previous.project || state.hasOpenProject !== previous.hasOpenProject) sync();
});
if (import.meta.hot) import.meta.hot.dispose(() => {
  unsubscribe();
  previewProxyCache.syncProject(null);
});

export const usePreviewProxyStore = <T,>(selector: (state: PreviewProxyState) => T): T => useStore(previewProxyCache.store, selector);
