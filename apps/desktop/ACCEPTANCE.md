# LicketySplit desktop acceptance

Engineering checks, synthetic normal-UI proof, physical-device acceptance, provider quality and signed/downloaded installation are separate gates. The first candidate targets Apple silicon, macOS14+,8GiB, under its own LicketySplit profile. A16GiB host or a memory-capped VM does not establish physical8GiB acceptance.

## Reproducible fixture and measured budgets

For a general export-shape fixture, `node scripts/verify-desktop-fixture.mjs --generate <evidence-directory> --ffmpeg <pinned-arm64-ffmpeg> --seconds 3600` creates three 4K H.264 camera files and two 48 kHz microphones with known signal events. This checks deterministic media/export properties; its repeated tone and event impulses do **not** prove long-offset synchronization or drift recovery.

Use the separate [full-hour nonperiodic sync fixture](../../scripts/takeover-verification/generate-full-hour.mjs) for long-offset and drift checks. It creates 3,602 seconds of synthetic camera/mic sources with aperiodic signals, camera and mic drift, split originals, a 35-second source start, overlap, gap, rotation, a stereo decoy channel, and measurement points through the hour. Reproduce the native and compact comparisons using the commands in the [full-hour benchmark report](../../.superpowers/work/takeover/verification/full-hour-benchmark-report.md). The report records the measured results and limits: synthetic continuous noise is not speech, the benchmark is not a normal-UI walkthrough, and it does not establish human acceptance.

For full workflow acceptance, build an editable project from the fixture with actual current camera cuts, static/ordinary keyframed effects and a title overlay. Record source hashes and actual codecs/rates; test missing originals and exact relink. Add expected retained source-word IDs and rendered dimensions/rate/channel count/duration to the fixture manifest for each selected render.

Run `python3 scripts/verify-desktop-memory.py --pid <app-main-pid> --output <evidence-directory> --duration 60`. It reads process-tree RSS once per second and queries memory pressure without changing it. Summed RSS may double-count shared pages; GPU/unified memory ownership is qualified. Actual8GiB acceptance requires sampled tree RSS≤3GiB, warm ready-preview seek p95≤500ms,≥90% delivered frames for sources≤30fps, UI cancel acknowledgement≤2s and worker exit≤5s. Cold preparation timing is reported separately from warm reopening/playback; required proxies and the queue must be ready before measuring warm editing.

Validate an actual original-quality render with `node scripts/verify-desktop-fixture.mjs --manifest <fixture.json> --export <video> --project <saved-draft.licketysplit> --ffmpeg <pinned-arm64-ffmpeg> --out <receipt.json>`. Proxy-resolution output fails resolution verification. Compare beginning/middle/end sync, camera cuts, word retention, titles/effects and picture/audio correspondence. A short segment does not establish full-hour export timing. Inspect the saved original/draft and undo/redo with the normal UI. Human listening/story review remains separate.

## Provider and installation gates

Use intercepted/cached synthetic provider responses by default; never spend AssemblyAI/editorial tokens without explicit paid acceptance authorization. A structurally valid transcript/proposal or successful HTTP connection does not establish transcription/story/publishing quality. Validate channel names, word timing, retained speech, pauses, hooks and factual copy with the owner before publication.

Unsigned/ad-hoc ARM64 archives are test packages. Release readiness requires the owner's DeveloperID signing identity and notarization credentials in GitHub secrets, successful codesign/notary/stapler/spctl checks, actual8GiB evidence, downloaded matching checksums and normal launch/reopen without developer tooling. Preserve the installed legacy app/profile/projects/credentials. Keep draft releases draft and update feeds disabled; public promotion and shared-branch merge require their own explicit authorization.

Current host prerequisites are known to be missing at implementation: actual8GiB hardware; paid provider/editorial quality authorization; a valid local DeveloperID identity and repository signing/notarization secrets; signed downloaded-install proof. Complete the remaining engineering and retain exact evidence rather than marking these gates passed.


A committed source receipt is embedded as `Contents/Resources/BUILD_SOURCE.json`.
Run `node apps/desktop/scripts/write-source-receipt.mjs` from a clean committed
checkout before packaging. The package verifier rejects a candidate whose
embedded source differs from the checked commit.

Signing remains an explicit next stage: a Developer ID Application identity,
its matching Apple Team ID, notarization credentials and a stapled ticket must
be supplied in a protected build environment. The unsigned build workflow does
not request them or publish assets. Preserve the unsigned candidate as separate
engineering evidence. After signing, verify every nested executable's signature,
`codesign --verify --deep --strict`, `xcrun stapler validate`, and `spctl --assess`
on the resulting app. Signing changes executable hashes: generate a fresh signed
manifest from the verified artifact, including `signing: signed-notarized` and
`teamId`; never relabel the unsigned manifest.

Before creating even a draft release, run
`node apps/desktop/scripts/release-gates.mjs signed-manifest.json acceptance.json`.
The acceptance document must match the source commit and final package digest,
identify a physical8GiB ARM64 machine, and record completed normal workflows and
fresh-download Gatekeeper acceptance. Missing evidence blocks draft creation.
After those prerequisites, attach the matching DMG, ZIP, manifest, checksums and
third-party notices to a **draft** GitHub release targeting that exact commit.
Publishing remains a separate user action.

## Native import reference follow-up

Desktop disk-file intake reads basic metadata directly from the selected original.
It does not automatically transcode the import or copy video/audio bytes into
IndexedDB. Pending references contain no verified digest; identity is calculated
when a demanded proxy, analysis or export needs it. Original disks and paths must
remain available; missing or changed sources require relinking. Generated media
without a real source path is streamed in bounded chunks to managed disk storage.
Images retain reference-only persistence and hydrate image bytes when needed.

Basic media entries appear before optional thumbnails. Automatic preview
preparation is retained for selected/current clips; unused library recordings
are deferred. Unsupported codecs require a preview proxy even below540p.
General waveform/sync scheduling and batch format-conversion UI are separate
proposals, not part of this follow-up. Import conversion still requires separate
user approval. Existing source copies, databases and installed apps are preserved.
