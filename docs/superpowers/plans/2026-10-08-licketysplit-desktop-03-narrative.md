# LicketySplit Narrative and Pacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validated AI Narrative drafts from the current timeline, protected pacing, and useful timed production cues.

**Architecture:** The LLM returns source-word ranges, not timeline code. A pure, OS-independent slicer preserves current supported edit semantics and creates a separate project; UI review and local finishing use existing editor services.

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

- Multicam materialization: current camera edits survive without stale group times overwriting the draft (Task 1).
- Keyframes/automation at cuts: evaluated state survives, no animation restart (Task 1).
- Response truncated or source edit changed: no automatic application or paid repair (Task 2).
- Quiet reaction/word-end ambiguity: protected words and meaningful pauses survive (Task 3).
- Cue after reordering/deletion: final timestamps and retained evidence only (Task 3).

---

## File structure and task ownership

Each task's Files/Interfaces blocks below define the module boundaries. New behavior lives in focused `lickety` modules, with small changes to upstream integration points. No broad rewrite of the editor, no changes to the Railway deployment, and no removal of unrelated upstream desktop capabilities.

## Prerequisites

All test snippets use test-local injected transports/fixture objects. Define those fixtures in the listed test file or use `makeWorkflowFixture`; helper names in assertions are not additional production APIs. Their behavior is fixed by the named cases and exact expected values.

Read the spec and prior work-package Interfaces. At execution time use an isolated managed worktree on a `codex/` branch from the reviewed baseline; inspect the current checkout and preserve unrelated work. Record baseline failures before modifications. Install only the repository's frozen dependency set and compile existing WASM before tests that need it. Capture progress in the linked ClickUp task, not a second persistent task ledger.

### Task 1: Slice the existing timeline into a separate editable draft

**Files:**
- Create: `packages/core/src/lickety/timeline-slicer.ts`, `apps/web/src/services/lickety/narrative.ts`
- Modify: `apps/web/src/stores/project-store.ts`, `apps/web/src/stores/project/clone-project-for-edit.ts`, `packages/core/src/storage/project-serializer.ts`
- Test: `packages/core/src/lickety/timeline-slicer.test.ts`, `apps/web/src/services/lickety/narrative.test.ts`

**Interfaces:**
- Consumes: AnalysisSnapshot, original current Project, canonical TranscriptDocument, existing native multicam sequence conversion and project load/save.
- Produces: `sliceTimeline(project:Project,ranges:TimelineRange[]):Project`; `deriveTimelineWords(doc:TranscriptDocument,ranges:TimelineRange[]):TimelineWord[]`; `projectTranscript(doc:TranscriptDocument,words:TimelineWord[],snapshotHash:string):TranscriptDocument`; `compileNarrative(project:Project,doc:TranscriptDocument,proposal:NarrativeProposal):NarrativeResult`; `saveNarrativeDraft(result:NarrativeResult):Promise<void>`.

- [ ] **Step 1: Write the failing tests** in the listed test files. Use these assertions and the additional named cases below.

```ts
it('reorders the current camera edits without changing source media', () => {
  const result = compileNarrative(source, doc, proposalBThenA);
  expect(result.project.id).not.toBe(source.id);
  expect(result.project.mediaLibrary.items[0]).toBe(source.mediaLibrary.items[0]);
  expect(result.project.timeline.tracks[0].clips[0].mediaId).toBe('cam-b');
  expect(source.timeline).toEqual(beforeTimeline);
});
```

Task owns `source_camera_cut_inside_excerpt_retained`, `retains_transform_color_and_effect`, `keyframe_value_at_trim_boundary`, `audio_title_subtitles_move_together`, `fractional_24000_1001_and_30000_1001`, `contained_transition_preserved_crossed_transition_rejected`, `missing_original_rejected`, and `save_failure_leaves_source_project`. Validate total duration equals quantized ranges and each selected word occurs exactly once. Add `second_narrative_uses_current_retained_words_only`: projectTranscript exposes only current word occurrences, records sourceWordId/derivedFromSnapshotHash, and never sends discarded original words for the next action.

