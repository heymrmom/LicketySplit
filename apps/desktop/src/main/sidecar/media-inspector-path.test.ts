import path from "node:path";
import { describe, expect, it } from "vitest";
import { mediaInspectorBinaryPath, mediaInspectorDevelopmentBases } from "./media-inspector-path";

describe("native packet inspector resource path", () => {
  it("resolves the builder's packaged native-inspector extraResources directory", () => {
    expect(mediaInspectorBinaryPath("/App/Contents/Resources", true, "darwin", "arm64"))
      .toBe(path.join("/App/Contents/Resources", "native-inspector", "darwin-arm64", "ffprobe"));
  });

  it("resolves the development resource directory without adding a second nested folder", () => {
    expect(mediaInspectorBinaryPath("/repo/apps/desktop/resources/native-inspector", false, "darwin", "arm64"))
      .toBe(path.join("/repo/apps/desktop/resources/native-inspector", "darwin-arm64", "ffprobe"));
  });

  it("uses the desktop resource directory from the bundled dist/main module location", () => {
    expect(mediaInspectorDevelopmentBases("/repo/apps/desktop/dist/main")[0])
      .toBe(path.join("/repo/apps/desktop/resources/native-inspector"));
  });

  it("retains the source-test fallback while resolving the real bundled resource from this checkout", () => {
    const sourceBases = mediaInspectorDevelopmentBases(path.join(__dirname));
    expect(sourceBases[1]).toContain(path.join("apps", "desktop", "resources", "native-inspector"));
  });
});
