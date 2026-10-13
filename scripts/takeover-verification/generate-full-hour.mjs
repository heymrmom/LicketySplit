#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = promisify(execFile);
const RATE = 8_000;
const CHUNK_SECONDS = 4;
const CHUNK_FRAMES = RATE * CHUNK_SECONDS;
const TOTAL_SECONDS = 3_602;
const TOTAL_FRAMES = TOTAL_SECONDS * RATE;

const sources = [
  { id: 'cam-a-1', file: 'CAM_A_001.MOV', kind: 'camera', cameraId: 'camera-a', segment: 1, scale: 1, offsetSeconds: 0, durationSeconds: 1_800, seed: 0, rotation: 0 },
  { id: 'cam-a-2', file: 'CAM_A_002.MOV', kind: 'camera', cameraId: 'camera-a', segment: 2, scale: 1, offsetSeconds: 1_799, durationSeconds: 1_803, seed: 0, rotation: 0 },
  { id: 'cam-b-1', file: 'CAM_B_001.MOV', kind: 'camera', cameraId: 'camera-b', segment: 1, scale: 1.00012, offsetSeconds: 35, durationSeconds: 1_800, seed: 1, rotation: 0 },
  { id: 'cam-b-2', file: 'CAM_B_002.MOV', kind: 'camera', cameraId: 'camera-b', segment: 2, scale: 1.00012, offsetSeconds: 35 + 1_800 * 1.00012, durationSeconds: (TOTAL_SECONDS - (35 + 1_800 * 1.00012)) / 1.00012, seed: 1, rotation: 0 },
  { id: 'cam-c-1', file: 'CAM_C_001.MOV', kind: 'camera', cameraId: 'camera-c', segment: 1, scale: 0.99992, offsetSeconds: 0, durationSeconds: 1_800, seed: 2, rotation: 0 },
  { id: 'cam-c-2', file: 'CAM_C_002.MOV', kind: 'camera', cameraId: 'camera-c', segment: 2, scale: 0.99992, offsetSeconds: 1_810, durationSeconds: (TOTAL_SECONDS - 1_810) / 0.99992, seed: 2, rotation: 90 },
  { id: 'mic-alice', file: 'MIC_ALICE.wav', kind: 'microphone', participantId: 'alice', scale: 1, offsetSeconds: 0, durationSeconds: TOTAL_SECONDS, seed: 3, channels: 1 },
  { id: 'mic-bob', file: 'MIC_BOB_STEREO.wav', kind: 'microphone', participantId: 'bob', scale: 1.00004, offsetSeconds: 0.25, durationSeconds: (TOTAL_SECONDS - 0.25) / 1.00004, seed: 4, channels: 2 },
];

function noiseAt(index, seed) {
  let value = Math.imul((index + seed * 0x9e3779b9) >>> 0, 0x45d9f3b);
  value ^= value >>> 16;
  value = Math.imul(value, 0x45d9f3b);
  value ^= value >>> 16;
  return ((value >>> 0) / 0x80000000) - 1;
}

function wavHeader(dataBytes, channels, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28); header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

async function writeNoiseFile(file, seed) {
  const handle = await open(file, 'w');
  let filter = 0;
  try {
    for (let start = 0; start < TOTAL_FRAMES; start += CHUNK_FRAMES) {
      const frames = Math.min(CHUNK_FRAMES, TOTAL_FRAMES - start);
      const chunk = Buffer.allocUnsafe(frames * 4);
      for (let i = 0; i < frames; i++) {
        filter = filter * 0.72 + noiseAt(start + i, seed) * 0.28;
        chunk.writeFloatLE(filter, i * 4);
      }
      await handle.write(chunk, 0, chunk.length, start * 4);
    }
  } finally { await handle.close(); }
}

async function readFloatRange(handle, start, end) {
  const first = Math.max(0, start), last = Math.min(TOTAL_FRAMES, end);
  if (last <= first) return { first, values: new Float32Array() };
  const bytes = Buffer.allocUnsafe((last - first) * 4);
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, first * 4);
  if (bytesRead !== bytes.length) throw new Error('Short read from deterministic source signal.');
  const values = new Float32Array(last - first);
  for (let i = 0; i < values.length; i++) values[i] = bytes.readFloatLE(i * 4);
  return { first, values };
}

