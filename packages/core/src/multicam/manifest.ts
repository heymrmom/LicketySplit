import type { MulticamEditPolicy } from "./automatic-edit";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const MULTICAM_MANIFEST_SPEC = "licketysplit-multicam/v1" as const;
export const LEGACY_MULTICAM_MANIFEST_SPEC = "openreel-multicam/v1" as const;

export type MulticamCameraType =
  | "closeup"
  | "wide"
  | "two-shot"
  | "reaction"
  | "unknown";
export type MulticamSeat = "left" | "center" | "right" | number;

export interface MulticamManifestParticipant {
  id: string;
  name: string;
  /** Audio media/track identifier mapped to this isolated microphone. */
  audio: string;
  seat: MulticamSeat;
  /** A single shared conversation mix is not evidence of isolated speakers. */
  audioMode?: "isolated" | "shared-mix";
  /** All source lanes when a participant is assembled from several original files. */
  audioTracks?: string[];
  bindings?: Array<{ trackId: string; streamIndex?: number; channel?: number }>;
  /** Live clip windows used to invalidate activity after microphone edits. */
  audioWindows?: Array<{
    trackId: string;
    clipId: string;
    mediaId: string;
    startTime: number;
    duration: number;
    inPoint: number;
    outPoint: number;
    speed: number;
    volume: number;
    sourceChannelIndex?: number;
  }>;
}

export interface MulticamManifestCamera {
  id: string;
  type: MulticamCameraType;
  /** Participant id, a '+'-joined participant list, or 'all'. */
  subject: string;
  /** Original file hint used to resolve/relink the camera source. */
  file: string;
  /** Optional resolved LicketySplit timeline clip id. */
  clipId?: string;
  /** Runtime angle mapping; camera id/file remain the shoot-authored identity. */
  angleId?: string;
  /** Ordered original-source coverage used by grouped podcast angles. */
  sourceSegments?: import("../video/multicam-engine").CameraSourceSegment[];
}

export interface MulticamManifestSync {
  method: "audio-crosscorr" | "timecode" | "manual";
  reference: string;
  block_seconds?: number;
  max_offset_seconds?: number;
}

export interface MulticamManifestConstraints {
  min_shot_ms: number;
  max_shot_ms: number;
  cut_lead_ms: number;
  reaction_shot_after_ms: number;
  forbid_jump_cut_same_subject: boolean;
}

export interface MulticamManifest {
  spec: typeof MULTICAM_MANIFEST_SPEC;
  fps: number;
  sync: MulticamManifestSync;
  participants: MulticamManifestParticipant[];
  cameras: MulticamManifestCamera[];
  constraints: MulticamManifestConstraints;
}

export interface MulticamManifestValidation {
  valid: boolean;
  errors: string[];
}

export const DEFAULT_MULTICAM_MANIFEST_CONSTRAINTS: MulticamManifestConstraints = {
  min_shot_ms: 1_800,
  max_shot_ms: 25_000,
  cut_lead_ms: 120,
  reaction_shot_after_ms: 12_000,
  forbid_jump_cut_same_subject: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  path: string,
  errors: string[],
): value is string {
  if (typeof value === "string" && value.trim().length > 0) return true;
  errors.push(`${path} is required`);
  return false;
}

function positiveNumber(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    errors.push(`${path} must be a positive number`);
  }
}

