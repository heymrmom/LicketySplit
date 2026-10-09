import {it,expect,vi,afterEach} from 'vitest';import {AudioEngine} from './audio-engine';import {makeWorkflowFixture} from '../lickety/test-fixtures';
afterEach(()=>{delete (globalThis as unknown as {openreel?:unknown}).openreel;});
it.each([20,7200])('native source of %s seconds uses bounded original ranges, not a full source read',async(durationSec)=>{const p=makeWorkflowFixture({durationSec});const media={...p.mediaLibrary.items[2],blob:new Blob(['source']),nativeSource:{identity:{assetId:'a',mediaId:'mic-alice',sha256:'sha',byteLength:1},originalUri:'opaque',durationMs:7200000}};const full=vi.spyOn(media.blob,'arrayBuffer').mockRejectedValue(new Error('full decode forbidden'));const calls:number[]=[];(globalThis as unknown as {openreel:unknown}).openreel={platform:'desktop',lickety:{resolve:async()=>media.nativeSource.originalUri,audioWindow:async(args:{durationMs:number})=>{calls.push(args.durationMs);return {channels:[new Float32Array(args.durationMs*48)],sampleRate:48000};}}};const parameter={value:1,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn(),setValueCurveAtTime:vi.fn()};const context={createGain:()=>({gain:{...parameter},connect:vi.fn()}),createStereoPanner:()=>({pan:{...parameter},connect:vi.fn()}),destination:{},createBuffer:(channels:number,length:number,sampleRate:number)=>({duration:length/sampleRate,getChannelData:()=>new Float32Array(length),numberOfChannels:channels,sampleRate}),createBufferSource:()=>({connect:vi.fn(),start:vi.fn(),playbackRate:{value:1}})};const engine=new AudioEngine();await (engine as unknown as {renderClipToContext(ctx:unknown,item:unknown,info:unknown,start:number):Promise<void>}).renderClipToContext(context,media,{mediaId:media.id,timelineStartTime:0,duration:10,sourceTime:3000,volume:1,pan:0,effects:[],fadeIn:0,fadeOut:0,clipOffset:0,clipDuration:7200,speed:1,reversed:false},0);expect(calls).toEqual([10000]);expect(full).not.toHaveBeenCalled();});

it("unsupported long range effects require a rendered stem without dropping effects",async()=>{const media=makeWorkflowFixture({durationSec:7200}).mediaLibrary.items[2];(globalThis as unknown as {openreel:unknown}).openreel={platform:"desktop",lickety:{}};const engine=new AudioEngine();await expect((engine as unknown as {renderClipToContext(ctx:unknown,item:unknown,info:unknown,start:number):Promise<void>}).renderClipToContext({},media,{effects:[{type:"reverb",enabled:true}],duration:10},0)).rejects.toThrow(/preserve filter continuity/);});

