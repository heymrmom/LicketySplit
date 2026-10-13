# LicketySplit Apple Silicon desktop design

Status: review draft. This records the user's selected direction and proposed implementation contracts. It is not an implementation approval or evidence that any feature has shipped.

## 1. Product outcome and confirmed decisions

Build LicketySplit on OpenReel's desktop editor. First target Apple silicon Macs with 8 GB RAM. Keep the native editor, multicamera synchronization, camera planning, participant setup, reframing, undo conventions, and existing provider approval/token controls. Source remains https://github.com/heymrmom/LicketySplit; desktop installers will eventually be downloadable through GitHub Releases. The current Railway browser deployment is a separate baseline and is not part of this desktop release.

The Narrative AI function operates on the **current timeline**, preserving the current camera cuts, source links, transforms, and supported effects. It does not start again from selected raw recordings. AssemblyAI is the exclusive speech-to-text provider. No local Whisper fallback or speech-model download is offered in the desktop app. Local VAD and face/reaction processing remain separate features and are not prohibited by this choice.

Add validated transcript-driven Narrative assembly, protected-word pacing, semantic enhancements to existing shorts, production cue markers/B-roll suggestions, and optional AI publishing files selected at export. XML/Resolve delivery is a later milestone. Speech leveling and the old full-source WAV delivery process are not selected for the first release. Do not import the legacy synchronization approval screens or monetary reservation ledger.

## 2. Inspected baseline

Repository branch at inspection: `codex/openreel-baseline`; commit `56ca594` (record full SHA in implementation evidence). Legacy reference: `/Users/donaldanderson/Documents/ChatGPT/Lickety Split`, beta20. Upstream comparison: `c9340465e5d37e684cc25bdbe746c4ccd45e165c`.

- `apps/desktop/src/main/index.ts`, preload and IPC modules already supply Electron, FFmpeg, OS key storage, and native export.
- `apps/desktop/src/main/sidecar/media-job.ts` supplies low/medium/high proxies. `packages/core/src/media/native-media-bridge.ts` currently reads generated proxies back as whole blobs; avoid that for long recordings.
- `apps/web/src/services/preview-proxy-cache.ts` provides preview-only proxies with a 256 MiB blob cache. Add a disk-backed desktop implementation, preserving the browser implementation.
- `apps/web/src/components/editor/inspector/MultiCameraPanel.tsx` decodes camera audio into retained buffers. Preserve the sync/shot decision algorithms while replacing large desktop input allocations.
- `packages/core/src/audio/audio-engine.ts` already has segmented decoding above 120 s and `packages/core/src/export/export-engine.ts` already chunks export audio. Keep these successes; eliminate whole-source fallback on long desktop files and unbounded decoder preparation.
- Native export has credit backpressure. `packages/core/src/types/project.ts`, serializer and `cloneProjectForEdit` are the existing project/source-identity seams.
- Existing `makeBYOKClient` and `LLMClient.complete` support selected compatible endpoints and user-entered models. Use these instead of hardcoding an editorial provider/model.
- `.github/workflows/release.yml` currently builds multiple platforms and can publish to upstream R2. The new desktop release workflow must be separate, ARM64-only, and target this GitHub repository.

## 3. Global constraints

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

## 4. Five independently testable work packages

1. **Desktop identity and 8 GB foundation**: isolated app profile, managed original assets, durable disk proxies, bounded audio/decoder paths, packaged native smoke.
2. **AssemblyAI transcript foundation**: managed timeline audio preparation, secure direct provider jobs, normalized word identity, captions and multicam transcript consumers, no Whisper entry points.
3. **Narrative, pacing, and cues**: immutable timeline snapshot, LLM range proposal, validated deterministic timeline slicing, separate draft, protected pauses and final-time markers.
4. **Export publishing and shorts**: optional publishing generation for the final edit and semantic review of existing OpenReel short candidates, with native timeline integration.
5. **GitHub distribution and acceptance**: ARM64 artifacts, binary verification, signing/notarization, real 8 GB workflow proof, draft GitHub releases and manual installation rollback.

