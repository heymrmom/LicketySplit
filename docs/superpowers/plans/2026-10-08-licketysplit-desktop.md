# LicketySplit Apple Silicon Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fast, 8 GB-capable Apple silicon OpenReel desktop app with LicketySplit transcript workflows and eventual GitHub downloads.

**Architecture:** Keep OpenReel's native editor and multicam decisions. Put bounded media/provider jobs in Electron main and validated Narrative/short/publishing transformations in shared focused modules. Release each work package through its own tests, then verify the assembled app on a real 8 GB Mac.

**Tech Stack:** Existing React/TypeScript/Electron 33, native FFmpeg, MediaBunny, Vitest, Node 22, declared pnpm, AssemblyAI, configured OpenReel LLM endpoint/model, GitHub Actions/Releases.

**Spec:** [../specs/2026-10-08-licketysplit-desktop-design.md](../specs/2026-10-08-licketysplit-desktop-design.md). This is a review draft; inspect the proposed support floor/budgets and transformation limits before execution.

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

- Proxy/original confusion: package 1 Task 2 and package 5 Task 2 prove original-quality export.
- Stale or uncertain paid work: package 2 Tasks 1/2 and package 3 Task 2 preserve identity/results without blind resubmission.
- Camera/effect/word damage during slicing: package 3 Tasks 1/3 verify all linked timeline content and protected words.
- A successful synthetic run mislabeled as 8 GB acceptance: package 5 Task 2 requires actual physical-device measurements.
- A packaged app mislabeled as a downloadable signed release: package 5 Tasks 1/3 verify architecture/signing/download/installation separately.

---

## Delivery sequence

| Work package | Independently useful result | Detailed plan |
| --- | --- | --- |
| 1 | Isolated ARM64 app with durable proxies and bounded analysis/export paths | [Foundation](2026-10-08-licketysplit-desktop-01-foundation.md) |
| 2 | AssemblyAI captions and word/channel transcripts with restart recovery | [Transcription](2026-10-08-licketysplit-desktop-02-transcription.md) |
| 3 | Current-timeline Narrative draft, optional pacing, timed production cues | [Narrative](2026-10-08-licketysplit-desktop-03-narrative.md) |
| 4 | Optional export copy and enhanced existing shorts | [Publishing and shorts](2026-10-08-licketysplit-desktop-04-publishing-shorts.md) |
| 5 | Tested/signed ARM64 candidate and GitHub draft download | [Distribution](2026-10-08-licketysplit-desktop-05-distribution.md) |

Build-only package-5 Task 1 begins after package 1, so packaging regressions are found before AI integration. Physical-device/resource proof belongs to each media change and the final assembled candidate; do not defer every measurement to the end. Paid/provider and human review are distinct from automated checks.

## Decisions carried from the conversation

- Confirmed: current timeline as Narrative input; retain existing camera edits/effects; OpenReel synchronization initially; AssemblyAI exclusively; optional AI publishing on export; augment current shorts; keep upstream setup/camera/framing/token controls; XML later; native finish/render first.
- Added target: actual 8 GB Apple silicon device, automatic disk proxies where needed, bounded audio/decoder/jobs.
- First release: GitHub source and ARM64 installer assets; manual download; later Intel/Windows through shared contracts and isolated platform adapters.
- Not selected: old sync review workflow, old dollar ledger, automatic publication, speech leveling/full-source Resolve WAV adapter, legacy 115% crop policy.

## Review decisions before execution

1. Approve or change the proposed macOS 14 support floor and the measurable 8 GB budgets in spec section 3.
2. Review the Narrative supported-input envelope in section 9: current cut/effect preservation, explicit handling of ramps/nested/3D/transition-boundary cases.
3. Confirm new independent app ID/version and draft/manual GitHub release policy in section 12; source repository visibility is preserved.
4. Select execution method after reviewing these documents: native implementation or task-by-task subagent implementation.

## Readiness and verification boundaries

No implementation code, dependencies, branch, installed app, GitHub release, or live Railway setting was changed to write these plans. Plans were self-reviewed for coverage, cross-package types, test ownership, exact values and existing file paths. They describe future checks; no build/test/performance/signing pass is claimed here.

ClickUp remains the work record: https://app.clickup.com/t/86e3n70p1. Plan checkboxes are executor instructions, not a competing commitment/progress ledger.

## Execution handoff

Review the design and package 1 first. Recommended execution: native for the first foundation package, with one independent whole-package review, because proxy/source/decoder changes share tightly coupled interfaces. Subagent-driven execution is an alternative for the later independent packages, with fresh task reviews. Either method requires user review of the plan before product changes begin.
