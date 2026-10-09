import type { AudioClipSchedule } from './realtime-audio-graph';
import type { MasterTimelineClock } from '../playback/master-timeline-clock';
/** The browser decoder keeps a small streaming buffer; the existing graph owns effects. */
export function createNativeStreamingSource(
  context: AudioContext, clock: Pick<MasterTimelineClock,'currentTime'|'isPlaying'>,
  schedule: AudioClipSchedule, destination: AudioNode, onEnded:()=>void,
  onError:(error:Error)=>void, makeElement:()=>HTMLAudioElement=()=>new Audio(),
): {stop():void;disconnect():void} {
  const element=makeElement();element.preload='auto';element.crossOrigin='anonymous';
  element.src=schedule.nativeUri!;element.playbackRate=schedule.speed;
  const node=context.createMediaElementSource(element);node.connect(destination);
  let stopped=false;let playing=false;let timer:ReturnType<typeof setInterval>|undefined;
  const stop=()=>{if(stopped)return;stopped=true;if(timer)clearInterval(timer);element.pause();node.disconnect();element.removeAttribute('src');element.load();};
  const sync=()=>{
    if(stopped)return;
    if(clock.currentTime>=schedule.endTime){stop();onEnded();return;}
    const active=clock.isPlaying&&clock.currentTime>=schedule.startTime;
    const target=schedule.mediaOffset+Math.max(0,clock.currentTime-schedule.startTime)*schedule.speed;
    if(!playing||Math.abs(element.currentTime-target)>0.12)element.currentTime=target;
    if(active&&!playing){playing=true;void element.play().catch(error=>{stop();onError(error);onEnded();});}
    else if(!active&&playing){playing=false;element.pause();}
  };
  element.addEventListener('error',()=>{stop();onError(new Error('Native audio preview unavailable; retry preparation or relink the original'));onEnded();});
  sync();if(!stopped)timer=setInterval(sync,25);
  return {stop,disconnect:stop};
}
