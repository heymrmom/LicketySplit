import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { boundedRange } from "./asset-registry";

export const MEDIA_READ_CHUNK_BYTES = 1024 * 1024;

/** Convert Node byte chunks without counting each chunk as a single Web queue unit. */
export function toBoundedByteStream(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream, {
    strategy: {
      highWaterMark: MEDIA_READ_CHUNK_BYTES,
      size: (chunk: Uint8Array) => chunk.byteLength,
    },
  }) as ReadableStream<Uint8Array>;
}

/** Serve the full single Range requested while keeping filesystem and Web-stream buffers byte-bounded. */
export async function createMediaResponse(
  file: string,
  mime: string,
  rangeHeader: string | null,
  signal?: AbortSignal,
  allowedOrigin?: string,
): Promise<Response> {
  const { size } = await fs.stat(file);
  let range: ReturnType<typeof boundedRange>;
  try {
    range = boundedRange(rangeHeader, size);
  } catch {
    return new Response(null, {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${size}`,
        ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin } : {}),
      },
    });
  }

  const stream = createReadStream(file, {
    start: range.start,
    end: range.end,
    highWaterMark: MEDIA_READ_CHUNK_BYTES,
    signal,
  });
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Content-Length": String(range.end - range.start + 1),
    "Cross-Origin-Resource-Policy": "cross-origin",
    ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin } : {}),
  };
  if (range.partial) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  return new Response(toBoundedByteStream(stream), { status: range.partial ? 206 : 200, headers });
}
