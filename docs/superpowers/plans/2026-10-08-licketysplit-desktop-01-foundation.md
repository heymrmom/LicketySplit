# LicketySplit Desktop Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A separately identified ARM64 app with durable preview proxies and bounded media paths.

**Architecture:** Reuse Electron/native FFmpeg and existing upstream processing. Add a managed asset/resource adapter, leaving browser deployment and OpenReel sync decisions intact.

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

- Source disconnected/relinked: retain edits and request the exact original (Task 2).
- Cancelled proxy creation: no partial cache promoted, original untouched (Task 2).
- Portrait/VFR/fractional timing: proxy mapping preserves original presentation times (Tasks 2/3).
- Long codec fallback: range decode never allocates an entire 48 kHz recording (Task 3).
- Large asset count: inactive decoder count stays bounded without export frame duplication (Task 3).

---

## File structure and task ownership

Each task's Files/Interfaces blocks below define the module boundaries. New behavior lives in focused `lickety` modules, with small changes to upstream integration points. No broad rewrite of the editor, no changes to the Railway deployment, and no removal of unrelated upstream desktop capabilities.

## Prerequisites

All test snippets use test-local injected transports/fixture objects. Define those fixtures in the listed test file or use `makeWorkflowFixture`; helper names in assertions are not additional production APIs. Their behavior is fixed by the named cases and exact expected values.

Read the spec and prior work-package Interfaces. At execution time use an isolated managed worktree on a `codex/` branch from the reviewed baseline; inspect the current checkout and preserve unrelated work. Record baseline failures before modifications. Install only the repository's frozen dependency set and compile existing WASM before tests that need it. Capture progress in the linked ClickUp task, not a second persistent task ledger.

### Task 1: Isolated desktop identity and shared project contracts

**Files:**
- Create: `packages/core/src/lickety/types.ts`, `packages/core/src/lickety/test-fixtures.ts`, `apps/desktop/src/main/lickety/resource-policy.ts`
- Modify: `packages/core/src/types/project.ts`, `packages/core/src/storage/project-serializer.ts`, `packages/core/src/storage/schema-types.ts`, `packages/core/src/index.ts`, `apps/desktop/package.json`, `apps/desktop/electron-builder.yml`, `apps/desktop/src/main/index.ts`
- Test: `packages/core/src/lickety/types.test.ts`, `apps/desktop/test/resource-policy.test.ts`

**Interfaces:**
- Consumes: existing Project, schema 1.2.0, collectHardwareInfo(); shared spec types.
- Produces: `getResourceProfile(totalBytes: number): ResourceProfile`; optional `Project.lickety`; schema/reader 1.3.0; `makeWorkflowFixture(options?: {frameRate?: number; durationSec?: number}): Project`; isolated LicketySplit profile.

- [ ] **Step 1: Write the failing tests** in the listed test files. Use these assertions and the additional named cases below.

```ts
it('uses bounded preparation on an 8 GiB Mac', () => {
  const p = getResourceProfile(8 * 1024 ** 3);
  expect(p).toMatchObject({lowMemory:true,maxHeavyJobs:1,maxVideoDecoders:4,maxChunkBytes:16*1024**2});
});
it('preserves original media objects when a workflow draft is cloned', () => {
  const p = makeWorkflowFixture();
  expect(cloneProjectForEdit(p).mediaLibrary.items[0]).toBe(p.mediaLibrary.items[0]);
});
```

Also test `loads_old_project_without_workflow_state`, `workflow_roundtrip_retains_word_ids`, `rejects_newer_reader`, and `new_profile_does_not_read_legacy_or_upstream_keys`. Import real fixture types; do not duplicate source buffers in mocks.

- [ ] **Step 2: Run the tests and confirm the new contract fails.**

Run: `pnpm --filter @openreel/core exec vitest run src/lickety/types.test.ts && pnpm --filter @openreel/desktop exec vitest run test/resource-policy.test.ts`
Expected: FAIL for the missing new behavior/module; distinguish unrelated baseline failures.

- [ ] **Step 3: Implement the listed interfaces in the owning files.**

