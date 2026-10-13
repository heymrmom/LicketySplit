#!/usr/bin/env node
// Rebuilds the metadata-only LGPL FFprobe from a locally supplied source tarball.
// No download occurs: set FFPROBE_SOURCE_ARCHIVE to the pinned FFmpeg 9.0.1 archive.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This checked-in inspector target is macOS arm64.");
const sourceSha256 = "cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635";
const archive = process.env.FFPROBE_SOURCE_ARCHIVE;
if (!archive || !existsSync(archive)) throw new Error("Set FFPROBE_SOURCE_ARCHIVE to a local ffmpeg-9.0.1.tar.xz source archive; this script does not download files.");
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
if (hash(archive) !== sourceSha256) throw new Error("Pinned FFmpeg source checksum mismatch.");
const flags = ["--disable-autodetect", "--disable-gpl", "--disable-nonfree", "--disable-version3", "--disable-network", "--disable-doc", "--disable-debug", "--enable-small", "--disable-shared", "--enable-static", "--disable-programs", "--enable-ffprobe", "--disable-avdevice", "--disable-avfilter", "--disable-swscale", "--disable-swresample", "--disable-encoders", "--disable-decoders", "--disable-muxers", "--disable-filters", "--disable-hwaccels", "--disable-protocols", "--enable-protocol=file,pipe", "--arch=aarch64", "--extra-cflags=-mmacosx-version-min=12.0", "--extra-ldflags=-mmacosx-version-min=12.0"];
const temporary = mkdtempSync(path.join(os.tmpdir(), "licketysplit-ffprobe-"));
const output = path.join(root, "resources/native-inspector/darwin-arm64");
mkdirSync(output, { recursive: true });
try {
  execFileSync("/usr/bin/tar", ["-xf", archive, "-C", temporary]);
  const source = path.join(temporary, "ffmpeg-9.0.1");
  execFileSync("./configure", flags, { cwd: source, stdio: "inherit" });
  execFileSync("/usr/bin/make", ["-j4", "ffprobe"], { cwd: source, stdio: "inherit" });
  const binary = path.join(source, "ffprobe");
  const builtArch = execFileSync("/usr/bin/lipo", ["-archs", binary], { encoding: "utf8" }).trim();
  if (builtArch !== "arm64") throw new Error("Compiled inspector has the wrong architecture.");
  const license = execFileSync(binary, ["-hide_banner", "-L"], { encoding: "utf8" }).replace(/\s+/g, " ");
  if (!license.includes("GNU Lesser General Public License") || !license.includes("version 2.1")) throw new Error("Unexpected inspector license.");
  const buildconf = execFileSync(binary, ["-hide_banner", "-buildconf"], { encoding: "utf8" }).replaceAll("'", "");
  if (flags.some((flag) => !buildconf.includes(flag))) throw new Error("Inspector configuration does not match the pinned recipe.");
  const destination = path.join(output, "ffprobe");
  copyFileSync(binary, destination); chmodSync(destination, 0o755);
  const receipt = { version: "9.0.1", sourceUrl: "https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz", sourceSha256, arch: "arm64", configure: flags, sourceModifications: "none", license: "LGPL-2.1-or-later", sha256: hash(destination), networkProtocols: ["file", "pipe"], videoDecoders: [], compiler: execFileSync("/usr/bin/clang", ["--version"], { encoding: "utf8" }).split("\n")[0] };
  writeFileSync(path.join(output, "ffprobe-build.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally { rmSync(temporary, { recursive: true, force: true }); }
