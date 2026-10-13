import type {SyncPlacement,SyncRegion,DecodeReceipt} from './types.js';
import {projectTime,sourceTime,validateMapping} from './time.js';
export function validateRegions(regions:SyncRegion[]) {
 if(!regions.length)throw new Error('A segmented source must retain at least one mapping region.');
 for(let i=0;i<regions.length;i++){
  const r=regions[i];validateMapping(r.mapping);
  if(!r.id || !Number.isFinite(r.sourceStartSeconds)||!Number.isFinite(r.sourceEndSeconds)||r.sourceEndSeconds<=r.sourceStartSeconds)throw new Error('Invalid source region bounds.');
  if(regions.slice(0,i).some(x=>x.id===r.id)||i>0&&regions[i-1].sourceEndSeconds>r.sourceStartSeconds+1e-9)throw new Error('Source mapping regions must be ordered, unique and non-overlapping.');
  if(i>0&&r.sourceStartSeconds-regions[i-1].sourceEndSeconds>1e-9)throw new Error('Retain omitted source intervals as explicit excluded regions with a note.');
  if(r.status==='excluded'&&!r.note?.trim())throw new Error('Excluded regions require a decision note.');
  if(r.status==='manual'&&!r.note?.trim())throw new Error('Manual regions require an evidence note.');
 }
}
export function regionMappingBlockers(p:SyncPlacement) {
 if(!p.regions)return [];
 const included=p.regions.filter(r=>r.status!=='excluded'),issues=[];
 for(let i=1;i<included.length;i++)if(projectTime(included[i].sourceStartSeconds,included[i].mapping)<projectTime(included[i-1].sourceEndSeconds,included[i-1].mapping)-1/48000)issues.push('Timing regions overlap in project time. Resolve the boundary with an explicit source trim/exclusion before approval; overlapping audio must not be summed.');
 return [...new Set(issues)];
}
export function mappingRegions(p:SyncPlacement,lo:number,hi:number):SyncRegion[] {
 const regions=p.regions||[{id:'whole',sourceStartSeconds:lo,sourceEndSeconds:hi,mapping:p.mapping,status:p.status==='reference'?'measured':p.status,locked:p.locked,provenance:p.provenance,note:p.exception}];
 return regions.map(r=>({...r,sourceStartSeconds:Math.max(lo,r.sourceStartSeconds),sourceEndSeconds:Math.min(hi,r.sourceEndSeconds)})).filter(r=>r.sourceEndSeconds>r.sourceStartSeconds);
}
export function regionAtProject(p:SyncPlacement,t:number) {
 if(!p.regions)return {mapping:p.mapping,sourceSeconds:sourceTime(t,p.mapping)};
 const found=p.regions.filter(r=>r.status!=='excluded'&&t>=projectTime(r.sourceStartSeconds,r.mapping)&&t<projectTime(r.sourceEndSeconds,r.mapping));
 if(found.length!==1)return undefined;
 return {region:found[0],mapping:found[0].mapping,sourceSeconds:sourceTime(t,found[0].mapping)};
}
export function regionStatus(p:SyncPlacement) {
 if(!p.regions)return;
 validateRegions(p.regions);
 if(p.regions.every(r=>r.status==='excluded'))p.status='excluded';
 else if(p.regions.some(r=>r.status==='unresolved'))p.status='unresolved';
 else if(p.regions.some(r=>r.status==='manual'))p.status='manual';
 else p.status='measured';
}
export function splitRegion(p:SyncPlacement,seconds:number,bounds:{lo:number;hi:number},note:string) {
 if(p.locked||!note.trim())throw new Error('Unlock the source and record the reason for the timing boundary.');
 const regions=mappingRegions(p,bounds.lo,bounds.hi),index=regions.findIndex(r=>seconds>r.sourceStartSeconds&&seconds<r.sourceEndSeconds);
 if(index<0)throw new Error('Split time must be inside a source region.');
 const r=regions[index];if(r.locked)throw new Error('Unlock the region before splitting it.');
 const provenance=[...r.provenance,`manual timing boundary at source ${seconds}: ${note}`];
 regions.splice(index,1,{...r,id:`${r.id}-before-${seconds}`,sourceEndSeconds:seconds,status:'unresolved',provenance}, {...r,id:`${r.id}-after-${seconds}`,sourceStartSeconds:seconds,status:'unresolved',provenance});
 p.regions=regions;regionStatus(p);
}
/** Compressed PCM positions are distinct from presentation timestamps. */
export function audioSpans(receipt:DecodeReceipt) {
 const boundaries=[{frame:0,pts:receipt.firstPTSSeconds},...receipt.discontinuities.map(g=>({frame:Math.round(g.decodedFrame),pts:g.atSeconds}))];
 return boundaries.map((b,i)=>({firstFrame:b.frame,frames:(boundaries[i+1]?.frame??receipt.frames)-b.frame,lo:b.pts,hi:b.pts+((boundaries[i+1]?.frame??receipt.frames)-b.frame)/receipt.sampleRate})).filter(s=>s.frames>0);
}
export function audioTimestampBlockers(receipt:DecodeReceipt) {
 const spans=audioSpans(receipt);
 return spans.some((s,i)=>i>0&&s.lo<spans[i-1].hi-1/receipt.sampleRate)?['Audio timestamps restart or overlap inside one file. A unique segment/sample identity is required before approval.']:[];
}
