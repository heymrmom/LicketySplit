# Bounded audio recovery and Podcast intake

This change addresses a bounded decoder short read without treating missing audio as silence. The recorded MIC2 replay returned 55,887 of 55,945 requested samples at 8 kHz. The exact packaged command used two seconds of preroll. The 58-sample deficit was 7.25 ms and 0.103674% of the request; the requested end exceeded the container duration by 7.184 ms. That observation supports an EOF-duration mismatch but does not establish its decoder or resampler mechanism.

## Acceptance boundary

Interior windows require all requested valid samples. A final short window can be accepted only with evidenced natural EOF, decoder draining, resampler flushing, covered start, accounted timestamps, and no decoding or I/O error. Both provisional limits apply: at most 10 ms missing and at most 0.2% of the requested samples. These are trial limits, not audio standards.

The reader retains actual counts and timing receipts. Missing samples do not enter feature extraction as padding; incomplete feature blocks are omitted. Cache identities distinguish the decoder/feature policy, source and channel identity, sample boundaries, actual count, and coverage receipts. Existing cache files are preserved while incompatible semantics invalidate reuse.

The alternate read removes the input-duration cutoff and retains a ten-second output cap, byte cap, and timeout. An EOF marker alone is insufficient: the evidenced output end must precede that cap. Only the final chunk of the final requested window can use the tail exception. Input timestamp quantization is accounted for using the inspected rational time base and cumulative decoded samples from one origin; output timestamps remain sample-contiguous.

An incomplete window receives one bounded alternate decode attempt. The reader does not restart the episode. If the alternate cannot establish coverage, the saved setup identifies the affected source, stream, channel, and sample location. The user can explicitly exclude that recording from automatic alignment, choose another copy for identity revalidation, or save the setup and stop. Explicitly excluded sources remain assigned and visible. Remaining verified sources can proceed through the existing review and approval gates.

## Reuse and UI boundary

The existing intake grouping, fingerprint DSP, candidate matching, graph fitting, local refinement, review, source revision, and approval flow remain the basis of the implementation. The bounded reader and its coverage/cache contract are adapted; the legacy synchronization algorithm is not replaced. `fingerprintBlock` already requires complete FFT windows, and waveform extraction now omits unsupported partial hops.

Recordings imports call the shared project import path and use opaque native original identity for deduplication. Select all and Clear operate on eligible audio/video in that same inventory. Native jobs freeze conflicting controls through cancellation settlement. The visible progress region reports the actual phase, source, phase-specific counts, and elapsed time rather than an overall percentage or estimated finish time.

Before line-up, the dialog presents source names, roles, split order, duration, and unverified status. Saved timing continues to use the existing gap, overlap, and confidence review. Decode failures remain visible until the user makes an explicit recovery choice.

## Evidence and release limits

Local verification evidence and isolated synthetic fixtures are recorded under `.superpowers/work/improvements-20261010/`. The improved candidate uses version `0.1.0-alpha.3` and the separate `apps/desktop/release-improvements-alpha3/` output directory. Prior candidate resources and source receipts are preserved and checked separately.

The full desktop suite passed 296 tests; the opt-in full-hour benchmark was deliberately skipped. The relevant web suite passed 71 tests, and the core and project-serialization suite passed 59 tests. Core, web, and desktop typechecks passed. Native fixtures include a 44.1 kHz PCM tail read after a 12.755-second seek (39,960/40,000 valid samples), a 48 kHz shifted AAC exact window after a one-second seek, and rejection of a shortfall in a non-final internal chunk even when that chunk alone meets the trial caps. The existing bounded late-read fixture also verifies a ten-second request far into a 600-second synthetic source.

The actual React dialog and application CSS were exercised with a mocked native bridge at 1080×720 and 1440×940. Screenshots and assertions cover keyboard selection, mixed selection, pre-lineup inventory, visible elapsed progress, cancellation pending, failure recovery, and saved timing review. These fixtures cannot establish real media playback or native bridge behavior; the packaged smoke test is recorded separately.

Unit and isolated native tests, actual-component UI screenshots, and an unsigned local package are separate proof levels. They do not establish real 8 GB hardware acceptance, owner-media episode acceptance, paid-provider acceptance, signing/notarization, downloaded-install verification, or human acceptance. The owner app and profiles are not fixtures, the monitor remains paused, and XML output is outside this change.
