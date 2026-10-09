import { it, expect } from "vitest";
import { makeWorkflowFixture } from "@openreel/core/lickety/test-fixtures";
import { useLicketyWorkflowStore } from "./lickety-workflow-store";
import { useProjectStore } from "./project-store";
import { snapshotDialogue } from "../services/lickety/transcription";
import { finalWords } from "../services/lickety/shorts";

it("fresh transcription preserves podcast assembly while clearing stale editorial results", async () => {
  Object.assign(window, { openreel: { platform: "desktop", lickety: {
    findAsset: async (mediaId: string) => ({ identity: { assetId: mediaId, mediaId, sha256: "sha", byteLength: 1 } }),
    resumeTranscription: async () => {},
  } } });
  const source = makeWorkflowFixture();
  const snapshot = await snapshotDialogue(source);
  const doc = { schemaVersion: 1, snapshotHash: snapshot.revisionHash, provider: "assemblyai", providerJobId: "fresh", preparedAudioSha256: "sha", words: [{ id: "new", text: "new current speech", startMs: 100, endMs: 500, confidence: 1 }] };
  window.openreel!.lickety!.getTranscription = async () => ({ state: "completed", transcript: doc }) as never;
  const podcastSetup = { setupId: "setup-kept", revision: 3 };
  const podcastAssembly = { setupId: "setup-kept", setupRevision: 3, originShiftSeconds: 12, ownedTrackIds: ["owned"], groupIds: ["group"] };
  const project = {
    ...source,
    timeline: { ...source.timeline, markers: [{ id: "lickety-cue:old", time: 0.1, label: "old", color: "#000" }, { id: "manual", time: 1, label: "Keep", color: "#000" }] },
    lickety: {
      schemaVersion: 1 as const,
      podcastSetup: podcastSetup as never,
      podcastAssembly: podcastAssembly as never,
      words: [{ occurrenceId: "old", sourceWordId: "old", text: "deleted old speech", startMs: 100, endMs: 500 }],
      cues: [{ id: "old", kind: "onscreen" as const, startMs: 100, endMs: 500, evidence: "old", action: "old" }],
      sourceShortCandidates: [{ id: "old", wordIds: ["old"], maxDurationMs: 45_000 }],
      narrative: { old: true } as never,
      semanticShorts: [{ old: true }] as never,
    },
  };
  useProjectStore.setState({ project });
  useLicketyWorkflowStore.setState({ jobs: { [project.id]: { jobId: "fresh", snapshot, state: "processing" } } });

  await useLicketyWorkflowStore.getState().resume(project);

  const updated = useProjectStore.getState().project;
  expect(finalWords(updated).map((word) => word.text)).toEqual(["new current speech"]);
  expect(updated.lickety?.sourceShortCandidates).toBeUndefined();
  expect(updated.lickety?.cues).toBeUndefined();
  expect(updated.lickety?.narrative).toBeUndefined();
  expect(updated.lickety?.semanticShorts).toBeUndefined();
  expect(updated.lickety?.podcastSetup).toEqual(podcastSetup);
  expect(updated.lickety?.podcastAssembly).toEqual(podcastAssembly);
  expect(updated.timeline.markers.map((marker) => marker.id)).toEqual(["manual"]);
});
