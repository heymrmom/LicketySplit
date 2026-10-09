# Branding, storage migration, and remaining compatibility boundaries

## Implemented

The active product identity now uses `LicketySplit` / `licketysplit` names across the root and workspace package identities, desktop product and app ID, `app://licketysplit`, renderer/native bridges, desktop MCP server and endpoint variables, project-save defaults, interchange writers, and active product documentation. The old origin is retained only as the isolated source for migration. New projects save as `.licketysplit`; import still accepts `.oreel` and `.json`. ORMA remains `.orma`; new activity exports use `application/vnd.licketysplit.activity+json`.

New multicam, edit-plan, activity, and bleed-calibration writes use `licketysplit-*/v1`. Deserialization/import explicitly accepts `openreel-multicam/v1`, `openreel-multicam-edit/v1`, `openreel-activity/v1`, and `openreel-bleed-calibration/v1`, normalizing them on read. The serialization boundary writes normalized specs when an old project is saved, including autosaves, without changing placement or timing data.

The origin migration uses the restricted top-level legacy reader and sequential port acknowledgements. Its transport protocol remains version 1; origin migration status is version 2, correcting the earlier false-complete marker; same-origin namespace migration has its own version-1 marker. An origin retry always reconciles the namespace before opening the editor, including partial retries. Destination values win, the source remains unchanged, and incomplete handle copies remain visible and retryable. Continuing an incomplete copy does not write a completion marker.

The protected key file is copied byte-for-byte from `openreel-keys.json` to `licketysplit-keys.json`; destination-wins behavior is verified before inspecting a stale source. The existing crash reporter logs locally and sends nowhere unless `LICKETYSPLIT_CRASH_ENDPOINT` explicitly names a valid HTTP(S) endpoint. Its regression test keeps `OPENREEL_CRASH_ENDPOINT` as an old, ignored fixture value.

The exact original transparent mark and original ICNS are copied without transformation. SHA-256 values: PNG `fd61f7dd4e2958d63be51ccc76c766b918a3a1e4731e39056dc4bf2d5e25e2f4`; ICNS `34fafa461b9ad1fc5bfbe4d182d0421733791e6239651d6d39322810741ae202`. Active light, dark, and desktop themes now use the LicketySplit purple palette; white text uses a darker purple control fill. The media panel uses a compact accessible “Used on timeline” icon and responsive card sizing. The non-macOS runtime window icon also resolves that original PNG from the renderer resources; macOS packaging uses the original ICNS. The unused inherited favicon SVG, generic favicon/PWA PNGs and desktop build icon were removed after a reference scan, along with stale Vite rewrite rules. Their history is preserved in Git. Browser Welcome and Share labels also use LicketySplit; the welcome hero uses the original PNG and purple accents. Active contributor/agent guides and local Serena identity use current names; the capability reference was regenerated from the 311-tool registry and its generator test passed. Image and Studio favicon/PWA references, the Image welcome mark, and the Studio product-logo component use byte-identical copies of the approved transparent PNG; unused generic green SVG favicons and the inherited Studio logo drawing were removed. Their primary/theme/selection colors use the approved purple family, with darker controls for white text; semantic success and content-palette colors remain distinct. The exact local output `apps/desktop/release-takeover-alpha2/` is ignored.

## Migration verification

Fresh isolated Electron profiles were used; no owner profile or user MCP configuration was changed.

- The hour-project profile copied matching source/destination counts and hashes: 5 databases, 8 media records, 3 autosaves, 1 multicam artifact, and 3 preferences. The old v1 false-complete marker remained untouched and a correct v2 marker was written.
- The rich profile verified a 2 MiB Blob by bytes/hash, a usable nonextractable AES key, typed arrays/Map/Date and indexes, an encrypted browser vault, destination-wins, and byte-identical mode-0600 native key migration. `Cmd+9` custom shortcuts were preserved.
- Its origin-bound OPFS handle was not falsely copied: the gate stayed incomplete, Continue preserved the warning across reload, the reader window closed after interruption, and retry after replacing the destination handle completed while preserving the original handle contents.

