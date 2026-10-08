# LicketySplit OpenReel baseline — 2026-10-08

Live app: https://video.heymrmom.com

This is OpenReel's browser editor with its upstream interface, features, defaults, branding and client processing code preserved. LicketySplit names the separate GitHub repository and Railway infrastructure. No existing Lickety Split features have been integrated.

## Source and identity

| Item | Value |
| --- | --- |
| GitHub | https://github.com/heymrmom/LicketySplit |
| Branch | `codex/openreel-baseline` |
| App baseline commit | `6f79d512d1bdefb815ff0e1da68581ce3ba89ff7` |
| Upstream | https://github.com/Augani/openreel-video |
| Upstream commit | `c9340465e5d37e684cc25bdbe746c4ccd45e165c` |
| Upstream commit date | 2026-10-03 |
| Local checkout | `/Users/donaldanderson/Documents/GitHub/LicketySplit` |
| Upstream remote | `upstream` |
| Origin remote | `origin` |

The MIT license, copyright/author attribution, README, packages, all editor source, upstream assets, and dependency lockfile are retained. Comparison with the exact upstream commit shows no changes to upstream tracked files in the final baseline. All final changes are new hosting, CI, and deployment documentation files. The initial, superseded `railway.toml` addition was removed.

The existing `heymrmom/lickety-split`, `heymrmom/lickety-split-beta`, installed desktop app, projects, media and credentials were not modified. No credentials were copied from them.

## Railway

| Item | Value |
| --- | --- |
| Workspace | `heymrmom's Projects` — `0ebbfe7e-7a07-40e5-b5e4-d1e8eb97dd07` |
| Existing plan | Pro; unchanged |
| Project | `LicketySplit` — `4330ccb5-942d-48e7-927a-106bcb6ccdc7` |
| Service | `LicketySplit` — `3ddbecfc-1750-4117-bdeb-09c84cd742e3` |
| Environment | `production` — `f9ecf148-15e5-4816-99bc-42a85ae8f67a` |
| Final deployment | `54f0c676-bbea-4d79-8dec-eec2d7850c1d` — SUCCESS; the final observed status and image digest are recorded in `verification.json` |
| Source revision | `6f79d512d1bdefb815ff0e1da68581ce3ba89ff7` |
| Region | `sfo` |
| Replicas | 1 |
| Runtime limits | 0.25 vCPU, 0.25 GB RAM |
| Health check | `/healthz`, timeout 120 seconds |
| Restart policy | On failure, maximum 3 retries |
| Infrastructure | One service; no databases, volumes, storage buckets or render services |

The Docker build uses Node 22 Alpine and upstream pnpm 11.7.0, a frozen dependency lockfile, upstream AssemblyScript WASM builds, TypeScript checking and Vite production build. The runtime uses an unprivileged Node production server; Vite's development/preview servers are not used in production.

`hosting/railway/server.mjs` serves the production output with the upstream isolation/security headers, MIME types, streaming and single byte ranges, conditional requests, and SPA routes. Missing assets and unknown APIs return 404 rather than HTML. Media import, editing and export run in the user's browser.

The server directly adapts the unchanged upstream Cloudflare Pages handler at `apps/web/functions/api/proxy/[[catchall]].ts`. Service/path allowlists, per-request caller keys, 8 MiB request cap and 120-second upstream timeout are retained. It adds same-origin checks and removes stale compression/length headers when streaming Fetch responses through Node. No provider keys are configured on this service.

Railway's live API rejected `railwayConfigFile` because per-repository `railway.toml` is retired. Service settings are reproducible through the supported API:

```bash
cd /Users/donaldanderson/Documents/GitHub/LicketySplit
railway link --project 4330ccb5-942d-48e7-927a-106bcb6ccdc7 --environment production --service LicketySplit
railway api --file hosting/railway/service-settings.graphql --variables @deployment/railway-target.json
railway variable set RAILWAY_DOCKERFILE_PATH=Dockerfile --skip-deploys --service LicketySplit
```

