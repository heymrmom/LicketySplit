import type {ResourceProfile,RegisteredAsset,ProxyReceipt,AnalysisSnapshot,PreparedAudio,TranscriptDocument,JobState} from "@licketysplit/core/lickety/types";
import type { PodcastBridge } from "@licketysplit/core/lickety/podcast-types";
export {};

export interface LicketySplitHardwareInfo {
  cpu: { model: string; physicalCores: number; logicalCores: number };
  memory: { totalBytes: number; freeBytes: number };
  gpus: string[];
  encoders: string[];
  platform: "darwin" | "win32" | "linux";
  arch: string;
}

export interface LicketySplitExportStartArgs {
  width: number;
  height: number;
  frameRate: number;
  codec: string;
  format: string;
  bitrateKbps: number;
  outputPath: string;
  totalFrames: number;
  audioSampleRate: number;
  audioChannels: number;
  encodeMode?: "fast" | "balanced" | "smallest";
  quality?: number;
  proresProfile?: "proxy" | "lt" | "standard" | "hq" | "4444" | "4444xq";
}

export interface LicketySplitExportSession {
  jobId: string;
}

export interface LicketySplitAuroraRenderPreviewArgs {
  scene: unknown;
  assets: unknown[];
  width: number;
  height: number;
  background?: string;
  timeSeconds?: number;
  quality?: "preview" | "final";
}

export interface LicketySplitAuroraPreviewSessionStartArgs
  extends LicketySplitAuroraRenderPreviewArgs {
  sessionId?: string;
}

export interface LicketySplitAuroraPreviewSessionStartResult {
  sessionId: string;
}

export interface LicketySplitAuroraSequenceSessionStartArgs
  extends Omit<LicketySplitAuroraRenderPreviewArgs, "timeSeconds"> {
  sessionId?: string;
  frameRate: number;
  durationSeconds: number;
}

export interface LicketySplitAuroraSequenceSessionStartResult {
  sessionId: string;
}

export interface LicketySplitAuroraRenderPreviewResult {
  backend: "native" | "cpu";
  pngBase64: string;
  dataUri: string;
  width: number;
  height: number;
  coveredPixels: number;
  shadowedPixels: number;
  renderMs: number;
}

export type LicketySplitAuroraPreviewSessionEvent =
  | {
      kind: "update";
      sessionId: string;
      stage: "draft" | "refine" | "final";
      progress: number;
      done: boolean;
      targetWidth: number;
      targetHeight: number;
      result: LicketySplitAuroraRenderPreviewResult;
    }
  | {
      kind: "error";
      sessionId: string;
      done: true;
      error: string;
    };

export type LicketySplitAuroraSequenceSessionEvent =
  | {
      kind: "frame";
      sessionId: string;
      frameIndex: number;
      totalFrames: number;
      timeSeconds: number;
      progress: number;
      done: boolean;
      result: {
        backend: "native" | "cpu";
        rgba: Uint8Array;
        width: number;
        height: number;
        coveredPixels: number;
        shadowedPixels: number;
        renderMs: number;
      };
    }
  | {
      kind: "error";
      sessionId: string;
      done: true;
      error: string;
    };

export interface LicketySplitMcpStatus {
  running: boolean;
  url: string;
  port: number;
  token: string;
  shimPath: string;
  endpointFile: string;
}

export interface LicketySplitRiggingBackendProbe {
  available: boolean;
  provider: "blender";
  mode?: "configured" | "bundled" | "system";
  path?: string;
  version?: string;
  error?: string;
}

export interface LicketySplitRiggingWarning {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface LicketySplitRigHumanoidModelArgs {
  modelUrl: string;
  outputPath?: string;
  name?: string;
  heightMeters?: number;
  overwriteExisting?: boolean;
}

export interface LicketySplitRigHumanoidModelResult {
  ok: boolean;
  provider: "blender";
  inputUrl: string;
  outputUrl?: string;
  outputPath?: string;
  armatureName?: string;
  createdArmature: boolean;
  preservedExistingArmature: boolean;
  skinnedMeshCount: number;
  meshCount: number;
  boneCount: number;
  warnings: LicketySplitRiggingWarning[];
  error?: string;
}

export type LicketySplitUpdaterStatus =
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "none" }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

