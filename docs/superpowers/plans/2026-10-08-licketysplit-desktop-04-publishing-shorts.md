# LicketySplit Publishing and Shorts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional final-edit publishing files and semantic enhancements to native OpenReel shorts.

**Architecture:** Reuse final transcript identity and structured AI response validation. Export copy is separate from video rendering; short review augments upstream candidates and creates native editable results.

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

- Unchecked AI option: export stays free of new provider requests (Task 1).
- Narrative/pacing changed edit: chapters/copy use retained final dialogue (Task 1).
- Export failure after paid copy: reuse saved response, no hidden second request (Task 1).
- Two simultaneous speakers: semantic short remains source-grounded without duplicate text (Task 2).
- Pictureless or gap-crossing short: disclose limitations and preserve original episode (Task 2).

---

## File structure and task ownership

Each task's Files/Interfaces blocks below define the module boundaries. New behavior lives in focused `lickety` modules, with small changes to upstream integration points. No broad rewrite of the editor, no changes to the Railway deployment, and no removal of unrelated upstream desktop capabilities.

## Prerequisites

All test snippets use test-local injected transports/fixture objects. Define those fixtures in the listed test file or use `makeWorkflowFixture`; helper names in assertions are not additional production APIs. Their behavior is fixed by the named cases and exact expected values.

Read the spec and prior work-package Interfaces. At execution time use an isolated managed worktree on a `codex/` branch from the reviewed baseline; inspect the current checkout and preserve unrelated work. Record baseline failures before modifications. Install only the repository's frozen dependency set and compile existing WASM before tests that need it. Capture progress in the linked ClickUp task, not a second persistent task ledger.

### Task 1: Optional publishing package on native export

**Files:**
- Create: `packages/core/src/lickety/publishing.ts`, `apps/web/src/services/lickety/publishing.ts`, `apps/web/src/components/editor/lickety/PublishingOptions.tsx`
- Modify: `apps/web/src/components/editor/ExportDialog.tsx`, `apps/web/src/services/export-runner.ts`, `apps/web/src/stores/lickety-workflow-store.ts`
- Test: `packages/core/src/lickety/publishing.test.ts`, `apps/web/src/components/editor/lickety/PublishingOptions.test.tsx`, `apps/web/src/services/lickety/publishing.test.ts`

**Interfaces:**
- Consumes: final derived TimelineWord[], frozen final snapshot, requestWorkflowOutput from package 3, selected LLM configuration, native save/export.
- Produces: `validatePublishingPackage(raw:unknown,snapshotHash:string,durationMs:number):PublishingPackage`; `generatePublishingPackage(words:TimelineWord[],snapshotHash:string,durationMs:number,llm:LLMClient,options:{provider:"openai"|"anthropic";signal?:AbortSignal}):Promise<PublishingPackage>`; `writePublishingPackage(pkg:PublishingPackage,exportPath:string):Promise<string[]>`.

- [ ] **Step 1: Write the failing tests** in the listed test files. Use these assertions and the additional named cases below.

```ts
it('does not use AI when export publishing is unchecked', async () => {
  await exportVideo({generatePublishing:false});
  expect(llm.complete).not.toHaveBeenCalled();
});
it('rejects chapters outside the final edit', () => {
  expect(() => validatePublishingPackage(copyWithLateChapter, 'final-sha', 20_000)).toThrow(/chapter/i);
});
```

Task owns `deleted_words_not_in_prompt`, `copy_matches_post_pacing_timing`, `cancel_copy_keeps_project_and_render`, `render_failure_retains_copy`, `destination_disk_full_no_success`, `no_secret_in_publishing_manifest`, and no API request when checkbox is off.

- [ ] **Step 2: Run the tests and confirm the new contract fails.**

Run: `pnpm --filter @openreel/core exec vitest run src/lickety/publishing.test.ts && pnpm --filter @openreel/web exec vitest run src/components/editor/lickety/PublishingOptions.test.tsx src/services/lickety/publishing.test.ts`
Expected: FAIL for the missing new behavior/module; distinguish unrelated baseline failures.

- [ ] **Step 3: Implement the listed interfaces in the owning files.**

Add unchecked export checkbox with exact copy `Generate publishing package (uses AI tokens)`, using existing explicit paid confirmation. Freeze the final retained-word/timeline revision; one structured response supplies titles, descriptions, chapters, tags, show notes, thumbnail/pinned-comment ideas. Validate all fields and ordered chapter bounds. Write Publishing Files/title-options.md, youtube-description.md, youtube-chapters.txt, youtube-tags.txt, spotify-show-notes.md, thumbnail-concepts.md, pinned-comment-candidates.md and publishing-manifest.json beside the export via native dialogs/file bridge. Atomic writes; never publish to a platform. Keep video and copy completion states separate. Reuse a successful identical response if render fails; revision/model/prompt changes invalidate it without automatically spending again.

- [ ] **Step 4: Run the same tests and the owning package typecheck.**

Run: `pnpm --filter @openreel/core exec vitest run src/lickety/publishing.test.ts && pnpm --filter @openreel/web exec vitest run src/components/editor/lickety/PublishingOptions.test.tsx src/services/lickety/publishing.test.ts`
Expected: PASS.

