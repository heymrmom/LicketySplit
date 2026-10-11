import type { PodcastWorkItem, PodcastWorkProgress } from '../../../../../../packages/core/src/lickety/podcast-types';
import type { PodcastProgressUpdate } from './engine';

const terminal = (state: PodcastWorkItem['status']) => ['done', 'reused', 'skipped'].includes(state);
/** Fixed equal-weight work units, not a prediction of elapsed time. Adaptive
 * checks stay within their planned per-recording parent; save is the final unit. */
export class PodcastWorkLedger {
  private items: PodcastWorkItem[] = [];
  private last: PodcastProgressUpdate = { phase: 'inspect', completed: 0, total: 0, message: 'Planning line-up work' };
  constructor(assetIds: string[], private readonly publish: (event: PodcastProgressUpdate) => void) {
    const ids = [...new Set(assetIds)];
    const add = (id: string, assets: string[], stage: PodcastWorkItem['stage']) => this.items.push({ id, assetIds: assets, stage, status: 'queued', completed: 0, total: 1 });
    for (const id of ids) for (const stage of ['inspect','features','validate','regions'] as const) add(`${stage}:${id}`, [id], stage);
    for (let i=0;i<ids.length;i++) for(let j=i+1;j<ids.length;j++) add(`match:${ids[i]}:${ids[j]}`, [ids[i],ids[j]], 'match');
    add('save', ids, 'save');
  }
  snapshot(): PodcastWorkProgress {
    return { completed: this.items.reduce((sum,item)=>sum+item.completed,0), total: this.items.length, items: structuredClone(this.items) };
  }
  report(event: PodcastProgressUpdate, id?: string, status: PodcastWorkItem['status']='running', fraction=0): void {
    if (id) {
      const item=this.items.find(item=>item.id===id);
      if (!item) throw new Error(`Unplanned line-up work: ${id}`);
      if (!terminal(item.status)) {
        item.status=status;
        item.completed=terminal(status)?1:Math.max(item.completed,Math.min(.999,Math.max(0,Number.isFinite(fraction)?fraction:0)));
      }
    }
    this.last=event;
    this.publish({...event,work:this.snapshot()});
  }
  finishStage(stage: PodcastWorkItem['stage'], status: 'done'|'skipped'='done'): void {
    for (const item of this.items.filter(item=>item.stage===stage&&!terminal(item.status))) this.report(this.last,item.id,status === "done" && item.status === "queued" ? "skipped" : status);
  }
  fail(canceled = false): void {
    for (const item of this.items) if(item.status==='running' || canceled && item.status==='queued') item.status=canceled ? 'canceled' : 'failed';
    this.publish({...this.last,work:this.snapshot()});
  }
}
