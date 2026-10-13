# Guided podcast review and auxiliary-image timing

The owner requested a beginner-facing sequence from recorded-source review to an editable timeline, retaining the existing camera playback and intake design. The approved flow is Review recordings, Check coverage, then Finish. Line-up also receives a subtle accessible progress bar: determinate for actual phase counts, indeterminate when no valid total is available; no overall percentage or ETA is inferred.

## Observed failure and intended boundary

Metadata-only inspection of one relevant DJI source found timed HEVC camera footage at stream 0 (3840×2160, 15,985 frames) and an MJPEG attached picture at stream 5 (`disposition.attached_pic=1`). The prior inspector classified every `codec_type=video` stream as episode footage. Its stream-5 packet warning became a hard synchronization approval blocker even though the assembly selected the first genuine video stream.

Auxiliary classification must rely on positive stream-disposition evidence, never filenames, codec alone, stream number, or a blanket waiver. Saved setups need source-identity verification and metadata revalidation before an old auxiliary-stream warning can be removed. Genuine media timing warnings, unresolved placement, recorder constraints, source mappings, locks, review notes, and completed analysis remain authoritative. An attached picture diagnosis for one source does not establish the health of every camera file.

## Review behavior

Present one role/part at a time with playback, useful checkpoints, plain-language issue, and the available decision together. Lock means protected from edits, not accepted; unlocking remains explicit. Human acceptance records an explicit review and does not rewrite automatic evidence. Unsupported timing has no generic approval bypass.

Coverage summaries distinguish confirmed gaps/overlaps from unknown spans containing unresolved recordings. Tiny seam measurements can be grouped for display without altering mappings or precision thresholds. Camera fallback is a coverage decision. Finish summarizes included and excluded recordings and remaining blockers before invoking the existing revision-checked approval/materialization path.

## Reuse and verification boundary

Reuse the existing native update, approval, mapping digest, undo, media preview, and assembly pathways. This change is a presentation and source-classification correction, not a replacement sync engine. Relevant tests, actual-component viewport checks, package provenance, and synthetic packaged smoke receipts are retained under `.superpowers/work/guided-review-20261010/`.

The owner requested a fresh start after delivery; this work does not save, reset, delete, or exercise the current owner session. Packaging goes to a separate alpha.4 folder with a new-profile launcher. Owner media/full-episode, real 8 GB hardware, provider, signing/notarization, downloaded installation, and human acceptance remain separate gates. The monitor remains paused.
