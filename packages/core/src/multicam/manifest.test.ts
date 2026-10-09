import { describe, expect, it } from "vitest";
import {
  DEFAULT_MULTICAM_MANIFEST_CONSTRAINTS,
  manifestConstraintsToPolicy,
  parseMulticamManifest,
  serializeMulticamManifest,
  validateMulticamManifest,
  type MulticamManifest,
} from "./manifest";

const manifest = (): MulticamManifest => ({
  spec: "openreel-multicam/v1",
  fps: 25,
  sync: { method: "audio-crosscorr", reference: "wide" },
  participants: [
    { id: "p1", name: "Alex", audio: "track-1", seat: "left" },
    { id: "p2", name: "Jamie", audio: "track-2", seat: "right" },
  ],
  cameras: [
    { id: "a", type: "closeup", subject: "p1", file: "A001.mp4" },
    { id: "b", type: "closeup", subject: "p2", file: "B001.mp4" },
    { id: "wide", type: "wide", subject: "all", file: "C001.mp4" },
  ],
  constraints: { ...DEFAULT_MULTICAM_MANIFEST_CONSTRAINTS },
});

describe("validateMulticamManifest", () => {
  it("accepts the openreel-multicam/v1 shoot specification", () => {
    expect(validateMulticamManifest(manifest())).toEqual({ valid: true, errors: [] });
  });

  it("accepts explicitly unknown podcast framing without inventing a participant subject", () => {
    const value = manifest();
    value.cameras[0] = { id: "a", type: "unknown", subject: "unmapped", file: "A001.mp4" };
    value.participants[0]!.audioWindows = [{ trackId: "track-1", clipId: "mic-1", mediaId: "media-1", startTime: 2, duration: 4, inPoint: 0, outPoint: 4, speed: 1, volume: 1, sourceChannelIndex: 0 }];

    expect(validateMulticamManifest(value)).toEqual({ valid: true, errors: [] });
  });

  it("requires isolated mics, valid subjects, a wide shot, and a sync reference", () => {
    const invalid = manifest();
    invalid.participants = invalid.participants.slice(0, 1);
    invalid.cameras = [
      { id: "a", type: "closeup", subject: "missing", file: "A001.mp4" },
      { id: "a", type: "closeup", subject: "p1", file: "B001.mp4" },
    ];
    invalid.sync.reference = "missing";

    const result = validateMulticamManifest(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "participants must contain at least one routed microphone",
        "cameras[0].subject references unknown participant missing",
        "camera id a is duplicated",
        "cameras must include at least one locked-off wide shot",
        "sync.reference missing is not a camera",
      ]),
    );
  });

  it("maps manifest constraints into engine policy fields", () => {
    expect(manifestConstraintsToPolicy(DEFAULT_MULTICAM_MANIFEST_CONSTRAINTS)).toMatchObject({
      minShotMs: 1_800,
      maxShotMs: 25_000,
      cutLeadMs: 120,
      reactionShotAfterMs: 12_000,
      forbidJumpCutSameSubject: true,
    });
  });

  it("parses equivalent JSON and YAML shoot manifests", () => {
    const value = manifest();
    const json = parseMulticamManifest(JSON.stringify(value));
    const yaml = parseMulticamManifest(serializeMulticamManifest(value, "yaml"));

    expect(json).toEqual(value);
    expect(yaml).toEqual(value);
  });
});
