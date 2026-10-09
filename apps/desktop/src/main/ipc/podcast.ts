import { BrowserWindow, app } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { PodcastGroup, PodcastParticipant, PodcastProgressEvent } from "../../../../../packages/core/src/lickety/podcast-types";
import { CHANNELS } from "../../shared/channels";
import { NativeAudioAnalysis } from "../lickety/audio-analysis";
import { PodcastNativeService } from "../lickety/podcast/service";
import { heavyQueue } from "../lickety/media-jobs";
import { getAssetRegistry } from "./lickety";
import { handle } from "./index";

const uuid = z.string().uuid();
const controllers = new Map<string, AbortController>();
let service: PodcastNativeService | undefined;

function nativeService() {
  if (!service) {
    const registry = getAssetRegistry();
    service = new PodcastNativeService(path.join(app.getPath("userData"), "podcast"), registry, new NativeAudioAnalysis(registry, heavyQueue));
  }
  return service;
}

function progress(setupId: string, requestId: string, update: Omit<PodcastProgressEvent, "setupId" | "requestId">) {
  const event: PodcastProgressEvent = { setupId, requestId, ...update };
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(CHANNELS.podcastProgress, event);
}

function ownRequest<T>(requestId: string, operation: (controller: AbortController) => Promise<T>): Promise<T> {
  if (controllers.has(requestId)) throw new Error("Podcast request ID is already active.");
  const controller = new AbortController();
  controllers.set(requestId, controller);
  return operation(controller).finally(() => {
    if (controllers.get(requestId) === controller) controllers.delete(requestId);
  });
}

export function installPodcastIpc() {
  handle(CHANNELS.podcastInspect, z.object({ projectId: z.string().trim().min(1), mediaIds: z.array(z.string().trim().min(1)).min(1), setupId: uuid.optional(), requestId: uuid }),
    (args) => ownRequest(args.requestId, (controller) => {
      const setupId = args.setupId ?? randomUUID();
      return nativeService().inspect({ ...args, createSetupId: setupId }, controller.signal, (update) => progress(setupId, args.requestId, update));
    }));
  handle(CHANNELS.podcastRevise, z.object({ setupId: uuid, groups: z.array(z.unknown()), participants: z.array(z.unknown()) }),
    (args) => nativeService().revise({ setupId: args.setupId, groups: args.groups as PodcastGroup[], participants: args.participants as PodcastParticipant[] }));
  handle(CHANNELS.podcastAnalyze, z.object({ setupId: uuid, requestId: uuid, retryAssetIds: z.array(z.string()).optional(), prepareOnly: z.boolean().optional() }),
    (args) => ownRequest(args.requestId, (controller) => nativeService().analyze(args.setupId, args.requestId, controller.signal, (update) => progress(args.setupId, args.requestId, update), args.retryAssetIds, args.prepareOnly)));
  handle(CHANNELS.podcastUpdate, z.object({
    setupId: uuid, assetId: z.string().optional(), offsetSeconds: z.number().optional(), scale: z.number().positive().optional(), locked: z.boolean().optional(),
    excluded: z.boolean().optional(), note: z.string().optional(), regionId: z.string().optional(), splitSourceSeconds: z.number().optional(),
    waiveUnsupported: z.boolean().optional(), reviewSaved: z.boolean().optional(), acceptTiming: z.boolean().optional(), referenceAssetId: z.string().optional(),
    clockAssetIds: z.array(z.string()).optional(), analysisDecision: z.enum(["apply", "discard"]).optional(), undoTiming: z.boolean().optional(),
  }), (args) => nativeService().update(args));
  handle(CHANNELS.podcastGet, z.object({ setupId: uuid }), (args) => nativeService().get(args.setupId));
  handle(CHANNELS.podcastWaveform, z.object({ setupId: uuid, channelId: z.string().min(1), startSeconds: z.number(), durationSeconds: z.number().positive(), maxPoints: z.number().int().positive().max(20_000).optional() }),
    (args) => nativeService().getWaveform(args));
  handle(CHANNELS.podcastCancel, z.object({ requestId: uuid }), (args) => {
    controllers.get(args.requestId)?.abort(new Error("Podcast task canceled by the user."));
  });
  handle(CHANNELS.podcastApprove, z.object({ setupId: uuid, expectedRevision: z.number().int().nonnegative() }),
    (args) => nativeService().approve(args.setupId, args.expectedRevision));
}
