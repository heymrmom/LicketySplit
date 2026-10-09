# Synthetic full-hour native and compact benchmark

The native legacy pipeline and the existing compact drift worker were exercised against the same deterministic synthetic originals. All eight source IDs and SHA-256 digests matched between the manifest, managed registry, native setup, and compact run. The fixture contains three 4K/25fps camera identities split across six originals, two participant microphones, 120 ppm and -80 ppm camera drift, 40 ppm mic drift, a 35-second start, a one-second overlap, a 10.144-second gap, and a 90-degree rotated camera segment.

The audio is continuous low-pass aperiodic synthetic noise, not speech. It tests synchronization and drift recovery, not speaker-driven cuts. The separate [alternating activity fixture](../../.superpowers/work/takeover/verification/full-hour-20261009/challenges/alternating-activity/manifest.json) is available for later planner checks; it was not part of these timing benchmarks. No owner footage, provider calls, normal-UI walkthrough, or human acceptance was involved.

## Measured runs

| Run | Receipt elapsed* | Reuse / output | Sampled peak process RSS |
|---|---:|---|---:|
| Native first analysis | 214.319 s (`elapsedSeconds`: inspect + revision + analysis) | 0 cache hits, 9 misses; 128.1 s feature decode; 7 measured placements plus Alice reference | 380.3 MB |
| Native corrected binding revision | 28.295 s (`packetScanAndReanalysisSeconds`; excludes 0.023 s revision) | 9 hits, 0 misses, 0 feature-decode seconds; all 9 feature keys unchanged; all eight placements unchanged exactly | 466.8 MB |
| Native warm pipeline reopen | 32.130 s (`pipelineSeconds`; excludes 0.013 s setup load) | 9 hits, 0 misses, 0 feature-decode seconds; same placement truth errors | 488.5 MB |
| Existing compact worker, first pass | 71.155 s (`decodeSeconds + analysisSeconds`) | 70.829 s bounded decode, 0.326 s drift analysis | 316.5 MB |
| Existing compact worker, repeat pass | 66.376 s (`decodeSeconds + analysisSeconds`) | 66.035 s bounded decode, 0.342 s drift analysis; model outputs bit-for-bit identical to first pass | 328.8 MB |

*Receipt elapsed values time the named service/pipeline stages, not Vitest startup and shutdown. Vitest reported overall durations of 216.845 s for native first analysis, 28.76 s corrected, 32.68 s native warm, 71.70 s compact first pass, and 66.90 s compact repeat.

The native first pass wrote 18 feature/waveform JSON files totaling 59,830,435 bytes; the largest was 6,525,425 bytes. Native first analysis requested 6,525 audio windows, capped each request and FFmpeg input decode at 10 seconds, emitted at most 256,000 bytes, and ran one FFmpeg child at a time. The corrected and warm native review passes requested 900 bounded windows (largest request 6.12 seconds; largest input decode 8.12 seconds).

Compact mode retained eight full 1 kHz source arrays while comparing them, then read Bob channel 0 separately; the eight primary arrays alone occupy 71,861,280 bytes (71.9 MB), calculated from the manifest durations with the harness’s floor(duration × 1,000) Float32 allocation. Across both compact passes, the reader stayed within 10-second windows, 32,000-byte output, and one FFmpeg child. RSS values are sampled every 750 ms, not a continuous memory trace. “First” and “repeat” describe this sequence: the OS file cache was not flushed, so these are not cold-storage measurements. Compact has no application-level analysis cache.

The initial native cold run was retained as the requested profiling pass, but its temporary group setup assigned Bob’s independent stereo decoy channel to Bob. The controlled native revision maps only channel 0 to Bob and leaves channel 1 usable but unassigned. Its [receipt](../../.superpowers/work/takeover/verification/full-hour-20261009/benchmark/native-corrected-warm.json) is authoritative for participant mapping: it verifies unchanged registered source IDs and manifest hashes, all nine unchanged feature keys, and exact offset/scale/status equality for all eight placements. Thus the first run’s source fingerprint and timing measurements remain useful, while its participant assignment is not treated as accepted setup.

## Accuracy and behavioral limits

Native timing error stayed below 0.042 ms at the sampled ground-truth points; maximum drift error was 0.035 ppm. Correcting the participant binding did not alter any placement.

The compact harness calls the existing worker’s exported `analyzeMulticamDrift` function directly with the production settings: 5-second blocks, 300-second interval, 400 Hz analysis, and a maximum offset of 30 seconds. Its full-source reader follows the compact 1 kHz array path, but this is an algorithm comparison, not a full panel execution. The current panel uses the worker for camera angles and does not use participant microphones as a reference. It also calls the reader without a source-channel selector, so its stereo path downmixes to mono.

