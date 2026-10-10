import { createVolumeAutomationEvaluator } from "../../../../../packages/core/src/audio/clip-volume-automation";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AnalysisSnapshot, PreparedAudio, DialogueSpan } from "../../../../../packages/core/src/lickety/types";
import { NativeAudioAnalysis } from "./audio-analysis";
import { atomicJson, hashFile } from "./asset-registry";

export interface AudioPreparationOptions {
  mode: "mixed" | "isolated-stereo";
  participants?: { channel: 1 | 2; participantId: string }[];
}

function wavHeader(frames: number, channels: number) {
  const buffer = Buffer.alloc(44);
  const size = frames * channels * 2;
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + size, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(16000 * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(size, 40);
  return buffer;
}

function gainAt(span: DialogueSpan, localMs: number, volumeAt: (time: number) => number): number {
  const render = span.render;
  if (!render) return 1;
  let gain = volumeAt(localMs / 1000);
  const fadeTime = (localMs + (render.fadeOffsetMs ?? 0)) / 1000;
  const fadeDuration = ((render.fadeDurationMs ?? render.clipDurationMs) / 1000);
  gain *= Math.min(
    render.fade?.fadeIn ? Math.min(1, fadeTime / render.fade.fadeIn) : 1,
    render.fade?.fadeOut ? Math.min(1, (fadeDuration - fadeTime) / render.fade.fadeOut) : 1,
  );
  return Math.max(0, gain);
}

function sampleAtSpeed(samples: Float32Array, outputFrame: number, speed: number): number {
  const position = outputFrame * speed;
  const first = Math.floor(position);
  const fraction = position - first;
  const left = samples[first] ?? 0;
  const right = samples[Math.min(first + 1, samples.length - 1)] ?? 0;
  return left + (right - left) * fraction;
}

export class PreparedAudioStore {
  constructor(readonly directory: string, private audio: NativeAudioAnalysis) {}

  async prepare(snapshot: AnalysisSnapshot, options: AudioPreparationOptions, signal: AbortSignal): Promise<PreparedAudio> {
    signal.throwIfAborted();
    if (!snapshot.dialogue.length || snapshot.durationMs <= 0) throw new Error("No dialogue to prepare");
    const channels = options.mode === "mixed" ? 1 : 2;
    const participants = options.participants ?? [];
    if (channels === 2 && (participants.length !== 2 || new Set(participants.map((participant) => participant.channel)).size !== 2 || new Set(participants.map((participant) => participant.participantId)).size !== 2)) {
      throw new Error("Isolated stereo requires two explicit participant/channel mappings");
    }
    if (channels === 2 && snapshot.dialogue.some((span) => !participants.some((participant) => participant.participantId === span.participantId || participant.participantId === span.trackId))) {
      throw new Error("Additional microphones require mixed diarization; none may be dropped");
    }
    if (snapshot.dialogue.some((span) => span.render?.effects.some((effect) => effect.enabled))) {
      throw new Error("Render and relink processed dialogue stems before transcribing audio with effects");
    }
    const speeds = snapshot.dialogue.map((span) => span.render?.speed ?? 1);
    if (speeds.some((speed) => !Number.isFinite(speed) || speed <= 0)) throw new Error("Prepared audio requires positive constant-speed dialogue");
    await fs.mkdir(this.directory, { recursive: true });
    const key = createHash("sha256").update("absolute-gain-v3:" + snapshot.revisionHash + JSON.stringify(options)).digest("hex");
    const receiptFile = path.join(this.directory, key + ".json");
    try {
      const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8")) as PreparedAudio;
      const file = await this.resolve(receipt);
      if (await hashFile(file, signal) === receipt.sha256) return receipt;
    } catch (error) {
      signal.throwIfAborted();
    }

    const handleId = randomUUID();
    const file = path.join(this.directory, handleId + ".wav");
    const partial = file + ".tmp";
    const frames = Math.round(snapshot.durationMs * 16);
    if (frames * channels * 2 > 0xffffffff - 36) throw new Error("Prepared audio exceeds WAV size; split this timeline");
    const output = await fs.open(partial, "wx", 0o600);
    const hash = createHash("sha256");
    try {
      const header = wavHeader(frames, channels);
      await output.write(header);
      hash.update(header);
      const maxSpeed = Math.max(1, ...speeds);
      const framesPerChunk = Math.max(1, Math.floor(16000 * 10 / maxSpeed));

      for (let startFrame = 0; startFrame < frames;) {
        signal.throwIfAborted();
        const count = Math.min(framesPerChunk, frames - startFrame);
        const startMs = startFrame / 16;
        const endFrame = startFrame + count;
        const endMs = endFrame / 16;
        const mixed = Array.from({ length: channels }, () => new Float32Array(count));
        for (const span of snapshot.dialogue) {
          const overlapStart = Math.max(startMs, span.timelineStartMs);
          const overlapEnd = Math.min(endMs, span.timelineEndMs);
          if (overlapEnd <= overlapStart) continue;
          const speed = span.render?.speed ?? 1;
          const sourceStartMs = span.sourceInMs + (overlapStart - span.timelineStartMs) * speed;
          const sourceDurationMs = Math.min(10000, (overlapEnd - overlapStart) * speed);
          const source = await this.audio.getNativeAudioWindow(
            span.assetId,
            span.render?.audioTrackIndex ?? 0,
            sourceStartMs,
            sourceDurationMs,
            signal,
            16000,
            1,
            span.render?.sourceChannelIndex,
          );
          const samples = source.channels[0] ?? new Float32Array(0);
          const expectedSourceFrames = Math.round(sourceDurationMs * 16);
          if (samples.length + 2 < expectedSourceFrames) {
            throw new Error(`Native audio source returned a truncated window for ${span.clipId}.`);
          }
          const channel = channels === 1 ? 0 : participants.find((participant) => participant.participantId === span.participantId || participant.participantId === span.trackId)!.channel - 1;
          const volumeAt = createVolumeAutomationEvaluator(span.render?.automation?.volume, span.render?.volume ?? 1);
          const offset = Math.round((overlapStart - startMs) * 16);
          const overlapFrames = Math.max(0, Math.round((overlapEnd - overlapStart) * 16));
          for (let index = 0; index < overlapFrames && offset + index < count; index++) {
            const gain = gainAt(span, overlapStart - span.timelineStartMs + index / 16, volumeAt);
            mixed[channel][offset + index] += sampleAtSpeed(samples, index, speed) * gain;
          }
        }
        const bytes = Buffer.alloc(count * channels * 2);
        for (let index = 0; index < count; index++) {
          for (let channel = 0; channel < channels; channel++) {
            bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mixed[channel][index]!)) * 32767), (index * channels + channel) * 2);
          }
        }
        await output.write(bytes);
        hash.update(bytes);
        startFrame = endFrame;
      }

      await output.close();
      await fs.rename(partial, file);
      const receipt: PreparedAudio = { handleId, snapshotHash: snapshot.revisionHash, sha256: hash.digest("hex"), sampleRate: 16000, channels, durationMs: snapshot.durationMs };
      await atomicJson(path.join(this.directory, handleId + ".json"), receipt);
      await atomicJson(receiptFile, receipt);
      return receipt;
    } catch (error) {
      await output.close().catch(() => {});
      await fs.unlink(partial).catch(() => {});
      throw error;
    }
  }

  async resolve(audio: PreparedAudio): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(audio.handleId)) throw new Error("Unknown managed audio handle");
    const receipt = JSON.parse(await fs.readFile(path.join(this.directory, audio.handleId + ".json"), "utf8")) as PreparedAudio;
    if (receipt.sha256 !== audio.sha256 || receipt.snapshotHash !== audio.snapshotHash || receipt.durationMs !== audio.durationMs || receipt.channels !== audio.channels || audio.sampleRate !== 16000) {
      throw new Error("Prepared audio identity mismatch");
    }
    const file = path.join(this.directory, audio.handleId + ".wav");
    await fs.access(file);
    if (await hashFile(file) !== audio.sha256) throw new Error("Prepared audio content changed; prepare it again");
    return file;
  }
}