Packages 1 and 2 establish shared interfaces for 3 and 4. Package 5 starts with build-only ARM64 smoke as soon as 1 exists and publishes a draft candidate only after all selected features pass. No Intel/Windows delivery is claimed; shared code must not import macOS-only modules.

## 5. Files and ownership

| Area | New focused modules | Existing integration points |
| --- | --- | --- |
| Shared contracts | `packages/core/src/lickety/types.ts`, `snapshot.ts`, `transcript.ts`, `timeline-slicer.ts`, `pacing.ts`, `cues.ts`, `publishing.ts`, `shorts.ts`, `test-fixtures.ts` | project types, serializer/schema types, timeline item helpers; shared core index |
| Native resource/media layer | `apps/desktop/src/main/lickety/resource-policy.ts`, `asset-registry.ts`, `media-jobs.ts`, `audio-analysis.ts`, `job-store.ts`, `assemblyai-client.ts`; `apps/desktop/src/main/ipc/lickety.ts` | main/preload/channels/IPC schema, protocol, hardware info, existing FFmpeg locator and native export |
| Editor integration | `apps/web/src/services/lickety/desktop-media.ts`, `transcription.ts`, `workflow-ai.ts`, `narrative.ts`, `publishing.ts`, `shorts.ts`; `apps/web/src/stores/lickety-workflow-store.ts` | native bridge/global types, proxy store, project store/slices, caption panel, multicam panel/bridge, export dialog |
| UI | `apps/web/src/components/editor/lickety/NarrativePanel.tsx`, `NarrativeReview.tsx`, `PacingControls.tsx`, `TranscriptControls.tsx`, `PublishingOptions.tsx`, `CueDetails.tsx` | existing AI/inspector panels and native settings API keys |
| Distribution | `.github/workflows/licketysplit-desktop.yml`, `apps/desktop/scripts/verify-licketysplit-package.mjs`, `scripts/verify-desktop-memory.py`, `scripts/verify-desktop-fixture.mjs` | electron-builder config/package metadata, distribution documentation, update initialization |

Use sibling `*.test.ts` / `*.test.tsx` files for each unit; native integration tests go in `apps/desktop/test/`. Do not turn the existing large project store, multicam panel, or agent registry into the implementation home; add a small bridge into focused modules.

## 6. Shared interface contracts

Implement these names in `packages/core/src/lickety/types.ts`. All times below are milliseconds relative to the frozen input timeline unless stated otherwise. OpenReel project times remain seconds; convert only at the adapter boundary.

```ts
export type JobState = 'queued'|'preparing'|'uploading'|'submitted'|'processing'|'completed'|'cancelled'|'failed'|'submission-unknown';
export interface ResourceProfile { lowMemory: boolean; maxHeavyJobs: 1; maxVideoDecoders: 4; maxChunkBytes: number; proxyMaxLongEdge: 960; proxyMaxShortEdge: 540; }
export interface AssetIdentity { assetId: string; mediaId: string; sha256: string; byteLength: number; }
export interface RegisteredAsset { identity: AssetIdentity; originalUri: string; durationMs: number; }
export interface ProxyReceipt { assetId: string; sourceSha256: string; proxyUri: string; width: number; height: number; sourceStartPTS: number; proxyStartPTS: number; durationMs: number; version: 1; }
export interface DialogueSpan { clipId: string; mediaId: string; assetId: string; trackId: string; timelineStartMs: number; timelineEndMs: number; sourceInMs: number; channel: number; participantId?: string; }
export interface AnalysisSnapshot { schemaVersion: 1; projectId: string; revisionHash: string; durationMs: number; frameRate: number; assets: AssetIdentity[]; dialogue: DialogueSpan[]; }
export interface PreparedAudio { handleId: string; snapshotHash: string; sha256: string; sampleRate: 16000; channels: 1|2; durationMs: number; }
export interface TranscriptWord { id: string; text: string; startMs: number; endMs: number; confidence: number; channel?: number; speaker?: string; sourceWordId?: string; }
export interface TranscriptDocument { schemaVersion: 1; snapshotHash: string; preparedAudioSha256: string; provider: 'assemblyai'; providerJobId: string; words: TranscriptWord[]; derivedFromSnapshotHash?: string; }
export interface TimelineWord { occurrenceId: string; sourceWordId: string; text: string; startMs: number; endMs: number; }
export interface NarrativeExcerpt { id: string; firstWordId: string; lastWordId: string; reason: string; }
export interface NarrativeProposal { schemaVersion: 1; snapshotHash: string; excerpts: NarrativeExcerpt[]; protectedAfterWordIds: string[]; reviewNotes: string[]; }
export interface TimelineRange { id: string; inMs: number; outMs: number; }
export interface NarrativeResult { project: import('../types/project').Project; words: TimelineWord[]; ranges: TimelineRange[]; }
export interface GapEvidence { leftWordId: string; rightWordId: string; startMs: number; endMs: number; rms: number[]; speechRms: number; confidence: number; }
export interface PauseCut { startMs: number; endMs: number; reason: string; }
export interface Cue { id: string; kind: 'onscreen'|'description'|'speech-cut'|'broll'|'short'; startMs: number; endMs: number; evidence: string; action: string; }
export interface PublishingPackage { schemaVersion: 1; snapshotHash: string; titles: string[]; youtubeDescription: string; chapters: {startMs:number;title:string}[]; tags: string[]; spotifyNotes: string; thumbnailIdeas: string[]; pinnedComments: string[]; }
export interface SemanticShort { candidateId: string; firstWordId: string; lastWordId: string; hookOptions: string[]; recommendedHook: string; rationale: string; captions: {youtube:string;facebook:string;instagram:string;tiktok:string}; tags: string[]; }
export interface LicketyProjectState { schemaVersion: 1; snapshot?: AnalysisSnapshot; transcript?: TranscriptDocument; narrative?: NarrativeProposal; words?: TimelineWord[]; cues?: Cue[]; publishing?: PublishingPackage; }
```

