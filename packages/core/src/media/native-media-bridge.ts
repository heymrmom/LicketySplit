// Renderer-side bridge to the desktop native FFmpeg sidecar (window.openreel.media).
// packages/core cannot see apps/web's ambient window.openreel type, so we declare the
// minimal slice this module uses and access it via a typed cast on globalThis.

export interface NativeMediaBridge {
  platform?: string;
  fs: {
    tempFilePath(ext: string): Promise<string>;
    openWrite(path: string): Promise<string>;
    writeChunk(handleId: string, data: ArrayBuffer, position: number): Promise<void>;
    closeWrite(handleId: string): Promise<void>;
    readFileBytes(path: string): Promise<ArrayBuffer>;
  };
  media: {
    inspectFile?(file:File):Promise<import("./types").MediaTrackInfo|null>;
    inspectPath?(args:{srcPath:string}):Promise<import("./types").MediaTrackInfo>;
    probeFile?(file:File):Promise<{streams:{index:number;codec:string;channels:number;sampleRate:number}[]}|null>;
    generateProxy(args: { srcPath: string; preset: "low" | "medium" | "high" }): Promise<{ outPath: string }>;
    transcode(args: {
      srcPath: string;
      container?: "mp4" | "webm" | "mov";
      videoBitrateKbps?: number;
      audioBitrateKbps?: number;
    }): Promise<{ outPath: string }>;
    extractAudioWav(args: { srcPath: string; streamIndex?: number }): Promise<{ outPath: string }>;
    probeAudioStreams(args: { srcPath: string }): Promise<{
      streams: { index: number; codec: string; channels: number; sampleRate: number; language?: string }[];
    }>;
  };
}

export function getBridge(): NativeMediaBridge | undefined {
  const w = globalThis as unknown as { openreel?: Partial<NativeMediaBridge> };
  const o = w.openreel;
  if (o && o.platform === "desktop" && o.fs && o.media) {
    return o as NativeMediaBridge;
  }
  return undefined;
}

export function nativeMediaAvailable(): boolean {
  return getBridge() !== undefined;
}

function extensionFor(file: File | Blob): string {
  const name = (file as File).name;
  if (name && name.includes(".")) return name.slice(name.lastIndexOf(".") + 1);
  const t = file.type;
  if (t.includes("mp4")) return "mp4";
  if (t.includes("webm")) return "webm";
  if (t.includes("quicktime") || t.includes("mov")) return "mov";
  if (t.includes("wav")) return "wav";
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  return "bin";
}

const materializedOriginals=new WeakMap<Blob,string>();
export function getMaterializedOriginal(file:Blob):string|undefined{return materializedOriginals.get(file);}

// Stream a File/Blob to a temp file on disk (chunked — bounded peak memory) and return its path.
export async function materializeToTemp(bridge: NativeMediaBridge, file: File | Blob): Promise<string> {
  const tmpPath = await bridge.fs.tempFilePath(extensionFor(file));
  const handleId = await bridge.fs.openWrite(tmpPath);
  const reader = file.stream().getReader();
  let position = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const view = value as Uint8Array;
      for(let offset=0;offset<view.byteLength;offset+=16*1024**2){const piece=view.subarray(offset,offset+16*1024**2);const buf=piece.buffer.slice(piece.byteOffset,piece.byteOffset+piece.byteLength) as ArrayBuffer;await bridge.fs.writeChunk(handleId,buf,position);position+=piece.byteLength;}
    }
    await bridge.fs.closeWrite(handleId);
  } catch (err) {
    await bridge.fs.closeWrite(handleId).catch(() => {});
    throw err;
  }
  materializedOriginals.set(file,tmpPath);
  return tmpPath;
}

export async function readBackBlob(bridge: NativeMediaBridge, outPath: string, mime: string): Promise<Blob> {
  const bytes = await bridge.fs.readFileBytes(outPath);
  return new Blob([bytes], { type: mime });
}

export async function proxyViaNative(file: File | Blob, preset: "low" | "medium" | "high"): Promise<Blob> {
  const bridge = getBridge();
  if (!bridge) throw new Error("native media bridge unavailable");
  const srcPath = await materializeToTemp(bridge, file);
  const { outPath } = await bridge.media.generateProxy({ srcPath, preset });
  return readBackBlob(bridge, outPath, "video/mp4");
}

export async function transcodeViaNative(
  file: File | Blob,
  opts: { container: "mp4" | "webm" | "mov"; videoBitrateKbps: number; audioBitrateKbps: number },
): Promise<Blob> {
  const bridge = getBridge();
  if (!bridge) throw new Error("native media bridge unavailable");
  const srcPath = await materializeToTemp(bridge, file);
  const { outPath } = await bridge.media.transcode({ srcPath, ...opts });
  const mime = opts.container === "webm" ? "video/webm" : opts.container === "mov" ? "video/quicktime" : "video/mp4";
  return readBackBlob(bridge, outPath, mime);
}

export class NoAudioStreamError extends Error {
  constructor(message = "media has no matching audio stream") {
    super(message);
    this.name = "NoAudioStreamError";
  }
}