Define the exact shared types from spec section 6. Default fixture is a 20 s, 25 fps project: camera A active 0-10 s, camera B active 10-20 s, two named isolated microphones, a retained transform/effect and title; media objects are immutable. Change only desktop identity to LicketySplit/com.heymrmom.licketysplit.desktop/0.1.0-alpha.1. Retain workspace and IPC names. Add a test-only `LICKETYSPLIT_DATA_DIR` override and enforce a separate userData path before reading credentials/projects. Serializer saves workflow metadata without paths/secrets, imports 1.2.0, and refuses a reader newer than 1.3.0.

- [ ] **Step 4: Run the same tests and the owning package typecheck.**

Run: `pnpm --filter @openreel/core exec vitest run src/lickety/types.test.ts && pnpm --filter @openreel/desktop exec vitest run test/resource-policy.test.ts`
Expected: PASS.

Run: `pnpm --filter @openreel/core typecheck && pnpm --filter @openreel/desktop typecheck`
Expected: exit 0 for all owning/consuming TypeScript checks. Preserve existing behavior.

- [ ] **Step 5: Commit only this task's files after verification.**

```bash
git add packages/core/src/lickety/types.ts packages/core/src/lickety/test-fixtures.ts apps/desktop/src/main/lickety/resource-policy.ts packages/core/src/types/project.ts packages/core/src/storage/project-serializer.ts packages/core/src/storage/schema-types.ts packages/core/src/index.ts apps/desktop/package.json apps/desktop/electron-builder.yml apps/desktop/src/main/index.ts packages/core/src/lickety/types.test.ts apps/desktop/test/resource-policy.test.ts
git commit -m "feat: establish isolated LicketySplit desktop contracts"
```

### Task 2: Managed original files and persistent disk-backed proxies

**Files:**
- Create: `apps/desktop/src/main/lickety/asset-registry.ts`, `apps/desktop/src/main/lickety/media-jobs.ts`, `apps/desktop/src/main/ipc/lickety.ts`, `apps/web/src/services/lickety/desktop-media.ts`
- Modify: `apps/desktop/src/main/protocol.ts`, `apps/desktop/src/main/sidecar/media-job.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/shared/channels.ts`, `apps/desktop/src/shared/ipc-contract.ts`, `apps/web/src/types/global.d.ts`, `packages/core/src/types/project.ts`, `packages/core/src/media/mediabunny-engine.ts`, `packages/core/src/media/native-media-bridge.ts`, `apps/web/src/stores/preview-proxy-store.ts`
- Test: `apps/desktop/test/managed-assets.test.ts`, `apps/desktop/test/desktop-proxy.test.ts`, `apps/web/src/services/lickety/desktop-media.test.ts`

**Interfaces:**
- Consumes: ResourceProfile, RegisteredAsset, ProxyReceipt from Task 1; existing FFmpeg locator and preview/export distinction.
- Produces: `ManagedAssetRegistry.registerOriginal(mediaId:string, path:string, signal?:AbortSignal): Promise<RegisteredAsset>`; `.resolve(assetId:string, purpose:"original"|"proxy"): Promise<{path:string;mime:string}>` (main only); `ensureProxy(assetId:string, profile:ResourceProfile, signal:AbortSignal):Promise<ProxyReceipt>`; `MediaItem.nativeSource?: RegisteredAsset`; `resolveDesktopMedia(item:MediaItem,purpose:"preview"|"export"):Promise<string>`.

- [ ] **Step 1: Write the failing tests** in the listed test files. Use these assertions and the additional named cases below.

```ts
it('always resolves export to the registered original', async () => {
  expect(await resolveDesktopMedia(itemWithReadyProxy, 'export')).toBe(itemWithReadyProxy.nativeSource.originalUri);
});
it('rejects a proxy after source content changes', async () => {
  expect(await isProxyReceiptValid(receipt, changedAsset.identity)).toBe(false);
});
```

Task owns `rejects_path_traversal`, `range_read_is_bounded`, `proxy_reused_after_restart`, `cancel_removes_partial_and_keeps_original`, `external_drive_disconnected`, `insufficient_disk_before_encode`, `portrait_square_fractional_pts`, `export_missing_original_refuses_proxy`, and a two-hour sparse/mock file test proving no complete proxy readback.

- [ ] **Step 2: Run the tests and confirm the new contract fails.**

Run: `pnpm --filter @openreel/desktop exec vitest run test/managed-assets.test.ts test/desktop-proxy.test.ts && pnpm --filter @openreel/web exec vitest run src/services/lickety/desktop-media.test.ts`
Expected: FAIL for the missing new behavior/module; distinguish unrelated baseline failures.

