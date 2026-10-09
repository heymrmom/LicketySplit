import { describe, it, expect } from 'vitest';
import { makeWorkflowFixture } from './test-fixtures';
import { ProjectSerializer } from '../storage/project-serializer';
import { cloneProjectForWorkflow as cloneProjectForEdit } from './clone-project';
import type { IStorageEngine } from '../storage/types';
const serializer = new ProjectSerializer({} as IStorageEngine);
describe('portable workflow contracts', () => {
 it('preserves original media objects when cloned', () => { const p=makeWorkflowFixture(); expect(cloneProjectForEdit(p).mediaLibrary.items[0]).toBe(p.mediaLibrary.items[0]); });
 it('loads old project without workflow state', () => {const p=serializer.importFromJson(JSON.stringify({version:'1.2.0',project:makeWorkflowFixture()}));expect(p.lickety).toBeUndefined();});
 it('roundtrips stable word IDs and declares reader capability', () => {
 const p={...makeWorkflowFixture(),lickety:{schemaVersion:1 as const,words:[{occurrenceId:'o1',sourceWordId:'w1',text:'hello',startMs:100,endMs:200}]}};
 const json=serializer.exportToJson(p); expect(JSON.parse(json)).toMatchObject({version:'1.4.0',minimumReaderVersion:'1.3.0',capabilities:['licketysplit-workflows-v1']}); expect(serializer.importFromJson(json).lickety?.words?.[0].sourceWordId).toBe('w1');
 });
 it('rejects a newer reader even in nested project metadata', () => {expect(()=>serializer.importFromJson(JSON.stringify({version:'1.3.0',project:{...makeWorkflowFixture(),minimumReaderVersion:'1.5.0'}}))).toThrow(/reader/);});
});