declare global {
  interface Window {
    licketysplit?: {
      platform: "desktop";
      lickety?: {
        reconcileTranscription(jobId:string,providerJobId:string):Promise<void>;
        assemblyKeyStatus():Promise<boolean>;
        startTranscription(args:{audio:PreparedAudio;snapshot:AnalysisSnapshot;mode:"mixed"|"isolated-stereo";participants?:{channel:1|2;participantId:string}[];confirmationId:string}):Promise<{jobId:string}>;
        cancelTranscription(jobId:string):Promise<void>;
        resumeTranscription(jobId:string):Promise<void>;
        prepareAudio(args:{snapshot:AnalysisSnapshot;options:{mode:"mixed"|"isolated-stereo";participants?:{channel:1|2;participantId:string}[]};requestId:string}):Promise<PreparedAudio>;
        getTranscription(jobId:string):Promise<{state:JobState;providerJobId?:string;transcript?:TranscriptDocument;error?:string}>;
        audioWindow(args:{requestId?:string;assetId:string;trackIndex:number;startMs:number;durationMs:number;sampleRate:1000|16000|48000;channels:1|2;sourceChannelIndex?:number}):Promise<{channels:Float32Array[];sampleRate:number}>;
        resourceProfile():Promise<ResourceProfile>;
        referenceFile(mediaId:string,file:File):Promise<{originalUri:string}|null>;
        referencePath(mediaId:string,path:string):Promise<{originalUri:string}>;
        originalUri(mediaId:string):Promise<string|undefined>;
        registerFile(mediaId:string,file:Blob):Promise<RegisteredAsset>;
        registerPath(mediaId:string,path:string):Promise<RegisteredAsset>;
        findAsset(mediaId:string):Promise<RegisteredAsset|undefined>;
        identifyOriginalFile(file:File):Promise<{identity:string;size:number;mtimeMs:number}|null>;
        findOriginalMediaId(file:File,mediaIds:string[]):Promise<string|undefined>;
        resolve(assetId:string,purpose:"original"|"proxy"):Promise<string>;
        ensureAudioStream(assetId:string,trackIndex:number,sourceChannelIndex?:number):Promise<string>;
        ensureProxy(assetId:string):Promise<ProxyReceipt>;
        cancelMedia(assetId:string):Promise<void>;
      };
      podcast?: PodcastBridge;
      publicOrigin: string;
      probeHardware(): Promise<LicketySplitHardwareInfo>;
      onMenuAction(cb: (id: string) => void): () => void;
      fs: {
        showSaveDialog(opts: {
          defaultPath: string;
          filters: { name: string; extensions: string[] }[];
        }): Promise<string | null>;
        showOpenDialog(opts: {
          filters: { name: string; extensions: string[] }[];
        }): Promise<string | null>;
        readFile(path: string): Promise<string>;
        readFileBytes(path: string): Promise<ArrayBuffer>;
        tempFilePath(ext: string): Promise<string>;
        writeFile(path: string, data: string): Promise<void>;
        openWrite(path: string): Promise<string>;
        writeChunk(handleId: string, data: ArrayBuffer | Uint8Array, position: number): Promise<void>;
        closeWrite(handleId: string): Promise<void>;
        abortWrite(handleId: string): Promise<void>;
        revealInFolder(path: string): Promise<void>;
      };
      keychain: {
        get(id: string): Promise<string | null>;
        set(id: string, value: string): Promise<void>;
        delete(id: string): Promise<void>;
      };
      export: {
        start(args: LicketySplitExportStartArgs): Promise<LicketySplitExportSession>;
        writeAudioWav(jobId: string, wav: ArrayBuffer): Promise<void>;
        writeAudioChunk(jobId: string, chunk: ArrayBuffer, position: number): Promise<void>;
        finishAudio(jobId: string): Promise<void>;
        cancel(jobId: string): Promise<void>;
      };
      aurora?: {
        renderPreview(
          args: LicketySplitAuroraRenderPreviewArgs,
        ): Promise<LicketySplitAuroraRenderPreviewResult>;
        startPreviewSession(
          args: LicketySplitAuroraPreviewSessionStartArgs,
        ): Promise<LicketySplitAuroraPreviewSessionStartResult>;
        cancelPreviewSession(sessionId: string): Promise<void>;
        onPreviewEvent(
          cb: (event: LicketySplitAuroraPreviewSessionEvent) => void,
        ): () => void;
        startSequenceSession(
          args: LicketySplitAuroraSequenceSessionStartArgs,
        ): Promise<LicketySplitAuroraSequenceSessionStartResult>;
        cancelSequenceSession(sessionId: string): Promise<void>;
        onSequenceEvent(
          cb: (event: LicketySplitAuroraSequenceSessionEvent) => void,
        ): () => void;
      };
      cloud: {
        fetch(
          service:
            | "elevenlabs"
            | "openai"
            | "anthropic"
            | "openai-compatible"
            | "anthropic-compatible",
          path: string,
          options?: {
            method?: string;
            headers?: Record<string, string>;
            body?: string;
            baseUrl?: string;
          },
        ): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: ArrayBuffer }>;
      };
      win: {
        minimize(): Promise<void>;
        toggleMaximize(): Promise<void>;
        close(): Promise<void>;
        isMaximized(): Promise<boolean>;
      };
      lifecycle: {
        onQueryUnsaved(handler: () => boolean): () => void;
        onFlush(handler: () => Promise<void>): () => void;
      };
      updater: {
        onStatus(cb: (status: LicketySplitUpdaterStatus) => void): () => void;
        download(): Promise<void>;
        install(): Promise<void>;
      };
      crash: {
        report(payload: { message: string; stack?: string; type?: string; context?: unknown }): void;
      };
      mcp?: {
        onRequest(
          handler: (req: {
            callId: string;
            kind: "listTools" | "callTool";
            name?: string;
            args?: Record<string, unknown>;
          }) => Promise<{ ok: boolean; result?: unknown; error?: string }>,
        ): () => void;
        getStatus(): Promise<LicketySplitMcpStatus>;
        rotateToken(): Promise<LicketySplitMcpStatus>;
        testConnection(): Promise<{ ok: boolean; message?: string; toolCount?: number }>;
      };
      media: {
        generateProxy(args: { srcPath: string; preset: "low" | "medium" | "high" }): Promise<{ outPath: string }>;
        transcode(args: {
          srcPath: string;
          container?: "mp4" | "webm" | "mov";
          videoBitrateKbps?: number;
          audioBitrateKbps?: number;
        }): Promise<{ outPath: string }>;
        extractAudioWav(args: { srcPath: string; streamIndex?: number }): Promise<{ outPath: string }>;
        inspectFile(file:File):Promise<import("@licketysplit/core/media/types").MediaTrackInfo|null>;
        inspectPath(args:{srcPath:string}):Promise<import("@licketysplit/core/media/types").MediaTrackInfo>;
        probeFile(file:File):Promise<{streams:{index:number;codec:string;channels:number;sampleRate:number}[]}|null>;
        probeAudioStreams(args: { srcPath: string }): Promise<{
          streams: { index: number; codec: string; channels: number; sampleRate: number; language?: string }[];
        }>;
        fetchUrl(args: { url: string; maxBytes?: number }): Promise<{
          ok: boolean;
          status: number;
          statusText: string;
          contentType: string;
          body: ArrayBuffer;
          error?: string;
        }>;
      };
      rigging?: {
        probeBackend(): Promise<LicketySplitRiggingBackendProbe>;
        rigHumanoidModel(
          args: LicketySplitRigHumanoidModelArgs,
        ): Promise<LicketySplitRigHumanoidModelResult>;
      };
    };
  }
}