- [ ] **Step 3: Implement the listed interfaces in the owning files.**

Add `isProxyReceiptValid(receipt:ProxyReceipt, identity:AssetIdentity):boolean` to desktop-media. Registry resolves only opaque IDs into read-only original or completed derivative paths. Add bounded byte-range custom protocol responses with traversal/unknown-ID rejection. Bridge registers user-picked File paths through Electron webUtils; materialize generated blobs in <=16 MiB chunks only once. Extend native decoder inputs with URL-backed source resolution; use original metadata for aspect/transform geometry. Proxies fit the spec box, preserve presentation-time mapping and have atomic receipts; queue heavy jobs at concurrency 1. Prefer executable VideoToolbox, one software fallback. Complete cache entries survive restart; cancelled partials do not. Low-memory high-resolution preview waits for a proxy; no hidden heavy-original fallback. Keep browser blob proxy behavior unchanged. Implement projected-output disk check +1 GiB, 10 GiB derived-only cache cap, and user relink/retry paths.

- [ ] **Step 4: Run the same tests and the owning package typecheck.**

Run: `pnpm --filter @openreel/desktop exec vitest run test/managed-assets.test.ts test/desktop-proxy.test.ts && pnpm --filter @openreel/web exec vitest run src/services/lickety/desktop-media.test.ts`
Expected: PASS.

Run: `pnpm --filter @openreel/core typecheck && pnpm --filter @openreel/web typecheck && pnpm --filter @openreel/desktop typecheck`
Expected: exit 0 for all owning/consuming TypeScript checks. Preserve existing behavior.

- [ ] **Step 5: Commit only this task's files after verification.**

```bash
git add apps/desktop/src/main/lickety/asset-registry.ts apps/desktop/src/main/lickety/media-jobs.ts apps/desktop/src/main/ipc/lickety.ts apps/web/src/services/lickety/desktop-media.ts apps/desktop/src/main/protocol.ts apps/desktop/src/main/sidecar/media-job.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/shared/channels.ts apps/desktop/src/shared/ipc-contract.ts apps/web/src/types/global.d.ts packages/core/src/types/project.ts packages/core/src/media/mediabunny-engine.ts packages/core/src/media/native-media-bridge.ts apps/web/src/stores/preview-proxy-store.ts apps/desktop/test/managed-assets.test.ts apps/desktop/test/desktop-proxy.test.ts apps/web/src/services/lickety/desktop-media.test.ts
git commit -m "feat: add persistent native preview proxies"
```

### Task 3: Bound desktop analysis and native export without replacing OpenReel decisions

**Files:**
- Create: `apps/desktop/src/main/lickety/audio-analysis.ts`, `apps/web/src/services/lickety/analysis-audio.ts`
- Modify: `apps/web/src/components/editor/inspector/MultiCameraPanel.tsx`, `apps/web/src/components/editor/inspector/multicam-workflow.ts`, `packages/core/src/audio/audio-engine.ts`, `packages/core/src/media/mediabunny-engine.ts`, `packages/core/src/export/export-engine.ts`, `apps/desktop/src/main/ipc/lickety.ts`, `apps/desktop/src/preload/index.ts`, `apps/web/src/types/global.d.ts`
- Test: `apps/desktop/test/analysis-audio.test.ts`, `apps/web/src/services/lickety/analysis-audio.test.ts`, `packages/core/src/audio/audio-engine.test.ts`, `packages/core/src/export/export-engine.test.ts`

**Interfaces:**
- Consumes: registered originals, ResourceProfile and media scheduler; existing upstream drift, VAD and camera planner.
- Produces: `readAnalysisAudio(assetId:string,sampleRate:1000|16000,range:{startMs:number;endMs:number},signal:AbortSignal):AsyncIterable<Float32Array>`; `getCompactSyncInputs(project:Project,signal:AbortSignal):Promise<Map<string,{samples:Float32Array;sampleRate:1000}>>`; `getNativeAudioWindow(assetId:string,trackIndex:number,startMs:number,durationMs:number,signal:AbortSignal):Promise<{channels:Float32Array[];sampleRate:number}>`.

- [ ] **Step 1: Write the failing tests** in the listed test files. Use these assertions and the additional named cases below.

