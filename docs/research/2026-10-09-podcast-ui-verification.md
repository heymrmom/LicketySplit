# Podcast desktop workflow verification

This is engineering evidence on the synthetic full-hour fixture, using an isolated Electron profile on the available 16 GiB ARM64 Mac. It is not owner-footage, physical 8 GiB, provider, downloaded-install, or human listening acceptance. The running development build for this checkpoint includes UI commit `8379262`; branding and final package verification are separate subsequent steps.

## Normal application path

The test started with ordinary Blank → Horizontal creation and imported eight original files through the renderer's native file input. Existing imported media was inspected from Podcast setup. Controls confirmed three physical camera groups, Camera A as the wide view, Alice and Bob participants, and Bob's channel 0 as program dialogue while the independent channel 1 remained unassigned. Alignment used the ported legacy native pipeline. Camera B's second original received a manual offset of 1835.216 seconds, scale 1.00012, a review note, and explicit acceptance. Closing and resuming setup retained that reviewed timing and note.

Explicit **Keep picture gaps** enabled **Create timeline**. The actual control created a native assembly spanning 3602.0279950710697 seconds. Its saved representation has eight original media references, three physical camera angles, six camera-original source rows, two dialogue rows, and one program picture row. Source rows remain hidden and scratch sound muted; they are not six separate physical camera angles. The program picture initially uses the confirmed wide camera and retains original segment references.

One Undo removed the assembly, and Redo restored it. Normal Save wrote the project, then File → Open restored that saved assembly after Undo had removed the live version. Only the native picker selection was stubbed to the isolated fixture's `Horizontal.oreel` path; application menu dispatch, serialization, file write/read, and renderer restoration were real. The main window had to be focused because native menu dispatch targets `BrowserWindow.getFocusedWindow()`. No project data was injected to claim this result. The owner's similarly named project was not read or modified.

The reopened editor displayed the synthetic purple camera picture and retained the hour-long duration and Used on timeline indicators. This confirms visible picture restoration, not human listening quality. A subsequent normal review check selected Bob channel 0 and jumped to the Camera B beginning at episode 35 seconds. The selected audio was readyState 4, unmuted, and advanced from 34.748612 to 37.255746 file-relative seconds at rate 0.9999600055774138 while muted camera picture advanced from 0 to 2.489689 seconds. Stop paused both elements. A temporary captureStream analyser, without changing device or output-volume settings, observed one decoded audio track with RMS 0.2060469833 and peak 0.7124947906 across 24576 samples; the capture tracks/context were disposed. This proves nonzero decoded output from the selected derivative and running shared-clock behavior, not human lip-sync acceptance. Boundary/cut/relink/export checks remain for the integrated candidate.

## Routed microphone Auto Edit

The normal **Auto Edit** control recognized the grouped podcast and analyzed routed original microphones on the episode clock. Direct camera resynchronization was disabled for this group, preserving onboarding timing authority. It created 524 planned shots materialized as 525 native program clips, saved through the ordinary Save command. All program source bounds were valid. At the Camera A original boundary, the first file ended at source 1800 seconds; the next program piece started at approximately source 0.999978 seconds of the second file, correctly respecting the confirmed one-second overlap and original order.

Only Camera A was confirmed as a view in this particular UI fixture; Camera B/C participant framing remained explicitly unknown. Therefore the planner used the known wide view, with both original Camera A segments. The continuous-noise fixture exercises the routing/materialization path; its activity labels and shot count are not evidence of real-speech editorial quality or participant-camera identification.

One Undo returned the program to its original two clips; Redo restored all 525. Both states retained nine tracks, three physical angles, and two microphone clips. Each state was saved/read back to verify coherent application. A 60-second process sample window begun after the Auto Edit trigger observed a combined main/descendant RSS peak of 1,151,776 KiB. It spans completion/warm editing and is not a complete cold-job trace or an 8 GiB hardware acceptance result.

## Full Extent Zoom and shortcut UI

The existing reopened hour project was resized with the test application's own window API. Actual Full Extent Zoom and vertical scrolling produced:

