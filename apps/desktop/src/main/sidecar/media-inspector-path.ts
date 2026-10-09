import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

export function mediaInspectorRelativePath(platform: NodeJS.Platform, arch: string) {
  const binary = platform === "win32" ? "ffprobe.exe" : "ffprobe";
  return `${platform}-${arch}/${binary}`;
}

export function mediaInspectorBinaryPath(base: string, packaged: boolean, platform: NodeJS.Platform, arch: string) {
  return path.join(packaged ? path.join(base, "native-inspector") : base, mediaInspectorRelativePath(platform, arch));
}

export function mediaInspectorDevelopmentBases(moduleDir: string) {
  // tsup places the main bundle in dist/main; source-level tests run under src/main/sidecar.
  return [path.resolve(moduleDir, "../../resources/native-inspector"), path.resolve(moduleDir, "../../../resources/native-inspector")];
}

export function resolveMediaInspectorPath() {
  const packaged = Boolean(app?.isPackaged);
  const candidates = packaged
    ? [mediaInspectorBinaryPath(process.resourcesPath, true, process.platform, process.arch)]
    : mediaInspectorDevelopmentBases(__dirname).map((base) => mediaInspectorBinaryPath(base, false, process.platform, process.arch));
  const binary = candidates.find(existsSync);
  if (!binary) throw new Error(`Native packet inspector is unavailable for ${process.platform}-${process.arch}; original presentation timing remains unverified.`);
  return binary;
}
