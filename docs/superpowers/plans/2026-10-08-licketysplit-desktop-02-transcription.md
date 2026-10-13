# LicketySplit AssemblyAI Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exclusive desktop AssemblyAI speech-to-text with correct word/channel identity and recovery.

**Architecture:** Keep credentials and provider jobs in Electron main; use managed, streamed audio and a portable transcript contract. Existing editor caption and multicam consumers share the same service.

**Tech Stack:** TypeScript, React, Electron 33, existing native FFmpeg, MediaBunny, Vitest, Node 22, declared pnpm version.

**Spec:** [../specs/2026-10-08-licketysplit-desktop-design.md](../specs/2026-10-08-licketysplit-desktop-design.md) — read it first, particularly the numbered interface contracts and acceptance envelope.

**Status:** Review draft; the user has requested these plans, not their execution. No implementation or release is authorized by a checked planning document alone.

## Global Constraints

These lines are copied into each implementation plan.

- Product and installer name: `LicketySplit`; proposed new app ID: `com.heymrmom.licketysplit.desktop`; do not reuse `studio.cutline.app` or `video.openreel.desktop`.
- First supported target: Apple silicon ARM64, macOS 14 or newer, 8 GB RAM. macOS 14 is a proposed support floor for this review, not an already-tested compatibility claim.
- Keep internal `@openreel/*` workspace names and existing renderer IPC namespace unless a specific new channel requires an addition; preserve attribution/licenses.
- Keep OpenReel multicamera sync, camera planner, setup, and reframing algorithms. Native input preparation may change; prove timing/output parity on fixtures.
- AssemblyAI is the only speech-to-text provider; no desktop Whisper action, fallback, or model download. Imported subtitle files remain supported.
- Narrative input is an immutable snapshot of the current timeline; original media and the source project remain untouched; result is a separately saved editable draft.
- Preview proxies never replace originals in the media library, analysis source identity, or full-quality export. Export must fail clearly when an original is missing.
- Low-memory profile: total RAM <= 8 GiB; one heavy native media job at a time; four cached video decoders maximum; 16 MiB maximum IPC/file-read chunk.
- Low-memory automatic proxy policy: video above a 960x540 landscape / 540x960 portrait bounding box requires a disk-backed proxy before normal preview. Never upscale a smaller source; preserve source presentation-time mapping.
- Proposed physical-device acceptance: app process-tree sampled RSS <= 3 GiB in the representative fixture; ready-preview seek p95 <= 500 ms; warm playback >= 90% of source frames for sources <= 30 fps; cancel acknowledgement <= 2 s and worker exit <= 5 s. These are release gates to measure, not current results or universal project guarantees.
- Heavy audio operations use <= 10 s chunks and no full-duration decoded 48 kHz AudioBuffer for recordings longer than 120 s. Sync input is compact mono 1 kHz; VAD analysis is processed sequentially at 16 kHz. Keep the existing DSP decision policy.
- All new paid actions require explicit user initiation/confirmation. API keys stay in the existing OS-protected key store; no key in project files, GitHub assets, logs, or AssemblyAI renderer results.
- Keep OpenReel cost/confirmation UX; no legacy dollar ledger. Persist known provider job IDs/results; never blindly resubmit a non-idempotent POST after an uncertain submission.
- First release channels: GitHub draft prerelease, manual download; no automatic updater until repository visibility and signed-update authorization are reviewed.
- Do not change the live Railway service, DNS, installed legacy app, unrelated work, repository visibility, or publish a release during implementation-plan execution without the relevant explicit release action.

## Review Focus

- Shared mix vs isolated microphones: correct provider settings and participant names (Tasks 1/2).
- Audio gaps/source offsets: returned words retain frozen timeline timing (Task 1).
- Unknown paid submission: no silent second POST (Task 2).
- App closes during polling: known provider ID resumes (Task 2).
- Desktop entry point still calls local model: captions/multicam/agent are all routed (Task 3).

---

## File structure and task ownership

Each task's Files/Interfaces blocks below define the module boundaries. New behavior lives in focused `lickety` modules, with small changes to upstream integration points. No broad rewrite of the editor, no changes to the Railway deployment, and no removal of unrelated upstream desktop capabilities.

## Prerequisites

All test snippets use test-local injected transports/fixture objects. Define those fixtures in the listed test file or use `makeWorkflowFixture`; helper names in assertions are not additional production APIs. Their behavior is fixed by the named cases and exact expected values.

Read the spec and prior work-package Interfaces. At execution time use an isolated managed worktree on a `codex/` branch from the reviewed baseline; inspect the current checkout and preserve unrelated work. Record baseline failures before modifications. Install only the repository's frozen dependency set and compile existing WASM before tests that need it. Capture progress in the linked ClickUp task, not a second persistent task ledger.

