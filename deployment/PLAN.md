# LicketySplit OpenReel baseline

Goal: deploy the unchanged browser editor from Augani/openreel-video commit c9340465e5d37e684cc25bdbe746c4ccd45e165c to https://video.heymrmom.com.

Authorization: the user explicitly approved a separate repository/checkout, branch codex/openreel-baseline, GitHub push, Railway project/service creation and public deployment, and DNS creation when no existing resource is replaced. No further approval gates apply to those actions.

Architecture: retain every upstream editor source file, license, dependency lockfile and asset. Add a Node production static server that reproduces upstream browser headers, streams static files with MIME/range/conditional support, falls back to index.html for application routes, and adapts the existing Cloudflare Pages AI proxy handler. Build with the upstream pnpm 11.7.0 commands in a multi-stage Node 22 Dockerfile. A single Railway service runs the production server; no database, volume, cloud media storage, or render service.

1. [x] Inspect upstream instructions, exact revision, licenses, GitHub naming, Railway workspace/plan, and initial public DNS. Clone a separate repository with upstream remote and the requested branch.
2. [ ] Test hosting contracts before implementing the adapter: isolation/security headers, WASM/worker MIME, SPA/missing-asset routing, byte ranges/downloads, keyless proxy rejection and preflight. Implement Dockerfile and Railway configuration; run upstream production build/typecheck/lint/tests and record inherited failures without changing editor behavior.
3. [ ] Review the hosting diff. Create heymrmom/LicketySplit, push the requested branch, create Railway LicketySplit, connect the exact GitHub branch, and deploy one replica with small resource limits. Do not copy any existing app credentials.
4. [ ] Inspect authoritative DNS before creating only Railway-required video subdomain records. Verify HTTPS, local import/playback, timeline edit, short export and exported-file properties, save/reload/reopen, workers/assets and keyless optional proxy routing through the deployed browser UI.
5. [ ] Save exact revision/service/domain evidence, external dependencies, costs, future review/publishing workflow, rollback procedure, and limits. Keep the initial baseline branch intact for comparison.

Review focus: path traversal and missing asset must not return sensitive files or HTML as JS/WASM; ranges and streamed downloads must return correct bytes; headers must enable SharedArrayBuffer; proxy must keep upstream service/path limits and never use service-owned keys; deployed revision must match GitHub and custom domain.
