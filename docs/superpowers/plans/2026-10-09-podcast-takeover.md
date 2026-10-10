# Podcast takeover integration plan

Authoritative scope: October 9 implementation takeover. Design: `../specs/2026-10-09-podcast-native-adapters.md`. Reuse decisions: `../../research/2026-10-09-legacy-podcast-reuse.md`. Existing October 8 foundations remain in place except where the new handoff explicitly supersedes them.

## Execution order and ownership

1. Native port: reuse legacy grouping, DSP/graph, source revision, manual review and checksummed cache modules behind registered-source, bounded-reader and current-resource adapters. Publish shared portable types first. Regression checks cover legacy parity, channel selection, unresolved evidence, identity/cache validity, cancellation and recovery.
2. Timeline/shortcuts independently: extend current zoom store for hour-long overview/detail restore and actual scrollport dimensions, keep tracks accessible, verify advertised handlers/focus and document installed Resolve 21.1 comparison. Preserve storage keys until identity migration.
3. Grouped native edit integration: create source/microphone tracks and physical camera groups in one undo action; split materialized camera edits at original boundaries; use program microphones for speaker activity. Preserve affine source timing through playback/export/transcription/Narrative, save/reopen/relink and MCP readers. Add timeline-use badges from live references.
4. Optional setup UI: adapt legacy choose/recordings/setup/line-up/check transitions into the current shell; no forced wizard. Reuse imported media; persist draft and explicit mappings; visible shared-playhead review; cancel/back/resume/manual path; explicit Create timeline. No paid calls.
5. Serialized brand/storage migration and delivery: reuse original mark/icon and purple accents, rename maintained namespaces only after feature edits finish, migrate old renderer-origin storage before normal initialization, preserve credentials and registry. Verify final UI/synthetic hour fixtures and resource behavior, run integrated checks, commit/push draft PR, build separate ARM64 package with clean-source receipt and checksums.

## Integration acceptance cases

- Three physical cameras containing multiple out-of-order files and two microphones remain three angles. A late source beyond 30 seconds, gaps, overlaps, rotation and known drift produce original-source in/out points through the complete hour. Unmatched recordings remain unresolved until deliberate placement; gaps never erase dialogue.
- Reused analysis versus compact engine use identical fixture signals; report measured wall time, confidence, error in milliseconds/frames and end-of-hour drift. Do not expose a claimed faster verified mode without evidence.
- Create timeline is atomic undo/redo and saved; ordinary edits, reopened references, relink and current-timeline Narrative preserve timing and source identity. Muted/hidden source clips still count in media-use indicators.
- Optional skip/manual editing, cancellation and resumed setup work through normal UI. Review beginning/middle/end and every segment boundary in a fresh profile. MCP handshake/readers use the actual replacement client/shim.
- Fit tests cover empty, short, hour-long, gaps/late overlays and many tracks at 1080×720 and 1440×940. Fit responds to resize/panels; detail restore preserves playhead/selection.
- Migration tests seed old-origin IndexedDB/localStorage/custom shortcuts and encrypted native key metadata, then verify new access without deleting old data. Residual legacy identifiers remain isolated compatibility/license exceptions with exact accounting.

## Evidence boundaries

A synthetic engineering pass is not owner footage acceptance. The host is 16 GiB ARM64; physical 8 GiB, paid-provider quality, signing/notarization and downloaded-install/human acceptance remain separately open. Do not alter or launch the owner's app/project, installed legacy app/profile, live deployment, repository visibility, signing secrets or public release. Fresh test profiles and separate local packages are authorized. ClickUp remains the only commitment/progress ledger.