### Task 1: Canonical timeline snapshot and streamed analysis audio

**Files:**
- Create: `packages/core/src/lickety/snapshot.ts`, `packages/core/src/lickety/transcript.ts`, `apps/web/src/services/lickety/transcription.ts`
- Modify: `apps/desktop/src/main/ipc/lickety.ts`, `apps/desktop/src/preload/index.ts`, `apps/web/src/types/global.d.ts`
- Test: `packages/core/src/lickety/snapshot.test.ts`, `packages/core/src/lickety/transcript.test.ts`, `apps/web/src/services/lickety/transcription.test.ts`

**Interfaces:**
- Consumes: package 1 ResourceProfile/managed audio/window interfaces; current audible track roles, original media identities.
- Produces: `createAnalysisSnapshot(project:Project,assets:AssetIdentity[]):Promise<AnalysisSnapshot>`; `prepareAnalysisAudio(snapshot:AnalysisSnapshot,options:{mode:"mixed"|"isolated-stereo";participants?:{channel:1|2;participantId:string}[]},signal:AbortSignal):Promise<PreparedAudio>`; `normalizeAssemblyTranscript(raw:unknown,snapshot:AnalysisSnapshot,audio:PreparedAudio):TranscriptDocument`.

- [ ] **Step 1: Write the failing tests** in the listed test files. Use these assertions and the additional named cases below.

```ts
it('maps two microphone channels without pretending shared sound is isolated', () => {
  const doc = normalizeAssemblyTranscript(stereoResponse, snapshot, stereoAudio);
  expect(new Set(doc.words.map(w => w.channel))).toEqual(new Set([1,2]));
  expect(doc.words.every(w => w.endMs > w.startMs)).toBe(true);
});
it('keeps late speech at the same timeline time', async () => {
  const audio = await prepareGapFixture();
  expect(audio.impulseTimesMs).toEqual([1000, 3_599_000]);
});
```

Task owns `muted_reference_audio_not_uploaded`, `gaps_and_nonzero_source_inpoints`, `two_channels_do_not_duplicate_words`, `unknown_speaker_remains_unknown`, `visual_style_change_reuses_audio_identity`, `source_audio_change_invalidates`, `malformed_provider_timestamps_reject`, and a fractional-rate one-hour impulse fixture. See spec section 8 for sample/channel and model values.

- [ ] **Step 2: Run the tests and confirm the new contract fails.**

Run: `pnpm --filter @openreel/core exec vitest run src/lickety/snapshot.test.ts src/lickety/transcript.test.ts && pnpm --filter @openreel/web exec vitest run src/services/lickety/transcription.test.ts`
Expected: FAIL for the missing new behavior/module; distinguish unrelated baseline failures.

- [ ] **Step 3: Implement the listed interfaces in the owning files.**

Freeze relevant audio timing and asset content identity, not current UI selection. Visual-only style changes do not change submitted audio identity. Prepare 16 kHz PCM to a managed disk handle in <=10 s chunks through the existing audio renderer/native ranged fallback, respecting gaps and audible dialogue roles. Mixed mono uses speaker diarization; isolated stereo requires deliberate channel mapping. Missing roles get a compact selector, not a full setup redesign. Hash audio as written. Normalize full provider words/utterances using official schema; stable word IDs include job/channel/order. Keep overlapping speakers and unknown identities. Add explicit disambiguation for a word whose audio timing cannot map to the frozen timeline; never fabricate timestamps.

- [ ] **Step 4: Run the same tests and the owning package typecheck.**

Run: `pnpm --filter @openreel/core exec vitest run src/lickety/snapshot.test.ts src/lickety/transcript.test.ts && pnpm --filter @openreel/web exec vitest run src/services/lickety/transcription.test.ts`
Expected: PASS.

Run: `pnpm --filter @openreel/core typecheck && pnpm --filter @openreel/web typecheck && pnpm --filter @openreel/desktop typecheck`
Expected: exit 0 for all owning/consuming TypeScript checks. Preserve existing behavior.

- [ ] **Step 5: Commit only this task's files after verification.**

```bash
git add packages/core/src/lickety/snapshot.ts packages/core/src/lickety/transcript.ts apps/web/src/services/lickety/transcription.ts apps/desktop/src/main/ipc/lickety.ts apps/desktop/src/preload/index.ts apps/web/src/types/global.d.ts packages/core/src/lickety/snapshot.test.ts packages/core/src/lickety/transcript.test.ts apps/web/src/services/lickety/transcription.test.ts
git commit -m "feat: prepare canonical AssemblyAI timeline audio"
```

