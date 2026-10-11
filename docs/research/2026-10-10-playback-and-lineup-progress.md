# Playback reliability and whole-lineup progress

Approved bounded follow-up to alpha.4. Proxy preparation during intake, automatic prewarming, and early disk-cached video/microphone preparation are explicitly deferred. The existing original/proxy eligibility policy remains unchanged.

## Diagnosis and scope

Warm owner-app playback and seeking advanced the clock and changed picture during read-only observation. Intermittent cold stalls and audio continuity were not established by that observation. A synthetic native-preparation failure exposed a concrete recovery hole: a rejected URI preparation left the per-item runtime cached and not ready, so resolution continued returning no media Blob. This change adds explicit recovery and visible preparation/error state. Synthetic media and isolated editor evidence are engineering checks; they do not establish full-episode owner-media performance.

Review playback now distinguishes starting, buffering, ready, stopped, and failed attempts. A stale or canceled play promise must not restart playback. Camera fallback precedes the coverage overview. Existing supported timing controls remain the correction authority; the interface distinguishes constant offset, changing drift/sections, insufficient evidence, and measured disagreement without inventing a repair or relaxing the 5 ms target.

## Work ledger

The backend plans stable, equal-weight units: per-recording inspection, sound features, independent validation and optional region work; per-pair matching; and a final persistence unit. This is completed planned work, not an estimate of elapsed time. Adaptive checks remain inside their original validation/region parent units, so discovering more checkpoints cannot reset the whole-job denominator. Feature progress uses actual channel/sample counts. Cache reuse, skipped work, failed work and canceled work remain distinct. Optional stages that never execute are skipped, not claimed as analyzed. Successful final persistence is required before 100 percent.

Structured item IDs and asset IDs drive the clip-by-stage dashboard. A recording's stage aggregates all relevant child work (including multiple comparisons); one finished comparison cannot mark its entire stage complete. Legacy progress without a ledger remains indeterminate. Final canceled/error snapshots retain their remaining work instead of implying success.

## Review provenance

Human acceptance remains separate from automatic evidence. New review records include the reviewed revision and an equality key over the source identity/digest, source bounds, recording/section mapping and bounds, and reference source identity/digest/mapping. Mapping or source/reference changes invalidate the current label. Unrelated later revisions such as locking preserve the original reviewed revision. Legacy unbound notes remain visible as prior notes; they do not acquire new scoped provenance. These keys are equality checks, not cryptographic approval; native approval remains authoritative.

The owner alpha.4 snapshot used for diagnosis contained 77 passing, 74 fitting-overlap, 54 unverified and 2 failed checks. The latter were 7.125 and 8.125 ms. Weak/ambiguous sound is not a measured error, and reusing fitting observations is not independent validation. No threshold or automatic classifier has been retrained from subjective acceptance.

## Verification boundaries

Regression tests cover retry recovery, keyboard seeks, pending/rejected/canceled review playback, fixed monotonic work accounting, native persistence before 100 percent, cancellation, reference changes, and scoped review labels. Isolated actual-component fixtures cover both required viewport sizes. Final candidate receipts record the exact source and separate media-helper, mounted-editor and packaged-native evidence. Owner full-episode, real 8 GB, provider, signed/notarized/downloaded-installation and human acceptance remain separate gates.