- [ ] **Step 2: Run the tests and confirm the new contract fails.**

Run: `pnpm --filter @openreel/core exec vitest run src/lickety/timeline-slicer.test.ts && pnpm --filter @openreel/web exec vitest run src/services/lickety/narrative.test.ts`
Expected: FAIL for the missing new behavior/module; distinguish unrelated baseline failures.

- [ ] **Step 3: Implement the listed interfaces in the owning files.**

Default fixture at 25 fps selects original 11.0-12.4 s then 1.0-3.4 s. Intersect all supported track items with ranges, compute source in/out and new timeline placement, assign new clip IDs, preserve immutable media references, remap captions/contained markers and stable word occurrences. Rebase clip-local keyframes/automation/fades with evaluated boundary values. Materialize native current multicam cuts before slicing; store source-group provenance but omit stale live group absolute-time definitions from the reordered draft. Save the original snapshot and new draft separately. Preflight and reject unsupported reverse/ramp/freeze/nested/motion/3D transforms, or a cut through a live transition. Preserve those features in normal editing. No automatic synchronization run or hidden XML dependency.

- [ ] **Step 4: Run the same tests and the owning package typecheck.**

Run: `pnpm --filter @openreel/core exec vitest run src/lickety/timeline-slicer.test.ts && pnpm --filter @openreel/web exec vitest run src/services/lickety/narrative.test.ts`
Expected: PASS.

Run: `pnpm --filter @openreel/core typecheck && pnpm --filter @openreel/web typecheck`
Expected: exit 0 for all owning/consuming TypeScript checks. Preserve existing behavior.

- [ ] **Step 5: Commit only this task's files after verification.**

```bash
git add packages/core/src/lickety/timeline-slicer.ts apps/web/src/services/lickety/narrative.ts apps/web/src/stores/project-store.ts apps/web/src/stores/project/clone-project-for-edit.ts packages/core/src/storage/project-serializer.ts packages/core/src/lickety/timeline-slicer.test.ts apps/web/src/services/lickety/narrative.test.ts
git commit -m "feat: compile source-preserving Narrative drafts"
```

### Task 2: Structured Narrative AI proposal and review controls

**Files:**
- Create: `apps/web/src/services/lickety/workflow-ai.ts`, `apps/web/src/components/editor/lickety/NarrativePanel.tsx`, `apps/web/src/components/editor/lickety/NarrativeReview.tsx`
- Modify: `apps/web/src/stores/lickety-workflow-store.ts`, `apps/web/src/components/editor/InspectorPanel.tsx`
- Test: `apps/web/src/services/lickety/workflow-ai.test.ts`, `apps/web/src/components/editor/lickety/NarrativePanel.test.tsx`

**Interfaces:**
- Consumes: existing makeBYOKClient/LLMClient.complete, selected endpoint/model/token control, current retained-word projected transcript and Task 1 compiler.
- Produces: `requestWorkflowOutput(name:"submit_narrative"|"submit_publishing"|"submit_shorts",payload:unknown,schema:Record<string,unknown>,llm:LLMClient,options:{provider:"openai"|"anthropic";signal?:AbortSignal}):Promise<unknown>`; `requestNarrative(doc:TranscriptDocument,options:{direction:string;targetDurationMs?:number;provider:"openai"|"anthropic";signal?:AbortSignal},llm:LLMClient):Promise<NarrativeProposal>`; `validateNarrativeProposal(raw:unknown,doc:TranscriptDocument):NarrativeProposal`.

- [ ] **Step 1: Write the failing tests** in the listed test files. Use these assertions and the additional named cases below.

```ts
it('refuses fabricated source words', () => {
  expect(() => validateNarrativeProposal(proposalWithUnknownWord, doc)).toThrow(/word/i);
});
it('does not apply incomplete AI output', async () => {
  await expect(requestNarrative(doc, options, truncatedLLM)).rejects.toThrow(/incomplete/i);
  expect(saveNarrativeDraft).not.toHaveBeenCalled();
});
```