function at(range, projectFrame) {
  const left = Math.floor(projectFrame), fraction = projectFrame - left;
  const local = left - range.first;
  const a = local >= 0 && local < range.values.length ? range.values[local] : 0;
  const b = local + 1 >= 0 && local + 1 < range.values.length ? range.values[local + 1] : 0;
  return a + (b - a) * fraction;
}

async function createAudioSource(directory, source, signalFiles) {
  const file = path.join(directory, source.file.replace(/\.MOV$/i, '.wav'));
  const channels = source.channels ?? 1;
  const frames = Math.round(source.durationSeconds * RATE);
  const handle = await open(file, 'w');
  const raw = Object.fromEntries(await Promise.all(Object.entries(signalFiles).map(async ([key, signalPath]) => [key, await open(signalPath, 'r')])));
  try {
    await handle.write(wavHeader(frames * channels * 2, channels, RATE), 0, 44, 0);
    for (let start = 0; start < frames; start += CHUNK_FRAMES) {
      const count = Math.min(CHUNK_FRAMES, frames - start);
      const firstProject = source.offsetSeconds * RATE + start * source.scale;
      const lastProject = source.offsetSeconds * RATE + (start + count - 1) * source.scale;
      const from = Math.floor(Math.min(firstProject, lastProject)) - 2;
      const to = Math.ceil(Math.max(firstProject, lastProject)) + 3;
      const signals = Object.fromEntries(await Promise.all(Object.entries(raw).map(async ([key, input]) => [key, await readFloatRange(input, from, to)])));
      const pcm = Buffer.allocUnsafe(count * channels * 2);
      for (let i = 0; i < count; i++) {
        const projectFrame = source.offsetSeconds * RATE + (start + i) * source.scale;
        const common = at(signals.common, projectFrame), alice = at(signals.alice, projectFrame);
        const bob = at(signals.bob, projectFrame), decoy = at(signals.decoy, projectFrame);
        let samples;
        if (source.kind === 'camera') samples = [0.68 * common + 0.24 * alice + 0.24 * bob];
        else if (source.participantId === 'alice') samples = [0.84 * common + 0.48 * alice];
        else samples = [0.84 * common + 0.48 * bob, 0.92 * decoy];
        for (let channel = 0; channel < channels; channel++) {
          const value = Math.max(-0.98, Math.min(0.98, samples[channel] ?? 0));
          pcm.writeInt16LE(Math.round(value * 32767), (i * channels + channel) * 2);
        }
      }
      await handle.write(pcm, 0, pcm.length, 44 + start * channels * 2);
    }
  } finally {
    await handle.close();
    await Promise.all(Object.values(raw).map((input) => input.close()));
  }
  return file;
}