Add optional `Project.lickety?: LicketyProjectState`; bump project reader/schema to `1.3.0`. Workflow-bearing files declare capability `licketysplit-workflows-v1` and minimum reader `1.3.0`; ordinary imported `1.2.0` projects still load. Store no media bytes, managed native paths, credentials, or provider upload URLs in the portable JSON. Media registry retains local URI/path resolution separately and supports relink. The project schema version is distinct from desktop installer version.

## 7. Native resource contract and proxies

`registerAsset(mediaId, path)` streams a SHA-256 once and registers a read-only original. Generated blob media are materialized in bounded chunks once. A `licketysplit-media://` protocol resolves opaque registered asset/cache IDs and byte ranges; reject unknown IDs, traversal and access outside the registry. Use URL-backed media decoding on desktop; avoid fetch-to-ArrayBuffer/whole-Blob readback for long originals/proxies.

`getResourceProfile(totalBytes)` produces the fixed profile above. `ensureProxy(assetId, profile, signal)` writes a cache file and atomic receipt keyed by source SHA, preset and encoder version. Low-memory preview automatically requests it; preview shows preparation until ready instead of silently decoding a heavy original. Failure offers retry/relink; it does not relabel the proxy as the original. Preserve aspect ratio and presentation-time mapping, never upscale, and test landscape/portrait/square and fractional frame rates. Only one proxy/analysis/export preparation process runs at a time; UI remains cancellable. Reopening reuses valid receipts. Changed sources invalidate their proxies/analysis. Disk cleanup removes derived cache files, never originals or unrelated folders.

Use native VideoToolbox H.264 when execution proves availability; allow one software H.264 fallback attempt. Keep a stable cache key per effective encoder. Check disk space before encoding; require projected output plus 1 GiB free cache headroom, report the path and needed space if unavailable. Cache eviction is limited to completed, unused managed derivatives and a user-selectable cap (proposed default 10 GiB).

For sync, decode directly to compact mono analysis samples; preserve OpenReel's block correlation/drift and shot planning. For VAD/energy, process one source at a time and release its 16 kHz buffer. No change to sync confidence rules, approval UI or shot policy. Compare existing-versus-new fixture offsets within 1 ms and identical chosen camera segments on deterministic fixtures. Retain safe display/review where upstream requires it.

