import type { Project, MediaItem } from '../types/project';
import type { Clip, Transform, Track } from '../types/timeline';
import { DEFAULT_TEXT_STYLE } from '../text/types';
export function makeWorkflowFixture(options: { frameRate?: number; durationSec?: number } = {}): Project {
 const duration=options.durationSec ?? 20;
 const transform:Transform={position:{x:0,y:0},scale:{x:1.1,y:1.1},rotation:0,anchor:{x:0.5,y:0.5},opacity:1};
 const media=(id:string,type:'video'|'audio'):MediaItem=>Object.freeze({id,name:id,type,fileHandle:null,blob:null,thumbnailUrl:null,waveformData:null,metadata:{duration,width:type==='video'?3840:0,height:type==='video'?2160:0,frameRate:options.frameRate??25,sampleRate:48000,channels:type==='audio'?1:2,codec:type==='video'?'h264':'pcm',fileSize:100,hasVideo:type==='video',hasAudio:true}});
 const clip=(id:string,mediaId:string,trackId:string,startTime:number,clipDuration:number):Clip=>({id,mediaId,trackId,startTime,duration:clipDuration,inPoint:startTime,outPoint:startTime+clipDuration,effects:[{id:'color-'+id,type:'brightness',enabled:true,params:{value:0.1}}],audioEffects:[],transform,volume:1,keyframes:[]});
 const track=(id:string,type:'video'|'audio',clips:Clip[]):Track=>({id,name:id,type,role:type==='audio'?'dialogue':'general',clips,transitions:[],hidden:false,muted:false,locked:false,solo:false});
 return {id:'fixture-project',name:'Episode',createdAt:1,modifiedAt:1,settings:{width:3840,height:2160,frameRate:options.frameRate??25,sampleRate:48000,channels:2},mediaLibrary:{items:[media('cam-a','video'),media('cam-b','video'),media('mic-alice','audio'),media('mic-bob','audio')]},timeline:{duration,tracks:[track('program','video',[clip('a','cam-a','program',0,duration/2),clip('b','cam-b','program',duration/2,duration/2)]),track('Alice','audio',[clip('alice','mic-alice','Alice',0,duration)]),track('Bob','audio',[clip('bob','mic-bob','Bob',0,duration)])],subtitles:[],markers:[]},textClips:[{id:'title',trackId:'program',startTime:1,duration:3,text:'Episode',style:DEFAULT_TEXT_STYLE,transform,keyframes:[]}]};
}
