import { describe, expect, it } from "vitest";
import type { Project } from "../types";
import type {
  MotionAudioClip,
  MotionComposition,
  MotionVideoLayer,
} from "../motion/types";
import { DEFAULT_MOTION_TRANSFORM } from "../motion/types";
import type { MotionShaderDef } from "../motion/shaders/types";
import type {
  CacheRecord,
  IStorageEngine,
  MediaRecord,
  ProjectSummary,
  StorageUsage,
  WaveformRecord,
} from "./types";
import {
  ProjectSerializer,
  SCHEMA_VERSION,
  assertReaderCompatibility,
  normalizeMotionComposition,
  normalizeProjectCreationFields,
  normalizeProjectMotionFields,
  serializeProjectFile,
} from "./project-serializer";
import { createCreationScene, createEmptyCreationState } from "../creation";
import { UNIVERSAL_TRACKS_CAPABILITY } from "../timeline/timeline-items";
import { DEFAULT_MULTICAM_MANIFEST_CONSTRAINTS } from "../multicam/manifest";
import { makeWorkflowFixture } from "../lickety/test-fixtures";

const makeVideoLayer = (
  overrides: Partial<MotionVideoLayer> = {},
): MotionVideoLayer => ({
  id: "layer-video-1",
  type: "video",
  name: "Clip",
  startTime: 0,
  duration: 3,
  visible: true,
  locked: false,
  transform: DEFAULT_MOTION_TRANSFORM,
  keyframes: [],
  assetId: "asset-1",
  width: 1920,
  height: 1080,
  fit: "contain",
  playbackRate: 1,
  timeOffset: 0,
  trimStart: 0,
  muted: false,
  ...overrides,
});

const makeComposition = (
  overrides: Partial<MotionComposition> = {},
): MotionComposition => ({
  id: "comp-1",
  name: "Scene",
  width: 1920,
  height: 1080,
  frameRate: 30,
  duration: 5,
  backgroundColor: "transparent",
  layers: [],
  assets: [],
  variables: [],
  markers: [],
  createdAt: 1,
  modifiedAt: 1,
  ...overrides,
});

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: "project-1",
  name: "Project",
  createdAt: 1,
  modifiedAt: 1,
  settings: {
    width: 1920,
    height: 1080,
    frameRate: 30,
    sampleRate: 48000,
    channels: 2,
  },
  mediaLibrary: { items: [] },
  timeline: {
    tracks: [],
    subtitles: [],
    duration: 0,
    markers: [],
  },
  ...overrides,
});

class MemoryStorageEngine implements IStorageEngine {
  private projects = new Map<string, Project>();
  private media = new Map<string, MediaRecord>();

  async saveProject(project: Project): Promise<void> {
    this.projects.set(project.id, project);
  }
  async loadProject(id: string): Promise<Project | null> {
    return this.projects.get(id) ?? null;
  }
  async listProjects(): Promise<ProjectSummary[]> {
    return [...this.projects.values()].map((project) => ({
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      modifiedAt: project.modifiedAt,
    }));
  }
  async deleteProject(id: string): Promise<void> {
    this.projects.delete(id);
  }
  async saveMedia(media: MediaRecord): Promise<void> {
    this.media.set(media.id, media);
  }
  async loadMedia(id: string): Promise<MediaRecord | null> {
    return this.media.get(id) ?? null;
  }
  async deleteMedia(id: string): Promise<void> {
    this.media.delete(id);
  }
  async getMediaByProject(): Promise<MediaRecord[]> {
    return [];
  }
  async saveCache(): Promise<void> {}
  async loadCache(): Promise<CacheRecord | null> {
    return null;
  }
  async deleteCache(): Promise<void> {}
  async clearCache(): Promise<void> {}
  async saveWaveform(): Promise<void> {}
  async loadWaveform(): Promise<WaveformRecord | null> {
    return null;
  }
  async deleteWaveform(): Promise<void> {}
  async saveFileHandle(): Promise<void> {}
  async loadFileHandle(): Promise<FileSystemFileHandle | null> {
    return null;
  }
  async saveDirectoryHandle(): Promise<void> {}
  async loadDirectoryHandle(): Promise<{
    handle: FileSystemDirectoryHandle;
    folderName: string;
  } | null> {
    return null;
  }
  async getStorageUsage(): Promise<StorageUsage> {
    return { used: 0, quota: 0, projects: 0, mediaItems: 0 };
  }
  async clearAllData(): Promise<void> {}
  close(): void {}
}

