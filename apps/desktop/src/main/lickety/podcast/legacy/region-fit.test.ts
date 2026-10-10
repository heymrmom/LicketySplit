import {validateRegions} from './regions.js';
import {it,expect} from 'vitest';import {fitRegions,applyRefinedEvidence} from './region-fit.js';import type {SyncRegionEvidence} from './types.js';
const base={version:1 as const,scale:1,offsetSeconds:-10};
function evidence(scale:number,step=false):SyncRegionEvidence[]{return Array.from({length:40},(_,i)=>{const sourceSeconds=10+i*12;return {assetId:'s',channelId:'s:0',referenceChannelId:'r:0',role:i%2?'validation':'fit',sourceSeconds,referenceSeconds:sourceSeconds,projectSeconds:sourceSeconds-10,observedProjectSeconds:sourceSeconds*scale-10+(step&&sourceSeconds>240?.04:0),windowSeconds:6,fitOverlap:false,score:.8,competingScore:.2,residualMs:0,usable:true,subwindows:[]};});}
it('uses one continuous model when distributed evidence supports positive, negative and absent drift',()=>{
 for(const scale of [1,1.00004,.99996]){const regions=fitRegions(evidence(scale),0,500,base);const verified=regions.filter(r=>r.status==='measured');expect(verified).toHaveLength(1);expect(verified[0].mapping.scale).toBeCloseTo(scale,10);expect(regions).toHaveLength(1);expect(regions[0].sourceStartSeconds).toBe(0);expect(regions[0].sourceEndSeconds).toBe(500);}
});
it('separates a discontinuity and does not use held-out failures to move breakpoints or refit',()=>{
 const points=evidence(1.00001,true),a=fitRegions(points,0,500,base);expect(a.filter(r=>r.status==='measured')).toHaveLength(2);expect(a.some(r=>r.status==='unresolved'&&r.sourceStartSeconds>0&&r.sourceEndSeconds<500)).toBe(true);
 const damaged=points.map(p=>({...p,observedProjectSeconds:p.observedProjectSeconds+(p.role==='validation'?.1:0)}));
 const b=fitRegions(damaged,0,500,base);expect(b.map(r=>[r.sourceStartSeconds,r.sourceEndSeconds,r.mapping])).toEqual(a.map(r=>[r.sourceStartSeconds,r.sourceEndSeconds,r.mapping]));expect(b.every(r=>r.status==='unresolved')).toBe(true);
});

it('does not certify an entire recording from a short patch or relaxed 10 ms validation',()=>{
 const patch=evidence(1).filter(e=>e.sourceSeconds<130);
 expect(fitRegions(patch,0,500,base).every(r=>r.status==='unresolved')).toBe(true);
 const marginal=evidence(1).map(e=>({...e,observedProjectSeconds:e.observedProjectSeconds+(e.role==='validation'?.007:0)}));
 const result=fitRegions(marginal,0,500,base);expect(result).toHaveLength(1);expect(result[0].status).toBe('unresolved');expect(result[0].mapping.offsetSeconds).toBeCloseTo(base.offsetSeconds,10);
});

it('refines unresolved sections without replacing a manual section or its note',()=>{
 const placement={assetId:'s',component:'ref',status:'unresolved' as const,locked:false,provenance:[],mapping:base,regions:[{id:'manual',sourceStartSeconds:0,sourceEndSeconds:50,mapping:base,status:'manual' as const,locked:false,note:'Checked clap',provenance:['editor']},{id:'unknown',sourceStartSeconds:50,sourceEndSeconds:550,mapping:base,status:'unresolved' as const,locked:false,provenance:[]}]};
 const saved=structuredClone(placement.regions[0]);
 const rows=evidence(1).map(e=>({...e,sourceSeconds:e.sourceSeconds+50,observedProjectSeconds:e.observedProjectSeconds+50}));
 applyRefinedEvidence(placement,rows,0,550);
 expect(placement.regions[0]).toEqual(saved);expect(placement.regions[1].status).toBe('measured');expect(placement.regions[1].sourceEndSeconds).toBe(550);
});

it('keeps repeated/contradictory training observations reviewable without producing an invalid clock',()=>{
 const rows=evidence(1);rows.splice(6,0,...Array.from({length:8},()=>({...rows[4],observedProjectSeconds:1000})));
 const regions=fitRegions(rows,0,500,base);expect(()=>validateRegions(regions)).not.toThrow();expect(regions.length).toBeGreaterThan(0);expect(regions.every(r=>Number.isFinite(r.mapping.scale)&&r.mapping.scale>0)).toBe(true);
});
