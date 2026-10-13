# LicketySplit

LicketySplit is a video editor built around a multi-track timeline, original-media workflows, and native desktop export tools. This repository contains the editor, its shared media and timeline engines, and the desktop application.

The first desktop candidate targets Apple silicon on macOS 14 or newer. It is an engineering candidate; signed installation, public downloads, and automatic updates are not enabled. See the [desktop distribution guide](apps/desktop/DISTRIBUTION.md) and [acceptance gates](apps/desktop/ACCEPTANCE.md) for the current release boundaries.

Editing and export operate on local project data and source files. Optional connected features, such as transcription or AI-assisted editing, can send requests to the provider selected for that feature. Keep backups of project files and original media.

## Run the development app

Use the Node.js and pnpm versions pinned by the repository, then run:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Vite prints the local development URL. To build and check the workspace:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Desktop candidate packaging and its safeguards are documented in the [distribution guide](apps/desktop/DISTRIBUTION.md). A successful local build does not establish signed installation, physical-device acceptance, or public release readiness.

## Project layout

| Path | Contents |
| :--- | :--- |
| [`apps/web`](apps/web) | Editor interface and browser renderer |
| [`apps/desktop`](apps/desktop) | Electron shell, native integrations, and candidate packaging |
| [`packages/core`](packages/core) | Project, timeline, media, audio, and export engines |
| [`packages/ui`](packages/ui) | Shared interface components |
| [`packages/agent`](packages/agent) | Editing actions and assistant integration |

The repository is licensed under the terms in [`LICENSE`](LICENSE).