describe("normalizeMotionComposition", () => {
  it("defaults audioClips to [] when missing", () => {
    const composition = makeComposition();
    expect(composition.audioClips).toBeUndefined();

    const normalized = normalizeMotionComposition(composition);

    expect(normalized.audioClips).toEqual([]);
  });

  it("preserves existing audioClips", () => {
    const audioClips: MotionAudioClip[] = [
      { id: "audio-1", startTime: 0, duration: 4, gain: 0.8 },
    ];
    const normalized = normalizeMotionComposition(
      makeComposition({ audioClips }),
    );

    expect(normalized.audioClips).toEqual(audioClips);
  });

  it("drops malformed audioClips entries", () => {
    const audioClips = [
      { id: "audio-1", startTime: 0, duration: 4 },
      null,
      { startTime: 1, duration: 2 },
    ] as unknown as MotionAudioClip[];

    const normalized = normalizeMotionComposition(
      makeComposition({ audioClips }),
    );

    expect(normalized.audioClips).toHaveLength(1);
    expect(normalized.audioClips?.[0]?.id).toBe("audio-1");
  });

  it("preserves video layers and their fields", () => {
    const videoLayer = makeVideoLayer({
      assetId: "video-asset-42",
      playbackRate: 1.5,
      trimStart: 2,
      muted: true,
    });
    const normalized = normalizeMotionComposition(
      makeComposition({ layers: [videoLayer] }),
    );

    expect(normalized.layers).toHaveLength(1);
    const layer = normalized.layers[0] as MotionVideoLayer;
    expect(layer.type).toBe("video");
    expect(layer.assetId).toBe("video-asset-42");
    expect(layer.playbackRate).toBe(1.5);
    expect(layer.trimStart).toBe(2);
    expect(layer.muted).toBe(true);
  });

  it("backfills guides/lights/tracks and is idempotent", () => {
    const composition = makeComposition();
    const once = normalizeMotionComposition(composition);
    const twice = normalizeMotionComposition(once);

    expect(once.guides).toEqual([]);
    expect(once.lights).toEqual([]);
    expect(once.tracks).toEqual([]);
    expect(twice).toEqual(once);
  });
});

describe("normalizeProjectMotionFields", () => {
  it("defaults motionCompositions and motionInstances", () => {
    const normalized = normalizeProjectMotionFields(makeProject());

    expect(normalized.motionCompositions).toEqual([]);
    expect(normalized.motionInstances).toEqual([]);
  });

  it("does not clobber existing motion instances", () => {
    const project = makeProject({
      motionInstances: [
        {
          id: "instance-1",
          compositionId: "comp-1",
          startTime: 0,
          duration: 5,
          transform: {
            position: { x: 0, y: 0 },
            scale: { x: 1, y: 1 },
            rotation: 0,
            anchor: { x: 0.5, y: 0.5 },
            opacity: 1,
            fitMode: "contain",
          },
          opacity: 1,
        },
      ],
    });

    const normalized = normalizeProjectMotionFields(project);

    expect(normalized.motionInstances).toHaveLength(1);
    expect(normalized.motionInstances?.[0]?.id).toBe("instance-1");
  });
});

describe("normalizeProjectCreationFields", () => {
  it("normalizes creation state while preserving scene records", () => {
    const creation = {
      ...createEmptyCreationState(),
      scenes: [createCreationScene({ id: "scene-creation", name: "Creation", now: 1 })],
    };
    const normalized = normalizeProjectCreationFields(makeProject({ creation }));

    expect(normalized.creation?.version).toBe(creation.version);
    expect(normalized.creation?.scenes).toHaveLength(1);
    expect(normalized.creation?.operationHistory).toEqual([]);
  });
});