async function main() {
  const args = process.argv.slice(2);
  const atArg = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const directory = path.resolve(atArg('--out') ?? '.superpowers/work/takeover/verification/full-hour');
  const ffmpeg = path.resolve(atArg('--ffmpeg') ?? 'apps/desktop/resources/bin/darwin-arm64/ffmpeg');
  await mkdir(directory, { recursive: true });
  const baseDir = path.join(directory, 'ground-truth-signals');
  await mkdir(baseDir, { recursive: true });
  const signalFiles = {};
  for (const [key, seed] of [['common', 11], ['alice', 23], ['bob', 37], ['decoy', 53]]) {
    signalFiles[key] = path.join(baseDir, `${key}.f32le`);
    await writeNoiseFile(signalFiles[key], seed);
  }

  const seeds = [];
  for (let camera = 0; camera < 3; camera++) {
    const seed = path.join(directory, `picture-seed-${camera}.mp4`);
    const color = ['#6b3fa0', '#207c83', '#bc5a35'][camera];
    await exec(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=3840x2160:r=25`, '-t', '1', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '36', seed]);
    seeds.push(seed);
  }

  const manifestSources = [];
  for (const source of sources) {
    const audio = await createAudioSource(directory, source, signalFiles);
    let original = audio;
    if (source.kind === 'camera') {
      original = path.join(directory, source.file);
      const seed = seeds[source.seed];
      const duration = source.durationSeconds.toFixed(6);
      const command = ['-y', '-hide_banner', '-loglevel', 'error', '-stream_loop', '-1'];
      if (source.rotation) command.push('-display_rotation:v:0', String(source.rotation));
      command.push('-i', seed, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-t', duration, '-c:v', 'copy', '-c:a', 'copy');
      command.push('-movflags', '+faststart', original);
      await exec(ffmpeg, command, { maxBuffer: 1024 * 1024 });
    }
    manifestSources.push({
      id: source.id, mediaId: `verification-${source.id}`, path: original, file: source.file,
      sha256: await hashFile(original), kind: source.kind, codec: source.kind === 'camera' ? 'h264 + pcm_s16le' : 'pcm_s16le',
      sampleRate: RATE, channels: source.channels ?? 1, durationSeconds: source.durationSeconds,
      physicalIdentity: source.cameraId ?? source.participantId, segment: source.segment,
      mapping: { version: 1, scale: source.scale, offsetSeconds: source.offsetSeconds },
      expectedCoverage: { startSeconds: source.offsetSeconds, endSeconds: Math.min(TOTAL_SECONDS, source.offsetSeconds + source.scale * source.durationSeconds) },
      video: source.kind === 'camera' ? { width: 3840, height: 2160, frameRate: 25, rotationDegrees: source.rotation } : undefined,
      signalChannels: source.kind === 'camera' ? ['common+alice+bob scratch'] : source.participantId === 'alice' ? ['common+alice'] : ['common+bob', 'independent decoy'],
    });
  }

  const manifest = {
    schemaVersion: 1, synthetic: true, purpose: 'full-hour native-vs-existing-compact verification',
    durationSeconds: TOTAL_SECONDS, generatedWith: { ffmpeg: 'pinned desktop ffmpeg; version 7.1', sampleRate: RATE, pcmChunkSeconds: CHUNK_SECONDS, pcmBuffering: 'four-second disk-backed chunks; no full-hour Float32 allocation' },
    sources: manifestSources,
    constraints: { cameraCount: 3, cameraOriginalsPerCamera: 2, participantCount: 2, stereoInput: 'mic-bob channel 0 carries Bob/common; channel 1 is independent decoy', commonSound: 'deterministic low-pass aperiodic noise present in all scratch and participant microphones', signalLimitation: 'common-dominant continuous synthetic content stresses correlation and drift; it does not encode alternating conversational turns or validate speaker-driven camera cuts', drift: { cameraB: 120, cameraC: -80, bob: 40 }, explicitGap: { cameraId: 'camera-c', fromProjectSeconds: 1_800 * 0.99992, toProjectSeconds: 1_810, durationSeconds: 1_810 - 1_800 * 0.99992 }, overlap: { cameraId: 'camera-a', fromProjectSeconds: 1_799, toProjectSeconds: 1_800, durationSeconds: 1 }, rotation: { sourceId: 'cam-c-2', degrees: 90 }, maximumSourceStartOffsetSeconds: 35 },
    expected: {
      sourceToEpisode: Object.fromEntries(manifestSources.map((source) => [source.id, source.mapping])),
      measurementPoints: [5, 60, 600, 1_200, 1_798, 1_800, 1_805, 1_810, 1_835, 2_400, 3_000, 3_590],
      cameraCount: 3, physicalCameraOriginals: 6, participantMicrophones: 2, episodeEndSeconds: TOTAL_SECONDS,
    },
    ownerFootage: false, providerCalls: false, humanAcceptance: false,
  };
  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ directory, sources: manifestSources.length, cameras: 6, microphones: 2, durationSeconds: TOTAL_SECONDS, manifest: path.join(directory, 'manifest.json') }));
}

await main();