## Automated checks

Commands used the pinned local Node 22/pnpm 11.7 toolchain.

- `pnpm --filter @licketysplit/web exec vitest run src/desktop/migration src/bootstrap.test.ts src/services/secure-storage.desktop.test.ts src/services/auto-save.test.ts`: **57/57 passed**. This includes the restored `openreel-theme` legacy fixture and the partial-origin-retry namespace reconciliation regression.
- `pnpm --filter @licketysplit/web exec vitest run src/components/editor/AssetsPanel.media-selection.test.tsx src/desktop/theme/desktop-theme.test.ts`: **6/6 passed**.
- `pnpm --filter @licketysplit/desktop exec vitest run test/gpu-cache-migration.test.ts`: **7/7 passed**.
- `pnpm --filter @licketysplit/desktop exec vitest run test/crash-reporter.test.ts`: **2/2 passed**.
- `pnpm --filter @licketysplit/web exec vitest run src/components/editor/timeline/Timeline.touch.test.tsx src/desktop/podcast/PodcastSetupDialog.test.tsx --reporter=dot --silent`: **20/20 passed**; focused ESLint on both files passed.
- Web, desktop, and core TypeScript checks each passed; the coordinator also reports the complete integrated workspace typecheck passed after the final identity changes.
- `git diff --check` passed after the final source edits then present. Manifest JSON parsed successfully; both approved asset hashes match.

The initial origin-copy evidence above belongs to the `540e9fd` development checkpoint. The integrated `97d066b` build subsequently verified the renamed namespace in both existing isolated profiles. All five hour-profile database schemas/counts and three stored preferences matched their preserved old-name sources. The rich profile matched its three existing mapped databases and settings/custom bindings; its 2 MiB Blob hash, usable nonextractable key, encrypted browser vault under `licketysplit-secure`, and native key retrieval all passed again. Both protected-key files retained the same SHA-256 and mode 0600. The active bridge is `window.licketysplit`; `window.openreel` is absent.

Normal controls opened a blank project in the rich profile. Its migrated custom `Cmd+9` binding appeared in the Fit Timeline tooltip/help and toggled the actual overview control from “Restore previous zoom” to “Full Extent Zoom.” The preset label is LicketySplit Default. A first probe correctly triggered the toggle but timed out because its fixed accessible-name lookup expected the old label; the corrected receipt records the changed control explicitly.

Receipts are in `verification/namespace-verification-1791583614050/` and `verification/migration-retry-1791583691999/`, relative to the ignored takeover evidence directory. The development MCP shim also initialized as `licketysplit` version `0.1.0-alpha.2`, exposed 311 tools, used a mode-0600 endpoint, and successfully read the real reopened hour project (8 media, 9 tracks, 533 clip nodes, duration 3602.027995 seconds). Packaged runtime proof remains separate.

## Integrated source checks

The complete non-renderer workspace rerun passed 2,441 tests (21 skipped), and the final renderer rerun passed 1,206 tests (7 skipped): 3,647 passing tests in total. The initial failed runs remain in the local evidence. Repairs corrected stale fixtures for input preroll, the deliberately ignored legacy crash environment variable, and the replaced SVG mark; only the integration parity case received a longer timeout after passing alone in 1.13 seconds. Production audio frame validation was not loosened.

Every workspace TypeScript check passed. All configured lint workspaces passed, with existing warnings retained; four browser-type names in test fixtures were expressed locally so lint did not mistake them for runtime globals. Logs are under the ignored `.superpowers/work/takeover/verification/` directory: `integrated-tests-recheck-20261009.log`, `integrated-web-tests-final-20261009.log`, `integrated-typecheck-20261009.log`, and the integrated lint/recheck logs.

## Remaining old identifiers and explicit exceptions