it("routes a constant-speed clip to the selected original channel with source-time offsets",async()=>{const project=makeWorkflowFixture({durationSec:7200});const media={...project.mediaLibrary.items[2],blob:new Blob(["source"]),nativeSource:{identity:{assetId:"asset",mediaId:"mic-alice",sha256:"sha",byteLength:1},originalUri:"opaque",durationMs:7200000}};const windows:Array<{startMs:number;durationMs:number;sourceChannelIndex?:number}>=[];const starts:number[][]=[];(globalThis as unknown as {openreel:unknown}).openreel={platform:"desktop",lickety:{resolve:async()=>"opaque",audioWindow:async(args:{startMs:number;durationMs:number;sourceChannelIndex?:number})=>{windows.push(args);return {channels:[new Float32Array(args.durationMs*48)],sampleRate:48000};}}};const parameter={value:1,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn(),setValueCurveAtTime:vi.fn()};const context={createGain:()=>({gain:{...parameter},connect:vi.fn()}),createStereoPanner:()=>({pan:{...parameter},connect:vi.fn()}),destination:{},createBuffer:(channels:number,length:number,sampleRate:number)=>({duration:length/sampleRate,getChannelData:()=>new Float32Array(length),numberOfChannels:channels,sampleRate}),createBufferSource:()=>({connect:vi.fn(),start:(...args:number[])=>starts.push(args),playbackRate:{value:1}})};const engine=new AudioEngine();await (engine as unknown as {renderClipToContext(ctx:unknown,item:unknown,info:unknown,start:number):Promise<void>}).renderClipToContext(context,media,{mediaId:media.id,timelineStartTime:0,duration:10,sourceTime:3,volume:1,pan:0,effects:[],fadeIn:0,fadeOut:0,clipOffset:0,clipDuration:10,speed:2,reversed:false,audioTrackIndex:1,sourceChannelIndex:1},0);expect(windows.map(({startMs,durationMs,sourceChannelIndex})=>({startMs,durationMs,sourceChannelIndex}))).toEqual([{startMs:3000,durationMs:10000,sourceChannelIndex:1},{startMs:13000,durationMs:10000,sourceChannelIndex:1}]);expect(starts).toEqual([[0,0,10],[5,0,10]]);});

it("converts timeline offsets to source offsets using the clip speed",()=>{const project=makeWorkflowFixture();const track=project.timeline.tracks.find(item=>item.id==="Alice")!;const clip={...track.clips[0]!,startTime:1,inPoint:2,speed:2,sourceChannelIndex:1};const renderInfo=(new AudioEngine() as unknown as {createClipRenderInfo(clip:unknown,start:number,end:number,timeline:unknown,track:unknown):{sourceTime:number;sourceChannelIndex?:number}}).createClipRenderInfo(clip,3,4,project.timeline,track);expect(renderInfo).toMatchObject({sourceTime:6,sourceChannelIndex:1});});

it("selects a source channel before decoding short effect-processed multichannel originals",async()=>{const project=makeWorkflowFixture({durationSec:20});const media={...project.mediaLibrary.items[2],blob:new Blob(["source"]),metadata:{...project.mediaLibrary.items[2]!.metadata,duration:20},nativeSource:{identity:{assetId:"asset",mediaId:"mic-alice",sha256:"sha",byteLength:1},originalUri:"opaque",durationMs:20000}};const calls:Array<{startMs:number;sourceChannelIndex?:number;channels:number}>=[];(globalThis as unknown as {openreel:unknown}).openreel={platform:"desktop",lickety:{resolve:async()=>"opaque",audioWindow:async(args:{startMs:number;sourceChannelIndex?:number;channels:number;durationMs:number})=>{calls.push(args);return {channels:[new Float32Array(args.durationMs*48)],sampleRate:48000};}}};const parameter={value:1,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn(),setValueCurveAtTime:vi.fn()};const context={createGain:()=>({gain:{...parameter},connect:vi.fn()}),createStereoPanner:()=>({pan:{...parameter},connect:vi.fn()}),destination:{},createBuffer:(channels:number,length:number,sampleRate:number)=>({duration:length/sampleRate,length, getChannelData:()=>new Float32Array(length),numberOfChannels:channels,sampleRate}),createBufferSource:()=>({connect:vi.fn(),start:vi.fn(),playbackRate:{value:1}})};const engine=new AudioEngine();await (engine as unknown as {renderClipToContext(ctx:unknown,item:unknown,info:unknown,start:number):Promise<void>}).renderClipToContext(context,media,{mediaId:media.id,timelineStartTime:0,duration:5,sourceTime:0,volume:1,pan:0,effects:[{type:"reverb",enabled:true}],fadeIn:0,fadeOut:0,clipOffset:0,clipDuration:5,speed:1,reversed:false,audioTrackIndex:0,sourceChannelIndex:2},0);expect(calls.map(({startMs,sourceChannelIndex,channels})=>({startMs,sourceChannelIndex,channels}))).toEqual([{startMs:0,sourceChannelIndex:2,channels:1},{startMs:10000,sourceChannelIndex:2,channels:1}]);});

