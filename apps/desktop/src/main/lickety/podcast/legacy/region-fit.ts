import { mediaCheckpoint } from './resource-control.js';
import {validationReservations} from './evidence-history.js';
import type {SyncProject,SyncPlacement,SyncRegion,SyncRegionEvidence,SyncProgress,PcmReader} from './types.js';
import {projectTime,sourceTime} from './time.js';import {audioSpans,regionStatus} from './regions.js';import {windowEvidence} from './window-evidence.js';
/** Fit-only segmentation. Validation measurements never choose a breakpoint,
 * slope, offset or outlier. Unsupported transition intervals remain unresolved. */
export function fitRegions(evidence:SyncRegionEvidence[],lo:number,hi:number,base:SyncRegion['mapping']):SyncRegion[] {
 const candidates=evidence.filter(e=>e.role==='fit'&&e.usable&&Number.isFinite(e.sourceSeconds)&&Number.isFinite(e.observedProjectSeconds)&&e.score>0).sort((a,b)=>a.sourceSeconds-b.sourceSeconds);
 const fit:SyncRegionEvidence[]=[];
 for(const row of candidates){const previous=fit.at(-1);if(previous&&Math.abs(row.sourceSeconds-previous.sourceSeconds)<.001){if(row.score>previous.score)fit[fit.length-1]=row;}else fit.push(row);}
 const groups:SyncRegionEvidence[][]=[];
 const mapping=(rows:SyncRegionEvidence[])=>{
  if(rows.length<2)return {...base};
  // Centered weighted regression on fit windows only. Local regions need not
  // inherit the whole-file minimum baseline used by coarse clock estimation.
  const weight=rows.reduce((s,r)=>s+r.score*r.score,0),center=rows.reduce((s,r)=>s+r.sourceSeconds*r.score*r.score,0)/weight;
  const mean=rows.reduce((s,r)=>s+(r.observedProjectSeconds-r.sourceSeconds)*r.score*r.score,0)/weight;
  const variance=rows.reduce((s,r)=>s+(r.sourceSeconds-center)**2*r.score*r.score,0);
  if(variance<1e-6)return {...base};
  const slope=rows.reduce((s,r)=>s+(r.sourceSeconds-center)*((r.observedProjectSeconds-r.sourceSeconds)-mean)*r.score*r.score,0)/Math.max(1e-12,variance);
  if(!Number.isFinite(slope)||1+slope<=0)return {...base};
  return {version:1 as const,scale:1+slope,offsetSeconds:mean-slope*center};
 };
 const loss=(rows:SyncRegionEvidence[])=>{const m=mapping(rows);return rows.reduce((s,r)=>s+Math.min(.1,Math.abs(projectTime(r.sourceSeconds,m)-r.observedProjectSeconds))**2,0);};
 const split=(rows:SyncRegionEvidence[])=>{
  if(rows.length<3){groups.push(rows);return;}
  const m=mapping(rows),worst=Math.max(...rows.map(r=>Math.abs(projectTime(r.sourceSeconds,m)-r.observedProjectSeconds)));
  const gap=rows.findIndex((r,i)=>i>0&&r.sourceSeconds-rows[i-1].sourceSeconds>120);
  if(worst<=.003&&Math.abs(m.scale-1)<=.005&&gap<0){groups.push(rows);return;}
  if(rows.length<6){groups.push(rows);return;}
  let index=3,best=Infinity;
  for(let i=3;i<=rows.length-3;i++){const score=loss(rows.slice(0,i))+loss(rows.slice(i));if(score<best){best=score;index=i;}}
  if(gap>=3&&gap<=rows.length-3)index=gap;
  split(rows.slice(0,index));split(rows.slice(index));
 };
 if(fit.length)split(fit);
 // Only fitting evidence may justify a clock break. Small residual noise or
 // quiet gaps alone must not manufacture dozens of independent clocks.
 const supportedBreak=(left:SyncRegionEvidence[],right:SyncRegionEvidence[])=>{
  if(left.length<3||right.length<3||left.at(-1)!.sourceSeconds-left[0].sourceSeconds<30||right.at(-1)!.sourceSeconds-right[0].sourceSeconds<30)return false;
  const lm=mapping(left),rm=mapping(right);
  if([lm,rm].some(m=>Math.abs(m.scale-1)>.005))return false;
  if(left.some(r=>Math.abs(projectTime(r.sourceSeconds,lm)-r.observedProjectSeconds)>.003)||right.some(r=>Math.abs(projectTime(r.sourceSeconds,rm)-r.observedProjectSeconds)>.003))return false;
  const t=(left.at(-1)!.sourceSeconds+right[0].sourceSeconds)/2;
  return Math.abs(projectTime(t,lm)-projectTime(t,rm))>.015;
 };
 // A supported break at one boundary must not retain unrelated noise-driven
 // subdivisions elsewhere. Join every boundary without its own evidence.
 const joined:SyncRegionEvidence[][]=[];
 for(let i=0;i<groups.length;i++){if(!i||supportedBreak(groups[i-1],groups[i]))joined.push([...groups[i]]);else joined.at(-1)!.push(...groups[i]);}
 groups.splice(0,groups.length,...joined);
 const clockBreak=groups.length>1;
 const regions:SyncRegion[]=[];let cursor=lo;
 const unresolved=(start:number,end:number,reason:string)=>{if(end<=start)return;regions.push({id:`unresolved-${start}`,sourceStartSeconds:start,sourceEndSeconds:end,mapping:{...base},status:'unresolved',locked:false,provenance:[reason]});};
 for(const rows of groups){
  if(rows.length<3)continue;const m=mapping(rows),start=clockBreak?Math.max(lo,cursor,rows[0].sourceSeconds-3):lo,end=clockBreak?Math.min(hi,rows.at(-1)!.sourceSeconds+3):hi;
  if(end<=start)continue;
  const fitResidual=Math.max(...rows.map(r=>Math.abs(projectTime(r.sourceSeconds,m)-r.observedProjectSeconds)*1000));
  const validation=evidence.filter(e=>e.role==='validation'&&e.usable&&e.sourceSeconds-e.windowSeconds/2>=start&&e.sourceSeconds+e.windowSeconds/2<=end).sort((a,b)=>a.sourceSeconds-b.sourceSeconds);
  let lastValidationEnd=-Infinity;
  const independent=validation.filter(e=>{if(e.sourceSeconds-e.windowSeconds/2<lastValidationEnd)return false;lastValidationEnd=e.sourceSeconds+e.windowSeconds/2;return true;});
  const residual=Math.max(0,...validation.map(e=>Math.abs(projectTime(e.sourceSeconds,m)-e.observedProjectSeconds)*1000));
  const coverage=clockBreak || (rows.at(-1)!.sourceSeconds-rows[0].sourceSeconds >= (hi-lo)*.8 && rows[0].sourceSeconds-lo<=Math.max(12,(hi-lo)*.1) && hi-rows.at(-1)!.sourceSeconds<=Math.max(12,(hi-lo)*.1));
  const pass=coverage&&rows.every(r=>r.sourceSeconds>=start&&r.sourceSeconds<=end)&&rows.length>=3&&independent.length>=3&&fitResidual<=3&&residual<=5&&Math.abs(m.scale-1)<=.005&&rows.at(-1)!.sourceSeconds-rows[0].sourceSeconds>=30&&!rows.some((r,i)=>i>0&&r.sourceSeconds-rows[i-1].sourceSeconds>120);
  unresolved(cursor,start,'Insufficient independent evidence between supported timing regions. No constant-clock assumption across this interval.');
  regions.push({id:`fit-${start}`,sourceStartSeconds:start,sourceEndSeconds:end,mapping:m,status:pass?'measured':'unresolved',locked:false,uncertaintyMs:residual,provenance:[`Regional fit: ${rows.length} training and ${independent.length} independent validation windows (${validation.length} checks); maximum fit ${fitResidual.toFixed(3)} ms, validation ${residual.toFixed(3)} ms.`]});cursor=end;
 }
 unresolved(cursor,hi,'No supported regional clock estimate. Original mapping retained for review.');return regions;
}
/** Refine only a source whose whole-file mapping failed. These observations
 * compare against connected, non-failing clocks; region proposals never become
 * reference truth for another source in the same pass. */
