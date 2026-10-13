# FFprobe packet inspector

OpenReel bundles FFprobe 9.0.1 for macOS arm64 as a separate metadata-only process. The local binary is unmodified, SHA-256 `d927f5c1fb6a094fd71a0a8ed080846c138550b9fff04792a7d7fa1e603af06d`. Its build receipt is `resources/native-inspector/darwin-arm64/ffprobe-build.json`.

The build disables GPL and nonfree components, network protocols, decoders, encoders, muxers, filters, and hardware acceleration. It enables only ffprobe and the `file` and `pipe` protocols. The executable reports GNU LGPL version 2.1 or later. The full license is in `FFPROBE-LGPL-2.1.txt`.

Corresponding source: FFmpeg 9.0.1 at <https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz>, SHA-256 `cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635`. The exact configure flags and reproducible local build steps are recorded in `scripts/prepare-media-inspector.mjs`; the script accepts an already downloaded source archive and verifies its digest before building.
