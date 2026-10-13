#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';

const rate = 8_000, seconds = 80, totalFrames = rate * seconds, chunkFrames = rate * 4, periodFrames = rate * 10;
function noiseAt(index, seed) {
  let value = Math.imul((index + seed * 0x9e3779b9) >>> 0, 0x45d9f3b);
  value ^= value >>> 16; value = Math.imul(value, 0x45d9f3b); value ^= value >>> 16;
  return ((value >>> 0) / 0x80000000) - 1;
}
function header(bytes) {
  const out = Buffer.alloc(44); out.write('RIFF', 0); out.writeUInt32LE(36 + bytes, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(bytes, 40); return out;
}
async function sha256(file) {
  const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex');
}
async function create(file, mode) {
  const handle = await open(file, 'w'), bytes = totalFrames * 2;
  let filtered = 0; const short = new Float32Array(periodFrames);
  for (let index = 0; index < short.length; index++) { filtered = filtered * 0.72 + noiseAt(index, 101) * 0.28; short[index] = filtered; }
  try {
    await handle.write(header(bytes), 0, 44, 0);
    for (let start = 0; start < totalFrames; start += chunkFrames) {
      const count = Math.min(chunkFrames, totalFrames - start), pcm = Buffer.allocUnsafe(count * 2);
      for (let index = 0; index < count; index++) {
        const absolute = start + index;
        let sample = 0;
        if (mode === 'repeated-reference') sample = short[absolute % periodFrames] ?? 0;
        if (mode === 'repeated-target') sample = short[(absolute + 3 * rate) % periodFrames] ?? 0;
        if (mode === 'unmatched') sample = noiseAt(absolute, 887) * 0.4;
        pcm.writeInt16LE(Math.round(sample * 30000), index * 2);
      }
      await handle.write(pcm, 0, pcm.length, 44 + start * 2);
    }
  } finally { await handle.close(); }
}
async function createActivity(file, role) {
  const handle = await open(file, 'w'), bytes = totalFrames * 2;
  let common = 0, alice = 0, bob = 0;
  try {
    await handle.write(header(bytes), 0, 44, 0);
    for (let start = 0; start < totalFrames; start += chunkFrames) {
      const count = Math.min(chunkFrames, totalFrames - start), pcm = Buffer.allocUnsafe(count * 2);
      for (let index = 0; index < count; index++) {
        const frame = start + index, t = frame / rate, slot = Math.floor(t / 10), within = t % 10;
        common = common * 0.72 + noiseAt(frame, 71) * 0.28;
        alice = alice * 0.72 + noiseAt(frame, 211) * 0.28;
        bob = bob * 0.72 + noiseAt(frame, 307) * 0.28;
        const active = within >= 1 && within < 9;
        const aliceActive = active && slot % 2 === 0 ? alice * 0.72 : 0;
        const bobActive = active && slot % 2 === 1 ? bob * 0.72 : 0;
        const sample = role === 'alice'
          ? 0.18 * common + aliceActive
          : role === 'bob'
            ? 0.18 * common + bobActive
            : 0.16 * common + aliceActive * 0.42 + bobActive * 0.42;
        pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), index * 2);
      }
      await handle.write(pcm, 0, pcm.length, 44 + start * 2);
    }
  } finally { await handle.close(); }
}
const root = path.resolve(process.argv[2] ?? '.superpowers/work/takeover/verification/full-hour-20261009');
const dir = path.join(root, 'challenges'); await mkdir(dir, { recursive: true });
const rows = [];
for (const [id, file, mode] of [
  ['silence', 'SILENCE_80S.wav', 'silence'],
  ['repeat-reference', 'REPEAT_REFERENCE_80S.wav', 'repeated-reference'],
  ['repeat-target', 'REPEAT_TARGET_80S.wav', 'repeated-target'],
  ['unmatched', 'UNMATCHED_80S.wav', 'unmatched'],
]) {
  const full = path.join(dir, file); await create(full, mode);
  rows.push({ id, mediaId: `verification-challenge-${id}`, path: full, file, sha256: await sha256(full), durationSeconds: seconds, sampleRate: rate, channels: 1, mode, role: 'challenge-only' });
}
await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, synthetic: true, durationSeconds: seconds, periodicContentPeriodSeconds: 10, challengeSources: rows, ownerFootage: false }, null, 2)}\n`);
const activityDir = path.join(dir, 'alternating-activity'); await mkdir(activityDir, { recursive: true });
const activitySources = [];
for (const [id, role] of [['alice', 'alice'], ['bob', 'bob'], ['camera-scratch', 'scratch']]) {
  const file = path.join(activityDir, `${id}.wav`); await createActivity(file, role);
  activitySources.push({ id: `activity-${id}`, path: file, sha256: await sha256(file), durationSeconds: seconds, sampleRate: rate, channels: 1, role, activityWindowsSeconds: Array.from({ length: 12 }, (_, slot) => ({ start: slot * 10 + 1, end: slot * 10 + 9, active: role === 'scratch' || (role === 'alice' ? slot % 2 === 0 : slot % 2 === 1) })) });
}
await writeFile(path.join(activityDir, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, synthetic: true, purpose: 'alternating participant activity and quiet gaps for future camera-planner validation', sources: activitySources, speakerIntentIsNotHumanAcceptance: true }, null, 2)}\n`);
console.log(JSON.stringify({ directory: dir, challengeSources: rows.length, activitySources: activitySources.length, durationSeconds: seconds }));
