import {spawn} from 'node:child_process';
import {ManagedAssetRegistry} from './asset-registry';import {HeavyJobQueue} from './media-jobs';
export async function capturePcm(args:string[],signal:AbortSignal):Promise<ArrayBuffer>{const {resolveFfmpegPath}=await import('../sidecar/ffmpeg-path');signal.throwIfAborted();return new Promise((resolve,reject)=>{const child=spawn(resolveFfmpegPath(),args,{stdio:['ignore','pipe','pipe']});const chunks:Buffer[]=[];let length=0;const abort=()=>child.kill('SIGKILL');signal.addEventListener('abort',abort,{once:true});child.stdout.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>16*1024**2){child.kill('SIGKILL');reject(new Error('Audio range exceeded bounded output'));}else chunks.push(chunk);});child.stderr.resume();child.once('error',reject);child.once('close',code=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else if(code!==0)reject(new Error('Could not decode original audio range'));else{const bytes=Buffer.concat(chunks);resolve(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer);}});});}
const SEEK_PREROLL_MS=2000;
const MAX_DECODE_WINDOW_MS=10000;
const MAX_AUDIO_WINDOW_MS=MAX_DECODE_WINDOW_MS-SEEK_PREROLL_MS;
export class NativeAudioAnalysis {
 constructor(private registry:ManagedAssetRegistry,private queue:HeavyJobQueue,private capture=capturePcm){}
 async getNativeAudioWindow(assetId:string,trackIndex:number,startMs:number,durationMs:number,signal:AbortSignal,sampleRate=48000,channels=2,sourceChannelIndex?:number):Promise<{channels:Float32Array[];sampleRate:number}>{
  if(!Number.isFinite(durationMs)||durationMs<=0||durationMs>10000)throw new Error('Audio window must be at most ten seconds (10000 ms)');
  if(startMs<0||!Number.isFinite(startMs)||!Number.isInteger(trackIndex)||trackIndex<0||!Number.isInteger(sampleRate)||sampleRate<1||!Number.isInteger(channels)||channels<1||channels>2||(sourceChannelIndex!==undefined&&(!Number.isInteger(sourceChannelIndex)||sourceChannelIndex<0||sourceChannelIndex>63)))throw new Error('Invalid original audio range');
  return this.queue.run(async()=>{
   const source=await this.registry.resolve(assetId,'original');
   const outputChannels=sourceChannelIndex===undefined?channels:1,totalFrames=Math.round(durationMs*sampleRate/1000),output=Array.from({length:outputChannels},()=>new Float32Array(totalFrames));
   let written=0;
   while(written<totalFrames){
    signal.throwIfAborted();
    const frames=Math.min(Math.floor(sampleRate*MAX_AUDIO_WINDOW_MS/1000),totalFrames-written),chunkStartMs=startMs+written*1000/sampleRate,chunkDurationMs=frames*1000/sampleRate,inputSeekMs=Math.max(0,chunkStartMs-SEEK_PREROLL_MS);
    // `-t` is an input option here. Keeping it before `-i` bounds decoder work
    // even when atrim emits fewer frames because the selected stream starts late.
    const args=['-hide_banner','-loglevel','error','-copyts','-start_at_zero','-ss',String(inputSeekMs/1000),'-t',String((chunkStartMs+chunkDurationMs-inputSeekMs)/1000),'-i',source.path,'-map',`0:a:${trackIndex}`,'-vn'];
    const filters:string[]=[];
    if(sourceChannelIndex!==undefined)filters.push(`pan=mono|c0=c${sourceChannelIndex}`);
    filters.push(`atrim=start=${chunkStartMs/1000}:duration=${chunkDurationMs/1000}`,`asetpts=PTS-${chunkStartMs/1000}/TB`,`aresample=${sampleRate}:first_pts=0`,`atrim=end_sample=${frames}`,'asetpts=N/SR/TB');
    args.push('-af',filters.join(','),'-ar',String(sampleRate),'-ac',String(outputChannels),'-f','f32le','pipe:1');
    const interleaved=new Float32Array(await this.capture(args,signal)),count=interleaved.length/outputChannels;
    if(!Number.isInteger(count)||count!==frames)throw new Error(`Native decoder returned ${count} of ${frames} requested audio frames; timing evidence was not saved.`);
    for(let i=0;i<frames;i++)for(let c=0;c<outputChannels;c++)output[c][written+i]=interleaved[i*outputChannels+c];
    written+=frames;
   }
   return {channels:output,sampleRate};
  },signal);
 }
 async *readAnalysisAudio(assetId:string,sampleRate:1000|16000,range:{startMs:number;endMs:number},signal:AbortSignal):AsyncIterable<Float32Array>{if(range.endMs<=range.startMs)throw new Error('Invalid analysis range');for(let start=range.startMs;start<range.endMs;start+=10000){signal.throwIfAborted();const window=await this.getNativeAudioWindow(assetId,0,start,Math.min(10000,range.endMs-start),signal,sampleRate,1);yield window.channels[0];}}
}
