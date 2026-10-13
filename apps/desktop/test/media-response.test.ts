import { it, expect } from "vitest";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { boundedRange } from "../src/main/lickety/asset-registry";
import * as responseModule from "../src/main/lickety/media-response";

const MiB = 1024 * 1024;
type CreateMediaResponse = (file: string, mime: string, range: string | null, signal?: AbortSignal, origin?: string) => Promise<Response>;
type ToBoundedByteStream = (stream: Readable) => ReadableStream<Uint8Array>;

function requiredExport<T>(name: string): T {
  const value = (responseModule as unknown as Record<string, unknown>)[name];
  expect(value, `${name} must be exported`).toBeTypeOf("function");
  return value as T;
}

async function sparseFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lickety-range-response-"));
  const file = path.join(dir, "sparse.mov");
  const size = 40 * MiB + 4096;
  const patterns = [
    { offset: 0, bytes: Buffer.from("begin-range") },
    { offset: 20 * MiB + 128, bytes: Buffer.from("middle-range") },
    { offset: size - 64, bytes: Buffer.from("tail-range") },
  ];
  const handle = await open(file, "w+");
  try {
    await handle.truncate(size);
    for (const pattern of patterns) await handle.write(pattern.bytes, 0, pattern.bytes.length, pattern.offset);
  } finally {
    await handle.close();
  }
  return { dir, file, size, patterns };
}

async function consume(response: Response, probes: { offset: number; bytes: Buffer }[] = []) {
  const reader = response.body!.getReader();
  let total = 0;
  let maxChunk = 0;
  const seen = new Set<number>();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunkStart = total;
    total += value.byteLength;
    maxChunk = Math.max(maxChunk, value.byteLength);
    probes.forEach((probe, index) => {
      if (probe.offset >= chunkStart && probe.offset + probe.bytes.length <= total) {
        expect(Buffer.from(value.subarray(probe.offset - chunkStart, probe.offset - chunkStart + probe.bytes.length))).toEqual(probe.bytes);
        seen.add(index);
      }
    });
  }
  return { total, maxChunk, seen: [...seen] };
}

it("streams the full requested open range with byte-sized backpressure", async () => {
  const createMediaResponse = requiredExport<CreateMediaResponse>("createMediaResponse");
  const fixture = await sparseFixture();
  try {
    const response = await createMediaResponse(fixture.file, "video/quicktime", "bytes=0-", undefined, "app://licketysplit");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-${fixture.size - 1}/${fixture.size}`);
    expect(response.headers.get("content-length")).toBe(String(fixture.size));
    expect(response.headers.get("access-control-allow-origin")).toBe("app://licketysplit");
    const result = await consume(response, fixture.patterns);
    expect(result.total).toBe(fixture.size);
    expect(result.maxChunk).toBeLessThanOrEqual(MiB);
    expect(result.seen).toEqual([0, 1, 2]);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

it("serves adjacent and suffix ranges exactly and rejects invalid ranges", async () => {
  const createMediaResponse = requiredExport<CreateMediaResponse>("createMediaResponse");
  const fixture = await sparseFixture();
  try {
    const firstEnd = 2 * MiB - 1;
    const first = await createMediaResponse(fixture.file, "video/quicktime", `bytes=0-${firstEnd}`);
    const second = await createMediaResponse(fixture.file, "video/quicktime", `bytes=${firstEnd + 1}-${2 * firstEnd + 1}`);
    expect(first.headers.get("content-range")).toBe(`bytes 0-${firstEnd}/${fixture.size}`);
    expect(second.headers.get("content-range")).toBe(`bytes ${firstEnd + 1}-${2 * firstEnd + 1}/${fixture.size}`);
    expect((await consume(first)).total).toBe(firstEnd + 1);
    expect((await consume(second)).total).toBe(firstEnd + 1);

    const suffix = await createMediaResponse(fixture.file, "video/quicktime", "bytes=-64");
    expect(suffix.headers.get("content-range")).toBe(`bytes ${fixture.size - 64}-${fixture.size - 1}/${fixture.size}`);
    expect(suffix.headers.get("content-length")).toBe("64");
    const suffixResult = await consume(suffix, [{ offset: 0, bytes: fixture.patterns[2].bytes }]);
    expect(suffixResult.total).toBe(64);
    expect(suffixResult.seen).toEqual([0]);

    const full = await createMediaResponse(fixture.file, "video/quicktime", null);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-range")).toBeNull();
    expect(full.headers.get("content-length")).toBe(String(fixture.size));
    expect((await consume(full)).total).toBe(fixture.size);

    for (const invalid of ["bytes=-0", "bytes=999999999-", "not-a-range"]) {
      const response = await createMediaResponse(fixture.file, "video/quicktime", invalid);
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${fixture.size}`);
      expect(response.body).toBeNull();
    }
    expect(() => boundedRange("bytes=-0", fixture.size)).toThrow();
    expect(() => boundedRange("bytes=999999999-", fixture.size)).toThrow();
    expect(() => boundedRange("not-a-range", fixture.size)).toThrow();
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

it("counts web-stream queue capacity in bytes rather than chunk objects", async () => {
  const toBoundedByteStream = requiredExport<ToBoundedByteStream>("toBoundedByteStream");
  const targetBytes = 8 * MiB;
  let produced = 0;
  const source = new Readable({
    highWaterMark: MiB,
    read() {
      if (produced >= targetBytes) {
        this.push(null);
        return;
      }
      const size = Math.min(64 * 1024, targetBytes - produced);
      produced += size;
      this.push(Buffer.alloc(size, 0x42));
    },
  });
  const web = toBoundedByteStream(source);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(produced).toBeLessThanOrEqual(2 * MiB + 64 * 1024);
  const result = await consume(new Response(web));
  expect(result.total).toBe(targetBytes);
});

it("stops requesting source chunks after the Web reader cancels", async () => {
  const toBoundedByteStream = requiredExport<ToBoundedByteStream>("toBoundedByteStream");
  const targetBytes = 8 * MiB;
  let produced = 0;
  const source = new Readable({
    highWaterMark: MiB,
    read() {
      if (produced >= targetBytes) {
        this.push(null);
        return;
      }
      const size = Math.min(64 * 1024, targetBytes - produced);
      produced += size;
      this.push(Buffer.alloc(size, 0x43));
    },
  });
  const reader = toBoundedByteStream(source).getReader();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const bytesBeforeCancel = produced;
  expect(bytesBeforeCancel).toBeLessThanOrEqual(2 * MiB + 64 * 1024);
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(source.destroyed).toBe(true);
  expect(produced).toBe(bytesBeforeCancel);
});

it("rejects an in-flight range read when the request signal aborts", async () => {
  const createMediaResponse = requiredExport<CreateMediaResponse>("createMediaResponse");
  const fixture = await sparseFixture();
  const controller = new AbortController();
  try {
    const response = await createMediaResponse(fixture.file, "video/quicktime", "bytes=0-", controller.signal);
    const reader = response.body!.getReader();
    const pendingRead = reader.read();
    controller.abort(new Error("request cancelled"));
    await expect(pendingRead).rejects.toThrow(/abort|cancel/i);
    await reader.cancel().catch(() => {});
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});
