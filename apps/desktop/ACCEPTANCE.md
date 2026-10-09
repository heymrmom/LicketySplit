# LicketySplit desktop acceptance

Engineering checks, synthetic normal-UI proof, physical-device acceptance, provider quality and signed/downloaded installation are separate gates. The first candidate targets Apple silicon, macOS14+,8GiB, under its own LicketySplit profile. A16GiB host or a memory-capped VM does not establish physical8GiB acceptance.

## Reproducible fixture and measured budgets

Generate public synthetic media with `node scripts/verify-desktop-fixture.mjs --generate <evidence-directory> --ffmpeg <pinned-arm64-ffmpeg> --seconds 3600`. The generator creates three4K H.264 cameras at25,30000/1001 and24000/1001 fps, two isolated48kHz microphones, and known beginning/middle/end impulses. Use an editable project with actual current camera cuts, static/ordinary keyframed effects and a title overlay. Record source hashes and actual codecs/rates; test missing originals and exact relink. Add expected retained source-word IDs and rendered dimensions/rate/channel count/duration to fixture.json for each selected render.

Run `python3 scripts/verify-desktop-memory.py --pid <app-main-pid> --output <evidence-directory> --duration 60`. It reads process-tree RSS once per second and queries memory pressure without changing it. Summed RSS may double-count shared pages; GPU/unified memory ownership is qualified. Actual8GiB acceptance requires sampled tree RSS≤3GiB, warm ready-preview seek p95≤500ms,≥90% delivered frames for sources≤30fps, UI cancel acknowledgement≤2s and worker exit≤5s. Cold preparation timing is reported separately from warm reopening/playback; required proxies and the queue must be ready before measuring warm editing.

Validate an actual original-quality render with `node scripts/verify-desktop-fixture.mjs --manifest <fixture.json> --export <video> --project <saved-draft.oreel> --ffmpeg <pinned-arm64-ffmpeg> --out <receipt.json>`. Proxy-resolution output fails resolution verification. Compare beginning/middle/end sync, camera cuts, word retention, titles/effects and picture/audio correspondence. A short segment does not establish full-hour export timing. Inspect the saved original/draft and undo/redo with the normal UI. Human listening/story review remains separate.

## Provider and installation gates

Use intercepted/cached synthetic provider responses by default; never spend AssemblyAI/editorial tokens without explicit paid acceptance authorization. A structurally valid transcript/proposal or successful HTTP connection does not establish transcription/story/publishing quality. Validate channel names, word timing, retained speech, pauses, hooks and factual copy with the owner before publication.

Unsigned/ad-hoc ARM64 archives are test packages. Release readiness requires the owner's DeveloperID signing identity and notarization credentials in GitHub secrets, successful codesign/notary/stapler/spctl checks, actual8GiB evidence, downloaded matching checksums and normal launch/reopen without developer tooling. Preserve the installed legacy app/profile/projects/credentials. Keep draft releases draft and update feeds disabled; public promotion and shared-branch merge require their own explicit authorization.

Current host prerequisites are known to be missing at implementation: actual8GiB hardware; paid provider/editorial quality authorization; a valid local DeveloperID identity and repository signing/notarization secrets; signed downloaded-install proof. Complete the remaining engineering and retain exact evidence rather than marking these gates passed.