Video decoder cache is lazy and LRU bounded; do not prepare a decoder for every historical file before the first export frame. Keep existing chunked audio export. Desktop long-source fallback must use native ranged decoding if MediaBunny cannot segment-decode; do not create a complete 48 kHz AudioBuffer. Export still renders the selected OpenReel effects/camera cuts from originals.

## 8. Transcription and snapshots

`createAnalysisSnapshot(project, assets)` hashes the relevant timeline/settings and dialogue source identity. Choose existing audible dialogue track(s); muted/reference-only audio is excluded. Expose one compact dialogue selector only if existing track roles do not identify the intended sources. Do not redesign participant/camera setup.

`prepareAnalysisAudio(snapshot, options)` creates disk-backed 16 kHz PCM: mono mixed conversation with speaker diarization, or exactly two isolated channels with approved channel->participant names and multichannel transcription. Do not equate camera scratch audio with participant microphones. Preserve nonzero source starts, gaps, and source/timeline offsets. New extraction/mixing streams <=10 s chunks, preserves timing, and is separate from native final export. Additional independent participants use mono shared diarization initially; do not silently drop microphones.

Proposed initial `speech_models`: `['universal-2']` for consistent mixed/stereo support; keep it configurable and verify current official model support before implementation. No automatic cross-provider fallback. Send `/v2/upload`, then `/v2/transcript`, persist returned job ID immediately, poll `/v2/transcript/{id}` every 3 s. Retry GET 429/5xx at most three times with bounded backoff respecting Retry-After. Do not blindly retry an uncertain submission POST. Cancellation stops local work/polling; explain that an already-submitted provider job may continue. Resume known jobs after restart; a completed transcript is reusable without another paid submission. Record exactly which audio snapshot was submitted.

Native credentials use key ID `assemblyai`. Renderer handles opaque job IDs and status, not provider secrets or local file paths. Each new paid initiation uses the existing confirmation concept. A missing/locked key blocks before audio upload. AssemblyAI completed words are validated, normalized to ms, sorted stably by channel/start/id and mapped to the frozen timeline. Missing speakers remain unknown. Overlapping channel speech is represented, not silently duplicated into Narrative selections. `deriveTimelineWords(doc, ranges)` remaps selected words after Narrative/pacing without retranscribing unchanged audio. `projectTranscript(doc, words, snapshotHash)` builds a view of ONLY the current retained word occurrences for a subsequent Narrative request, preserving the provider result separately and recording original word provenance. Never use the full original transcript to reintroduce omitted words in a later current-timeline action. Changed unrelated visual styling does not invalidate the source transcript; changed submitted audio does.

Route AutoCaption, multicam transcription and the agent transcript bridge through this service. Remove desktop Whisper model controls/workers/downloads from those entry points; keep imported subtitles and non-transcription AI features intact. Desktop-only gating preserves the deployed browser baseline until a separate web migration.

## 9. Narrative transformation and preserved edit semantics

Freeze a portable source-project snapshot before requesting the LLM. `requestNarrative(doc, options, llm)` uses existing selected LLM endpoint/model/token settings and a structured `submit_narrative` tool payload. Proposed limits: 20,000 input words, 500 excerpts, output token cap inherited from existing user settings with 8,192 used only if no cap is configured. No hidden repair request or silent transcript truncation. Return incomplete/invalid responses as reviewable failure without modifying the project.

`validateNarrativeProposal` rejects unknown word IDs, reversed ranges, empty excerpts, wrong snapshot hashes, duplicate/repeated word occurrences unless a future explicit repetition feature is added, and source/timing violations. Proposal text is explanatory; spoken output is assembled only from recorded references. Allow different excerpt ordering. `compileNarrative` slices the CURRENT timeline across all relevant tracks and remaps audio, current program-camera cuts, transforms, color/effect data, subtitles, and contained timed items into a new `Project.id`/name (`<original> - Narrative`). Original media object identity is preserved. Keep an immutable source project file for recovery.

First supported transformation envelope: forward normal-speed source clips, materialized multicamera cuts, ordinary video/audio/text/graphics, static and ordinary keyframed effects, and transitions wholly contained in a selected excerpt. Slice-local keyframes must retain their evaluated value at new boundaries, not restart the original animation. Clip fades/automation must be rebased. Reject reverse/speed ramps/freeze frames, nested/motion/3D compositions or a splice through an active transition with specific review notes; do not silently flatten/drop them. Preserve those features in normal OpenReel editing/export; the restriction applies only to automatic Narrative transformation. Record limits before paid generation where possible and validate actual selected boundaries afterward.