it.each([false, true])("preserves enabled gain effects for drift-speed clips (native=%s)", async (native) => {
  const source = makeWorkflowFixture({ durationSec: native ? 7_200 : 20 }).mediaLibrary.items[2]!;
  const media = {
    ...source,
    blob: new Blob(["audio"]),
    metadata: { ...source.metadata, duration: native ? 7_200 : 20 },
    ...(native ? { nativeSource: { identity: { assetId: "asset", mediaId: source.id, sha256: "sha", byteLength: 1 }, originalUri: "opaque", durationMs: 7_200_000 } } : {}),
  };
  if (native) {
    (globalThis as unknown as { openreel: unknown }).openreel = {
      platform: "desktop",
      lickety: {
        resolve: async () => "opaque",
        audioWindow: async ({ durationMs }: { durationMs: number }) => ({ channels: [new Float32Array(Math.floor(durationMs * 48))], sampleRate: 48_000 }),
      },
    };
  }
  const buffers: Array<{ duration: number; length: number; sampleRate: number; numberOfChannels: number; getChannelData(channel: number): Float32Array }> = [];
  const makeBuffer = (channels: number, length: number, sampleRate: number) => {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    const buffer = { duration: length / sampleRate, length, sampleRate, numberOfChannels: channels, getChannelData: (channel: number) => data[channel]! };
    buffers.push(buffer);
    return buffer;
  };
  const parameter = { value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), setValueCurveAtTime: vi.fn() };
  const starts: number[][] = [];
  const context = {
    createGain: () => ({ gain: { ...parameter }, connect: vi.fn() }),
    createStereoPanner: () => ({ pan: { ...parameter }, connect: vi.fn() }),
    destination: {},
    createBuffer: makeBuffer,
    decodeAudioData: async () => makeBuffer(1, 3 * 48_000, 48_000),
    createBufferSource: () => ({ connect: vi.fn(), start: (...args: number[]) => starts.push(args), playbackRate: { value: 1 } }),
  };
  const engine = new AudioEngine();
  (engine as unknown as { audioContext: unknown }).audioContext = context;
  if (!native) (engine as unknown as { mediaBuffers: Map<string, AudioBuffer> }).mediaBuffers.set(`${media.id}:0:mix`, makeBuffer(1, 3 * 48_000, 48_000) as unknown as AudioBuffer);
  const applyEffectChain = vi.fn(async (buffer: AudioBuffer) => ({ buffer, appliedEffects: ["gain"] }));
  (engine as unknown as { effectsEngine: unknown }).effectsEngine = { applyEffectChain };
  const process = vi.spyOn(engine as unknown as { processClipBuffer: (...args: unknown[]) => Promise<unknown> }, "processClipBuffer");

  await (engine as unknown as { renderClipToContext(ctx: unknown, item: unknown, info: unknown, start: number): Promise<void> }).renderClipToContext(
    context,
    media,
    { mediaId: media.id, timelineStartTime: 0, duration: 2, sourceTime: 0.25, volume: 1, pan: 0, effects: [{ type: "gain", enabled: true, params: { value: 0.5 } }], fadeIn: 0, fadeOut: 0, clipOffset: 0, clipDuration: 2, speed: 0.9999, reversed: false },
    0,
  );

  expect(applyEffectChain).toHaveBeenCalledTimes(1);
  expect(applyEffectChain).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({ type: "gain", enabled: true })]);
  expect(process).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ speed: 1, duration: 2 * 0.9999 }));
  expect(starts[0]?.[2]).toBeCloseTo(2 * 0.9999, 4);
  if (native) expect(starts[0]?.[0]).toBe(0);
  expect(buffers.length).toBeGreaterThan(0);
});
