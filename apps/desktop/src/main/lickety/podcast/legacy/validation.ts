import { mediaCheckpoint } from './resource-control.js';
import type { SyncProject, SyncReviewCheck, SyncReviewCandidate, SyncProgress, PcmReader } from './types.js';
import { projectTime } from './time.js';
import { windowEvidence } from './window-evidence.js';
import {mappingRegions,regionAtProject,audioSpans} from './regions.js';
/** Held-out checks do not refit any mapping. Test all usable channels against
 * every connected recorder (or another camera when no recorder overlaps).
 * Local signal quality chooses the comparison, never its residual.
 */
export async function validateClockNetwork(p: SyncProject, progress: (p:SyncProgress)=>void, readPcm:PcmReader, signal?:AbortSignal, extraSeconds:number[] = [],targetIds?:string[]) {
 const checks:SyncReviewCheck[]=[];
 const training=(id:string)=>[...p.edges.flatMap(e=>e.anchors.filter(a=>a.role==='fit').flatMap(a=>e.a===id?[{time:a.referenceSeconds,half:a.windowSeconds/2}]:e.b===id?[{time:a.sourceSeconds,half:a.windowSeconds/2}]:[])),...(p.regionEvidence||[]).filter(e=>e.role==='fit'&&e.usable).flatMap(e=>e.assetId===id?[{time:e.sourceSeconds,half:e.windowSeconds/2}]:p.channels.find(c=>c.id===e.referenceChannelId)?.assetId===id?[{time:e.referenceSeconds,half:e.windowSeconds/2}]:[])];
 const channels=(id:string)=>p.channels.filter(c=>c.assetId===id && c.usable);
 const placements=p.placements.filter(v=>v.component===p.referenceAssetId && v.status!=='excluded');
 for(const placement of placements.filter(v=>v.assetId!==p.referenceAssetId&&(!targetIds||targetIds.includes(v.assetId)))) {
  // A shared recorder's sample relationship is known; microphone perspective is not clock error.
  if(p.clockGroups.some(g=>g.confirmed&&g.sourceStarts&&g.assetIds.includes(placement.assetId)&&g.assetIds.includes(p.referenceAssetId)))continue;
  const sourceChannels=channels(placement.assetId);if(!sourceChannels.length)continue;
  const sourceBounds=sourceChannels.flatMap(c=>audioSpans(c.receipt).flatMap(span=>mappingRegions(placement,span.lo,span.hi).map(r=>({lo:projectTime(r.sourceStartSeconds,r.mapping),hi:projectTime(r.sourceEndSeconds,r.mapping)}))));
  const lo=Math.min(...sourceBounds.map(b=>b.lo)),hi=Math.max(...sourceBounds.map(b=>b.hi));
  const times=[lo+7,lo+(hi-lo)*.19,lo+(hi-lo)*.39,lo+(hi-lo)*.63,lo+(hi-lo)*.81,hi-7,...extraSeconds];
  for(let t=lo+13;t<hi-3.1;t+=120)times.push(t);
  for(const t of [...new Set(times)].filter(t=>t>=lo+3.1 && t<=hi-3.1)) {
   await mediaCheckpoint(signal);
   progress({phase:'solve',completed:checks.length,total:placements.length*6,message:`Checking independent common sound: ${p.analysis.assets.find(a=>a.id===placement.assetId)!.name}`});
   const candidates:SyncReviewCandidate[]=[];
   const other=placements.filter(v=>v.assetId!==placement.assetId&&(v.status==='reference'||v.status==='measured'||v.status==='manual'&&v.locked));
   // All standalone recorder channels first. If none carries usable common
   // sound, test cameras for indirect-overlap validation.
   for(const audioOnly of [true,false]) {
    for(const ref of other.filter(v=>(p.analysis.assets.find(a=>a.id===v.assetId)!.kind==='audio')===audioOnly)) {
     const sm=regionAtProject(placement,t),rm=regionAtProject(ref,t);if(!sm||!rm)continue;
     const source=sm.sourceSeconds,rtime=rm.sourceSeconds;
     if(sm.region&&(source-3<sm.region.sourceStartSeconds||source+3>sm.region.sourceEndSeconds)||rm.region&&(rtime-3.06<rm.region.sourceStartSeconds||rtime+3.06>rm.region.sourceEndSeconds))continue;
     for(const channel of sourceChannels)for(const reference of channels(ref.assetId)) {
      await mediaCheckpoint(signal);
      if(source-3<channel.receipt.firstPTSSeconds || source+3>Math.max(...audioSpans(channel.receipt).map(s=>s.hi)) || rtime-3.06<reference.receipt.firstPTSSeconds || rtime+3.06>Math.max(...audioSpans(reference.receipt).map(s=>s.hi)))continue;
      const [a,b]=await Promise.all([readPcm(reference,rtime-3-.06,6.12),readPcm(channel,source-3,6)]);
      if(a.length<48960 || b.length!==48000)continue;
      const fitOverlap=training(channel.assetId).some(a=>Math.abs(a.time-source)<a.half+3.06) || training(reference.assetId).some(a=>Math.abs(a.time-rtime)<a.half+3.06);
      candidates.push({channelId:channel.id,referenceChannelId:reference.id,sourceSeconds:source,referenceSeconds:rtime,fitOverlap,...windowEvidence(a,b)});
     }
    }
    if(candidates.some(c=>c.usable))break;
   }
   if(!candidates.length)continue;
   const sorted=[...candidates].sort((a,b)=>Number(b.usable)-Number(a.usable)||b.score-a.score||a.channelId.localeCompare(b.channelId));
   const best=sorted[0],competing=sorted.some(c=>c.usable && c.score>=.85*best.score && Math.abs(c.residualMs-best.residualMs)>2);
   const quality=best.usable && !competing;
   checks.push({assetId:placement.assetId,...best,projectSeconds:t,windowSeconds:6,candidates,
    reason:competing?'Equally strong channel comparisons disagree.':!best.usable?'Insufficient signal, competing peaks or unstable subwindows.':'Strongest stable common-signal comparison; residual did not affect selection.',
    status:best.fitOverlap?'overlaps-training':!quality?'unverified':Math.abs(best.residualMs)<=5?'pass':'failed'});
  }
 }
 return checks;
}
