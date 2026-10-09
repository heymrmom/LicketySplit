import type {SyncProject} from './types.js';
/** Once examined as validation, a source interval must never become training on
 * a retry merely because the latest report uses a different set of positions. */
export function validationReservations(p:SyncProject) {
 const checks=[...(p.reviewChecks||[]).flatMap(c=>[c,...(c.candidates||[]).map(candidate=>({...candidate,assetId:c.assetId,windowSeconds:c.windowSeconds}))]),...(p.regionEvidence||[]).filter(e=>e.role==='validation')];
 const rows=[...(p.validationReservations||[]),...checks.flatMap(c=>{
  const ref=p.channels?.find(r=>r.id===c.referenceChannelId);
  return [{assetId:c.assetId,sourceSeconds:c.sourceSeconds,windowSeconds:c.windowSeconds},
   ...(ref?[{assetId:ref.assetId,sourceSeconds:c.referenceSeconds,windowSeconds:c.windowSeconds+.12}]:[])];
 }),...(p.edges||[]).flatMap(e=>e.anchors.filter(a=>a.role==='validation').flatMap(a=>[
  {assetId:e.a,sourceSeconds:a.referenceSeconds,windowSeconds:a.windowSeconds},
  {assetId:e.b,sourceSeconds:a.sourceSeconds,windowSeconds:a.windowSeconds}]))];
 return [...new Map(rows.map(r=>[`${r.assetId}:${r.sourceSeconds}:${r.windowSeconds}`,r])).values()];
}