Materialize the existing active multicam plan for the frozen snapshot using its native sequence conversion. Preserve its actual camera cuts/effects. Narrative drafts carry that cut geometry and reference the original group in provenance; do not retain a live old group definition whose absolute times could later overwrite the reordered draft. The source project retains original editable multicam groups and synchronization. The new draft's cuts remain manually editable. No recomputation of synchronization.

Use integer frame boundaries for splice decisions, snapping starts outward down and ends outward up, with checks preventing duplicate spoken words. Effects/transcript times remain source-relative or draft-relative as appropriate. Handle `24000/1001` and `30000/1001` fixtures. One apply action creates/saves the new draft; cancel/failure leaves the source untouched. No LLM output directly mutates the store. Clear labeling distinguishes a generated proposal, saved draft, and rendered video.

## 10. Pacing and cues

Pacing is optional, reversible, and uses the selected Narrative result's words plus local original-audio evidence. Default Natural; offer Relaxed/Natural/Tight. Relaxed: quiet run >=2.4 s, retain >=1.1 s. Natural: quiet run >=1.5 s, retain >=0.7 s. Tight: gap >=650 ms, word confidence >=0.65, speech RMS >=0.012, quiet threshold clamp(speechRMS*0.30,0.006,0.04), protect 150 ms next to each word, minimum removable quiet run 160 ms. Evidence bins are 10 ms. These reproduce the documented current behavior rather than inventing general silence removal.

Protected word IDs and meaningful pauses cannot be cut; weak/corrected timing causes abstention. No reaction or breath semantic guarantee is inferred from amplitude alone. Reuse the timeline slicer to ripple ALL included picture/audio/overlay/subtitle tracks together, and remap markers/derived words. Verify retained word IDs/count unchanged. Preview and undo remain available. Speech leveling is not included.

Local retained-transcript cue scanning detects explicit English on-screen and description promises, including negation and speaker/gap boundaries. Narrative LLM output may supply separate B-roll suggestions, not invented assets or inserted footage. Each Cue stores a final-time range, evidence and action; associate it with an existing OpenReel marker plus a details pane. Omitted dialogue creates no cues; repeated exports do not duplicate them. Keep full ranges in `Project.lickety.cues`; don't overwrite existing markers or require changing the upstream Marker shape.

## 11. Publishing and shorts

Export has unchecked-by-default `Generate publishing package (uses AI tokens)`. Video export itself makes no new AI request unless selected. Freeze the final timeline and derive its retained words; validate the response and save package files next to the exported video, with a source revision receipt. Generation and rendering have separate completion states; a failed render may reuse its successful copy response. A changed final edit invalidates copy reuse. Chapters and descriptions reflect final timing/retained statements, not deleted material. Publish nowhere automatically.

Reuse existing OpenReel short candidates and UI. `reviewShortCandidates(candidates, finalWords, llm)` scores standalone meaning/hook/payoff and returns bounds within the candidate, not new unrelated excerpts. Default duration stays OpenReel's 45 s; any configured upstream maximum remains authoritative. Empty valid set is successful. Validate unique IDs, positive ranges, word references, no overlap after selection, and actual final-timeline coverage. Each selected short carries 5-8 opening hook options, one recommended hook from that set, rationale, platform captions, and tags. Reuse native short/cut creation and markers. Preserve original episode timeline, camera edits and aspect-ratio choice. Reframing remains OpenReel's existing feature.

## 12. Versioning, cross-platform seams, and GitHub release

Installer's proposed first independent version: `0.1.0-alpha.1`; do not reuse OpenReel's upstream release number or imply feature parity. Keep a separate Electron profile and product identity. Package ARM64 `.dmg` and `.zip`, SHA256SUMS, third-party notices, release notes, and build/source manifest. No LLM/API credentials or user media in release assets.

