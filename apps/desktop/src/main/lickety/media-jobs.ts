import {promises as fs} from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
import type {ResourceProfile,ProxyReceipt} from '../../../../../packages/core/src/lickety/types';
import {ManagedAssetRegistry} from './asset-registry';
interface QueuedHeavyTask {work:()=>Promise<unknown>;signal:AbortSignal;priority:HeavyJobPriority;queuedAt:number;sequence:number;resolve:(value:unknown)=>void;reject:(error:unknown)=>void;abort:()=>void;promote:(priority:HeavyJobPriority)=>void;}
export class HeavyJobQueue {
 private pending:QueuedHeavyTask[]=[];
 private active=false;
 private sequence=0;
 private foregroundBurst=0;
 private readonly foregroundBurstLimit=3;
 private readonly agingMs=5_000;
 private bySignal=new Map<AbortSignal,Set<QueuedHeavyTask>>();
 run<T>(work:()=>Promise<T>,signal:AbortSignal,priority:HeavyJobPriority='normal'):Promise<T>{
  if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise<T>((resolve,reject)=>{
   const task:QueuedHeavyTask={work,signal,priority,queuedAt:Date.now(),sequence:this.sequence++,resolve:resolve as (value:unknown)=>void,reject,abort:()=>{},promote:()=>{}};
   task.promote=(nextPriority)=>{if(this.pending.includes(task)&&priorityRank(nextPriority)<priorityRank(task.priority))task.priority=nextPriority;};
   task.abort=()=>{const index=this.pending.indexOf(task);if(index<0)return;this.pending.splice(index,1);signal.removeEventListener('abort',task.abort);this.removePromotion(signal,task);reject(signal.reason);};
   let promotions=this.bySignal.get(signal);if(!promotions)this.bySignal.set(signal,promotions=new Set());promotions.add(task);
   signal.addEventListener('abort',task.abort,{once:true});this.pending.push(task);this.pump();
  });
 }
 promote(signal:AbortSignal,priority:HeavyJobPriority):boolean{const tasks=this.bySignal.get(signal);if(!tasks)return false;for(const task of tasks)task.promote(priority);return true;}
 private removePromotion(signal:AbortSignal,task:QueuedHeavyTask){const tasks=this.bySignal.get(signal);tasks?.delete(task);if(tasks?.size===0)this.bySignal.delete(signal);}
 private pump(){
  if(this.active||this.pending.length===0)return;
  const now=Date.now();
  const normal=this.pending.filter(task=>task.priority==='normal').sort((a,b)=>a.sequence-b.sequence)[0];
  const agedBackground=this.pending.filter(task=>task.priority==='background'&&now-task.queuedAt>=this.agingMs).sort((a,b)=>a.sequence-b.sequence)[0];
  const starvedBackground=this.pending.filter(task=>task.priority==='background'&&now-task.queuedAt>=this.agingMs*2).sort((a,b)=>a.sequence-b.sequence)[0];
  let next=this.pending.filter(task=>task.priority==='foreground').sort((a,b)=>a.sequence-b.sequence)[0];
  if(starvedBackground)next=starvedBackground;
  else if(this.foregroundBurst>=this.foregroundBurstLimit&&(normal||agedBackground))next=normal&&(!agedBackground||normal.sequence<agedBackground.sequence)?normal:agedBackground;
  else if(!next)next=normal??this.pending.filter(task=>task.priority==='background').sort((a,b)=>a.sequence-b.sequence)[0];
  if(!next)return;
  this.pending.splice(this.pending.indexOf(next),1);next.signal.removeEventListener('abort',next.abort);
  this.removePromotion(next.signal,next);
  if(next.priority==='foreground')this.foregroundBurst++;else this.foregroundBurst=0;
  this.active=true;
  void (async()=>{try{next.signal.throwIfAborted();next.resolve(await next.work());}catch(error){next.reject(error);}finally{this.active=false;this.pump();}})();
 }
}
export type HeavyJobPriority='foreground'|'normal'|'background';
function priorityRank(priority:HeavyJobPriority){return priority==='foreground'?0:priority==='normal'?1:2;}
export class MediaRequestControllers {
 private byRequest=new Map<string,Set<AbortController>>();
 private byAsset=new Map<string,Set<AbortController>>();
 register(controller:AbortController,requestId?:string,assetId?:string){
  if(requestId)this.add(this.byRequest,requestId,controller);
  if(assetId)this.add(this.byAsset,assetId,controller);
 }
 remove(controller:AbortController,requestId?:string,assetId?:string){
  if(requestId)this.delete(this.byRequest,requestId,controller);
  if(assetId)this.delete(this.byAsset,assetId,controller);
 }
 cancel(identifier:string){
  const controllers=this.byRequest.get(identifier)??this.byAsset.get(identifier);
  for(const controller of controllers??[])controller.abort(new Error('Media preparation cancelled'));
 }
 private add(map:Map<string,Set<AbortController>>,key:string,controller:AbortController){let set=map.get(key);if(!set)map.set(key,set=new Set());set.add(controller);}
 private delete(map:Map<string,Set<AbortController>>,key:string,controller:AbortController){const set=map.get(key);if(!set)return;set.delete(controller);if(set.size===0)map.delete(key);}
}
export const heavyQueue = new HeavyJobQueue();
export function proxyDimensions(width:number,height:number){if(!(width>0&&height>0))throw new Error('Invalid video dimensions');const scale=Math.min(1,960/Math.max(width,height),540/Math.min(width,height));return {width:Math.max(2,Math.floor(width*scale/2)*2),height:Math.max(2,Math.floor(height*scale/2)*2)};}
export async function runFfmpeg(args:string[],signal:AbortSignal):Promise<string>{const {resolveFfmpegPath}=await import('../sidecar/ffmpeg-path');return runProcess(resolveFfmpegPath(),args,signal);}
export async function runProcess(binary:string,args:string[],signal:AbortSignal):Promise<string>{signal.throwIfAborted();return new Promise((resolve,reject)=>{const child=spawn(binary,args,{stdio:['ignore','ignore','pipe']});let stderr='';const abort=()=>child.kill('SIGKILL');signal.addEventListener('abort',abort,{once:true});child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-32768);});child.once('error',reject);child.once('close',code=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else if(code===0)resolve(stderr);else reject(new Error(`Media processing failed (${code}): ${stderr.slice(-2000)}`));});});}
export interface VideoProbe {width:number;height:number;durationMs:number;startPTS:number;}
export async function probeVideo(file:string,signal:AbortSignal):Promise<VideoProbe>{signal.throwIfAborted();const {probeInputHeader}=await import('../sidecar/probe-streams');const {parseOriginalMetadata}=await import('./import-inspection');const output=await probeInputHeader(file,signal);signal.throwIfAborted();const metadata=parseOriginalMetadata(output,0);if(!metadata.hasVideo)throw new Error('Could not inspect original video');return {width:metadata.width,height:metadata.height,durationMs:metadata.duration*1000,startPTS:Number(/start:\s*(-?[\d.]+)/.exec(output)?.[1]??0)};}