| Window content size | Track viewport width | Fitted content width | Track viewport height | Track content height | Bottom scroll position |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1440 × 940 | 1260 px | 1260 px | 209 px | 594 px | 385 px |
| 1080 × 720 | 962 px | 962 px | 200 px | 594 px | 394 px |

Both microphone rows and the program row are reachable by vertical scrolling. Track headers follow the same scroll offset; editing controls remain above the tracks. At 1080 × 720, Cmd+0 restored the prior 180101 px detail extent and horizontal position 1730 px; a second Cmd+0 returned to the 962 px overview at scroll position zero. Resizing while fitted recomputed the width.

The normal Keyboard Shortcuts control opened the mounted help dialog. Searching the **Resolve 21.1 comparison** view for J/K/L returned the unsupported transport row and the Space playback comparison. Typing Space in the search field inserted a space rather than triggering playback. The help reflects the isolated profile's active default keymap; it does not claim to inspect the owner's Resolve or editor customizations. See [the full comparison](../resolve-shortcut-comparison.md) for verified manual references and supported differences.

Visual review identified wrapped Used on timeline text overlapping another badge and excessively narrow two-column media cards at 1080 px. Those fixes belong to the final branding/UI pass; the screenshots here are intentionally prebranding evidence.

## Local receipts

Ignored evidence directory: `.superpowers/work/takeover/verification/normal-ui-1791576272789/`.

- `project-reopened-from-disk.png`, `timeline-created.png`, `timeline-undone.png`, `timeline-redone.png` and the saved fixture project.
- `full-extent-metrics.json`; top/bottom screenshots for both requested sizes.
- `shortcuts-ui-receipt.json` and `shortcuts-resolve-search.png`.
- `selected-bob-audio-runtime.json`, `selected-bob-audio-runtime.png`, and `selected-bob-audio-signal.json`.
- `autoedit-saved-receipt.json`, `autoedit-undo-redo-receipt.json`, `autoedit-process-samples.json`, and before/after screenshots.
- Setup, manual review, and restart screenshots from the same isolated profile.

These receipts identify a development checkpoint, not the final source-matched installer. Final candidate evidence must add new-origin migration, branded assets, bounded decoders, selected-mic playback, split-boundary cuts/relink/export, replacement MCP shim, and embedded source receipt/checksums.


## Actual origin migration checkpoint

The development build at `540e9fd` ran the new primary origin `app://licketysplit` with a restricted, hidden top-level `app://openreel` reader and native MessagePorts. An earlier iframe experiment saw partitioned empty storage and incorrectly recorded v1 completion; the corrected v2 implementation disregards that marker. The failed experiment remains in the local evidence rather than being counted as success.

On the existing synthetic hour profile, read-only top-level inventories verified all five legacy databases remained intact. The destination retained eight media records, three autosaves, one activity artifact, matching database schemas, and exact hashes for all three stored preferences. This checkpoint copies data across origins; the subsequent v3 namespace migration must still verify new database/key names and consumers.

A second isolated profile tested values that JSON migration would lose: a 2 MiB Blob with matching SHA-256, a usable nonextractable AES-GCM CryptoKey, typed array, Date, Map, and a unique IndexedDB index. Existing destination values won conflicts. The encrypted browser vault still decrypted its synthetic secret using its retained legacy verifier. The native protected-key file was copied byte-for-byte with mode 0600 and remained usable; its source was unchanged. Custom shortcut bindings and preset values were retained for the later namespace upgrade.

A real origin-bound OPFS file handle could not cross origins. The application correctly displayed an incomplete migration, offered Retry or Continue, and did not write v2 completion. Normal Continue persisted the warning across reload. Reload closed an in-flight hidden reader (two windows became one). After explicit synthetic fixture setup supplied a destination handle, normal Retry completed, the reader closed, and the original old-origin handle still read its original contents. This verifies incomplete/retry/cleanup behavior; supplying that fixture handle is not normal media-bin relinking or owner-file acceptance.

Receipts: `verification/migration-retry-1791580636727/top-level-migration-inventory.json` and `verification/migration-retry-1791580656143/rich-migration-{readback,recovery}.json`, relative to the ignored takeover evidence directory. The rich fixture screenshots were visually inspected. Final branding, v3 namespace migration, saved-project hydration, and packaged behavior remain separate checks.