export async function proposeRegionalMappings(p:SyncProject,ids:string[],progress:(p:SyncProgress)=>void,readPcm:PcmReader,signal?:AbortSignal) {
 const all:SyncRegionEvidence[]=[];const failing=new Set(ids),reservations=validationReservations(p);
 for(const id of ids){
  const placement=p.placements.find(v=>v.assetId===id)!;if(placement.locked||placement.status==='manual'||placement.status==='excluded')continue;
  if(p.clockGroups.some(g=>g.confirmed&&g.assetIds.length>1&&g.assetIds.includes(id)))continue;
  const channels=p.channels.filter(c=>c.assetId===id&&c.usable);if(!channels.length)continue;
  const asset=p.analysis.assets.find(a=>a.id===id)!,video=asset.streams?.find(s=>s.kind==='video');
  const lo=Math.min(video?.startSeconds??Infinity,...channels.map(c=>c.receipt.firstPTSSeconds)),hi=Math.max(video?(video.startSeconds??0)+(asset.nativeVideoDurationSeconds??asset.durationSeconds):0,...channels.flatMap(c=>audioSpans(c.receipt).map(s=>s.hi)));
  const refs=p.placements.filter(v=>v.assetId!==id&&!failing.has(v.assetId)&&!v.regions&&['reference','measured'].includes(v.status)&&v.component===p.referenceAssetId);
  const retained=reservations.filter(c=>c.assetId===id).map(c=>({time:c.sourceSeconds,half:c.windowSeconds/2}));
  for(const e of p.edges)for(const a of e.anchors.filter(a=>a.role==='validation'))if(e.a===id||e.b===id)retained.push({time:e.a===id?a.referenceSeconds:a.sourceSeconds,half:a.windowSeconds/2});
  // Previous independent observations remain validation evidence, never training.
  // Convert their measured lag through the same reference clock used originally.
  const evidence:SyncRegionEvidence[]=[];
  // Reuse existing training observations, not just held-out checks. This keeps
  // retries from exhausting all fitting space on a shared reference recording.
  for(const edge of p.edges.filter(e=>e.basis!=='recorder'&&(e.a===id||e.b===id))) {
    const ref=refs.find(r=>r.assetId===(edge.a===id?edge.b:edge.a));if(!ref)continue;
    for(const a of edge.anchors.filter(a=>a.role==='fit')) {
      const sourceSeconds=edge.a===id?a.referenceSeconds:a.sourceSeconds,referenceSeconds=edge.a===id?a.sourceSeconds:a.referenceSeconds;
      if(reservations.some(r=>(r.assetId===id&&Math.abs(r.sourceSeconds-sourceSeconds)<r.windowSeconds/2+a.windowSeconds/2)||(r.assetId===ref.assetId&&Math.abs(r.sourceSeconds-referenceSeconds)<r.windowSeconds/2+a.windowSeconds/2)))continue;
      evidence.push({assetId:id,role:'fit',sourceSeconds,referenceSeconds,channelId:edge.a===id?edge.channelA:edge.channelB,referenceChannelId:edge.a===id?edge.channelB:edge.channelA,projectSeconds:projectTime(sourceSeconds,placement.mapping),observedProjectSeconds:projectTime(referenceSeconds,ref.mapping),windowSeconds:a.windowSeconds,fitOverlap:false,score:a.score,competingScore:a.competingScore,residualMs:0,usable:true,subwindows:[]});
    }
  }
  for(const check of p.reviewChecks||[]) {
   if(check.assetId!==id||!['pass','failed'].includes(check.status)||check.fitOverlap)continue;
   const refChannel=p.channels.find(c=>c.id===check.referenceChannelId),ref=refs.find(r=>r.assetId===refChannel?.assetId);
   if(!ref||evidence.some(e=>Math.abs(e.sourceSeconds-check.sourceSeconds)<.001))continue;
   const selected=check.candidates?.find(c=>c.channelId===check.channelId&&c.referenceChannelId===check.referenceChannelId);
   evidence.push({...check,usable:true,competingScore:selected?.competingScore??0,subwindows:selected?.subwindows??[],role:'validation',observedProjectSeconds:projectTime(check.referenceSeconds+check.residualMs/1000,ref.mapping)});
  }
  for(const e of p.regionEvidence||[])if(e.assetId===id&&e.role==='validation')retained.push({time:e.sourceSeconds,half:e.windowSeconds/2});
  // Reserve this pass's validation grid before evaluating any training window.
  for(let t=lo+22;t<hi-3.1;t+=24)retained.push({time:t,half:3});
  for(let i=0,center=lo+10;center<hi-3.1;i++,center+=12){
   await mediaCheckpoint(signal);const role=i%2===0?'fit':'validation';
   const candidates:SyncRegionEvidence[]=[];
   progress({phase:'solve',completed:i,total:Math.ceil((hi-lo)/12),message:`Testing separate clock regions: ${p.analysis.assets.find(a=>a.id===id)!.name}`});
   const windowSeconds=6,half=windowSeconds/2;
   for(const shift of role==='fit'?[0,-2,2,-4,4,-6,6,-8,8,-10,10,-1,1,-3,3,-5,5,-7,7,-9,9]:[0]) {
   const t=center+shift;if(role==='fit'&&retained.some(v=>Math.abs(t-v.time)<v.half+half+.1))continue;
   const projectSeconds=projectTime(t,placement.mapping);
   for(const audioOnly of [true,false]){
    for(const ref of refs.filter(v=>(p.analysis.assets.find(a=>a.id===v.assetId)!.kind==='audio')===audioOnly))for(const c of channels)for(const r of p.channels.filter(c=>c.assetId===ref.assetId&&c.usable)){
     const rt=sourceTime(projectSeconds,ref.mapping);
     if(role==='fit' && reservations.some(v=>v.assetId===ref.assetId&&Math.abs(v.sourceSeconds-rt)<v.windowSeconds/2+half+.06))continue;
     if(t-half<c.receipt.firstPTSSeconds||t+half>Math.max(...audioSpans(c.receipt).map(s=>s.hi))||rt-half-.06<r.receipt.firstPTSSeconds||rt+half+.06>Math.max(...audioSpans(r.receipt).map(s=>s.hi)))continue;
     const [a,b]=await Promise.all([readPcm(r,rt-half-.06,windowSeconds+.12),readPcm(c,t-half,windowSeconds)]);if(a.length!==(windowSeconds+.12)*8000||b.length!==windowSeconds*8000)continue;
     const w=windowEvidence(a,b,.06,role==='fit'?.25:.35);candidates.push({...w,assetId:id,role,channelId:c.id,referenceChannelId:r.id,sourceSeconds:t,referenceSeconds:rt,projectSeconds,observedProjectSeconds:projectTime(rt+w.residualMs/1000,ref.mapping),fitOverlap:false,windowSeconds});
    }
    if(candidates.some(c=>c.usable))break;
   }
   if(candidates.some(c=>c.usable))break;
   }
   candidates.sort((a,b)=>Number(b.usable)-Number(a.usable)||b.score-a.score);const best=candidates[0];if(!best)continue;
   if(candidates.some(c=>c.usable&&c.sourceSeconds===best.sourceSeconds&&c.score>=best.score*.85&&Math.abs(c.observedProjectSeconds-best.observedProjectSeconds)>.002))best.usable=false;
   evidence.push(best);
  }
  applyRefinedEvidence(placement,evidence,lo,hi);placement.provenance.push('Refined using separate fitting and validation evidence. Timing sections are introduced only for a supported clock break.');all.push(...evidence);
 }
 return all;
}

/** Preserve explicit decisions and independently measured sections on a retry. */
export function applyRefinedEvidence(placement:SyncPlacement,evidence:SyncRegionEvidence[],lo:number,hi:number) {
  if(placement.regions?.some(r=>r.locked||r.status==='manual'||r.status==='excluded'||r.status==='measured')) {
    placement.regions=placement.regions.flatMap(r=>r.locked||r.status!=='unresolved'?[r]:fitRegions(evidence.filter(e=>e.sourceSeconds-e.windowSeconds/2>=r.sourceStartSeconds&&e.sourceSeconds+e.windowSeconds/2<=r.sourceEndSeconds),r.sourceStartSeconds,r.sourceEndSeconds,r.mapping));
  } else {
    const regions=fitRegions(evidence,lo,hi,placement.mapping);
    if(regions.length===1){placement.mapping=regions[0].mapping;placement.regions=undefined;placement.status=regions[0].status;placement.uncertaintyMs=regions[0].uncertaintyMs;}else{placement.regions=regions;placement.status='unresolved';}
  }
  regionStatus(placement);
}
