import { contextBridge, ipcRenderer, webUtils } from "electron";
import { CHANNELS } from "../shared/channels";
import {
  forwardIdentityMigrationPort,
  IDENTITY_MIGRATION_CHANNELS,
  NEW_APP_ORIGIN,
} from "../shared/identity-migration";
import type { McpBridgeRequest } from "../shared/mcp";
import type {
  PodcastAnalyzeRequest, PodcastApprovalRequest, PodcastBridge, PodcastCancelRequest, PodcastInspectRequest,
  PodcastProgressEvent, PodcastReviseRequest, PodcastSetupRequest, PodcastUpdateRequest, PodcastWaveformRequest,
} from "../../../../packages/core/src/lickety/podcast-types";

const MIGRATION_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let migrationNonce: string | undefined;
let migrationPortForwarded = false;

ipcRenderer.on(IDENTITY_MIGRATION_CHANNELS.port, (event, payload: unknown) => {
  if (!migrationNonce || migrationPortForwarded) {
    for (const port of event.ports ?? []) { try { port.close(); } catch { /* already detached */ } }
    return;
  }
  if (forwardIdentityMigrationPort(event, payload, window, NEW_APP_ORIGIN, migrationNonce, "destination")) {
    migrationPortForwarded = true;
  }
});

const identityMigration = {
  start: async (nonce: string): Promise<void> => {
    if (!MIGRATION_UUID_V4.test(nonce)) throw new Error("A valid UUID migration nonce is required.");
    if (migrationNonce) throw new Error("This app window already has an identity migration session.");
    migrationNonce = nonce;
    migrationPortForwarded = false;
    try {
      await ipcRenderer.invoke(IDENTITY_MIGRATION_CHANNELS.start, nonce);
    } catch (error) {
      if (migrationNonce === nonce) migrationNonce = undefined;
      migrationPortForwarded = false;
      throw error;
    }
  },
  stop: async (nonce: string): Promise<void> => {
    if (!MIGRATION_UUID_V4.test(nonce)) throw new Error("A valid UUID migration nonce is required.");
    if (migrationNonce && migrationNonce !== nonce) throw new Error("The migration stop nonce does not match this app window's active session.");
    try {
      await ipcRenderer.invoke(IDENTITY_MIGRATION_CHANNELS.stop, nonce);
    } finally {
      if (migrationNonce === nonce) migrationNonce = undefined;
      migrationPortForwarded = false;
    }
  },
};