export async function extractAudioWavViaNative(file: File | Blob, streamIndex?: number): Promise<Blob> {
  const bridge = getBridge();
  if (!bridge) throw new Error("native media bridge unavailable");
  const srcPath = await materializeToTemp(bridge, file);
  const { streams } = await bridge.media.probeAudioStreams({ srcPath });
  if (streams.length === 0 || (streamIndex ?? 0) >= streams.length) {
    throw new NoAudioStreamError();
  }
  const { outPath } = await bridge.media.extractAudioWav({ srcPath, streamIndex });
  return readBackBlob(bridge, outPath, "audio/wav");
}

export async function probeAudioStreamCountViaNative(file: File | Blob): Promise<number> {
  const bridge = getBridge();
  if (!bridge) throw new Error("native media bridge unavailable");
  const direct=typeof File!=="undefined"&&file instanceof File?await bridge.media.probeFile?.(file):undefined;
  if(direct)return direct.streams.length;
  const srcPath = await materializeToTemp(bridge, file);
  const { streams } = await bridge.media.probeAudioStreams({ srcPath });
  return streams.length;
}

// Compatibility previews retain the File selected by the user as their analysis/export original.
const nativeOriginalFiles=new WeakMap<Blob,Blob>();
export function bindNativeOriginalFile(runtime:Blob,original:Blob):void {nativeOriginalFiles.set(runtime,original);}
export function getNativeOriginalFile(runtime:Blob):Blob|undefined {return nativeOriginalFiles.get(runtime);}

// Disk URLs are local runtime bindings, never portable media replacements.
const nativeSources = new WeakMap<Blob, {original:Promise<string>;preview:Promise<string>}>();
export function bindNativeMediaSources(blob:Blob,original:Promise<string>,preview:Promise<string>):void {
 original.catch(()=>{});preview.catch(()=>{});nativeSources.set(blob,{original,preview});
}
export function getNativeMediaSource(blob:Blob,purpose:'preview'|'export'='preview'):Promise<string|undefined> {
 const binding=nativeSources.get(blob);return binding ? (purpose==='export'?binding.original:binding.preview) : Promise.resolve(undefined);
}
export async function nativeVideoUrl(blob:Blob,purpose:'preview'|'export'='preview'):Promise<string>{return (await getNativeMediaSource(blob,purpose))??URL.createObjectURL(blob);}
export interface ManagedRendererBridge {
 referenceFile?(mediaId:string,file:File):Promise<{originalUri:string}|null>;
 referencePath?(mediaId:string,path:string):Promise<{originalUri:string}>;
 originalUri?(mediaId:string):Promise<string|undefined>;
 ensureAudioStream?(assetId:string,trackIndex:number):Promise<string>;
 cancelMedia?(assetId:string):Promise<void>;
 audioWindow?(args:{requestId?:string;assetId:string;trackIndex:number;startMs:number;durationMs:number;sampleRate:1000|16000|48000;channels:1|2}):Promise<{channels:Float32Array[];sampleRate:number}>;
 registerFile(mediaId:string,file:Blob):Promise<import('../lickety/types').RegisteredAsset>;
 registerPath(mediaId:string,path:string):Promise<import('../lickety/types').RegisteredAsset>;
 findAsset(mediaId:string):Promise<import('../lickety/types').RegisteredAsset|undefined>;
 resolve(assetId:string,purpose:'original'|'proxy'):Promise<string>;
}
export function getManagedBridge():ManagedRendererBridge|undefined {return (globalThis as unknown as {openreel?:{platform?:string;lickety?:ManagedRendererBridge}}).openreel?.lickety;}
export async function prepareNativeOriginal(item:import('../types/project').MediaItem):Promise<import('../types/project').MediaItem>{
 const managed=getManagedBridge();if(!managed)return item;
 const runtimeBlob=item.blob??await item.fileHandle?.getFile();
 const blob=runtimeBlob?(getNativeOriginalFile(runtimeBlob)??runtimeBlob):undefined;
 let asset=item.nativeSource??await managed.findAsset(item.id);
 if(blob&&typeof File!=="undefined"&&blob instanceof File&&!nativeSources.has(runtimeBlob??blob)){try{asset=await managed.registerFile(item.id,blob);}catch(error){const bridge=getBridge();if(!bridge)throw error;asset=await managed.registerPath(item.id,await materializeToTemp(bridge,blob));}}
 if(!asset){if(!blob)throw new Error(`Relink original ${item.name} before exporting`);try{asset=await managed.registerFile(item.id,blob);}catch(e){const bridge=getBridge();if(!bridge)throw e;asset=await managed.registerPath(item.id,await materializeToTemp(bridge,blob));}}
 const uri=await managed.resolve(asset.identity.assetId,'original');const bindingBlob=runtimeBlob??blob??new Blob([]);
 if(!nativeSources.has(bindingBlob))bindNativeMediaSources(bindingBlob,Promise.resolve(uri),Promise.resolve(uri));
 return {...item,blob:bindingBlob,nativeSource:asset,isPlaceholder:false};
}
