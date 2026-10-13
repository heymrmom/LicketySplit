import { beforeEach, expect, it, vi } from "vitest";
import { CHANNELS } from "../shared/channels";

const state = vi.hoisted(() => ({
  api: undefined as unknown,
  filePath: "/synthetic/microphone.wav" as string | undefined,
  invoke: vi.fn(async () => undefined),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { state.api = api; } },
  ipcRenderer: { invoke: state.invoke, on: vi.fn(), send: vi.fn(), sendSync: vi.fn() },
  webUtils: { getPathForFile: vi.fn(() => state.filePath) },
}));

type ExposedBridge = {
  lickety: {
    identifyOriginalFile(file: File): Promise<unknown>;
    findOriginalMediaId(file: File, mediaIds: string[]): Promise<unknown>;
  };
};

beforeEach(async () => {
  vi.resetModules();
  state.api = undefined;
  state.filePath = "/synthetic/microphone.wav";
  state.invoke.mockReset().mockResolvedValue(undefined);
  await import("./index");
});

it("sends only native File paths through opaque original identity lookups", async () => {
  const bridge = state.api as ExposedBridge;
  const file = new File(["synthetic"], "microphone.wav");
  await bridge.lickety.identifyOriginalFile(file);
  expect(state.invoke).toHaveBeenCalledWith(CHANNELS.licketyIdentifyOriginal, { path: "/synthetic/microphone.wav" });

  await bridge.lickety.findOriginalMediaId(file, ["media-a", "media-b"]);
  expect(state.invoke).toHaveBeenLastCalledWith(CHANNELS.licketyFindOriginalMediaId, { path: "/synthetic/microphone.wav", mediaIds: ["media-a", "media-b"] });
});

it("does not invoke native identity channels if Electron cannot resolve a File path", async () => {
  state.filePath = undefined;
  const bridge = state.api as ExposedBridge;
  const file = new File(["synthetic"], "microphone.wav");
  await expect(bridge.lickety.identifyOriginalFile(file)).resolves.toBeNull();
  await expect(bridge.lickety.findOriginalMediaId(file, ["media-a"])).resolves.toBeUndefined();
  expect(state.invoke).not.toHaveBeenCalled();
});