Only app, package, hosting, Dockerfile, Docker ignore, license, root package/lockfile, and dependency patch changes are watched for deployment. Documentation-only changes do not alter the application revision. One intermediate redeploy of the older revision failed when Railway selected Railpack and could not find a root start command. The successful deployment stayed available; the final deployment uses the Dockerfile and explicit service settings. That failed deployment remains in provider history.

## DNS and HTTPS

Cloudflare zone `a800273e000f49c286f976ec85932341` was inspected before mutation. Neither requested DNS name existed. All 21 existing DNS records were compared before/after and remain unchanged. Exactly these two records were added:

| Type | Name | Value | Cloudflare proxy |
| --- | --- | --- | --- |
| CNAME | `video.heymrmom.com` | `e3d65x2f.up.railway.app` | Off; DNS only |
| TXT | `_railway-verify.video.heymrmom.com` | `railway-verify=9e1e4b00534dee698f7c1df66e74519f5f5ee2077b62c5a846027666605505ae` | Not applicable |

CNAME record ID: `d6a37612041663e9cf0afb4292735099`.
TXT record ID: `03172349c0d731894bc75306a0e56013`.
Railway domain ID: `b1104d46-81f1-4f5e-b1e5-a1c838c84347`; target port 8080.

Railway observed DNS propagation, verified ownership and issued a valid certificate. Public Cloudflare and Google DNS resolvers return the Railway target. During the smoke test the local router/Tailscale resolver still cached the former NXDOMAIN result; the isolated test browser used normal secure DNS through Cloudflare, without a hosts-file override or TLS bypass. No persistent system DNS settings were changed. Temporary Chrome Apple Events JavaScript access used for authenticated DNS setup was restored to its original disabled state and checked afterward.

## Verification and limits

Tests used generated color-bar/sine media, a separate browser profile, and a disposable project named `LicketySplit baseline smoke 2026-10-08`. The input was a four-second 320×180 H.264/AAC MP4 (155,349 bytes). The project canvas was matched to the source using the normal editor dialog.

| Check | Result |
| --- | --- |
| Upstream production build | Passed: WASM compilation, TypeScript and Vite build |
| Full upstream typecheck | Passed |
| Full upstream tests | 3,258 passed across 458 test files; 70 skipped |
| Upstream lint | Failed with 2 inherited errors and 109 warnings in web workspace; errors are undefined `PointerEventInit` and `FrameRequestCallback` in unchanged `Timeline.touch.test.tsx` |
| Additional retired-cloud-GPU source check | Passed |
| Additional mobile-offline check | Cannot complete: upstream public checkout lacks the private Android manifest; outside this browser deployment |
| Hosting integration tests | 5 passed; isolation/MIME/routing/range/conditional/proxy contracts |
| Independent hosting reviews | No Critical or Important findings; missing Docker watch inputs corrected |
| GitHub Railway baseline CI | Passed on the application baseline revision |
| HTTPS/custom domain | 200 response, valid certificate; `/healthz` identifies app/revision |
| Editor load | Welcome and editor rendered; no page errors or failed network requests in the tested flow |
| Local import/playback | Passed; actual frames displayed and playhead advanced |
| Timeline editing | Split at 2 seconds, then deleted second half; 2 clips became 1 and duration changed from 4 seconds to 2 |
| Export | Actual 483,491-byte MP4 downloaded successfully |
| Export inspection | H.264 320×180 at 30 fps, AAC 48 kHz stereo; container duration 2.069333 s, with AAC padding; first/last frames displayed and nonzero audio confirmed |
| Local autosave/reload | Recovery dialog retained project name, 2-second edit and local media |
| Recent-project reopen | Passed from Welcome → Recent projects; clip and media restored |
| Worker/assets | Blob processing workers and served worker observed; worker JS returned 200 and correct MIME; WASM byte-range returned 206, `application/wasm`, and valid WASM magic bytes; cross-origin isolation and SharedArrayBuffer available |
| Optional proxy | OpenAI/Anthropic/ElevenLabs routes returned 401 without keys; disallowed path 403; same-origin preflight 204; no provider request was initiated |
| Media upload during core smoke flow | No POST requests observed |

