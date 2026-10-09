import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { projectManager } from "./project-manager";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (window as any).openreel = {
    platform: "desktop",
    fs: {
      showSaveDialog: vi.fn(async () => "/tmp/proj.oreel"),
      showOpenDialog: vi.fn(async () => "/tmp/proj.oreel"),
      writeFile: vi.fn(async (p: string, d: string) => {
        store.set(p, d);
      }),
      readFile: vi.fn(async (p: string) => store.get(p) ?? ""),
    },
  };
});

afterEach(() => {
  delete (window as any).openreel;
});

const project: any = {
  id: "p1",
  name: "Demo",
  timeline: { duration: 1, tracks: [] },
};

describe("ProjectManager desktop fs", () => {
  it("saveProjectAs writes via window.openreel.fs and round-trips", async () => {
    const ok = await projectManager.saveProjectAs(project);
    expect(ok).toBe(true);
    expect((window as any).openreel.fs.writeFile).toHaveBeenCalled();
    const loaded = await projectManager.openProject();
    expect(loaded?.name).toBe("Demo");
  });
});

it('desktop workflow saves declare reader and omit local source bindings',async()=>{const {makeWorkflowFixture}=await import('@openreel/core/lickety/test-fixtures');const fixture=makeWorkflowFixture();const p={...fixture,lickety:{schemaVersion:1 as const,words:[{occurrenceId:'o',sourceWordId:'w',text:'hello',startMs:0,endMs:100}]},mediaLibrary:{items:fixture.mediaLibrary.items.map(item=>({...item,nativeSource:{identity:{assetId:'asset',mediaId:item.id,sha256:'sha',byteLength:1},originalUri:'licketysplit-media://asset/original',durationMs:20000}}))}};await projectManager.saveProjectAs(p);const json=JSON.parse(store.get('/tmp/proj.oreel')!);expect(json).toMatchObject({version:'1.4.0',minimumReaderVersion:'1.3.0'});expect(JSON.stringify(json)).not.toContain('nativeSource');expect((await projectManager.openProject())?.lickety?.words?.[0].sourceWordId).toBe('w');});
