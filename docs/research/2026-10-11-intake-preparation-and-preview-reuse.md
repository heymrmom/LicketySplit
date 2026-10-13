# Intake preparation and completed preview reuse

This bounded change starts eligible native preview work during intake and removes unrelated heavy-queue wait from completed proxy reads. Original references, source identity, exact microphone channels, proxy dimensions/codecs, original-only export and timing validation remain unchanged. It does not promise instant first preparation.

## Implementation

- `ManagedMediaJobs` validates completed video/audio previews before entering the heavy queue, and rechecks queued misses. Shared work is keyed by asset identity, source hash, derivative version and channel. Each caller owns its cancellation signal; the final canceled consumer aborts the transcode. A foreground join promotes pending background work.
- The heavy queue runs one job. Foreground requests get priority with a bounded burst so normal analysis/export work can progress; aged background work also gets a turn. An already running job is not preempted.
- Header-only metadata inspection has a separate bounded single-worker queue. Starting preparation after the first import therefore does not place the next import's lightweight header inspection behind an entire transcode. At most one heavy job and one lightweight header probe can overlap.
- Renderer preparation keeps pending sources local to the current project, with a bounded foreground/background dispatch. Eligibility remains explicit proxy choice, unsupported video codec, or large video under the existing <=8 GiB policy. Metadata-only editing does not wait for full-source hashing.

## Native before/after measurements

Host: 16 GiB Mac. Fixtures: ten-minute 1920x1080 24 fps synthetic H.264 picture (1.9 MB, simple content), ten-minute four-channel 48 kHz PCM recording (220 MB). The selected preview uses source channel 2, whose tone is 990 Hz. Small/simple video content makes its hashing and transcoding results unrepresentative of an hour of camera footage.

Single engineering runs, milliseconds unless stated. These are not percentiles or hardware acceptance results.

| Measurement | Before | After |
|---|---:|---:|
| Lightweight video reference persistence | 1.69 | 1.72 |
| Header inspection | 15.16 | 5.18 |
| Video source registration/hash | 3.92 | 3.87 |
| Four-channel microphone registration/hash | 102.74 | 102.53 |
| First whole-file video preparation | 23.60 s | 23.66 s |
| First selected-channel preparation | 18.80 s | 19.09 s |
| Video FFmpeg process time (within preparation) | 23.591 s | 23.648 s |
| Audio FFmpeg process time (within preparation) | 18.799 s | 19.084 s |
| Warm proxy, queue idle | 0.103 | 0.088 |
| Warm proxy, unrelated queue held for 750 ms | 780.63 | 0.092 |
| Warm audio, queue occupied | 0.086 | 0.072 |
| New registry instance, saved video receipt | 0.607 | 0.743 |
| New registry instance, saved audio receipt | 0.168 | 0.138 |
| Sampled native benchmark summed process-tree RSS peak | 236 MiB | 236 MiB |
| Active FFmpeg transcodes | 1 | 1 |

Before: the cached proxy did not resolve until the controlled queue hold was released. After: both cached picture and sound resolved before release. Deterministic held-queue regressions separately establish the ordering without timing-only sleeps. Ordinary noise in metadata/transcode measurements is not attributed to the change.

The first decoder-ready picture/sound is a separate measurement from obtaining a prepared URI. Isolated packaged alpha.7 baseline produced `canplay` at readyState 4 after 30.71 ms picture and 260.94 ms sound from a cached URI. Exact selected-channel frequency was 990.23 Hz; channel change produced 662.11 Hz (expected 660). Forward/backward media-element seek and new-process reopen passed. Final alpha.8 packaged results are recorded with the candidate's verification receipt.

## Source verification

- Desktop: `pnpm --filter @licketysplit/desktop test:run` — 327 passed, one opt-in skipped. Focused queue/proxy/header checks: 22 passed.
- Core: `pnpm --filter @licketysplit/core test:run` — 1,406 passed, 20 skipped, including original-only export/timing regressions.
- Web: `pnpm --filter @licketysplit/web test:run` — 1,254 passed, seven skipped across 230 files. Focused new/existing preparation components: 42 passed.
- Desktop/core/web typechecks and native main build passed. Integrated focused review and packaged evidence are recorded in the final candidate receipt.

## Evidence and limits

Local reproducible harnesses and raw receipts are under `.superpowers/work/intake-preparation-20261011/`. `benchmark-after-source-proof.json` establishes that the measured bundle is byte-identical to a rebuild of native commit `1dc900d36a49209d05e1bd73b5d93559317cc790`; its run began while that saved change was still uncommitted. Before code was loaded from fixed baseline `8a4077e9cb7915629708c7a55555511f366bb26c`.

The separate alpha.8 candidate uses an unused output directory and a new-profile launcher. Existing artifacts/resource receipts are preserved. Native protocol playback tests use isolated profiles and synthetic originals. Component tests exercise pending/ready/error/retry behavior and stale source/project cancellation. Final commands, counts, package identity, actual intake timings and checksums accompany the candidate receipt.

Physical <=8 GB Apple-silicon acceptance, representative owner-media/full-episode performance, signing/notarization, downloaded installation and human acceptance remain open. An injected 8 GiB resource profile tests policy only. The existing exact-frame paused-seek discrepancy and unverified review-card blur are unchanged open visual gates. A running whole-file transcode or first full-source hash can still delay an uncached foreground source; this change reprioritizes pending work and reuses completed work, without preemption or segmented encoding.