Browser test: Chrome 154.0.8037.98 on this Mac, isolated automated profile with software graphics support. This is a bounded browser smoke test, not full feature parity, long-episode/4K performance, cross-platform acceptance, or physical-device/accessibility acceptance.

The final deployment was checked again after activation: the live health revision matched the app baseline SHA, the saved media/project reopened, and another actual MP4 exported and decoded successfully. See `verification.json` and local `final-smoke-fresh.json`.

Native project file-picker save/open dialogs are **unverified**: a headless Cmd+S attempt did not yield a project file. Local autosave recovery and reopening were tested separately and passed. Paid AI output, upstream sharing/template cloud services, segmentation, transcription models, multicamera, and all other advanced editing tools are present in upstream source but were not accepted through this test.

Evidence is retained locally in `deployment/evidence/` (excluded from Git and Docker), including the real input/export MP4s, extracted frames, UI screenshots, export probe, browser observations, routing responses, and build/check logs. Public source metadata and final observations are in `deployment/verification.json`.

Input SHA-256: `2da7c88cea16bbd74b4327f06c82159c75fa493d66ab54ebf1e06c6ed60232b2`.
Export SHA-256: `396ce044f65d8a7dbef7c9634dc58272000532b2de3e4bfdd9a9a47d279116e5`.

## External dependencies and optional data transfers

| Dependency/feature | Location and behavior |
| --- | --- |
| Fonts | Upstream local font assets and Google Fonts connections remain; remote font requests expose ordinary request metadata, not project media |
| FFmpeg and media decode | Upstream `unpkg.com` FFmpeg 0.12.6 WASM fallback, `esm.sh` MediaBunny 1.25.3 decode-worker import; code downloads run locally |
| Local ML | Hugging Face Whisper/model downloads, Google-hosted MediaPipe models, jsDelivr/UNPKG runtimes and Silero VAD assets; browser processing remains local after download |
| Stabilization | Upstream `mediashares.openreel.video/ffmpeg-vidstab` WASM assets remain external |
| AI Editor / voice | User-configured OpenAI, Anthropic, ElevenLabs and compatible endpoints can receive prompts, project context or audio/text according to the selected upstream feature; own-key provider use may incur charges. Compatible custom endpoints use upstream direct transport; fixed supported services use the same-origin proxy |
| AI Generate | Upstream KieAI (`api.kie.ai`, `kieai.redpandaai.co`) features can upload chosen reference files and prompts and incur provider charges |
| Share/templates | Upstream optional `api.openreel.video` services remain in source; sharing can upload the user's explicitly selected export; no replacement cloud backend or storage was deployed |
| Analytics | Upstream PostHog integration remains in source, but no `VITE_PUBLIC_POSTHOG_KEY` or host was configured for this baseline |

No new AI service, backend database or cloud media storage was introduced. Model/third-party service availability, CORS policy and API contracts remain external dependencies. Optional services have not been proved to accept this custom origin.

## Expected hosting cost

The existing Pro plan was confirmed live and left unchanged. Its $20 monthly minimum includes $20 of usage across the workspace; this service does not create another plan subscription. At inspection, existing workspace usage was about $27.08 with an estimate of $27.34 before this baseline's continuing traffic.

Early runtime memory was roughly 28–37 MB and CPU was near idle. A reasonable initial light-traffic allowance is **$0.50–$2 per month additional runtime usage, plus egress**. This is an estimate from a short observation, not a long-term measured forecast.