- The service worker recognizes old `openreel-*` cache names only when cleaning regenerable application caches; it does not rename or delete project databases.
- `app://openreel` is the read-only migration source origin. The desktop/editor old IndexedDB/localStorage names are isolated in `apps/web/src/desktop/migration/namespace.ts` and legacy fixtures; current editor consumers use the mapped LicketySplit names. `OPENREEL_CRASH_ENDPOINT` appears only in the negative compatibility test.
- The previous `.openreel-build` GPU-cache marker is read without deleting or changing it; the current marker is `.licketysplit-build`.
- The old native key filename `openreel-keys.json`, secure-vault verifier `openreel-verify-v1`, old `.oreel` project suffix, and four old `openreel-*/v1` specs are read/migration compatibility values. `.orma` remains the stable interchange extension.
- Existing legal attribution/source-offer files retain upstream names and text. In particular, the inherited FFmpeg notice still contains the explicitly marked `support@openreel.video` placeholder; establishing a real corresponding-source distribution/contact arrangement remains a release gate, and this work does not invent one. Required upstream attribution is preserved; active repository metadata points to `heymrmom/LicketySplit`.
- Image autosaves/color preferences and Studio drafts now write `licketysplit-image-project-*`, `licketysplit-image-colors`, and `licketysplit-studio`. Explicit adapters read `openreel-image-project-*`, `openreel-image-colors`, and `openreel-studio` with destination precedence; reads/saves leave source data unchanged, while explicit user deletion removes both copies to prevent deleted drafts returning. Image service-worker cleanup recognizes only the owned old/new Image cache prefixes and preserves unrelated caches. These boundaries passed 7 Image and 8 Studio tests, including absent legacy databases with/without enumeration and malformed-schema errors; Image, Studio, Agent, and Core typechecks passed. Image/Studio normal-UI and deployment behavior were not exercised. Old mobile paths occur in a compatibility-check script, but the referenced mobile source trees are absent from this checkout. The inherited June/August mobile release and port records are explicitly marked as preserved upstream reference, not current LicketySplit metadata or acceptance; their historical bundle IDs/source symbols remain exact. The preserved `codex/openreel-baseline` workflow branch and external `openreel-claude-bot` account reference identify existing history/accounts rather than the product.

- `LEGACY_PARTICLE_DEFAULT_SEED` retains the exact `openreel-particles` value because changing it reshapes existing scenes without an explicit seed. Core and Agent share that one compatibility constant; five particle tests preserve deterministic behavior. The active built-in template label is LicketySplit.

## External hosts awaiting product-owner disposition

No replacement endpoints were invented and no endpoint behavior was redirected. The upstream OpenReel hosts remain referenced in these existing paths pending the user’s decision:

- `https://api.openreel.video`: `apps/web/src/config/api-endpoints.ts` and cloud service calls for templates/share. Cloud template UI is reachable in the editor; share helpers have no active desktop UI callsite found. The default crash-report endpoint is disabled.
- `https://media.openreel.video/models/`: `apps/web/src/workers/whisper-worker.ts`, reached by local Whisper multicam transcription and auto-caption flows.
- `https://mediashares.openreel.video/ffmpeg-vidstab/{mt,st}`: `packages/core/src/video/stabilization/vidstab-engine.ts`, reachable from the editor’s stabilization controls.
- `https://app.openreel.video`: referenced by the share-origin helper; no current desktop user-flow caller was found.
- `https://filters.openreel.video` and `https://dl.openreel.video`: generator/build scripts only, not desktop runtime paths. Filter deployment prefers `LICKETYSPLIT_FILTERS_BUCKET`, with the old environment name and existing `openreel-filters` bucket retained as infrastructure compatibility pending disposition. Image deployment still names the existing `openreel-image` Cloudflare project; Studio sample documentation still references `cdn.openreel.video`. No deployment was run.
- `openreel.pages.dev` and `openreel-preview.pages.dev`: web Pages proxy allowlist/configuration only. Wrangler project names and Cloudflare resources still point at existing upstream services.
- `api.elevenlabs.io`, `api.openai.com`, and `api.anthropic.com` are third-party provider APIs and remain unchanged.

The active cloud deployment, Cloudflare resources, remote MCP client files, and user settings were not changed. Until the endpoint decision is made, the upstream service references above remain a known product-ownership dependency.