It recovered the zero-offset camera and Bob timing; it could not recover segments starting around 1,799–1,835 seconds or the 35-second camera start under that search limit. Those cases remained unresolved against ground truth. Bob’s normal compact downmix found his offset within 0.051 ms; explicitly selecting channel 0 improved it to 0.000071 ms error and raised confidence from 0.342 to 0.469. These mic comparisons are algorithm-level diagnostics rather than existing panel behavior.

On the repeated-content challenge, the native matcher marked the competing offset ambiguous; the compact worker returned confidence 0.99965 at an arbitrary -23-second offset and has no ambiguity status. Both methods left silence unresolved and unrelated aperiodic audio low-confidence/unmatched. This is an observed review-safety difference, not a forced compact success.

## Default-path decision

Keep the reused native path as the podcast default. Its persisted feature cache materially reduces subsequent preparation while preserving all tested split-source placements. The compact worker is faster on its first pass but fails five required late/split-source cases under its existing search limit and can express high confidence in an ambiguous repeated-content offset. Those measurements do not justify offering it as a trustworthy faster podcast mode. No new fast/accurate toggle is added merely to expose an unsafe alternative. Manual placement and visible review remain available; the existing compact workflow remains available in its original editor context.

## Reproduction and files

The harness lives at [full-hour-benchmark.test.ts](../../apps/desktop/src/main/lickety/podcast/verification/full-hour-benchmark.test.ts), with the sequential fresh-fixture runner at [run-full-hour-benchmark.sh](../../scripts/takeover-verification/run-full-hour-benchmark.sh). Use Node 22 and pnpm (or set `TAKEOVER_PNPM` to an executable using Node 22 for the sequential runner). Run one mode with absolute paths:

```bash
TAKEOVER_HOUR_FIXTURE="/absolute/path/to/full-hour-20261009" \
TAKEOVER_HOUR_FFMPEG="/absolute/path/to/apps/desktop/resources/bin/darwin-arm64/ffmpeg" \
TAKEOVER_HOUR_MODE="native-corrected" \
  pnpm --filter @openreel/desktop exec vitest run \
  src/main/lickety/podcast/verification/full-hour-benchmark.test.ts --reporter=verbose
```

The manifests and machine-readable receipts are in the local ignored `.superpowers/work/takeover/verification/full-hour-20261009/` evidence directory: `manifest.json`, `challenges/manifest.json`, and `benchmark/{native-cold,native-corrected-warm,native-warm,compact-cold,compact-warm}.json`. Synthetic generation scripts are [generate-full-hour.mjs](../../scripts/takeover-verification/generate-full-hour.mjs) and [generate-correlation-challenges.mjs](../../scripts/takeover-verification/generate-correlation-challenges.mjs).

Verification passed: desktop TypeScript check; all 11 `podcast/service.test.ts` tests; and all five full-hour benchmark modes. Whole-hour interactive editor/render proof remains separate.

## Per-original timing errors on warm reopen

These are synthetic affine mapping errors sampled at source start, 0.5 seconds, quarter, middle and half a second before the source end. Split-file starts and ends therefore bracket the known camera boundaries; they do not substitute for rendered picture/audio inspection.

| Original | Expected episode offset (s) | Start error (ms) | Middle error (ms) | Near-end error (ms) | Maximum absolute error (ms) | Drift error (ppm) |
|---|---:|---:|---:|---:|---:|---:|
| cam-a-1 | 0.000000 | -0.001618 | -0.003594 | -0.005569 | 0.005569 | -0.002196 |
| cam-a-2 | 1799.000000 | 0.016708 | -0.000104 | -0.016907 | 0.016907 | -0.018649 |
| cam-b-1 | 35.000000 | 0.018803 | 0.014669 | 0.010538 | 0.018803 | -0.004593 |
| cam-b-2 | 1835.216000 | 0.028374 | 0.019645 | 0.010921 | 0.028374 | -0.009882 |
| cam-c-1 | 0.000000 | -0.003071 | 0.019400 | 0.041859 | 0.041859 | 0.024968 |
| cam-c-2 | 1810.000000 | -0.028751 | 0.001829 | 0.032393 | 0.032393 | 0.034127 |
| mic-alice | 0.000000 | 0.000000 | 0.000000 | 0.000000 | 0.000000 | 0.000000 |
| mic-bob | 0.250000 | 0.016983 | 0.009819 | 0.002658 | 0.016983 | -0.003978 |
