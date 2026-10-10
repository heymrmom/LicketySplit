import {useTimelineStore} from "./timeline-store";
import {useUIStore} from "./ui-store";
import {getMediaBridge} from "../bridges/media-bridge";
import {bindNativeMediaSources} from "@licketysplit/core";
import {desktopMediaAvailable,registerDesktopMedia,resolveDesktopMedia} from "../services/lickety/desktop-media";
import { useStore } from "zustand";
import { FFmpegFallback, MediaImportService, getMediaEngine } from "@licketysplit/core";
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

const forcedNativeProxy=new WeakSet<object>();
const nativePrepared=new WeakMap<object, {item:import("@licketysplit/core").MediaItem; ready:boolean;cancelled?:boolean}>();
const nativeResolve=previewProxyCache.resolve.bind(previewProxyCache);
previewProxyCache.resolve=(projectId,item,purpose="preview")=>{if(purpose==="export"||!desktopMediaAvailable()||item.type!=="video")return nativeResolve(projectId,item,purpose);const prepared=nativePrepared.get(item);return prepared?.ready?prepared.item:{...item,blob:null};};
const sync = () => {
  const {project,hasOpenProject}=useProjectStore.getState();
  const native=desktopMediaAvailable();
  previewProxyCache.syncProject(hasOpenProject?(native?{...project,mediaLibrary:{...project.mediaLibrary,items:project.mediaLibrary.items.map(item=>({...item,isPlaceholder:false}))}}:project):null);
  if(!hasOpenProject||!native)return;
  const time=useTimelineStore.getState().playheadPosition;
  const requested=new Set(useUIStore.getState().selectedItems.map(selection=>selection.id));
  for(const track of project.timeline.tracks)if(!track.hidden)for(const clip of track.clips)if(clip.startTime<=time+.2&&clip.startTime+clip.duration>time)requested.add(clip.mediaId);
  for(const item of project.mediaLibrary.items){
    if(item.type!=='video'||(!requested.has(item.id)&&!forcedNativeProxy.has(item))||nativePrepared.has(item))continue;
    const runtime:{item:import('@licketysplit/core').MediaItem;ready:boolean;cancelled?:boolean}={item,ready:false};nativePrepared.set(item,runtime);
    previewProxyCache.store.setState(state=>({entries:{...state.entries,[item.id]:{source:item,preset:'low',status:'encoding',progress:0,enabled:true,createdAt:Date.now()}}}));
    void (async()=>{
      const bridge=window.licketysplit!.lickety!;const profile=await bridge.resourceProfile();const needsProxy=forcedNativeProxy.has(item)||item.metadata.canDecodeVideo===false||(profile.lowMemory&&(Math.max(item.metadata.width,item.metadata.height)>960||Math.min(item.metadata.width,item.metadata.height)>540));
      let original=await bridge.originalUri?.(item.id);const blob=item.blob??new Blob([]);let preview=original;
      if(needsProxy||!original){const asset=await registerDesktopMedia(item);runtime.item={...item,blob,nativeSource:asset,isPlaceholder:false};original=await resolveDesktopMedia(runtime.item,'export');preview=await resolveDesktopMedia(runtime.item,'preview',needsProxy);}
      else runtime.item={...item,blob,isPlaceholder:false};
      if(runtime.cancelled)return;bindNativeMediaSources(blob,Promise.resolve(original!),Promise.resolve(preview!));runtime.ready=true;
      previewProxyCache.store.setState(state=>({revision:state.revision+1,entries:{...state.entries,[item.id]:{...state.entries[item.id],status:'ready',progress:100,enabled:needsProxy}}}));
      try{if(!item.thumbnailUrl){const thumbs=await getMediaBridge().generateThumbnailsForMedia(blob,'video');const current=useProjectStore.getState().project;const currentItem=current.mediaLibrary.items.find(m=>m.id===item.id);if(thumbs.length&&current.id===project.id&&currentItem?.blob===item.blob)useProjectStore.setState({project:{...current,mediaLibrary:{...current.mediaLibrary,items:current.mediaLibrary.items.map(m=>m.id===item.id?{...m,thumbnailUrl:thumbs[0].dataUrl,filmstripThumbnails:thumbs.map(t=>({timestamp:t.timestamp,url:t.dataUrl}))}:m)}}});}}catch{/* Optional thumbnails never invalidate prepared playback. */}
    })().catch(error=>{if(runtime.cancelled)return;previewProxyCache.store.setState(state=>({revision:state.revision+1,entries:{...state.entries,[item.id]:{...state.entries[item.id],status:'error',error:`${error.message}. Relink or retry media preparation.`}}}));});
  }
};
const nativeRequest=previewProxyCache.request.bind(previewProxyCache);
const nativeRemove=previewProxyCache.remove.bind(previewProxyCache);
previewProxyCache.request=(item,preset)=>{if(!desktopMediaAvailable())return nativeRequest(item,preset);forcedNativeProxy.add(item);nativePrepared.delete(item);sync();};
previewProxyCache.remove=id=>{if(desktopMediaAvailable()){const item=useProjectStore.getState().getMediaItem(id);const runtime=item&&nativePrepared.get(item);if(runtime){runtime.cancelled=true;runtime.ready=false;const assetId=runtime.item.nativeSource?.identity.assetId;if(assetId)void window.licketysplit?.lickety?.cancelMedia(assetId);}}nativeRemove(id);};
sync();
const unsubscribeTimeline=useTimelineStore.subscribe((state,previous)=>{if(state.playheadPosition!==previous.playheadPosition)sync();});
const unsubscribeSelection=useUIStore.subscribe((state,previous)=>{if(state.selectedItems!==previous.selectedItems)sync();});
const unsubscribe = useProjectStore.subscribe((state, previous) => {
  if (state.project !== previous.project || state.hasOpenProject !== previous.hasOpenProject) sync();
});
if (import.meta.hot) import.meta.hot.dispose(() => {
  unsubscribe();unsubscribeTimeline();unsubscribeSelection();
  previewProxyCache.syncProject(null);
});

export const usePreviewProxyStore = <T,>(selector: (state: PreviewProxyState) => T): T => useStore(previewProxyCache.store, selector);