contextBridge.exposeInMainWorld("licketysplit", {
  platform: "desktop",
  lickety: {
    reconcileTranscription: (jobId:string,providerJobId:string) => ipcRenderer.invoke(CHANNELS.licketyReconcileTranscription,{jobId,providerJobId}),
    assemblyKeyStatus: () => ipcRenderer.invoke(CHANNELS.licketyKeyStatus),
    startTranscription: (args: unknown) => ipcRenderer.invoke(CHANNELS.licketyStartTranscription,args),
    getTranscription: (jobId: string) => ipcRenderer.invoke(CHANNELS.licketyGetTranscription,{jobId}),
    cancelTranscription: (jobId: string) => ipcRenderer.invoke(CHANNELS.licketyCancelTranscription,{jobId}),
    resumeTranscription: (jobId: string) => ipcRenderer.invoke(CHANNELS.licketyResumeTranscription,{jobId}),
    prepareAudio: (args: unknown) => ipcRenderer.invoke(CHANNELS.licketyPrepareAudio,args),
    audioWindow: (args: unknown) => ipcRenderer.invoke(CHANNELS.licketyAudioWindow,args),
    resourceProfile: () => ipcRenderer.invoke(CHANNELS.licketyResourceProfile),
    referenceFile: (mediaId:string,file:File) => {const path=webUtils.getPathForFile(file);return path?ipcRenderer.invoke(CHANNELS.licketyReferenceOriginal,{mediaId,path}):Promise.resolve(null);},
    referencePath: (mediaId:string,path:string) => ipcRenderer.invoke(CHANNELS.licketyReferenceOriginal,{mediaId,path,managed:true}),
    originalUri: (mediaId:string) => ipcRenderer.invoke(CHANNELS.licketyOriginalUri,{mediaId}),
    registerFile: (mediaId: string, file: File) => ipcRenderer.invoke(CHANNELS.licketyRegisterAsset, {mediaId, path:webUtils.getPathForFile(file)}),
    registerPath: (mediaId: string, path: string) => ipcRenderer.invoke(CHANNELS.licketyRegisterAsset, {mediaId,path,managed:true}),
    findAsset: (mediaId: string) => ipcRenderer.invoke(CHANNELS.licketyFindAsset, {mediaId}),
    identifyOriginalFile: (file:File) => {const filePath=webUtils.getPathForFile(file);return filePath?ipcRenderer.invoke(CHANNELS.licketyIdentifyOriginal,{path:filePath}):Promise.resolve(null);},
    findOriginalMediaId: (file:File,mediaIds:string[]) => {const filePath=webUtils.getPathForFile(file);return filePath?ipcRenderer.invoke(CHANNELS.licketyFindOriginalMediaId,{path:filePath,mediaIds}):Promise.resolve(undefined);},
    resolve: (assetId: string, purpose: string) => ipcRenderer.invoke(CHANNELS.licketyResolve, {assetId,purpose}),
    ensureAudioStream: (assetId:string,trackIndex:number,sourceChannelIndex?:number) => ipcRenderer.invoke(CHANNELS.licketyEnsureAudioStream,{assetId,trackIndex,sourceChannelIndex}),
    ensureProxy: (assetId: string) => ipcRenderer.invoke(CHANNELS.licketyEnsureProxy, {assetId}),
    cancelMedia: (assetId: string) => ipcRenderer.invoke(CHANNELS.licketyCancelMedia, {assetId}),
  },
  podcast: {
    inspect: (args: PodcastInspectRequest) => ipcRenderer.invoke(CHANNELS.podcastInspect, args),
    revise: (args: PodcastReviseRequest) => ipcRenderer.invoke(CHANNELS.podcastRevise, args),
    analyze: (args: PodcastAnalyzeRequest) => ipcRenderer.invoke(CHANNELS.podcastAnalyze, args),
    update: (args: PodcastUpdateRequest) => ipcRenderer.invoke(CHANNELS.podcastUpdate, args),
    get: (args: PodcastSetupRequest) => ipcRenderer.invoke(CHANNELS.podcastGet, args),
    getWaveform: (args: PodcastWaveformRequest) => ipcRenderer.invoke(CHANNELS.podcastWaveform, args),
    cancel: (args: PodcastCancelRequest) => ipcRenderer.invoke(CHANNELS.podcastCancel, args),
    approve: (args: PodcastApprovalRequest) => ipcRenderer.invoke(CHANNELS.podcastApprove, args),
    onProgress: (listener: (event: PodcastProgressEvent) => void) => {
      const handler = (_event: unknown, payload: PodcastProgressEvent) => listener(payload);
      ipcRenderer.on(CHANNELS.podcastProgress, handler);
      return () => ipcRenderer.removeListener(CHANNELS.podcastProgress, handler);
    },
  } satisfies PodcastBridge,
  identityMigration,
  publicOrigin: "https://app.openreel.video",
  probeHardware: () => ipcRenderer.invoke(CHANNELS.probeHardware, undefined),
  onMenuAction: (cb: (id: string) => void) => {
    const handler = (_event: unknown, id: string) => cb(id);
    ipcRenderer.on("licketysplit:menu:action", handler);
    return () => ipcRenderer.removeListener("licketysplit:menu:action", handler);
  },
  fs: {
    showSaveDialog: (opts: unknown) => ipcRenderer.invoke(CHANNELS.fsShowSaveDialog, opts),
    showOpenDialog: (opts: unknown) => ipcRenderer.invoke(CHANNELS.fsShowOpenDialog, opts),
    readFile: (p: string) => ipcRenderer.invoke(CHANNELS.fsReadFile, { path: p }),
    readFileBytes: (p: string) => ipcRenderer.invoke(CHANNELS.fsReadFileBytes, { path: p }),
    tempFilePath: (ext: string) => ipcRenderer.invoke(CHANNELS.fsTempFilePath, { ext }),
    writeFile: (p: string, data: string) => ipcRenderer.invoke(CHANNELS.fsWriteFile, { path: p, data }),
    openWrite: (p: string) => ipcRenderer.invoke(CHANNELS.fsOpenWrite, { path: p }),
    writeChunk: (handleId: string, data: ArrayBuffer | Uint8Array, position: number) =>
      ipcRenderer.invoke(CHANNELS.fsWriteChunk, { handleId, data, position }),
    closeWrite: (handleId: string) => ipcRenderer.invoke(CHANNELS.fsCloseWrite, { handleId }),
    abortWrite: (handleId: string) => ipcRenderer.invoke(CHANNELS.fsAbortWrite, { handleId }),
    revealInFolder: (p: string) => ipcRenderer.invoke(CHANNELS.fsRevealInFolder, { path: p }),
  },
  keychain: {
    get: (id: string) => ipcRenderer.invoke(CHANNELS.keychainGet, { id }),
    set: (id: string, value: string) => ipcRenderer.invoke(CHANNELS.keychainSet, { id, value }),
    delete: (id: string) => ipcRenderer.invoke(CHANNELS.keychainDelete, { id }),
  },
  export: {
    start: (args: unknown) =>
      new Promise((resolve) => {
        ipcRenderer.once("licketysplit:export-port", (event, meta) => {
          const { jobId } = meta as { jobId: string };
          const [port] = event.ports;
          // A live MessagePort cannot survive contextBridge serialization into
          // the main world, so forward it via window.postMessage transfer (the
          // documented Electron path) and resolve with just the jobId.
          window.postMessage({ __licketysplitExportPort: true, jobId }, "*", [port]);
          resolve({ jobId });
        });
        ipcRenderer.invoke(CHANNELS.exportStart, args);
      }),
    writeAudioWav: (jobId: string, wav: ArrayBuffer) =>
      ipcRenderer.invoke(CHANNELS.exportWriteAudioWav, { jobId, wav }),
    writeAudioChunk: (jobId: string, chunk: ArrayBuffer, position: number) =>
      ipcRenderer.invoke(CHANNELS.exportWriteAudioChunk, { jobId, chunk, position }),
    finishAudio: (jobId: string) => ipcRenderer.invoke(CHANNELS.exportFinishAudio, { jobId }),
    cancel: (jobId: string) => ipcRenderer.invoke(CHANNELS.exportCancel, { jobId }),
  },
  aurora: {
    renderPreview: (args: unknown) => ipcRenderer.invoke(CHANNELS.auroraRenderPreview, args),
    startPreviewSession: (args: unknown) =>
      ipcRenderer.invoke(CHANNELS.auroraStartPreviewSession, args),
    cancelPreviewSession: (sessionId: string) =>
      ipcRenderer.invoke(CHANNELS.auroraCancelPreviewSession, { sessionId }),
    onPreviewEvent: (cb: (event: unknown) => void) => {
      const handler = (_event: unknown, payload: unknown) => cb(payload);
      ipcRenderer.on(CHANNELS.auroraPreviewEvent, handler);
      return () => ipcRenderer.removeListener(CHANNELS.auroraPreviewEvent, handler);
    },
    startSequenceSession: (args: unknown) =>
      ipcRenderer.invoke(CHANNELS.auroraStartSequenceSession, args),
    cancelSequenceSession: (sessionId: string) =>
      ipcRenderer.invoke(CHANNELS.auroraCancelSequenceSession, { sessionId }),
    onSequenceEvent: (cb: (event: unknown) => void) => {
      const handler = (_event: unknown, payload: unknown) => cb(payload);
      ipcRenderer.on(CHANNELS.auroraSequenceEvent, handler);
      return () => ipcRenderer.removeListener(CHANNELS.auroraSequenceEvent, handler);
    },
  },
  cloud: {
    fetch: (
      service: string,
      path: string,
      options?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        baseUrl?: string;
      },
    ) => ipcRenderer.invoke(CHANNELS.cloudFetch, { service, path, ...(options ?? {}) }),
  },
  win: {
    minimize: () => ipcRenderer.invoke(CHANNELS.windowControl, { action: "minimize" }),
    toggleMaximize: () => ipcRenderer.invoke(CHANNELS.windowControl, { action: "toggleMaximize" }),
    close: () => ipcRenderer.invoke(CHANNELS.windowControl, { action: "close" }),
    isMaximized: () => ipcRenderer.invoke(CHANNELS.windowIsMaximized),
  },
  media: {
    generateProxy: (args: unknown) => ipcRenderer.invoke(CHANNELS.mediaGenerateProxy, args),
    transcode: (args: unknown) => ipcRenderer.invoke(CHANNELS.mediaTranscode, args),
    extractAudioWav: (args: unknown) => ipcRenderer.invoke(CHANNELS.mediaExtractAudioWav, args),
    inspectFile: (file:File) => {const srcPath=webUtils.getPathForFile(file);return srcPath?ipcRenderer.invoke(CHANNELS.mediaInspectOriginal,{srcPath}):Promise.resolve(null);},
    inspectPath: (args:unknown) => ipcRenderer.invoke(CHANNELS.mediaInspectOriginal,args),
    probeFile: (file:File) => {const srcPath=webUtils.getPathForFile(file);return srcPath?ipcRenderer.invoke(CHANNELS.mediaProbeAudioStreams,{srcPath}):Promise.resolve(null);},
    probeAudioStreams: (args: unknown) => ipcRenderer.invoke(CHANNELS.mediaProbeAudioStreams, args),
    fetchUrl: (args: unknown) => ipcRenderer.invoke(CHANNELS.mediaFetchUrl, args),
  },
  rigging: {
    probeBackend: () => ipcRenderer.invoke(CHANNELS.riggingProbeBackend, undefined),
    rigHumanoidModel: (args: unknown) =>
      ipcRenderer.invoke(CHANNELS.riggingRigHumanoidModel, args),
  },
  updater: {
    // Auto-update status pushed from the main process (checking/available/
    // downloading/downloaded/error). The renderer surfaces an update banner and
    // drives download/install on user consent.
    onStatus: (cb: (status: unknown) => void) => {
      const handler = (_event: unknown, status: unknown) => cb(status);
      ipcRenderer.on(CHANNELS.updaterStatus, handler);
      return () => ipcRenderer.removeListener(CHANNELS.updaterStatus, handler);
    },
    download: () => ipcRenderer.invoke(CHANNELS.updaterDownload),
    install: () => ipcRenderer.invoke(CHANNELS.updaterInstall),
  },
  crash: {
    // Fire-and-forget renderer error reporting; the main process attaches app
    // version/platform and forwards to the cloud crash collector.
    report: (payload: { message: string; stack?: string; type?: string; context?: unknown }) =>
      ipcRenderer.send(CHANNELS.crashReport, payload),
  },
  mcp: {
    // The main-process MCP server pushes tool-call / list-tool requests here; the
    // renderer runs them against the live editor and replies on the result
    // channel, correlated by callId so concurrent calls don't cross-wire.
    onRequest: (
      handler: (
        req: McpBridgeRequest,
      ) => Promise<{ ok: boolean; result?: unknown; error?: string }>,
    ) => {
      const listener = (_event: unknown, req: McpBridgeRequest) => {
        void Promise.resolve()
          .then(() => handler(req))
          .then((res) =>
            ipcRenderer.send(CHANNELS.mcpResponse, { callId: req.callId, ...res }),
          )
          .catch((error) =>
            ipcRenderer.send(CHANNELS.mcpResponse, {
              callId: req.callId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      };
      ipcRenderer.on(CHANNELS.mcpRequest, listener);
      return () => ipcRenderer.removeListener(CHANNELS.mcpRequest, listener);
    },
    getStatus: () => ipcRenderer.invoke(CHANNELS.mcpGetStatus, undefined),
    rotateToken: () => ipcRenderer.invoke(CHANNELS.mcpRotateToken, undefined),
    testConnection: () => ipcRenderer.invoke(CHANNELS.mcpTestConnection, undefined),
  },
  lifecycle: {
    // The main process asks (on window close / quit) whether there are unsaved
    // changes; the renderer answers synchronously from its dirty state.
    onQueryUnsaved: (handler: () => boolean) => {
      const listener = () => {
        let dirty = false;
        try {
          dirty = handler();
        } catch (error) {
          console.error("[lifecycle] unsaved query failed:", error);
        }
        ipcRenderer.send(CHANNELS.lifecycleUnsavedReply, dirty);
      };
      ipcRenderer.on(CHANNELS.lifecycleUnsavedQuery, listener);
      return () => ipcRenderer.removeListener(CHANNELS.lifecycleUnsavedQuery, listener);
    },
    // The main process asks the renderer to persist pending changes before the
    // window closes; the renderer flushes and reports whether it succeeded so
    // main can keep the window open on failure rather than dropping the edits.
    onFlush: (handler: () => Promise<void>) => {
      const listener = () => {
        void Promise.resolve()
          .then(handler)
          .then(() => ipcRenderer.send(CHANNELS.lifecycleFlushed, true))
          .catch((error) => {
            console.error("[lifecycle] flush failed:", error);
            ipcRenderer.send(CHANNELS.lifecycleFlushed, false);
          });
      };
      ipcRenderer.on(CHANNELS.lifecycleFlush, listener);
      return () => ipcRenderer.removeListener(CHANNELS.lifecycleFlush, listener);
    },
  },
});
