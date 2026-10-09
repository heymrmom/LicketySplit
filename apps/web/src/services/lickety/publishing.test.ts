import type {LLMTurnInput} from "@openreel/agent";
import {it,expect} from 'vitest';import {generatePublishingPackage,preparePublishingForExport} from './publishing';
it('only sends retained final words and never calls AI when unchecked',async()=>{let calls=0,prompt='';const words=[{occurrenceId:'o',sourceWordId:'w',text:'retained',startMs:100,endMs:500}];const llm={complete:async(input:LLMTurnInput)=>{calls++;prompt=JSON.stringify(input.messages);return {text:'',stopReason:'tool_use' as const,toolUses:[{id:'t',name:'submit_publishing',input:{schemaVersion:1,snapshotHash:'final',titles:['Title'],youtubeDescription:'retained',chapters:[],tags:[],spotifyNotes:'Notes',thumbnailIdeas:[],pinnedComments:[]}}]};}};await preparePublishingForExport({} as never,{generatePublishing:false,exportPath:'/tmp/video.mp4'});expect(calls).toBe(0);await generatePublishingPackage(words,'final',1000,llm,{provider:'openai'});expect(calls).toBe(1);expect(prompt).toContain('retained');expect(prompt).not.toContain('discarded');});

it('reuses identical successful copy and rejects stale dialogue before spending', async () => {
  const { webcrypto } = await import('node:crypto');
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  const { makeWorkflowFixture } = await import('@openreel/core/lickety/test-fixtures');
  const { snapshotDialogue } = await import('./transcription');
  const { useProjectStore } = await import('../../stores/project-store');
  const { useSettingsStore } = await import('../../stores/settings-store');
  const files = new Map<string, string>();
  let requests = 0;
  Object.assign(window, { openreel: {
    platform: 'desktop',
    lickety: { findAsset: async (mediaId: string) => ({ identity: { assetId: mediaId, mediaId, sha256: 'sha', byteLength: 1 }, originalUri: 'opaque', durationMs: 20000 }) },
    fs: { writeFile: async (file: string, text: string) => { files.set(file, text); }, readFile: async (file: string) => files.get(file) ?? '' },
    cloud: { fetch: async (_service: string, _path: string, args: { body: string }) => {
      requests++;
      const body = JSON.parse(args.body);
      const payload = JSON.parse(body.messages.at(-1).content);
      const copy = { schemaVersion: 1, snapshotHash: payload.snapshotHash, titles: ['Title'], youtubeDescription: 'Retained only', chapters: [], tags: [], spotifyNotes: 'Notes', thumbnailIdeas: [], pinnedComments: [] };
      return { status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'submit_publishing', arguments: JSON.stringify(copy) } }] }, finish_reason: 'tool_calls' }] }) };
    } }
  } });
  useSettingsStore.setState({ defaultLlmProvider: 'openai-compatible', llmBaseUrl: 'https://fixture.invalid/v1', llmModel: 'fixture-model' });
  const source = makeWorkflowFixture();
  const snapshot = await snapshotDialogue(source);
  const project = { ...source, lickety: { schemaVersion: 1 as const, snapshot, transcript: { schemaVersion: 1 as const, snapshotHash: snapshot.revisionHash, provider: 'assemblyai' as const, providerJobId: 'j', preparedAudioSha256: 'a', words: [{ id: 'w', text: 'retained', startMs: 100, endMs: 500, confidence: .99 }] } } };
  useProjectStore.setState({ project });
  await preparePublishingForExport(project, { generatePublishing: true, exportPath: '/tmp/video.mp4' });
  await preparePublishingForExport(useProjectStore.getState().project, { generatePublishing: true, exportPath: '/tmp/video.mp4' });
  expect(requests).toBe(1);
  expect(files.size).toBe(8);
  const changed = { ...project, timeline: { ...project.timeline, tracks: project.timeline.tracks.map(t => t.id === 'Alice' ? { ...t, clips: [] } : t) } };
  await expect(preparePublishingForExport(changed, { generatePublishing: true, exportPath: '/tmp/video.mp4' })).rejects.toThrow(/Dialogue changed/);
  expect(requests).toBe(1);
});