Task owns `wrong_snapshot_and_repeated_word_rejected`, `input_limit_before_provider_call`, `zero_excerpts_reviewable_failure`, `provider_401_and_cancel_do_not_mutate`, `timeline_changes_while_generating`, `unrelated_style_change_transcript_reuse`, and successful synthetic provider review->new draft->return to source. Read the spec transformation limits before presenting supported input claims.

- [ ] **Step 2: Run the tests and confirm the new contract fails.**

Run: `pnpm --filter @openreel/web exec vitest run src/services/lickety/workflow-ai.test.ts src/components/editor/lickety/NarrativePanel.test.tsx`
Expected: FAIL for the missing new behavior/module; distinguish unrelated baseline failures.

- [ ] **Step 3: Implement the listed interfaces in the owning files.**

Expose an AI Narrative panel with direction/optional length, current-transcript readiness, selected model, explicit generation confirmation, and proposal review. Use one constrained tool payload and validate exact word/range/snapshot identity locally before any mutation. No invented spoken text, duplicate IDs, hidden repair request or direct agent store mutation. Enforce <=20,000 words and <=500 excerpts. Preserve existing provider/token configuration; no hardcoded new editorial provider. Reject max_tokens/truncation cleanly and save the response for inspection/reuse. If the project changes while generating, retain the proposal tied to its source snapshot and offer review against that saved snapshot; never apply it to the changed current edit. Review actions save/open the separate draft or cancel.

- [ ] **Step 4: Run the same tests and the owning package typecheck.**

Run: `pnpm --filter @openreel/web exec vitest run src/services/lickety/workflow-ai.test.ts src/components/editor/lickety/NarrativePanel.test.tsx`
Expected: PASS.

Run: `pnpm --filter @openreel/web typecheck`
Expected: exit 0 for all owning/consuming TypeScript checks. Preserve existing behavior.

- [ ] **Step 5: Commit only this task's files after verification.**

```bash
git add apps/web/src/services/lickety/workflow-ai.ts apps/web/src/components/editor/lickety/NarrativePanel.tsx apps/web/src/components/editor/lickety/NarrativeReview.tsx apps/web/src/stores/lickety-workflow-store.ts apps/web/src/components/editor/InspectorPanel.tsx apps/web/src/services/lickety/workflow-ai.test.ts apps/web/src/components/editor/lickety/NarrativePanel.test.tsx
git commit -m "feat: add reviewed transcript Narrative AI action"
```

### Task 3: Protected-word pacing and final-time production cues

**Files:**
- Create: `packages/core/src/lickety/pacing.ts`, `packages/core/src/lickety/cues.ts`, `apps/web/src/components/editor/lickety/PacingControls.tsx`, `apps/web/src/components/editor/lickety/CueDetails.tsx`
- Modify: `apps/web/src/services/lickety/narrative.ts`, `apps/web/src/stores/lickety-workflow-store.ts`, `apps/web/src/components/editor/inspector/MarkersPanel.tsx`
- Test: `packages/core/src/lickety/pacing.test.ts`, `packages/core/src/lickety/cues.test.ts`, `apps/web/src/components/editor/lickety/PacingControls.test.tsx`

**Interfaces:**
- Consumes: NarrativeResult, local 10 ms energy windows, protected source-word IDs, Task 1 slicer; existing marker creation/undo.
- Produces: `measureGapEvidence(result:NarrativeResult,doc:TranscriptDocument,signal:AbortSignal):Promise<GapEvidence[]>`; `planPauseCuts(gaps:GapEvidence[],protectedAfterWordIds:ReadonlySet<string>,style:"relaxed"|"natural"|"tight"):PauseCut[]`; `applyPauseCuts(result:NarrativeResult,cuts:PauseCut[]):NarrativeResult`; `scanProductionCues(words:TimelineWord[]):Cue[]`.

- [ ] **Step 1: Write the failing tests** in the listed test files. Use these assertions and the additional named cases below.

