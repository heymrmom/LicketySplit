/** Broadcast-WAV sample reference is elapsed source samples, formatted at the
 * nominal timebase while preserving the actual (possibly fractional) rate. */
export function timecodeFromSampleReference(value: string | undefined, sampleRate: number, fps: number) {
  const samples = Number(value);
  if (!value || !Number.isFinite(samples) || samples < 0 || !Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(fps) || fps <= 0) return undefined;
  const timebase = Math.max(1, Math.round(fps));
  const totalFrames = Math.round(samples / sampleRate * fps);
  const framesPerHour = timebase * 3600, framesPerMinute = timebase * 60;
  const hours = Math.floor(totalFrames / framesPerHour) % 24;
  const minutes = Math.floor(totalFrames % framesPerHour / framesPerMinute);
  const seconds = Math.floor(totalFrames % framesPerMinute / timebase);
  const frames = totalFrames % timebase;
  return [hours, minutes, seconds, frames].map((part) => String(part).padStart(2, "0")).join(":");
}

export function podcastSequenceMetadata(name: string) {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  const stem = extension ? name.slice(0, -extension.length) : name;
  const match = /^(.*?)(\d+)(\D*)$/.exec(stem);
  if (!match) return {};
  return {
    familyKey: `${match[1].toLowerCase().replace(/\d{8,}/g, "{timestamp}")}#${match[3].toLowerCase()}${extension}`,
    sequenceNumber: Number(match[2]),
  };
}