interface JobDependencies {run?:(args:string[],signal:AbortSignal)=>Promise<unknown>;probe?:(file:string,signal:AbortSignal)=>Promise<VideoProbe>;freeBytes?:(dir:string)=>Promise<number>;}
export class ManagedMediaJobs {
 private shared=new Map<string,{controller:AbortController;consumers:Set<symbol>;promise:Promise<unknown>}>();
 constructor(private registry:ManagedAssetRegistry,private queue:HeavyJobQueue,private deps:JobDependencies={}){}
 async ensureAudioStream(assetId:string,index:number,signal:AbortSignal,sourceChannelIndex?:number,priority:HeavyJobPriority='foreground'):Promise<string>{
  signal.throwIfAborted();
  if(!Number.isInteger(index)||index<0)throw new Error('Invalid audio stream index');
  if(sourceChannelIndex!==undefined&&(!Number.isInteger(sourceChannelIndex)||sourceChannelIndex<0||sourceChannelIndex>63))throw new Error('Invalid source audio channel');
  const variant=sourceChannelIndex===undefined?`audio-${index}`:`audio-${index}-channel-${sourceChannelIndex}`;
  const uri=`licketysplit-media://${assetId}/${variant}`;
  const cached=await this.registry.audioPreview(assetId,index,sourceChannelIndex);
  signal.throwIfAborted();
  if(cached)return uri;
  const asset=await this.registry.get(assetId);
  const key=`${asset.identity.assetId}:${asset.identity.sha256}:audio-v1:${index}:${sourceChannelIndex??'mix'}`;
  return this.runShared(key,signal,priority,sharedSignal=>this.queue.run(async()=>{
   const cached=await this.registry.audioPreview(assetId,index,sourceChannelIndex);
   sharedSignal.throwIfAborted();
   if(cached)return uri;
   const src=await this.registry.resolve(assetId,'original');const asset=await this.registry.get(assetId);const channelTag=sourceChannelIndex===undefined?'':`-channel-${sourceChannelIndex}`;const base=path.join(this.registry.cacheDir,`${asset.identity.sha256}-audio-${index}${channelTag}-v1`);const partial=base+'.partial.m4a';try{const args=['-y','-i',src.path,'-map',`0:a:${index}`,'-vn'];if(sourceChannelIndex!==undefined)args.push('-af',`pan=mono|c0=c${sourceChannelIndex}`);args.push('-c:a','aac','-b:a','192k','-ar','48000','-ac',sourceChannelIndex===undefined?'2':'1','-movflags','+faststart',partial);await (this.deps.run??runFfmpeg)(args,sharedSignal);sharedSignal.throwIfAborted();await this.registry.trimDerivedCache((await fs.stat(partial)).size,assetId);const output=base+'.m4a';await fs.rename(partial,output);await this.registry.promoteAudioPreview(assetId,index,output,sourceChannelIndex);return uri;}finally{await fs.unlink(partial).catch(()=>{});}
  },sharedSignal,priority));
 }
 async ensureProxy(assetId:string,_profile:ResourceProfile,signal:AbortSignal,priority:HeavyJobPriority='foreground'):Promise<ProxyReceipt>{
  signal.throwIfAborted();
  const cached=await this.registry.receipt(assetId);
  signal.throwIfAborted();
  if(cached)return cached;
  const asset=await this.registry.get(assetId);
  const key=`${asset.identity.assetId}:${asset.identity.sha256}:proxy-540-v1`;
  return this.runShared(key,signal,priority,sharedSignal=>this.queue.run(async()=>{
   const secondLookup=await this.registry.receipt(assetId);
   sharedSignal.throwIfAborted();
   if(secondLookup)return secondLookup;
   const current=await this.registry.get(assetId);
   const src=await this.registry.resolve(assetId,'original');
   const metadata=await (this.deps.probe??probeVideo)(src.path,sharedSignal);
   const {width,height}=proxyDimensions(metadata.width,metadata.height);
   const free=await (this.deps.freeBytes??(async dir=>{const s=await fs.statfs(dir);return Number(s.bavail)*Number(s.bsize);}))(this.registry.cacheDir);
   const need=Math.ceil(metadata.durationMs/1000*2_000_000/8)+1024**3;
   if(free<need)throw new Error(`Insufficient disk space in ${this.registry.cacheDir}: need ${need} bytes`);
   const base=path.join(this.registry.cacheDir,`${current.identity.sha256}-540-v1`);
   const partial=base+'.partial.mp4';let effective='videotoolbox';
   try{
    const shared=['-y','-i',src.path,'-vf',`scale=${width}:${height}`,'-fps_mode','passthrough','-an','-movflags','+faststart'];
    try{await (this.deps.run??runFfmpeg)([...shared,'-c:v','h264_videotoolbox','-b:v','2000k',partial],sharedSignal);}catch(e){sharedSignal.throwIfAborted();effective='software';await (this.deps.run??runFfmpeg)([...shared,'-c:v','libx264','-preset','veryfast','-crf','28',partial],sharedSignal);}
    sharedSignal.throwIfAborted();await this.registry.trimDerivedCache((await fs.stat(partial)).size,assetId);const out=base+'-'+effective+'.mp4';await fs.rename(partial,out);
    const receipt:ProxyReceipt={assetId,sourceSha256:current.identity.sha256,proxyUri:`licketysplit-media://${assetId}/proxy`,width,height,sourceStartPTS:metadata.startPTS,proxyStartPTS:0,durationMs:metadata.durationMs,version:1};
    await this.registry.promoteProxy(assetId,out,receipt);return receipt;
   }finally{await fs.unlink(partial).catch(()=>{});}
  },sharedSignal,priority));
 }
 private runShared<T>(key:string,signal:AbortSignal,priority:HeavyJobPriority,start:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  signal.throwIfAborted();
  let shared=this.shared.get(key);
  if(shared?.controller.signal.aborted){this.shared.delete(key);shared=undefined;}
  if(!shared){
   const controller=new AbortController();
   const entry={controller,consumers:new Set<symbol>(),promise:Promise.resolve(undefined as unknown)};
   entry.promise=start(controller.signal).finally(()=>{if(this.shared.get(key)===entry)this.shared.delete(key);});
   this.shared.set(key,entry);shared=entry;
  }else if(priority==='foreground')this.queue.promote(shared.controller.signal,'foreground');
  const entry=shared;const consumer=Symbol(key);entry.consumers.add(consumer);
  return new Promise<T>((resolve,reject)=>{
   let settled=false;
   const release=(reason?:unknown)=>{
    if(settled)return;settled=true;signal.removeEventListener('abort',onAbort);entry.consumers.delete(consumer);
    if(reason!==undefined){if(entry.consumers.size===0)entry.controller.abort(reason);reject(reason);}
   };
   const onAbort=()=>release(signal.reason);
   signal.addEventListener('abort',onAbort,{once:true});
   entry.promise.then(value=>{if(settled)return;release();resolve(value as T);},error=>{if(settled)return;release();reject(error);});
   if(signal.aborted)onAbort();
  });
 }
}