/** Validates parsed multicam.json or multicam.yaml content against v1. */
export function validateMulticamManifest(
  value: unknown,
): MulticamManifestValidation {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, errors: ["Manifest must be an object"] };
  }
  if (value.spec !== MULTICAM_MANIFEST_SPEC && value.spec !== LEGACY_MULTICAM_MANIFEST_SPEC) {
    errors.push(`spec must be ${MULTICAM_MANIFEST_SPEC} or ${LEGACY_MULTICAM_MANIFEST_SPEC}`);
  }
  positiveNumber(value.fps, "fps", errors);

  const participants = Array.isArray(value.participants) ? value.participants : [];
  if (participants.length < 2 && !(participants.length === 1 && isRecord(participants[0]) && (participants[0].audioMode === "shared-mix" || participants[0].audioMode === "isolated"))) {
    errors.push("participants must contain at least one routed microphone");
  }
  const participantIds = new Set<string>();
  participants.forEach((entry, index) => {
    const path = `participants[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (requiredString(entry.id, `${path}.id`, errors)) {
      if (participantIds.has(entry.id)) errors.push(`participant id ${entry.id} is duplicated`);
      participantIds.add(entry.id);
    }
    requiredString(entry.name, `${path}.name`, errors);
    requiredString(entry.audio, `${path}.audio`, errors);
    if (entry.audioMode !== undefined && entry.audioMode !== "isolated" && entry.audioMode !== "shared-mix") errors.push(`${path}.audioMode is invalid`);
    if (entry.audioTracks !== undefined && (!Array.isArray(entry.audioTracks) || entry.audioTracks.some((trackId) => typeof trackId !== "string" || !trackId))) errors.push(`${path}.audioTracks is invalid`);
    if (entry.bindings !== undefined && (!Array.isArray(entry.bindings) || entry.bindings.some((binding) => {
      if (!isRecord(binding)) return true;
      return typeof binding.trackId !== "string" ||
        (binding.streamIndex !== undefined && (typeof binding.streamIndex !== "number" || !Number.isInteger(binding.streamIndex) || binding.streamIndex < 0)) ||
        (binding.channel !== undefined && (typeof binding.channel !== "number" || !Number.isInteger(binding.channel) || binding.channel < 0));
    }))) errors.push(`${path}.bindings is invalid`);
    if (entry.audioWindows !== undefined && (!Array.isArray(entry.audioWindows) || entry.audioWindows.some((window) => {
      if (!isRecord(window)) return true;
      return typeof window.trackId !== "string" || typeof window.clipId !== "string" || typeof window.mediaId !== "string" ||
        [window.startTime, window.duration, window.inPoint, window.outPoint, window.speed, window.volume].some((field) => typeof field !== "number" || !Number.isFinite(field)) ||
        (window.sourceChannelIndex !== undefined && (typeof window.sourceChannelIndex !== "number" || !Number.isInteger(window.sourceChannelIndex) || window.sourceChannelIndex < 0));
    }))) errors.push(`${path}.audioWindows is invalid`);
    if (
      entry.seat !== "left" &&
      entry.seat !== "center" &&
      entry.seat !== "right" &&
      (typeof entry.seat !== "number" || !Number.isFinite(entry.seat))
    ) {
      errors.push(`${path}.seat must be left, center, right, or a numeric order`);
    }
  });

  const cameras = Array.isArray(value.cameras) ? value.cameras : [];
  if (cameras.length < 2) errors.push("cameras must contain at least two angles");
  const cameraIds = new Set<string>();
  let hasWide = false;
  cameras.forEach((entry, index) => {
    const path = `cameras[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (requiredString(entry.id, `${path}.id`, errors)) {
      if (cameraIds.has(entry.id)) errors.push(`camera id ${entry.id} is duplicated`);
      cameraIds.add(entry.id);
    }
    if (
      !(["closeup", "wide", "two-shot", "reaction", "unknown"] as const).includes(
        entry.type as MulticamCameraType,
      )
    ) {
      errors.push(`${path}.type is invalid`);
    }
    if (entry.type === "wide") hasWide = true;
    if (requiredString(entry.subject, `${path}.subject`, errors) && entry.type !== "unknown") {
      const subjects = entry.subject === "all" ? [] : entry.subject.split("+");
      for (const subject of subjects) {
        if (!participantIds.has(subject)) {
          errors.push(`${path}.subject references unknown participant ${subject}`);
        }
      }
    }
    requiredString(entry.file, `${path}.file`, errors);
  });
  if (!hasWide) errors.push("cameras must include at least one locked-off wide shot");

  if (!isRecord(value.sync)) {
    errors.push("sync is required");
  } else {
    if (
      !(["audio-crosscorr", "timecode", "manual"] as const).includes(
        value.sync.method as MulticamManifestSync["method"],
      )
    ) {
      errors.push("sync.method is invalid");
    }
    if (
      requiredString(value.sync.reference, "sync.reference", errors) &&
      !cameraIds.has(value.sync.reference)
    ) {
      errors.push(`sync.reference ${value.sync.reference} is not a camera`);
    }
  }

  if (!isRecord(value.constraints)) {
    errors.push("constraints are required");
  } else {
    for (const key of [
      "min_shot_ms",
      "max_shot_ms",
      "reaction_shot_after_ms",
    ] as const) {
      positiveNumber(value.constraints[key], `constraints.${key}`, errors);
    }
    if (
      typeof value.constraints.cut_lead_ms !== "number" ||
      !Number.isFinite(value.constraints.cut_lead_ms) ||
      value.constraints.cut_lead_ms < 0
    ) {
      errors.push("constraints.cut_lead_ms must be a non-negative number");
    }
    if (typeof value.constraints.forbid_jump_cut_same_subject !== "boolean") {
      errors.push("constraints.forbid_jump_cut_same_subject must be boolean");
    }
    if (
      typeof value.constraints.min_shot_ms === "number" &&
      typeof value.constraints.max_shot_ms === "number" &&
      value.constraints.max_shot_ms < value.constraints.min_shot_ms
    ) {
      errors.push("constraints.max_shot_ms must be >= min_shot_ms");
    }
  }

  return { valid: errors.length === 0, errors };
}

export function manifestConstraintsToPolicy(
  constraints: MulticamManifestConstraints,
  overrides: Partial<MulticamEditPolicy> = {},
): Partial<MulticamEditPolicy> {
  return {
    minShotMs: constraints.min_shot_ms,
    maxShotMs: constraints.max_shot_ms,
    cutLeadMs: constraints.cut_lead_ms,
    reactionShotAfterMs: constraints.reaction_shot_after_ms,
    forbidJumpCutSameSubject: constraints.forbid_jump_cut_same_subject,
    ...overrides,
  };
}

export function parseMulticamManifest(
  contents: string,
  format: "json" | "yaml" | "auto" = "auto",
): MulticamManifest {
  let parsed: unknown;
  try {
    const trimmed = contents.trim();
    parsed = format === "json" || (format === "auto" && (trimmed.startsWith("{") || trimmed.startsWith("[")))
      ? JSON.parse(trimmed)
      : parseYaml(trimmed);
  } catch (error) {
    throw new Error(
      `Could not parse multicam manifest: ${error instanceof Error ? error.message : "invalid syntax"}`,
    );
  }
  const validation = validateMulticamManifest(parsed);
  if (!validation.valid) {
    throw new Error(`Invalid multicam manifest: ${validation.errors.join("; ")}`);
  }
  return { ...(parsed as MulticamManifest), spec: MULTICAM_MANIFEST_SPEC };
}

export function serializeMulticamManifest(
  manifest: MulticamManifest,
  format: "json" | "yaml" = "json",
): string {
  const current = { ...manifest, spec: MULTICAM_MANIFEST_SPEC };
  return format === "json"
    ? JSON.stringify(current, null, 2)
    : stringifyYaml(current);
}