Use Node 22 and the repository's declared pnpm version, existing TypeScript/React/Electron stack and bundled FFmpeg. macOS implementation stays under desktop adapters; shared snapshot/validation/timeline code is OS-independent. Build Linux/Windows/Intel workflows only in a later expansion; do not make their untested support a release promise.

A separate `.github/workflows/licketysplit-desktop.yml` uses `macos-14` ARM64 (verify label and `uname -m` at execution), validates binaries with `file`/`lipo`, and requires a build-only workflow_dispatch path. Proposed tag namespace `licketysplit-desktop-v*` avoids triggering upstream `v*` R2 release publishing. No R2/Cloudflare/Railway publishing occurs. GitHub draft releases are reviewable; making a release downloadable to others is a separate explicit release operation.

Public downloads require the user's Apple Developer ID identity and notarization credentials, configured as GitHub secrets; do not retain the upstream author's signing identity. Local unsigned/ad-hoc builds may be used for testing but are labeled that way and are not reported as Gatekeeper-ready releases. Signing/notarization evidence and an actual downloaded-install test are distinct from archive creation. Initially disable updater against both upstream R2 and private GitHub feeds. Decide signed auto-update/private-repo authentication later; never ship a repository access token.

## 13. Acceptance examples and performance proof

Required fixture: an actual 8 GB Apple silicon Mac, one-hour timeline, three 4K camera sources (record exact codecs/frame rates), two isolated microphone sources, cuts/effects/title overlay, and a representative missing/relinked asset. Generate synthetic public fixtures for deterministic tests; owner footage is used only with explicit access and paid-run authorization. Data size alone is not an acceptance metric.

Measure app main/renderer/native process-tree RSS at 1 s intervals; it is a conservative aggregate and not exact physical ownership. Record macOS memory-pressure state and GPU/unified memory qualifications. Gate on the proposed budgets above; artificially limiting a 16/32 GB host does not establish actual 8 GB acceptance. Record cold proxy preparation versus warm reopen separately. Seek/playback tests run after required proxies finish, with the job queue empty. Cold proxy timing is reported rather than promised before benchmarking.

Check sync events near beginning/middle/end against baseline; linked picture/sound remain aligned after Narrative and pacing. Export a representative original-quality segment at requested 4K resolution and frame rate; verify actual downloaded/rendered bytes, duration, audio channels, effects, and picture/audio correspondence. Full-hour export is an acceptance run when time/storage allow; no hard export-duration claim is made from the short sample. If a minimum device/credential is missing, preserve engineering evidence and mark that release gate open.

## 14. Coverage map and deferred work

| User candidate | Owning package |
| --- | --- |
| 1 | 3 Narrative |
| 2 | 3 protected pacing |
| 3 | 4 publishing |
| 4 | 4 shorts |
| 5 | 3 cues, 4 final publishing markers |
| 6,7,9,11,14 | Retained upstream behavior; regression gates in 1/3/5 |
| 8 | Minimal snapshots/identity contracts in 1/2/3/4 |
| 10 | 2 AssemblyAI |
| 12 | Deferred XML adapter; preserve native project truth now |
| 13 | Speech leveling/full-source export WAVs deferred; preserve native source handles |
| 15 and 8 GB request | 1 resource foundation; measured acceptance in 5 |

Design approvals still needed: proposed macOS 14 support floor/performance budgets, the initial Narrative transformation envelope, and installer version/app ID. The user's provider, current-timeline input, retained sync, platform focus and GitHub destination are confirmed. No requirement is silently expanded to all platforms or every OpenReel effect type.

## Primary references

- AssemblyAI async upload/submit/poll: https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit
- AssemblyAI channel/diarization behavior: https://www.assemblyai.com/docs/pre-recorded-audio/transcribe-multiple-audio-channels
- GitHub hosted runner architectures: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- Electron Builder publishing/signing: https://www.electron.build/publish/ and https://www.electron.build/code-signing-mac
- Legacy reference files: `electron/narrative-finish.ts`, `electron/narrative-project.ts`, `electron/providers.ts`, `docs/SHARED-TIMELINE-MARKERS.md` in the separate desktop source folder.

This document is a design/specification artifact, not a parallel task ledger. ClickUp owns commitments, priorities and progress.