```ts
it('preserves a meaningful pause', () => {
  expect(planPauseCuts([quiet700msGap], new Set(['w1']), 'tight')).toEqual([]);
});
it('only removes the eligible quiet center of an unprotected gap', () => {
  expect(planPauseCuts([quiet700msGap], new Set(), 'tight')).toEqual([
    {startMs:650,endMs:1050,reason:'tight-quiet-gap'}
  ]);
});
```

Task owns `quiet_breath_vs_loud_reaction`, `weak_confidence_abstains`, `word_count_unchanged`, `relaxed_2400_1100_natural_1500_700`, `negative_visual_promise_not_flagged`, `omitted_passage_no_cue`, `reordered_cue_final_time`, `repeated_export_no_duplicate_markers`, and undo/redo preserving complete linked edit. No ASR-low-confidence marker flood or speech leveling is introduced.

- [ ] **Step 2: Run the tests and confirm the new contract fails.**

Run: `pnpm --filter @openreel/core exec vitest run src/lickety/pacing.test.ts src/lickety/cues.test.ts && pnpm --filter @openreel/web exec vitest run src/components/editor/lickety/PacingControls.test.tsx`
Expected: FAIL for the missing new behavior/module; distinguish unrelated baseline failures.

- [ ] **Step 3: Implement the listed interfaces in the owning files.**

Implement measureGapEvidence in the existing narrative service using registered original-audio windows <=10 s, 10 ms RMS bins, and canonical source-word confidence; no full-source decode. Use exact spec section-10 thresholds; fixture gap begins at left-word end 500 ms and ends at right-word start 1200 ms, energy bins 10 ms at .001, adjacent speech .1, confidence .99. Cuts remain local/deterministic, preserve all retained word IDs, and use the same slicer to move included picture/audio/titles/captions together. Frame-snap only when applying, with word bounds checked after snapping. Save one reversible pacing decision. Scan final retained words for explicit visual/description promises using speaker/gap/negation boundaries. Combine optional AI B-roll suggestions with local cues; store Cue ranges/evidence/actions under Project.lickety and associate existing point markers. Do not auto-insert or generate B-roll. Marker details show retained final timeline positions after all reorder/pause cuts.

- [ ] **Step 4: Run the same tests and the owning package typecheck.**

Run: `pnpm --filter @openreel/core exec vitest run src/lickety/pacing.test.ts src/lickety/cues.test.ts && pnpm --filter @openreel/web exec vitest run src/components/editor/lickety/PacingControls.test.tsx`
Expected: PASS.

Run: `pnpm --filter @openreel/core typecheck && pnpm --filter @openreel/web typecheck`
Expected: exit 0 for all owning/consuming TypeScript checks. Preserve existing behavior.

- [ ] **Step 5: Commit only this task's files after verification.**

```bash
git add packages/core/src/lickety/pacing.ts packages/core/src/lickety/cues.ts apps/web/src/components/editor/lickety/PacingControls.tsx apps/web/src/components/editor/lickety/CueDetails.tsx apps/web/src/services/lickety/narrative.ts apps/web/src/stores/lickety-workflow-store.ts apps/web/src/components/editor/inspector/MarkersPanel.tsx packages/core/src/lickety/pacing.test.ts packages/core/src/lickety/cues.test.ts apps/web/src/components/editor/lickety/PacingControls.test.tsx
git commit -m "feat: add protected pacing and production cues"
```


## Work-package acceptance

Use a synthetic provider and native source fixtures through the normal UI. Inspect old/new project files, original asset hashes, linked AV timing, subtitles, effects and undo/return-to-source. Verify a rendered Narrative segment from originals and compare timed words. Separately authorized paid editorial evaluation and human story/listening acceptance remain release gates; a structurally valid proposal alone is not a successful story.

## Self-review record

Spec requirements are mapped to named tasks and tests above. Interfaces use the names in the shared spec. Review Focus cases each belong to a listed task. Physical-device, paid-provider, and signing gates are recorded separately from mocked/unit proof. Implementation steps name a result, not whole function bodies. Review this plan and the design together before execution.