```ts
it('keeps deterministic sync offsets within one millisecond', async () => {
  const next = await syncCompactFixture();
  expect(Math.abs(next.offsetSeconds - baseline.offsetSeconds)).toBeLessThanOrEqual(0.001);
  expect(next.cameraSegments).toEqual(baseline.cameraSegments);
});
it('reads no audio window longer than ten seconds', async () => {
  await exportLongFixture();
  expect(Math.max(...nativeReadDurationsMs)).toBeLessThanOrEqual(10_000);
});
```

Task owns `silent_audio_abstains_like_baseline`, `mixed_rate_pts_match`, `voice_activity_unchanged`, `long_unsupported_codec_uses_native_range_not_full_decode`, `effect_audio_chunk_boundary_matches_reference`, `decoder_peak_count_is_four`, `cancel_releases_native_and_renderer_buffers`, and original-quality export with proxy enabled. A full synthetic long-file allocation test proves bounded reads; physical 8 GB RSS is a separate package-5 gate.

- [ ] **Step 2: Run the tests and confirm the new contract fails.**

Run: `pnpm --filter @openreel/desktop exec vitest run test/analysis-audio.test.ts && pnpm --filter @openreel/web exec vitest run src/services/lickety/analysis-audio.test.ts && pnpm --filter @openreel/core exec vitest run src/audio/audio-engine.test.ts src/export/export-engine.test.ts`
Expected: FAIL for the missing new behavior/module; distinguish unrelated baseline failures.

- [ ] **Step 3: Implement the listed interfaces in the owning files.**

Feed the existing sync worker with compact mono inputs prepared from the original audio; extend workflow input adapters to accept structural analysis samples rather than requiring complete WebAudio buffers. Process VAD/energy per source sequentially and release buffers. Preserve the solver/thresholds/camera policies. Keep segmented audio and chunked native export; use native ranged fallback for >120 s desktop files whose browser codec cannot be segment-decoded. Bound decoder cache to four, initialize lazily, evict only inactive frames, and preserve export original resolution/effects. Keep audio filter continuity at chunk boundaries; do not reset audible delay/reverb state silently. Unsupported streamed-effect cases need explicit normal-export handling rather than silent omission. Add cancellation/progress from the shared scheduler.

- [ ] **Step 4: Run the same tests and the owning package typecheck.**

Run: `pnpm --filter @openreel/desktop exec vitest run test/analysis-audio.test.ts && pnpm --filter @openreel/web exec vitest run src/services/lickety/analysis-audio.test.ts && pnpm --filter @openreel/core exec vitest run src/audio/audio-engine.test.ts src/export/export-engine.test.ts`
Expected: PASS.

Run: `pnpm --filter @openreel/core typecheck && pnpm --filter @openreel/web typecheck && pnpm --filter @openreel/desktop typecheck`
Expected: exit 0 for all owning/consuming TypeScript checks. Preserve existing behavior.

- [ ] **Step 5: Commit only this task's files after verification.**

```bash
git add apps/desktop/src/main/lickety/audio-analysis.ts apps/web/src/services/lickety/analysis-audio.ts apps/web/src/components/editor/inspector/MultiCameraPanel.tsx apps/web/src/components/editor/inspector/multicam-workflow.ts packages/core/src/audio/audio-engine.ts packages/core/src/media/mediabunny-engine.ts packages/core/src/export/export-engine.ts apps/desktop/src/main/ipc/lickety.ts apps/desktop/src/preload/index.ts apps/web/src/types/global.d.ts apps/desktop/test/analysis-audio.test.ts apps/web/src/services/lickety/analysis-audio.test.ts packages/core/src/audio/audio-engine.test.ts packages/core/src/export/export-engine.test.ts
git commit -m "perf: bound desktop media analysis and decoder caches"
```


## Work-package acceptance

Package a local ARM64 test build in an isolated data profile using existing build scripts; inspect `file` output for Electron and FFmpeg. Verify native import, automatic proxy generation, warm reuse, sync parity, cancellation, and native original-quality export on synthetic fixtures. Record cold/warm times and process RSS. No signing/public release or legacy app installation occurs here. Foundation correctness is independent of paid AI.

## Self-review record

Spec requirements are mapped to named tasks and tests above. Interfaces use the names in the shared spec. Review Focus cases each belong to a listed task. Physical-device, paid-provider, and signing gates are recorded separately from mocked/unit proof. Implementation steps name a result, not whole function bodies. Review this plan and the design together before execution.