describe("ProjectSerializer round-trip", () => {
  it("requires reader 1.4 for selected source channels and segmented camera angles, then round-trips them", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const fixture = makeWorkflowFixture();
    const clip = { ...fixture.timeline.tracks[1]!.clips[0]!, sourceChannelIndex: 1 };
    const project: Project = {
      ...fixture,
      timeline: { ...fixture.timeline, tracks: fixture.timeline.tracks.map((track, index) => index === 1 ? { ...track, clips: [clip] } : track) },
      multicamGroups: [{
        id: "podcast-group", name: "Episode",
        angles: [{
          id: "angle-main", name: "Main", clipId: "clip-source", trackId: "source-main", offset: 0,
          color: "#ef4444", isActive: true,
          sourceSegments: [{ mediaId: "cam-a", clipId: "clip-source", trackId: "source-main", sourceStartSeconds: 0, sourceEndSeconds: 20, episodeMapping: { scale: 1, offsetSeconds: 0 } }],
        }],
        activeAngleId: "angle-main", syncPoint: 0, duration: 20, createdAt: 1,
      }],
    };
    const json = serializer.exportToJson(project);
    const file = JSON.parse(json) as { version: string; minimumReaderVersion?: string; capabilities?: string[] };
    const imported = serializer.importFromJson(json);

    expect(SCHEMA_VERSION).toBe("1.4.0");
    expect(file).toMatchObject({ version: "1.4.0", minimumReaderVersion: "1.4.0" });
    expect(file.capabilities).toContain("licketysplit-podcast-assembly-v1");
    expect(imported.timeline.tracks[1]?.clips[0]?.sourceChannelIndex).toBe(1);
    expect(imported.multicamGroups?.[0]?.angles[0]?.sourceSegments?.[0]?.mediaId).toBe("cam-a");
    expect(() => assertReaderCompatibility({ version: "1.3.0", minimumReaderVersion: "1.4.0", project }, "1.3.0")).toThrow(/requires LicketySplit project reader 1\.4\.0 or newer/);
  });

  it("keeps the 1.3 minimum for older plain and workflow projects", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const workflow = makeProject({ lickety: { schemaVersion: 1 } });
    const plainFile = JSON.parse(serializer.exportToJson(makeProject())) as { version: string; minimumReaderVersion?: string };
    const workflowFile = JSON.parse(serializer.exportToJson(workflow)) as { version: string; minimumReaderVersion?: string };
    expect(plainFile.version).toBe("1.4.0");
    expect(plainFile.minimumReaderVersion).toBeUndefined();
    expect(workflowFile.minimumReaderVersion).toBe("1.3.0");
  });

  it("normalizes legacy multicam specs when old projects are reopened and saved", () => {
    const source = makeWorkflowFixture();
    const legacyGroup = {
      id: "legacy-group",
      name: "Interview",
      angles: [{
        id: "main", name: "Main", clipId: "camera-clip", trackId: "camera-track",
        offset: 0.25, color: "#a855f7", isActive: true,
        sourceSegments: [{ mediaId: "camera", clipId: "camera-clip", trackId: "camera-track", sourceStartSeconds: 3, sourceEndSeconds: 13, episodeMapping: { scale: 0.9999, offsetSeconds: 2 } }],
      }],
      activeAngleId: "main",
      syncPoint: 7,
      duration: 10,
      createdAt: 123,
      switches: [{ id: "switch-1", groupId: "legacy-group", angleId: "main", time: 4 }],
      manifest: {
        spec: "openreel-multicam/v1",
        fps: 25,
        sync: { method: "manual", reference: "main" },
        participants: [{ id: "host", name: "Host", audio: "mic", seat: "left" }],
        cameras: [{ id: "main", type: "wide", subject: "host", file: "camera.mov" }],
        constraints: DEFAULT_MULTICAM_MANIFEST_CONSTRAINTS,
        retainedExtension: { sourceNote: "preserve" },
      },
      shotPlan: {
        spec: "openreel-multicam-edit/v1",
        durationMs: 10_000,
        shots: [{ startMs: 1_000, endMs: 8_000, reason: "speaker", confidence: 0.9, transitionIn: { type: "cut", durationMs: 0 }, layout: { template: "solo", panels: [{ cameraId: "main", subject: "host", rect: { x: 0.1, y: 0, width: 0.8, height: 1 } }] } }],
        retainedExtension: { plannerNote: "preserve" },
      },
    } as unknown as NonNullable<Project["multicamGroups"]>[number];
    const oldProject = { ...source, multicamGroups: [legacyGroup] };
    const before = structuredClone(oldProject);
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const opened = serializer.importFromJson(JSON.stringify({ version: "1.3.0", project: oldProject }));
    const saved = JSON.parse(serializeProjectFile(opened)) as { project: Project };

    expect(saved.project.multicamGroups?.[0]?.manifest?.spec).toBe("licketysplit-multicam/v1");
    expect(saved.project.multicamGroups?.[0]?.shotPlan?.spec).toBe("licketysplit-multicam-edit/v1");
    expect(saved.project.multicamGroups?.[0]).toEqual({
      ...legacyGroup,
      manifest: { ...legacyGroup.manifest, spec: "licketysplit-multicam/v1" },
      shotPlan: { ...legacyGroup.shotPlan, spec: "licketysplit-multicam-edit/v1" },
    });
    expect(oldProject).toEqual(before);
  });

  it("writes the universal-track reader requirement and preserves it", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const project = makeProject({
      capabilities: [UNIVERSAL_TRACKS_CAPABILITY],
      minimumReaderVersion: "1.2.0",
    });

    const json = serializer.exportToJson(project);
    const file = JSON.parse(json) as {
      version: string;
      minimumReaderVersion?: string;
      capabilities?: string[];
    };

    expect(file.version).toBe(SCHEMA_VERSION);
    expect(file.minimumReaderVersion).toBe("1.2.0");
    expect(file.capabilities).toContain(UNIVERSAL_TRACKS_CAPABILITY);
    expect(serializer.importFromJson(json).capabilities).toContain(
      UNIVERSAL_TRACKS_CAPABILITY,
    );
  });

  it("rejects a project that needs a newer reader", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const json = JSON.stringify({
      version: "9.0.0",
      minimumReaderVersion: "9.0.0",
      project: makeProject(),
    });

    expect(() => serializer.importFromJson(json)).toThrow(
      /requires LicketySplit project reader 9\.0\.0 or newer/,
    );
    expect(serializer.validateProjectJson(json)).toMatchObject({
      valid: false,
    });
  });

  it("preserves audioClips and video layers through export/import", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const composition = makeComposition({
      layers: [makeVideoLayer()],
      audioClips: [{ id: "audio-1", startTime: 0, duration: 4 }],
    });
    const project = makeProject({ motionCompositions: [composition] });

    const json = serializer.exportToJson(project);
    const imported = serializer.importFromJson(json);

    expect(imported.motionCompositions).toHaveLength(1);
    const importedComposition = imported.motionCompositions![0];
    expect(importedComposition.audioClips).toEqual([
      { id: "audio-1", startTime: 0, duration: 4 },
    ]);
    expect(importedComposition.layers).toHaveLength(1);
    expect((importedComposition.layers[0] as MotionVideoLayer).type).toBe(
      "video",
    );
    expect((importedComposition.layers[0] as MotionVideoLayer).assetId).toBe(
      "asset-1",
    );
  });

  it("backfills audioClips when an older composition lacks it", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const composition = makeComposition({ layers: [makeVideoLayer()] });
    const project = makeProject({ motionCompositions: [composition] });

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.motionCompositions![0].audioClips).toEqual([]);
  });
});

const makeShaderDef = (
  overrides: Partial<MotionShaderDef> = {},
): MotionShaderDef => ({
  id: "ai-round-1",
  name: "AI Round",
  category: "fill",
  glsl: "void main(){}",
  params: [
    {
      name: "u_intensity",
      label: "Intensity",
      type: "number",
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],
  origin: "generated",
  ...overrides,
});

describe("ProjectSerializer generatedShaders", () => {
  it("round-trips a valid generated shader through export/import", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const def = makeShaderDef();
    const project = makeProject({ generatedShaders: [def] });

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.generatedShaders).toEqual([def]);
  });

  it("drops malformed generated shaders on import", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const valid = makeShaderDef();
    const badCategory = makeShaderDef({ id: "ai-bad-cat", category: "wrong" as MotionShaderDef["category"] });
    const missingGlsl = { ...makeShaderDef({ id: "ai-no-glsl" }), glsl: undefined };
    const project = makeProject({
      generatedShaders: [valid, badCategory, missingGlsl] as MotionShaderDef[],
    });

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.generatedShaders?.map((d) => d.id)).toEqual(["ai-round-1"]);
  });

  it("defaults generatedShaders to an empty array when absent", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const project = makeProject();

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.generatedShaders).toEqual([]);
  });
});