Run: `pnpm --filter @openreel/core typecheck && pnpm --filter @openreel/web typecheck`
Expected: exit 0 for all owning/consuming TypeScript checks. Preserve existing behavior.

- [ ] **Step 5: Commit only this task's files after verification.**

```bash
git add packages/core/src/lickety/publishing.ts apps/web/src/services/lickety/publishing.ts apps/web/src/components/editor/lickety/PublishingOptions.tsx apps/web/src/components/editor/ExportDialog.tsx apps/web/src/services/export-runner.ts apps/web/src/stores/lickety-workflow-store.ts packages/core/src/lickety/publishing.test.ts apps/web/src/components/editor/lickety/PublishingOptions.test.tsx apps/web/src/services/lickety/publishing.test.ts
git commit -m "feat: add optional AI export publishing package"
```

### Task 2: Semantic review in existing OpenReel shorts workflow

**Files:**
- Create: `packages/core/src/lickety/shorts.ts`, `apps/web/src/services/lickety/shorts.ts`
- Modify: `apps/web/src/components/editor/inspector/MultiCameraPanel.tsx`, `apps/web/src/services/agent/multicam-bridge.ts`, `apps/web/src/stores/lickety-workflow-store.ts`
- Test: `packages/core/src/lickety/shorts.test.ts`, `apps/web/src/services/lickety/shorts.test.ts`

**Interfaces:**
- Consumes: existing extractMulticamSocialClips and native short/marker UI; final words; requestWorkflowOutput; cue/publishing metadata.
- Produces: `validateSemanticShorts(raw:unknown,candidates:readonly {id:string;startMs:number;endMs:number}[],words:TimelineWord[],maxDurationMs:number):SemanticShort[]`; `reviewShortCandidates(candidates:readonly {id:string;startMs:number;endMs:number}[],words:TimelineWord[],llm:LLMClient,options:{provider:"openai"|"anthropic";maxDurationMs:number;signal?:AbortSignal}):Promise<SemanticShort[]>`.

- [ ] **Step 1: Write the failing tests** in the listed test files. Use these assertions and the additional named cases below.

```ts
it('accepts an empty valid short set without changing the episode', () => {
  expect(validateSemanticShorts([], candidates, words, 45_000)).toEqual([]);
});
it('refuses invented words and hooks not present in the options', () => {
  expect(() => validateSemanticShorts(invalidShort, candidates, words, 45_000)).toThrow();
});
```

Task owns `audio_only_candidate_disclosed`, `overlap_words_not_duplicate_excerpt`, `short_crosses_final_picture_gap`, `candidate_out_of_bounds`, `configured_maximum_respected`, `semantic_cancel_no_new_short`, `retains_original_camera_cut_and_effect`, and episode unchanged after short creation. Do not introduce legacy separate XML exports.

- [ ] **Step 2: Run the tests and confirm the new contract fails.**

Run: `pnpm --filter @openreel/core exec vitest run src/lickety/shorts.test.ts && pnpm --filter @openreel/web exec vitest run src/services/lickety/shorts.test.ts`
Expected: FAIL for the missing new behavior/module; distinguish unrelated baseline failures.

- [ ] **Step 3: Implement the listed interfaces in the owning files.**

Keep existing local candidate ranking and default 45 s window; semantic AI is an explicit enhancement, using the actual configured maximum. Normalize candidate IDs and final transcript ranges, validate selected endpoints within original candidate and final timeline, uniqueness/non-overlap and positive duration. Require 5-8 hook options, recommended hook from them, rationale, platform captions and tags. Store ranged Cue metadata and existing native markers. Offer native short draft creation through the existing machinery; preserve the episode project, source camera edits, audio and aspect ratio. Keep reframing user-controlled through OpenReel. Integrate same transcript source in agent read bridge, not a second transcript engine.

- [ ] **Step 4: Run the same tests and the owning package typecheck.**

Run: `pnpm --filter @openreel/core exec vitest run src/lickety/shorts.test.ts && pnpm --filter @openreel/web exec vitest run src/services/lickety/shorts.test.ts`
Expected: PASS.

Run: `pnpm --filter @openreel/core typecheck && pnpm --filter @openreel/web typecheck`
Expected: exit 0 for all owning/consuming TypeScript checks. Preserve existing behavior.

- [ ] **Step 5: Commit only this task's files after verification.**

```bash
git add packages/core/src/lickety/shorts.ts apps/web/src/services/lickety/shorts.ts apps/web/src/components/editor/inspector/MultiCameraPanel.tsx apps/web/src/services/agent/multicam-bridge.ts apps/web/src/stores/lickety-workflow-store.ts packages/core/src/lickety/shorts.test.ts apps/web/src/services/lickety/shorts.test.ts
git commit -m "feat: add transcript-aware short candidate review"
```


## Work-package acceptance

Normal desktop UI with synthetic provider produces an actual rendered short and publishing directory; verify file contents and revision links. Cancel/retry/empty candidates remain useful states. A separately authorized live-model example is reviewed for truthful titles/hooks/chapters and human publishing suitability. No automatic posting or XML delivery.

## Self-review record

Spec requirements are mapped to named tasks and tests above. Interfaces use the names in the shared spec. Review Focus cases each belong to a listed task. Physical-device, paid-provider, and signing gates are recorded separately from mocked/unit proof. Implementation steps name a result, not whole function bodies. Review this plan and the design together before execution.
