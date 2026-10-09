import type { SyncEdge, SyncPlacement, SyncProject } from './types.js';
import { projectTime } from './time.js';

/** Solve one offset/rate per confirmed recording clock. Relative channel starts
 * are constraints, not fabricated waveform observations. Validation never fits. */
export function refineClockNetwork(placements: Map<string, SyncPlacement>, edges: SyncEdge[], clockGroups: SyncProject['clockGroups'] = []) {
  const clockFor = (id: string) => clockGroups.find(g => g.confirmed && g.assetIds.includes(id));
  for (const component of new Set([...placements.values()].map(p => p.component))) {
    const nodes = [...placements.values()].filter(p => p.component === component && !p.regions && p.status !== 'excluded');
    const usable = (p: SyncPlacement) => p.status !== 'manual' || p.locked || Boolean(clockFor(p.assetId)?.sourceStarts);
    const fitting = edges.filter(e => e.basis !== 'recorder' && nodes.some(p => p.assetId === e.a && usable(p)) && nodes.some(p => p.assetId === e.b && usable(p)))
      .flatMap(e => e.anchors.filter(a => a.role === 'fit').map(anchor => ({ e, anchor })));
    const unitKey = (p: SyncPlacement) => clockFor(p.assetId)?.sourceStarts ? clockFor(p.assetId)!.id : p.assetId;
    const starts = (p: SyncPlacement) => clockFor(p.assetId)?.sourceStarts?.[p.assetId] || 0;
    const units = [...new Set(nodes.map(unitKey))].map(key => {
      const members = nodes.filter(p => unitKey(p) === key);
      const fixed = members.filter(p => p.assetId === component || p.locked || p.status === 'manual');
      const anchor = fixed[0] || members[0];
      const scale = anchor.mapping.scale, offset = anchor.mapping.offsetSeconds - scale * starts(anchor);
      if (fixed.some(p => Math.abs(p.mapping.scale-scale)>1e-10 || Math.abs(p.mapping.offsetSeconds-scale*starts(p)-offset)>1e-7)) throw new Error('Confirmed recorder timing conflicts with a manual placement. Review the recording relationship in Setup.');
      for (const p of members) p.mapping = {version:1,scale,offsetSeconds:offset+scale*starts(p)};
      const times = fitting.flatMap(({e,anchor:a}) => members.some(p => p.assetId===e.a) ? [a.referenceSeconds+starts(placements.get(e.a)!)] : members.some(p=>p.assetId===e.b) ? [a.sourceSeconds+starts(placements.get(e.b)!)] : []);
      return { key, members, fixed: fixed.length>0, center: times.reduce((s,t)=>s+t,0)/Math.max(1,times.length) };
    });
    const free = units.filter(u => !u.fixed), indices = new Map(free.map((u,i)=>[u.key,i]));
    const slopes = new Map<string,number>(); let variables=free.length;
    for (const u of free) {
      const clock=clockFor(u.members[0].assetId), key=clock?.id || u.key;
      const members=clock ? nodes.filter(p=>clock.assetIds.includes(p.assetId)) : u.members;
      const fixed=members.filter(p=>p.assetId===component || p.locked || p.status==='manual');
      if (fixed.some(p=>Math.abs(p.mapping.scale-fixed[0].mapping.scale)>1e-10)) throw new Error('Confirmed recorder clock conflicts with locked/manual rates.');
      const common=fixed[0]?.mapping.scale ?? members[0].mapping.scale;
      for (const p of u.members) {
        p.mapping.offsetSeconds+=(p.mapping.scale-common)*(u.center-starts(p));p.mapping.scale=common;
      }
      if (!fixed.length && !slopes.has(key)) slopes.set(key,variables++);
    }
    if (!variables || !fitting.length) continue;
    const unitFor=(id:string)=>units.find(u=>u.members.some(p=>p.assetId===id))!;
    const slopeFor=(id:string)=>slopes.get(clockFor(id)?.id || unitKey(placements.get(id)!));
    const rows=fitting.map(({e,anchor:a})=>{
      const pa=placements.get(e.a)!,pb=placements.get(e.b)!,coefficients=new Float64Array(variables);
      for (const [p,t,sign] of [[pa,a.referenceSeconds,1],[pb,a.sourceSeconds,-1]] as const) {
        const u=unitFor(p.assetId),i=indices.get(u.key);if(i===undefined)continue;
        coefficients[i]+=sign;const slope=slopeFor(p.assetId);
        if(slope!==undefined)coefficients[slope]+=sign*(t+starts(p)-u.center)/1000;
      }
      return {coefficients,target:projectTime(a.sourceSeconds,pb.mapping)-projectTime(a.referenceSeconds,pa.mapping),weight:Math.max(.05,a.score*a.score)};
    });
    let solution=new Float64Array(variables);
    for(let iteration=0;iteration<8;iteration++) {
      const n=variables,matrix=Array.from({length:n},()=>new Float64Array(n+1));
      for(const row of rows) {
        const residual=row.coefficients.reduce((s,v,i)=>s+v*solution[i],0)-row.target;
        const weight=row.weight*Math.min(1,.0025/Math.max(1e-12,Math.abs(residual)));
        for(let i=0;i<n;i++)if(row.coefficients[i]) {
          matrix[i][n]+=weight*row.coefficients[i]*row.target;
          for(let j=0;j<n;j++)if(row.coefficients[j])matrix[i][j]+=weight*row.coefficients[i]*row.coefficients[j];
        }
      }
      for(let i=0;i<n;i++)matrix[i][i]+=1e-10;
      for(let i=0;i<n;i++) {
        let pivot=i;for(let j=i+1;j<n;j++)if(Math.abs(matrix[j][i])>Math.abs(matrix[pivot][i]))pivot=j;
        [matrix[i],matrix[pivot]]=[matrix[pivot],matrix[i]];
        const divisor=matrix[i][i];for(let k=i;k<=n;k++)matrix[i][k]/=divisor;
        for(let j=0;j<n;j++)if(j!==i){const f=matrix[j][i];for(let k=i;k<=n;k++)matrix[j][k]-=f*matrix[i][k];}
      }
      solution=Float64Array.from(matrix,r=>r[n]);
    }
    for(const u of free)for(const p of u.members) {
      const i=indices.get(u.key)!,slope=slopeFor(p.assetId),ds=slope===undefined?0:solution[slope]/1000;
      if(!Number.isFinite(ds)||!Number.isFinite(solution[i])||p.mapping.scale+ds<=0)continue;
      p.mapping={version:1,scale:p.mapping.scale+ds,offsetSeconds:p.mapping.offsetSeconds+solution[i]+ds*(starts(p)-u.center)};
      p.provenance.push(`robust-network-fit:${fitting.length}-fit-anchors; validation-held-out`);
    }
  }
}
