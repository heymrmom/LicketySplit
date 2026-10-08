# LicketySplit GitHub Distribution and Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A verified Apple silicon candidate and eventual signed GitHub download path.

**Architecture:** Separate build-only artifacts, physical-device evidence, signed draft release, and human publication. Keep the existing hosted web release independent and preserve a later Intel/Windows adapter path.

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

- Cross-compiled native binary wrong architecture: reject package before download (Task 1).
- Unsigned/notarization failure: never report Gatekeeper-ready release (Task 3).
- 8 GB device absent: engineering checks cannot close physical acceptance (Task 2).
- Proxy enabled at export: verify actual original resolution and source timing (Task 2).
- Install/update identity collision: old app/profile survives and new download opens correctly (Task 3).

---

## File structure and task ownership

Each task's Files/Interfaces blocks below define the module boundaries. New behavior lives in focused `lickety` modules, with small changes to upstream integration points. No broad rewrite of the editor, no changes to the Railway deployment, and no removal of unrelated upstream desktop capabilities.

## Prerequisites

All test snippets use test-local injected transports/fixture objects. Define those fixtures in the listed test file or use `makeWorkflowFixture`; helper names in assertions are not additional production APIs. Their behavior is fixed by the named cases and exact expected values.

Read the spec and prior work-package Interfaces. At execution time use an isolated managed worktree on a `codex/` branch from the reviewed baseline; inspect the current checkout and preserve unrelated work. Record baseline failures before modifications. Install only the repository's frozen dependency set and compile existing WASM before tests that need it. Capture progress in the linked ClickUp task, not a second persistent task ledger.

### Task 1: ARM64 packaging verification and build-only GitHub workflow

**Files:**
- Create: `.github/workflows/licketysplit-desktop.yml`, `apps/desktop/scripts/verify-licketysplit-package.mjs`
- Modify: `apps/desktop/electron-builder.yml`, `apps/desktop/package.json`, `apps/desktop/src/main/updater.ts`, `apps/desktop/DISTRIBUTION.md`
- Test: `apps/desktop/test/licketysplit-release.test.ts`

**Interfaces:**
- Consumes: packages 1-4 shared/native/UI modules; existing pnpm build:wasm, desktop build, bundled FFmpeg fetch; current GitHub source repo.
- Produces: `verifyLicketySplitPackage(appPath:string,expectedVersion:string):Promise<{architecture:"arm64";appId:string;version:string;sha256:string}>`; isolated build-only workflow; manual draft release path for tag namespace `licketysplit-desktop-v*`.

- [ ] **Step 1: Write the failing tests** in the listed test files. Use these assertions and the additional named cases below.

```ts
it('does not target upstream hosting or an untested platform', () => {
  expect(workflowText).toContain('runs-on: macos-14');
  expect(workflowText).toContain('--arm64');
  expect(workflowText).not.toMatch(/R2_|dl\.openreel\.video/);
  expect(updaterText).toContain('LICKETYSPLIT_AUTO_UPDATE_ENABLED');
});
```

Task owns `wrong_architecture_rejected`, `missing_native_binary_rejected`, `credential_and_media_paths_excluded`, `tag_namespace_does_not_trigger_upstream_r2`, `draft_assets_match_source_manifest`, and packaged launch using an isolated profile. Gatekeeper success is not claimed for unsigned test packages.

- [ ] **Step 2: Run the tests and confirm the new contract fails.**

Run: `pnpm --filter @openreel/desktop exec vitest run test/licketysplit-release.test.ts`
Expected: FAIL for the missing new behavior/module; distinguish unrelated baseline failures.

- [ ] **Step 3: Implement the listed interfaces in the owning files.**

Use Node 22, frozen declared pnpm, native macos-14 runner, explicit ARM64 and uname assertion. Run relevant upstream typecheck/test/lint gates and desktop build, then electron-builder --mac dmg zip --arm64 --publish never. Verify app identity/version and every required native binary using file/lipo, FFmpeg hash receipts, renderer/preload loadability and license files. No upstream signing identity, R2 upload or Railway mutation. Guard update initialization with `LICKETYSPLIT_AUTO_UPDATE_ENABLED === "1"`, default unset, and do not configure an upstream feed. Define workflowText/updaterText test-local by reading the actual workflow/updater files. Produce checksum/build manifests with repo/source SHA and dependency versions, without private media or credentials. Use workflow_dispatch build-only and action artifacts before enabling draft GitHub assets. Existing upstream release workflow remains separate.

