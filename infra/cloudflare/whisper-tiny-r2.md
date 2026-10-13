# Browser caption models

The inherited model-host configuration references the `openreel` R2 bucket for
Transformers.js downloads. This is an exact upstream infrastructure reference pending
owner disposition, not verification of current live ownership or deployment. The
desktop takeover does not deploy or rename this bucket. The documented tiers are:

- Fast: `models/onnx-community/whisper-tiny/resolve/main/` (~100 MB)
- Accurate: `models/onnx-community/whisper-large-v3-turbo_timestamped/resolve/main/`
  (~760 MB)

Only tokenizer/config files and the Q4 encoder/merged-decoder ONNX weights are
mirrored. Both upstream Whisper models are Apache-2.0 licensed. Model binaries
must not be committed to this repository.

R2 objects use long-lived public cache headers. The web worker uses the browser
cache after the first download and prefers WebGPU for the accurate tier, with a
WASM fallback. Publish a versioned prefix and update
`apps/web/src/workers/whisper-models.ts` when replacing the weights.
