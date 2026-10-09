# LicketySplit Desktop distribution

This guide covers the independent Apple silicon candidate. It does not describe any separately hosted service or legacy distribution channel.

## Candidate identity

- Product: **LicketySplit**
- macOS app ID: `com.heymrmom.licketysplit.desktop`
- First target: Apple silicon, macOS 14 or newer
- Candidate workflow: [`licketysplit-desktop.yml`](../../.github/workflows/licketysplit-desktop.yml)
- Acceptance gates: [`ACCEPTANCE.md`](ACCEPTANCE.md)

The candidate uses a separate Application Support profile and `app://licketysplit` origin. Keep installed legacy apps, profiles, projects, and credentials intact. Automatic updates and public publishing remain disabled.

## Build-only candidate

Run the dedicated GitHub Actions workflow with `workflow_dispatch` and stage `build-only`. It requires an ARM64 macOS 14 runner and Node 22, installs the frozen pnpm lockfile, runs typecheck and tests, fetches the pinned ARM64 FFmpeg binary, writes the source receipt, builds the desktop app, and verifies its package identity and native binaries.

The workflow uploads unsigned ARM64 DMG/ZIP test artifacts with SHA-256 sums, a source/build manifest, and third-party notices. These are engineering candidates; they are not signed, notarized, Gatekeeper-ready, published, or configured for automatic updates. Keep the artifact ID and its source commit together.

## Signed test and draft stages

Use the `signed-test` stage only in the protected `licketysplit-desktop-release` environment with the owner-approved LicketySplit signing and notarization credentials. The stage signs and notarizes a candidate and verifies its nested executables. It uploads a test artifact; it does not publish a release or enable an update feed. Keep those credentials separate from any other app identity or profile.

Use `draft-release` only after the signed artifact has passed the [acceptance gates](ACCEPTANCE.md). Supply the exact signed artifact ID and acceptance JSON whose package digest and source commit match that artifact. The workflow checks the package manifest and checksums, then creates a draft prerelease. Review and public promotion remain separate actions.

The workflow deliberately has no tag-triggered upstream publication path. Do not upload to upstream R2, change the hosted web app, publish a draft, merge to a shared branch, or enable automatic updates as part of local engineering work.

## Local engineering checks

Use the repository-pinned Node 22 and pnpm versions. The workflow is the source of truth for candidate build stages. For local investigation, the relevant commands are:

```bash
pnpm build:wasm
pnpm typecheck
pnpm test
node apps/desktop/scripts/fetch-ffmpeg.mjs darwin-arm64
pnpm --dir apps/desktop build
node apps/desktop/scripts/write-source-receipt.mjs
```

A source receipt requires a clean committed checkout. Package output is not evidence of a successful installed launch, a physical 8 GB acceptance run, a signed/downloaded installation, or a user-approved release. Use the exact verification and evidence boundaries in [`ACCEPTANCE.md`](ACCEPTANCE.md).


### Regenerating the native Aurora resources

A desktop build can reuse the committed ARM64 Aurora executable/library when the local CMake build directory is absent. After changing their C++ source, regenerate and test them before freezing a candidate; a skipped copy is not evidence of a fresh native build. On an Apple silicon Mac, use the existing CMake/clang toolchain:

```bash
cmake -S packages/creation-core -B packages/creation-core/build \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0 \
  -DCMAKE_INSTALL_NAME_DIR=@rpath \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON -DCMAKE_INSTALL_RPATH=@loader_path
cmake --build packages/creation-core/build --parallel 2
ctest --test-dir packages/creation-core/build --output-on-failure
node apps/desktop/scripts/prepare-aurora-native.mjs
```

Inspect both staged binaries with `otool -L`/`otool -l`: require ARM64, a macOS deployment target no newer than 14, and portable library paths rather than a developer's absolute build directory. Commit the regenerated `apps/desktop/resources/aurora/` files before the final desktop build and source receipt. The packaged copies must match those committed hashes and the packaged renderer must pass `--self-test`. This does not replace running on actual macOS 14 hardware.