- [ ] **Step 4: Run the same tests and the owning package typecheck.**

Run: `pnpm --filter @openreel/desktop exec vitest run test/licketysplit-release.test.ts`
Expected: PASS.

Run: `pnpm --filter @openreel/desktop typecheck`
Expected: exit 0 for all owning/consuming TypeScript checks. Preserve existing behavior.

- [ ] **Step 5: Commit only this task's files after verification.**

```bash
git add .github/workflows/licketysplit-desktop.yml apps/desktop/scripts/verify-licketysplit-package.mjs apps/desktop/electron-builder.yml apps/desktop/package.json apps/desktop/src/main/updater.ts apps/desktop/DISTRIBUTION.md apps/desktop/test/licketysplit-release.test.ts
git commit -m "build: add isolated Apple silicon desktop packaging"
```

### Task 2: Measure and accept the normal workflow on an actual 8 GB Mac

**Files:**
- Create: `scripts/verify-desktop-memory.py`, `scripts/verify-desktop-fixture.mjs`, `apps/desktop/ACCEPTANCE.md`
- Test: `apps/desktop/test/desktop-fixture-verifier.test.ts`

**Interfaces:**
- Consumes: managed proxies, jobs, Narrative/shorts/publishing workflows, ARM64 candidate from Task 1.
- Produces: `verify-desktop-memory.py --pid <app-main-pid> --output <evidence-dir>` samples process-tree RSS every 1 s; `verify-desktop-fixture.mjs --manifest <fixture.json> --export <rendered-file>` produces a verification receipt; deterministic verifier utilities tested independently.

- [ ] **Step 1: Write the failing tests** in the listed test files. Use these assertions and the additional named cases below.

```ts
it('rejects a proxy-resolution export offered as original-quality proof', () => {
  expect(checkExport({width:960,height:540}, {width:3840,height:2160})).toEqual({pass:false,reason:'resolution'});
});
```

Task owns `rss_sampler_tracks_child_processes`, `seek_percentile_calculated_from_samples`, `cancel_does_not_orphan_ffmpeg`, `original_vs_proxy_output_validation`, `restart_reuses_analysis`, and explicit source/effects/word retention. Human listening/story acceptance is documented separately from deterministic checks. One complete hour-long owner workflow is required before promising that workload to users.

- [ ] **Step 2: Run the tests and confirm the new contract fails.**

Run: `pnpm --filter @openreel/desktop exec vitest run test/desktop-fixture-verifier.test.ts`
Expected: FAIL for the missing new behavior/module; distinguish unrelated baseline failures.

- [ ] **Step 3: Implement the listed interfaces in the owning files.**

Define fixture manifest fields: source paths/hashes, codec/rate/duration/channel count, known sync events, expected selected words/cuts/effects, expected export dimensions/rate. Generate synthetic one-hour three-camera 4K/two-mic fixture and record codecs. On actual 8 GB ARM Mac, measure cold preparation, warm reopen/seek/playback, sync/checkpoint recovery, Narrative+pacing, optional copy/short generation, missing original/relink, and cancel. Apply spec budgets: sampled tree RSS <=3 GiB, warm seek p95 <=500 ms, >=90% frames at <=30 fps, UI cancellation <=2 s, native exit <=5 s. Record physical memory-pressure/GPU qualifications and baseline comparison. ffprobe/decoded audio/video checks verify actual final original-quality output; compare beginning/middle/end sync and cut boundaries. Mocked provider run is the default; one short live-provider acceptance requires explicit paid authorization. Missing physical device/credential remains an open gate; do not treat a capped larger Mac as equivalent.

- [ ] **Step 4: Run the same tests and the owning package typecheck.**

Run: `pnpm --filter @openreel/desktop exec vitest run test/desktop-fixture-verifier.test.ts`
Expected: PASS.

Run: `pnpm --filter @openreel/desktop typecheck`
Expected: exit 0 for all owning/consuming TypeScript checks. Preserve existing behavior.

- [ ] **Step 5: Commit only this task's files after verification.**