Railway's listed container prices are RAM $10/GB-month, CPU $20/vCPU-month, and network egress $0.05/GB. At the configured service limits, continuously consuming the entire CPU and RAM allowance is about $7.50/month before egress. Resource caps do not cap traffic costs. Build CPU/memory and image storage are free under current Railway pricing. No volume/database cost exists for this service.

Source: https://docs.railway.com/pricing/plans

## Make, review and publish future changes

1. **Make changes on a new branch.** Keep the deployed baseline tag for comparison; branch from `codex/openreel-baseline`, for example `codex/<change-name>`. Never develop in the existing desktop repositories for this new application.

   ```bash
   cd /Users/donaldanderson/Documents/GitHub/LicketySplit
   git fetch origin
   git switch -c codex/<change-name> origin/codex/openreel-baseline
   npx --yes pnpm@11.7.0 install --frozen-lockfile
   npx --yes pnpm@11.7.0 dev
   ```

2. **Verify and review.** Run hosting tests, production build, typecheck, tests and lint. Treat the documented lint errors as inherited debt, not a blanket waiver for new errors. Inspect the normal browser flow and actual output whenever changing import, timeline, persistence or export. Push the feature branch and open a GitHub PR against `codex/openreel-baseline`.

   ```bash
   node --experimental-strip-types --test hosting/railway/server.test.mjs
   npx --yes pnpm@11.7.0 build
   npx --yes pnpm@11.7.0 typecheck
   npx --yes pnpm@11.7.0 test
   npx --yes pnpm@11.7.0 lint
   git push -u origin codex/<change-name>
   gh pr create --base codex/openreel-baseline
   ```

3. **Publish only after review.** Merge the reviewed PR to the deployment branch when publication is approved. The Railway service points to that exact branch. An explicit source connection was proven to fetch and deploy its latest GitHub SHA; do not rely on an assumed webhook. If an automatic deployment does not appear, run the exact explicit publishing command:

   ```bash
   railway service source connect \
     --project 4330ccb5-942d-48e7-927a-106bcb6ccdc7 \
     --environment production \
     --service 3ddbecfc-1750-4117-bdeb-09c84cd742e3 \
     --repo heymrmom/LicketySplit \
     --branch codex/openreel-baseline --json
   ```

4. **Confirm publication.** `railway deployment list --json` must show SUCCESS and the reviewed SHA. Check `https://video.heymrmom.com/healthz`, the editor, and the changed user workflow. A Git push, green CI, or successful build alone is not proof of a live revision.

5. **Compare upstream deliberately.** `git fetch upstream` followed by `git log`/`git diff` against the pinned upstream SHA. Evaluate changes on a new feature branch and use the same review/publish gate. Do not automatically pull or merge upstream into production.

The immutable `openreel-baseline-2026-10-08` tag points to the app baseline commit. Documentation commits can be newer than the deployed app revision because deployment watches exclude documentation.

## Rollback

For a previous successful release within Railway image retention, select that successful deployment in the LicketySplit service's Deployments view and use Rollback. Inspect its revision first. Railway Pro currently retains removed images for 120 hours; within retention rollback restores the earlier image/settings/variables. Check the resulting deployed SHA, `/healthz` and browser workflow. Keep DNS unchanged.

For a durable source rollback, create a reviewed revert PR to `codex/openreel-baseline`, restore the desired changes with normal Git history, merge and publish through the source-connect workflow above. To restore this baseline, use `openreel-baseline-2026-10-08` as the comparison target. No force-push or reset of shared branch history is required.

A fast baseline rebuild can use a new local rollback branch rooted at the immutable tag, with explicit service selectors and `railway up` from that clean checkout; this publishes a local snapshot, so prefer the GitHub revert/source-connect workflow for normal releases.

Do not use the failed intermediate `ad50bb86-012c-4415-baaf-de62249c9c23` deployment as a rollback target. Do not point DNS at the existing desktop Lickety Split services.

Rollback reference: https://docs.railway.com/pricing/plans#image-retention-policy
