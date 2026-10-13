# Native podcast preparation adapters

Authority: the October 9 takeover prompt supersedes the October 8 exclusions of legacy setup/review and the earlier requirement to retain first-party inherited namespaces. This document describes implementation contracts, not a separate commitment ledger. ClickUp task 86e3n70p1 remains the work record.

## Reuse boundary

The established intake → setup → line-up → check flow is adapted into the existing editor. Legacy physical grouping, ordered source membership, channel assignments, graph alignment, drift decisions, revision-bound review, manual correction and completed-work caching remain the behavioral source. The accompanying reuse inventory identifies exact functions and baseline fixtures before product porting. XML builders, monetary ledger, legacy app shell/profile and raw-media Narrative are excluded.

Legacy main-process inspection and full-file native decoder bindings cannot run in the renderer or bypass the current resource scheduler. Their adapters resolve registered original media IDs, use the existing native inspector and bounded audio reader, persist analysis privately, and expose portable evidence. There is no guessed verified placement, automatic participant identity, or import transcoding.

## Episode-clock model

A physical camera owns an ordered list of original-source segment references. Each segment has an original media ID, native timeline clip ID, source interval and affine mapping: episode time = source time × scale + offset. Native clip speed is the reciprocal of mapping scale. Overlap lanes remain implementation tracks under one camera identity. Program microphones are independent dialogue sources mapped explicitly to participants or a shared conversation. Camera scratch audio stays muted by default.

Sync review and analysis retain the legacy raw packet-PTS coordinate system to preserve graph evidence, proposals, manual corrections and round-trip parity. `PodcastAsset.containerStartSeconds` explicitly identifies the file/container presentation origin. Native decoder seeks and clip in/out use file-relative time: native source time = raw source PTS − source container origin. At materialization, convert mapping offset to the reference-file basis with `rawOffset + scale × sourceContainerStart − referenceContainerStart`, then apply the one shared nonnegative episode shift. Use each stream's actual presented bounds; audio that starts after video must leave the corresponding silence gap. A stream start is not a substitute for the container origin. Standalone positive-origin and mixed video-zero/audio-late fixtures must verify nonzero seeks, picture/audio correspondence and source boundaries before this adapter is accepted.

CameraAngle gains optional segment membership; old single-clip projects preserve their path. Group duration is the episode extent including dialogue, not the shortest chunk. Materialized cuts intersect selected camera coverage and split at every original segment boundary. Source in/out and speed derive from the same mapping used for review. Coverage gaps stay visible; fallback selection requires a documented policy and never removes dialogue.

An optional project-scoped setup draft retains step, ordered groups, assignments, opaque native analysis identity, portable placements and reviewed revision. Existing projects open normally. Cancel closes setup without applying tracks. Resume restores the draft; source/group timing changes invalidate affected review, while friendly renaming preserves valid timing evidence. Create timeline applies source tracks, dialogue tracks and multicamera group through existing lickety/applyEdit as one undo step, then uses existing save behavior. Narrative continues to consume the current native timeline.

## Integration and verification

Native analysis retains one heavy job, ten-second maximum decoded windows, 16 MiB IPC chunks, cancellation and reusable identity-keyed results. Reused DSP and compact correlation are benchmarked on identical deterministic fixtures before exposing any speed/accuracy choice. Synthetic fixtures include a full hour, start beyond thirty seconds, drift, gaps/overlaps and split cameras; legacy parity is distinct from owner-footage acceptance.

Timeline fit extends the existing zoom store, uses actual scrollport width and timed content extent, offers overview/detail restore and preserves selection/playhead. Media badges derive from actual current timeline source references. Shortcut help follows registered handlers and preserves custom bindings.

## Identity migration design constraints

Perform namespace/package/storage renames only after overlapping feature edits finish. Keep com.heymrmom.licketysplit.desktop and its profile. A renamed renderer origin cannot open the old origin's IndexedDB: migration must complete before loading the normal editor, copy rather than delete old stores, preserve structured data/Blob/CryptoKey values, and fail safely without silently creating an empty project library. Local-storage keys, preset IDs and database names require explicit old→new mapping in one migration boundary. Native asset registry and OS-protected keys remain in the same profile. Legacy identifiers needed solely to read old data are visible exceptions, never encoded to conceal residual matches. New MCP descriptor/client shim must agree; do not overwrite an owner's running server descriptor during testing. Required third-party copyright notices and frozen build evidence remain intact.
