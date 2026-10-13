import {useTimelineStore} from "./timeline-store";
import {useUIStore} from "./ui-store";
import {getMediaBridge} from "../bridges/media-bridge";
import {bindNativeMediaSources} from "@licketysplit/core";
import {desktopMediaAvailable,registerDesktopMedia,resolveDesktopMedia,resolveDesktopOriginalPreview} from "../services/lickety/desktop-media";
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
type NativePreparation={item:import("@licketysplit/core").MediaItem;ready:boolean;published?:boolean;originalUri?:string;previewUri?:string;boundPreviewUri?:string;originalAvailable?:boolean;cancelled?:boolean;requestId:string};
const nativePrepared=new WeakMap<object, NativePreparation>();
const nativeOriginalFailureAttempted=new WeakSet<object>();
let activeNativePreparation:{projectId:string;source:import("@licketysplit/core").MediaItem;runtime:NativePreparation}|null=null;
const activeNativeForeground=new Map<string,{projectId:string;source:import("@licketysplit/core").MediaItem;runtime:NativePreparation}>();
let nativePlannerRunning=false;
let nativePlannerRequested=false;
type NativeBackgroundTask={key?:string;request:()=>Promise<unknown>;resolve:(value:unknown)=>void;reject:(reason:unknown)=>void};
const nativeBackgroundQueue:NativeBackgroundTask[]=[];
let nativeBackgroundRunning=false;
export function cancelNativeMediaBackground(key:string):void{for(let index=nativeBackgroundQueue.length-1;index>=0;index-=1)if(nativeBackgroundQueue[index]?.key===key){nativeBackgroundQueue.splice(index,1)[0]?.resolve(undefined);}}
export function runNativeMediaBackground<T>(request:()=>Promise<T>,key?:string):Promise<T>{return new Promise<T>((resolve,reject)=>{if(key){for(let index=nativeBackgroundQueue.length-1;index>=0;index-=1)if(nativeBackgroundQueue[index]?.key===key)nativeBackgroundQueue.splice(index,1)[0]?.resolve(undefined);}nativeBackgroundQueue.push({key,request,resolve:resolve as (value:unknown)=>void,reject});void pumpNativeBackgroundQueue();});}
async function pumpNativeBackgroundQueue():Promise<void>{if(nativeBackgroundRunning)return;nativeBackgroundRunning=true;try{while(nativeBackgroundQueue.length){const task=nativeBackgroundQueue.shift()!;try{task.resolve(await task.request());}catch(error){task.reject(error);}}}finally{nativeBackgroundRunning=false;if(nativeBackgroundQueue.length)void pumpNativeBackgroundQueue();}}
const nativeResolve=previewProxyCache.resolve.bind(previewProxyCache);
previewProxyCache.resolve=(projectId,item,purpose="preview")=>{if(purpose==="export"||!desktopMediaAvailable()||item.type!=="video")return nativeResolve(projectId,item,purpose);const prepared=nativePrepared.get(item);return (prepared?.originalAvailable||prepared?.ready&&prepared.published)&&!prepared.cancelled&&isCurrentNativePreparation(projectId,item,prepared!)?prepared!.item:{...item,blob:null};};
const sameNativeSource=(a:import("@licketysplit/core").MediaItem,b:import("@licketysplit/core").MediaItem)=>a.nativeSource?.identity.assetId&&b.nativeSource?.identity.assetId?a.nativeSource.identity.assetId===b.nativeSource.identity.assetId:a.blob===b.blob&&a.fileHandle===b.fileHandle&&a.originalUrl===b.originalUrl&&!b.isPlaceholder;
const isCurrentNativePreparation=(projectId:string,item:import("@licketysplit/core").MediaItem,runtime:NativePreparation)=>{
  const current=useProjectStore.getState();
  const currentItem=current.getMediaItem(item.id);
  return !runtime.cancelled&&current.hasOpenProject&&current.project.id===projectId&&!!currentItem&&sameNativeSource(item,currentItem);
};
const selectedNativeMediaIds=(project:import("@licketysplit/core").Project):string[]=>{
  const clips=new Map(project.timeline.tracks.flatMap(track=>track.clips).map(clip=>[clip.id,clip.mediaId]));
  const libraryIds=new Set(project.mediaLibrary.items.map(item=>item.id));
  return useUIStore.getState().selectedItems.map(selection=>libraryIds.has(selection.id)?selection.id:clips.get(selection.id)).filter((id):id is string=>Boolean(id));
};
const requestedNativeMedia=(project:import("@licketysplit/core").Project):Set<string>=>{
  const requested=new Set(selectedNativeMediaIds(project));
  const time=useTimelineStore.getState().playheadPosition;
  for(const track of project.timeline.tracks)if(!track.hidden)for(const clip of track.clips)if(clip.startTime<=time+.2&&clip.startTime+clip.duration>time)requested.add(clip.mediaId);
  return requested;
};
const foregroundNativeVideo=(project:import("@licketysplit/core").Project):import("@licketysplit/core").MediaItem|undefined=>{
  const byId=new Map(project.mediaLibrary.items.map(item=>[item.id,item]));
  const selected=selectedNativeMediaIds(project).map(id=>byId.get(id)).filter((item):item is import("@licketysplit/core").MediaItem=>Boolean(item?.type==='video'&&!item.isPlaceholder&&!item.isPending));
  if(selected.length)return selected.at(-1);
  const time=useTimelineStore.getState().playheadPosition;
  for(const track of project.timeline.tracks)if(!track.hidden)for(const clip of [...track.clips].sort((a,b)=>a.startTime-b.startTime))if(clip.startTime<=time+.2&&clip.startTime+clip.duration>time){const item=byId.get(clip.mediaId);if(item?.type==='video'&&!item.isPlaceholder&&!item.isPending)return item;}
  return undefined;
};
const orderedNativeVideoItems=(project:import("@licketysplit/core").Project)=>{
  const timelineOrder:string[]=[];
  for(const track of project.timeline.tracks)if(!track.hidden)for(const clip of [...track.clips].sort((a,b)=>a.startTime-b.startTime))if(!timelineOrder.includes(clip.mediaId))timelineOrder.push(clip.mediaId);
  const selectedOrder=selectedNativeMediaIds(project);
  const rank=(id:string)=>{const selected=selectedOrder.lastIndexOf(id);if(selected>=0)return selectedOrder.length-selected;const timeline=timelineOrder.indexOf(id);return timeline<0?Number.MAX_SAFE_INTEGER:timeline+selectedOrder.length+1;};
  return project.mediaLibrary.items.filter(item=>item.type==='video'&&!item.isPlaceholder&&!item.isPending).sort((a,b)=>rank(a.id)-rank(b.id)||project.mediaLibrary.items.indexOf(a)-project.mediaLibrary.items.indexOf(b));
};
const retireNativePreparation=(runtime:NativePreparation)=>{
  runtime.cancelled=true;runtime.ready=false;
  const cancel=window.licketysplit?.lickety?.cancelMedia;
  if(cancel)void cancel(runtime.requestId).catch(()=>undefined);
};
const prepareNativeVideo=async(projectId:string,item:import("@licketysplit/core").MediaItem,runtime:NativePreparation,needsProxy:boolean,priority:'foreground'|'background'='background')=>{
  const bridge=window.licketysplit?.lickety;if(!bridge||!isCurrentNativePreparation(projectId,item,runtime))return;
  const originalFromRegistry=await resolveDesktopOriginalPreview(item);
  if(!isCurrentNativePreparation(projectId,item,runtime))return;
  let original=originalFromRegistry;let preview=original;
  const blob=item.blob??new Blob([]);
  const canOfferOriginal=(item.metadata.canDecodeVideo??item.metadata.canDecode)===true&&!nativeOriginalFailureAttempted.has(item);
  runtime.item={...item,blob,isPlaceholder:false};runtime.originalUri=original;runtime.previewUri=original;
  if(canOfferOriginal){const newlyAvailable=!runtime.originalAvailable;runtime.boundPreviewUri=original;runtime.originalAvailable=true;bindNativeMediaSources(blob,Promise.resolve(original),Promise.resolve(original));previewProxyCache.store.setState(state=>({revision:state.revision+Number(newlyAvailable),entries:{...state.entries,[item.id]:{...state.entries[item.id],originalAvailable:true}}}));}
  if(needsProxy){
    const asset=await registerDesktopMedia(item);
    if(!isCurrentNativePreparation(projectId,item,runtime))return;
    runtime.item={...item,blob,nativeSource:asset,isPlaceholder:false};
    preview=needsProxy?await resolveDesktopMedia(runtime.item,'preview',true,{requestId:runtime.requestId,priority}):original;
  }
  if(!isCurrentNativePreparation(projectId,item,runtime))return;
  runtime.originalUri=original;runtime.previewUri=preview;runtime.ready=true;
  if(useTimelineStore.getState().playbackState!=="playing"){bindNativeMediaSources(blob,Promise.resolve(original!),Promise.resolve(preview!));runtime.boundPreviewUri=preview;}
  const cached=nativePrepared.get(item);if(!cached||cached.cancelled||cached===runtime)nativePrepared.set(item,runtime);
  const publish=useTimelineStore.getState().playbackState!=="playing";runtime.published=publish;
  previewProxyCache.store.setState(state=>({revision:state.revision+Number(publish),entries:{...state.entries,[item.id]:{...state.entries[item.id],status:'ready',progress:0,enabled:needsProxy,originalAvailable:runtime.originalAvailable}}}));
};
export function publishNativePreviewAtBoundary(projectId:string,item:import("@licketysplit/core").MediaItem):boolean{if(useTimelineStore.getState().playbackState==="playing")return false;const current=useProjectStore.getState();const runtime=nativePrepared.get(item);if(!runtime?.ready||runtime.cancelled||runtime.published||!current.hasOpenProject||current.project.id!==projectId||!isCurrentNativePreparation(projectId,item,runtime))return false;if(runtime.item.blob&&runtime.originalUri&&runtime.previewUri){bindNativeMediaSources(runtime.item.blob,Promise.resolve(runtime.originalUri),Promise.resolve(runtime.previewUri));runtime.boundPreviewUri=runtime.previewUri;}runtime.published=true;previewProxyCache.store.setState(state=>({revision:state.revision+1}));return true;}
export function getReadyNativePreviewUri(projectId:string,item:import("@licketysplit/core").MediaItem):string|undefined{const runtime=nativePrepared.get(item);return runtime?.ready&&runtime.published&&!runtime.cancelled&&isCurrentNativePreparation(projectId,item,runtime)?runtime.previewUri:undefined;}
export function handleNativeOriginalPreviewFailure(projectId:string,item:import("@licketysplit/core").MediaItem,failedUri:string):'fallback-started'|'already-attempted'|'stale'{const current=useProjectStore.getState();const currentItem=current.getMediaItem(item.id);const runtime=nativePrepared.get(item)??(currentItem&&nativePrepared.get(currentItem));if(!currentItem||!runtime?.originalAvailable||runtime.cancelled||!current.hasOpenProject||current.project.id!==projectId||!sameNativeSource(item,currentItem)||!isCurrentNativePreparation(projectId,currentItem,runtime)||runtime.originalUri!==failedUri||runtime.boundPreviewUri!==failedUri)return 'stale';if(nativeOriginalFailureAttempted.has(currentItem))return 'already-attempted';nativeOriginalFailureAttempted.add(currentItem);forcedNativeProxy.add(currentItem);previewProxyCache.request(currentItem,'low');return 'fallback-started';}
const generateNativeThumbnails=async(projectId:string,item:import("@licketysplit/core").MediaItem,runtime:NativePreparation)=>{
  if(item.thumbnailUrl)return;
  try{
    const blob=item.blob??new Blob([]);const thumbs=await getMediaBridge().generateThumbnailsForMedia(blob,"video");
    const latest=useProjectStore.getState();
    if(thumbs.length&&isCurrentNativePreparation(projectId,item,runtime)&&latest.hasOpenProject){
      const items=latest.project.mediaLibrary.items.map(mediaItem=>mediaItem===item?{...mediaItem,thumbnailUrl:thumbs[0].dataUrl,filmstripThumbnails:thumbs.map(thumb=>({timestamp:thumb.timestamp,url:thumb.dataUrl}))}:mediaItem);
      const thumbnailItem=items.find(mediaItem=>mediaItem.id===item.id)!;nativePrepared.set(thumbnailItem,runtime);if(forcedNativeProxy.has(item))forcedNativeProxy.add(thumbnailItem);
      useProjectStore.setState({project:{...latest.project,mediaLibrary:{...latest.project.mediaLibrary,items}}});
    }
  }catch{/* Optional thumbnails never invalidate prepared playback. */}
};
const prepareNativeForeground=(projectId:string,item:import("@licketysplit/core").MediaItem)=>{
  const existing=activeNativeForeground.get(item.id);
  const cached=nativePrepared.get(item);
  if(existing?.source===item||cached?.ready&&!cached.cancelled)return;
  if(cached?.cancelled)nativePrepared.delete(item);
  if(existing){retireNativePreparation(existing.runtime);activeNativeForeground.delete(item.id);}
  const runtime:NativePreparation={item,ready:false,requestId:crypto.randomUUID()};nativePrepared.set(item,runtime);activeNativeForeground.set(item.id,{projectId,source:item,runtime});
  const entry=previewProxyCache.store.getState().entries[item.id];
  previewProxyCache.store.setState(state=>({entries:{...state.entries,[item.id]:{source:item,preset:entry?.preset??'low',status:'encoding',progress:0,enabled:true,createdAt:Date.now()}}}));
  void (async()=>{
    const bridge=window.licketysplit?.lickety;if(!bridge)return;
    const profile=await bridge.resourceProfile();if(!isCurrentNativePreparation(projectId,item,runtime))return;
    const needsProxy=forcedNativeProxy.has(item)||item.metadata.canDecodeVideo===false||(profile.lowMemory&&(Math.max(item.metadata.width,item.metadata.height)>960||Math.min(item.metadata.width,item.metadata.height)>540));
    await prepareNativeVideo(projectId,item,runtime,needsProxy,'foreground');
    if(isCurrentNativePreparation(projectId,item,runtime))await generateNativeThumbnails(projectId,item,runtime);
  })().catch(error=>{if(isCurrentNativePreparation(projectId,item,runtime))previewProxyCache.store.setState(state=>({entries:{...state.entries,[item.id]:{...state.entries[item.id],status:'error',error:`${error instanceof Error?error.message:String(error)}. Relink or retry media preparation.`}}}));}).finally(()=>{if(activeNativeForeground.get(item.id)?.runtime===runtime)activeNativeForeground.delete(item.id);});
};
const pumpNativePlanner=async()=>{
  if(nativePlannerRunning){nativePlannerRequested=true;return;}
  nativePlannerRunning=true;
  try{
    while(true){
      const {project,hasOpenProject}=useProjectStore.getState();
      const bridge=window.licketysplit?.lickety;
      if(!hasOpenProject||!bridge||!desktopMediaAvailable())break;
      if(activeNativePreparation&&!isCurrentNativePreparation(activeNativePreparation.projectId,activeNativePreparation.source,activeNativePreparation.runtime)){retireNativePreparation(activeNativePreparation.runtime);activeNativePreparation=null;}
      let profile:Awaited<ReturnType<typeof bridge.resourceProfile>>;try{profile=await bridge.resourceProfile();}catch{const latest=useProjectStore.getState();if(latest.hasOpenProject&&latest.project.id===project.id){for(const candidate of orderedNativeVideoItems(project)){const entry=previewProxyCache.store.getState().entries[candidate.id];if(entry?.status==='queued')previewProxyCache.store.setState(state=>({entries:{...state.entries,[candidate.id]:{...state.entries[candidate.id],status:'error',error:'Could not read the desktop resource profile. Retry preview preparation.'}}}));}}break;}
      const current=useProjectStore.getState();if(!current.hasOpenProject||current.project.id!==project.id)continue;
      const requested=requestedNativeMedia(project);
      const foreground=foregroundNativeVideo(project);
      const items=orderedNativeVideoItems(project).filter(candidate=>candidate!==foreground&&(forcedNativeProxy.has(candidate)||candidate.metadata.canDecodeVideo===false||(profile.lowMemory&&(Math.max(candidate.metadata.width,candidate.metadata.height)>960||Math.min(candidate.metadata.width,candidate.metadata.height)>540))));
      for(const pending of items){const entry=previewProxyCache.store.getState().entries[pending.id];if(!entry)previewProxyCache.store.setState(state=>({entries:{...state.entries,[pending.id]:{source:pending,preset:'low',status:'queued',progress:0,enabled:true,createdAt:Date.now()}}}));}
      const item=items.find(candidate=>!nativePrepared.get(candidate)&&previewProxyCache.store.getState().entries[candidate.id]?.status!=='error');
      if(!item)break;
      const needsProxy=forcedNativeProxy.has(item)||item.metadata.canDecodeVideo===false||(profile.lowMemory&&(Math.max(item.metadata.width,item.metadata.height)>960||Math.min(item.metadata.width,item.metadata.height)>540));
      const runtime:NativePreparation={item,ready:false,requestId:crypto.randomUUID()};nativePrepared.set(item,runtime);activeNativePreparation={projectId:project.id,source:item,runtime};
      const previous=previewProxyCache.store.getState().entries[item.id];
      previewProxyCache.store.setState(state=>({entries:{...state.entries,[item.id]:{source:item,preset:previous?.preset??'low',status:'encoding',progress:0,enabled:true,createdAt:Date.now()}}}));
      try{
        await runNativeMediaBackground(()=>prepareNativeVideo(project.id,item,runtime,needsProxy));
        if(isCurrentNativePreparation(project.id,item,runtime)&&!needsProxy)previewProxyCache.store.setState(state=>({entries:{...state.entries,[item.id]:{...state.entries[item.id],enabled:false}}}));
        if(isCurrentNativePreparation(project.id,item,runtime)&&requested.has(item.id))await generateNativeThumbnails(project.id,item,runtime);
      }catch(error){if(isCurrentNativePreparation(project.id,item,runtime))previewProxyCache.store.setState(state=>({revision:state.revision+1,entries:{...state.entries,[item.id]:{...state.entries[item.id],status:'error',error:`${error instanceof Error?error.message:String(error)}. Relink or retry media preparation.`}}}));}
      finally{if(activeNativePreparation?.runtime===runtime)activeNativePreparation=null;}
    }
  }finally{
    nativePlannerRunning=false;
    if(nativePlannerRequested){nativePlannerRequested=false;void pumpNativePlanner();}
  }
};
const sync = () => {
  const {project,hasOpenProject}=useProjectStore.getState();
  const native=desktopMediaAvailable();
  previewProxyCache.syncProject(hasOpenProject?(native?{...project,mediaLibrary:{...project.mediaLibrary,items:project.mediaLibrary.items.map(item=>({...item,isPlaceholder:false}))}}:project):null);
  if(!hasOpenProject||!native){if(activeNativePreparation){retireNativePreparation(activeNativePreparation.runtime);activeNativePreparation=null;}for(const request of activeNativeForeground.values())retireNativePreparation(request.runtime);activeNativeForeground.clear();return;}
  if(useTimelineStore.getState().playbackState!=="playing")for(const item of project.mediaLibrary.items)publishNativePreviewAtBoundary(project.id,item);
  if(activeNativePreparation&&(activeNativePreparation.projectId!==project.id||!project.mediaLibrary.items.some(item=>item.id===activeNativePreparation?.source.id&&sameNativeSource(item,activeNativePreparation.source)))){retireNativePreparation(activeNativePreparation.runtime);activeNativePreparation=null;}
  for(const [id,request] of activeNativeForeground){if(request.projectId!==project.id||!project.mediaLibrary.items.some(item=>item.id===id&&sameNativeSource(item,request.source))){retireNativePreparation(request.runtime);activeNativeForeground.delete(id);}}
  const requested=requestedNativeMedia(project);const foreground=foregroundNativeVideo(project);
  for(const [id,request] of activeNativeForeground){if(request.projectId!==project.id||!foreground||!sameNativeSource(request.source,foreground)){retireNativePreparation(request.runtime);activeNativeForeground.delete(id);}}
  if(foreground)prepareNativeForeground(project.id,foreground);
  for(const item of orderedNativeVideoItems(project)){if(item===foreground||!requested.has(item.id)&&!forcedNativeProxy.has(item)&&item.metadata.canDecodeVideo!==false)continue;const entry=previewProxyCache.store.getState().entries[item.id];if(!entry)previewProxyCache.store.setState(state=>({entries:{...state.entries,[item.id]:{source:item,preset:'low',status:'queued',progress:0,enabled:true,createdAt:Date.now()}}}));}
  void pumpNativePlanner();
};
const nativeRequest=previewProxyCache.request.bind(previewProxyCache);
const nativeRemove=previewProxyCache.remove.bind(previewProxyCache);
previewProxyCache.request=(item,preset)=>{
  if(!desktopMediaAvailable())return nativeRequest(item,preset);
  const project=useProjectStore.getState();if(!project.hasOpenProject||item.type!=='video')return;
  forcedNativeProxy.add(item);
  const runtime:NativePreparation={item,ready:false,requestId:crypto.randomUUID()};
  nativePrepared.set(item,runtime);activeNativeForeground.set(item.id,{projectId:project.project.id,source:item,runtime});
  previewProxyCache.store.setState(state=>({entries:{...state.entries,[item.id]:{source:item,preset,status:'encoding',progress:0,enabled:true,createdAt:Date.now()}}}));
  void prepareNativeVideo(project.project.id,item,runtime,true,'foreground').catch(error=>{if(isCurrentNativePreparation(project.project.id,item,runtime))previewProxyCache.store.setState(state=>({entries:{...state.entries,[item.id]:{...state.entries[item.id],status:'error',error:`${error instanceof Error?error.message:String(error)}. Relink or retry media preparation.`}}}));}).finally(()=>{if(activeNativeForeground.get(item.id)?.runtime===runtime)activeNativeForeground.delete(item.id);});
};
previewProxyCache.remove=id=>{if(desktopMediaAvailable()){const item=useProjectStore.getState().getMediaItem(id);const runtime=item&&nativePrepared.get(item);if(runtime){retireNativePreparation(runtime);nativePrepared.delete(item);if(activeNativePreparation?.runtime===runtime)activeNativePreparation=null;if(activeNativeForeground.get(id)?.runtime===runtime)activeNativeForeground.delete(id);}}nativeRemove(id);};
export const retryNativePreviewPreparation=async(mediaId:string):Promise<void>=>{
  if(!desktopMediaAvailable())return;
  const before=useProjectStore.getState();
  const item=before.getMediaItem(mediaId);
  if(!item||item.type!=="video")return;
  const runtime=nativePrepared.get(item);
  if(runtime){
    runtime.cancelled=true;
    runtime.ready=false;
    if(window.licketysplit?.lickety?.cancelMedia){
      try{
        await window.licketysplit.lickety.cancelMedia(runtime.requestId);
      }catch(error){
        const current=useProjectStore.getState();
        if(current.hasOpenProject&&current.project.id===before.project.id&&current.getMediaItem(mediaId)===item){
          previewProxyCache.store.setState(state=>({entries:{...state.entries,[mediaId]:{...state.entries[mediaId],status:"error",error:`Could not cancel the previous preview preparation: ${error instanceof Error?error.message:String(error)}`}}}));
        }
        return;
      }
    }
    const current=useProjectStore.getState();
    if(!current.hasOpenProject||current.project.id!==before.project.id||current.getMediaItem(mediaId)!==item)return;
    if(nativePrepared.get(item)===runtime)nativePrepared.delete(item);
    if(activeNativePreparation?.runtime===runtime)activeNativePreparation=null;
  }
  const current=useProjectStore.getState();
  if(!current.hasOpenProject||current.project.id!==before.project.id||current.getMediaItem(mediaId)!==item)return;
  sync();
};
sync();
const unsubscribeTimeline=useTimelineStore.subscribe((state,previous)=>{if(state.playheadPosition!==previous.playheadPosition||state.playbackState!==previous.playbackState)sync();});
const unsubscribeSelection=useUIStore.subscribe((state,previous)=>{if(state.selectedItems!==previous.selectedItems)sync();});
const unsubscribe = useProjectStore.subscribe((state, previous) => {
  if (state.project !== previous.project || state.hasOpenProject !== previous.hasOpenProject) sync();
});
if (import.meta.hot) import.meta.hot.dispose(() => {
  unsubscribe();unsubscribeTimeline();unsubscribeSelection();
  previewProxyCache.syncProject(null);
});

export const usePreviewProxyStore = <T,>(selector: (state: PreviewProxyState) => T): T => useStore(previewProxyCache.store, selector);