```bash
git add scripts/verify-desktop-memory.py scripts/verify-desktop-fixture.mjs apps/desktop/ACCEPTANCE.md apps/desktop/test/desktop-fixture-verifier.test.ts
git commit -m "test: add physical-device desktop acceptance harness"
```

### Task 3: Signed GitHub draft release and downloaded installation proof

**Files:**
- Modify: `apps/desktop/scripts/verify-licketysplit-package.mjs`, `.github/workflows/licketysplit-desktop.yml`, `apps/desktop/electron-builder.yml`, `apps/desktop/DISTRIBUTION.md`, `apps/desktop/ACCEPTANCE.md`
- Test: `apps/desktop/test/licketysplit-release.test.ts`

**Interfaces:**
- Consumes: verified candidate, real-device evidence, user Apple Developer ID/notarization credentials, GitHub repository visibility/access.
- Produces: GitHub draft prerelease with LicketySplit-<version>-arm64.dmg/.zip, SHA256SUMS, notices and build manifest; verification receipts for codesign/notary/stapler/spctl and manual download/install.

- [ ] **Step 1: Write the failing tests** in the listed test files. Use these assertions and the additional named cases below.

```ts
it('requires signing evidence before describing an artifact as public-download ready', () => {
  expect(canPromote({signed:false,notarized:false,deviceAccepted:true})).toBe(false);
});
```

Task owns `missing_certificate_does_not_claim_signed`, `notarization_failure_no_promotion`, `download_checksum_matches_manifest`, `new_profile_keeps_legacy_projects_and_keys`, and `release_remains_draft_until_explicit_promotion`. Verify downloads according to existing private/public repository visibility; do not silently change it.

- [ ] **Step 2: Run the tests and confirm the new contract fails.**

Run: `pnpm --filter @openreel/desktop exec vitest run test/licketysplit-release.test.ts`
Expected: FAIL for the missing new behavior/module; distinguish unrelated baseline failures.

- [ ] **Step 3: Implement the listed interfaces in the owning files.**

Add `canPromote(evidence:{signed:boolean;notarized:boolean;deviceAccepted:boolean}):boolean` in package verifier as an evidence policy. Use GitHub secrets MAC_CSC_LINK, MAC_CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID (or explicit supported API-key alternative). Inspect existing account access; never copy upstream identity or old app secrets. No credentials in logs/artifacts. After signed/notarized build, create/upload only a draft prerelease using GitHub-token permissions scoped to this repository. Verify matching downloaded checksums, Gatekeeper acceptance, launch without developer tooling and reopening saved projects in the new profile. Preserve current installed legacy app and use a reversible new-app installation. Publish the draft only on explicit release authorization; leave auto-update/manual visibility decision as documented later work.

- [ ] **Step 4: Run the same tests and the owning package typecheck.**

Run: `pnpm --filter @openreel/desktop exec vitest run test/licketysplit-release.test.ts`
Expected: PASS.

Run: `pnpm --filter @openreel/desktop typecheck`
Expected: exit 0 for all owning/consuming TypeScript checks. Preserve existing behavior.

- [ ] **Step 5: Commit only this task's files after verification.**

```bash
git add apps/desktop/scripts/verify-licketysplit-package.mjs .github/workflows/licketysplit-desktop.yml apps/desktop/electron-builder.yml apps/desktop/DISTRIBUTION.md apps/desktop/ACCEPTANCE.md apps/desktop/test/licketysplit-release.test.ts
git commit -m "release: prepare signed LicketySplit GitHub prerelease"
```


## Work-package acceptance

A build artifact is not an accepted release. Required evidence is frozen source/build SHA, binary architecture/license checks, actual 8 GB workflow measurements, signed/notarized app assessment, matching downloaded installer and successful normal launch/reopen. Draft release is reviewable; public promotion remains an explicit final step. Record missing Apple credentials or device access as the precise blocker, not a generic failure.

## Self-review record

Spec requirements are mapped to named tasks and tests above. Interfaces use the names in the shared spec. Review Focus cases each belong to a listed task. Physical-device, paid-provider, and signing gates are recorded separately from mocked/unit proof. Implementation steps name a result, not whole function bodies. Review this plan and the design together before execution.
