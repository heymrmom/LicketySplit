import {stat} from 'node:fs/promises';
import type {MediaTrackInfo} from '../../../../../packages/core/src/media/types';
import {probeInputHeader,parseAudioStreams} from '../sidecar/probe-streams';
import {heavyQueue} from './media-jobs';
export function parseOriginalMetadata(text:string,fileSize:number):MediaTrackInfo {
 const video=/Video:\s*([\w]+)[^\n]*?\b(\d{2,5})x(\d{2,5})\b[^\n]*/.exec(text);
 const duration=/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
 const audio=parseAudioStreams(text);
 if(!duration||(!video&&!audio.length))throw new Error('Unable to inspect this original; relink a readable file or approve conversion separately');
 let frameRate=Number(/([\d.]+)\s*fps/.exec(video?.[0]??'')?.[1]??0);
 for(const rate of [24000/1001,30000/1001,60000/1001])if(Math.abs(frameRate-rate)<.01)frameRate=rate;
 const rotation=Number(/(?:rotation of|rotate\s*:)\s*(-?[\d.]+)/.exec(text)?.[1]??0);const quarterTurn=Math.abs(Math.abs(rotation%180)-90)<.01;
 const canDecodeVideo=!!video&&['h264','hevc','vp8','vp9','av1'].includes(video[1]);
 return {duration:+duration[1]*3600+ +duration[2]*60+ +duration[3],width:video?+video[quarterTurn?3:2]:0,height:video?+video[quarterTurn?2:3]:0,frameRate,codec:video?.[1]??audio[0]?.codec??'',sampleRate:audio[0]?.sampleRate??0,channels:audio[0]?.channels??0,fileSize,mimeType:video?'video/quicktime':'audio/wav',hasVideo:!!video,hasAudio:audio.length>0,rotation,canDecode:video?canDecodeVideo:audio.length>0,canDecodeVideo,audioTrackCount:audio.length};
}
export async function inspectOriginal(srcPath:string):Promise<MediaTrackInfo>{return heavyQueue.run(async()=>{const file=await stat(srcPath);if(!file.isFile())throw new Error('Original is not a readable file');const output=await probeInputHeader(srcPath);return parseOriginalMetadata(output,file.size);},new AbortController().signal);}