### Task 2: Secure AssemblyAI submission, durable job IDs and restart recovery

**Files:**
- Create: `apps/desktop/src/main/lickety/assemblyai-client.ts`, `apps/desktop/src/main/lickety/job-store.ts`
- Modify: `apps/desktop/src/main/ipc/lickety.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/shared/channels.ts`, `apps/desktop/src/shared/ipc-contract.ts`, `apps/web/src/types/global.d.ts`, `apps/web/src/components/editor/settings/ApiKeysPanel.tsx`
- Test: `apps/desktop/test/assemblyai-client.test.ts`, `apps/desktop/test/transcription-jobs.test.ts`

**Interfaces:**
- Consumes: PreparedAudio handle/snapshot and existing KeyStore; normalized transcript function; existing action-confirmation UX.
- Produces: `startTranscription(args:{audio:PreparedAudio;snapshot:AnalysisSnapshot;mode:"mixed"|"isolated-stereo";participants?:{channel:1|2;participantId:string}[];confirmationId:string}):Promise<{jobId:string}>`; `getTranscription(jobId:string):Promise<{state:JobState;providerJobId?:string;transcript?:TranscriptDocument;error?:string}>`; `cancelTranscription(jobId:string):Promise<void>`; `resumeTranscription(jobId:string):Promise<void>`.

- [ ] **Step 1: Write the failing tests** in the listed test files. Use these assertions and the additional named cases below.

```ts
it('resumes a known provider job without another POST', async () => {
  await service.resumeTranscription(savedJob.id);
  expect(transport.calls.filter(c => c.method === 'POST')).toHaveLength(0);
});
it('does not blindly retry an uncertain paid submission', async () => {
  await service.startTranscription(confirmedArgs);
  expect(await service.getTranscription(localJobId)).toMatchObject({state:'submission-unknown'});
  expect(submitPostCount).toBe(1);
});
```

Task owns `locked_key_before_upload`, `key_redacted_in_error_and_receipt`, `401_429_timeout_provider_error`, `malicious_audio_handle_rejected`, `restart_during_poll`, `cancel_after_submission_keeps_provider_id`, `completed_cache_reused`, and no automatic POST after network uncertainty. Fixtures use injected transport; no paid requests in this task.

- [ ] **Step 2: Run the tests and confirm the new contract fails.**

Run: `pnpm --filter @openreel/desktop exec vitest run test/assemblyai-client.test.ts test/transcription-jobs.test.ts`
Expected: FAIL for the missing new behavior/module; distinguish unrelated baseline failures.

- [ ] **Step 3: Implement the listed interfaces in the owning files.**

Resolve key `assemblyai` only in main. Stream managed audio to upload, submit with the reviewed speech_models and channel settings, write job ID atomically immediately, then GET poll at 3 s. Bound transient GET retries to three; respect Retry-After. Persist completed transcript and context so restart/retry never needs a duplicate paid call for known results. Uncertain submission is a separate recoverable state with no automatic resubmission. Handle locked key/401 before paid retry; cancellation aborts local work and clearly distinguishes remote already-submitted work. Validate IPC with Zod, resolve opaque handles against the managed registry, and do not expose secrets/upload URLs/path strings in renderer events. No monetary ledger is added.

- [ ] **Step 4: Run the same tests and the owning package typecheck.**

Run: `pnpm --filter @openreel/desktop exec vitest run test/assemblyai-client.test.ts test/transcription-jobs.test.ts`
Expected: PASS.

Run: `pnpm --filter @openreel/web typecheck && pnpm --filter @openreel/desktop typecheck`
Expected: exit 0 for all owning/consuming TypeScript checks. Preserve existing behavior.

- [ ] **Step 5: Commit only this task's files after verification.**

```bash
git add apps/desktop/src/main/lickety/assemblyai-client.ts apps/desktop/src/main/lickety/job-store.ts apps/desktop/src/main/ipc/lickety.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/shared/channels.ts apps/desktop/src/shared/ipc-contract.ts apps/web/src/types/global.d.ts apps/web/src/components/editor/settings/ApiKeysPanel.tsx apps/desktop/test/assemblyai-client.test.ts apps/desktop/test/transcription-jobs.test.ts
git commit -m "feat: add secure resumable AssemblyAI jobs"
```

### Task 3: Use AssemblyAI across desktop captions and multicam transcript consumers

