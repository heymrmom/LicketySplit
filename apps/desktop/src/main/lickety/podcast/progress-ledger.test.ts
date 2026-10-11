import { describe, it, expect } from 'vitest';
import { PodcastWorkLedger } from './progress-ledger';

describe('whole-run work ledger', () => {
  it('keeps a fixed denominator across phases, cache hits, and adaptive work and ends only after save', () => {
    const events: any[] = [];
    const ledger = new PodcastWorkLedger(['a', 'b'], event => events.push(event));
    const event = {phase:'features' as const,completed:1,total:2,message:'working'};
    ledger.report(event, 'features:a', 'running', .5);
    ledger.report({...event,phase:'inspect',completed:0}, 'inspect:b', 'done');
    ledger.report(event, 'features:a', 'reused');
    ledger.report(event, 'features:a', 'running', .1);
    const totals = events.map(e => e.work.total);
    expect(new Set(totals).size).toBe(1);
    expect(events.map(e=>e.work.completed)).toEqual([...events.map(e=>e.work.completed)].sort((a,b)=>a-b));
    expect(events.at(-1).work.items.find((i:any)=>i.id==='features:a').status).toBe('reused');
    for(const item of ledger.snapshot().items.filter(i=>i.id!=='save')) ledger.report(event,item.id,'skipped');
    expect(ledger.snapshot().completed).toBeLessThan(ledger.snapshot().total);
    ledger.report({...event,phase:'done'},'save','done');
    expect(ledger.snapshot().completed).toBe(ledger.snapshot().total);
  });
  it('keeps failed or canceled work below complete and snapshots isolated', () => {
    const ledger = new PodcastWorkLedger(['a'],()=>{});
    ledger.report({phase:'inspect',completed:0,total:1,message:'read'},'inspect:a','running',.2);
    ledger.fail();
    expect(ledger.snapshot().items.find(i=>i.id==='inspect:a')?.status).toBe('failed');
    const copy=ledger.snapshot();copy.items[0].status='done';
    expect(ledger.snapshot().items[0].status).toBe('failed');
    expect(ledger.snapshot().completed).toBeLessThan(ledger.snapshot().total);
    const canceled=new PodcastWorkLedger(['b'],()=>{});canceled.fail(true);
    expect(canceled.snapshot().items.every(item=>item.status==='canceled')).toBe(true);
    expect(canceled.snapshot().completed).toBe(0);
  });
});