**Files:**
- Create: `apps/web/src/components/editor/lickety/TranscriptControls.tsx`, `apps/web/src/stores/lickety-workflow-store.ts`
- Modify: `apps/web/src/components/editor/inspector/AutoCaptionPanel.tsx`, `apps/web/src/components/editor/inspector/MultiCameraPanel.tsx`, `apps/web/src/services/multicam-transcription.ts`, `apps/web/src/services/agent/multicam-bridge.ts`, `packages/agent/src/registry.ts`, `packages/core/src/storage/project-serializer.ts`
- Test: `apps/web/src/components/editor/lickety/TranscriptControls.test.tsx`, `apps/web/src/services/multicam-transcription.test.ts`, `apps/web/src/services/agent/multicam-bridge.test.ts`

**Interfaces:**
- Consumes: start/get/cancel/resumeTranscription, TranscriptDocument, native settings key state, current OpenReel caption insertion/group artifacts.
- Produces: desktop transcription controller consumes the canonical document; AutoCaption and multicam transcript reads use AssemblyAI; store persists Project.lickety metadata and local job refs; no desktop Whisper worker entry point.

- [ ] **Step 1: Write the failing tests** in the listed test files. Use these assertions and the additional named cases below.

```ts
it('never downloads Whisper when desktop captions are requested', async () => {
  await requestDesktopCaptions();
  expect(startAssemblyAI).toHaveBeenCalledOnce();
  expect(whisperWorkerFactory).not.toHaveBeenCalled();
});
it('existing transcript remains available after native job completion and reopen', async () => {
  expect(await reopenTranscriptFixture()).toMatchObject({provider:'assemblyai',providerJobId:'job-123'});
});
```

Task owns `imported_srt_without_key`, `desktop_missing_key_action`, `browser_baseline_not_migrated`, `multicam_camera_policy_unchanged`, `no_desktop_whisper_urls_in_caption_path`, and two-participant names survive save/reopen. Run a packaged synthetic-provider job through normal caption controls; real provider quality is package-5 acceptance.

- [ ] **Step 2: Run the tests and confirm the new contract fails.**

Run: `pnpm --filter @openreel/web exec vitest run src/components/editor/lickety/TranscriptControls.test.tsx src/services/multicam-transcription.test.ts src/services/agent/multicam-bridge.test.ts`
Expected: FAIL for the missing new behavior/module; distinguish unrelated baseline failures.

- [ ] **Step 3: Implement the listed interfaces in the owning files.**

Use a desktop runtime gate so the existing browser build stays unchanged. Replace model download/selection UI in desktop transcription with AssemblyAI key/job/channel controls; imported SRT/VTT continues to work. Adapt canonical words into existing caption style and multicam transcript segment structures. Update agent transcript tool description and read bridge; do not add a new camera planner or change sync/face/VAD behavior. Missing key has a direct Settings action; every new paid initiation has visible confirmation and upload disclosure. Preserve transcript recovery across UI close/reopen and project save.

- [ ] **Step 4: Run the same tests and the owning package typecheck.**

Run: `pnpm --filter @openreel/web exec vitest run src/components/editor/lickety/TranscriptControls.test.tsx src/services/multicam-transcription.test.ts src/services/agent/multicam-bridge.test.ts`
Expected: PASS.

Run: `pnpm --filter @openreel/core typecheck && pnpm --filter @openreel/web typecheck && pnpm --filter @openreel/agent typecheck`
Expected: exit 0 for all owning/consuming TypeScript checks. Preserve existing behavior.

- [ ] **Step 5: Commit only this task's files after verification.**

```bash
git add apps/web/src/components/editor/lickety/TranscriptControls.tsx apps/web/src/stores/lickety-workflow-store.ts apps/web/src/components/editor/inspector/AutoCaptionPanel.tsx apps/web/src/components/editor/inspector/MultiCameraPanel.tsx apps/web/src/services/multicam-transcription.ts apps/web/src/services/agent/multicam-bridge.ts packages/agent/src/registry.ts packages/core/src/storage/project-serializer.ts apps/web/src/components/editor/lickety/TranscriptControls.test.tsx apps/web/src/services/multicam-transcription.test.ts apps/web/src/services/agent/multicam-bridge.test.ts
git commit -m "feat: route desktop transcription through AssemblyAI"
```


## Work-package acceptance

Mocked native tests verify upload/submit/poll/restart/cancel and secret handling. A packaged normal-UI run with injected provider transport creates actual captions/transcript state. A separately authorized short paid run verifies actual AssemblyAI channel/timestamp/schema behavior; no mock or successful HTTP connection establishes transcription quality.

## Self-review record

Spec requirements are mapped to named tasks and tests above. Interfaces use the names in the shared spec. Review Focus cases each belong to a listed task. Physical-device, paid-provider, and signing gates are recorded separately from mocked/unit proof. Implementation steps name a result, not whole function bodies. Review this plan and the design together before execution.
