import { mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HeavyJobQueue, ManagedMediaJobs, MediaRequestControllers } from "./media-jobs";
import { ManagedAssetRegistry } from "./asset-registry";
import { getResourceProfile } from "./resource-policy";

function abortSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("ManagedMediaJobs audio preview cache", () => {
  it("returns a validated completed preview while another job holds the heavy queue", async () => {
    const queue = new HeavyJobQueue();
    let releaseBlocker!: () => void;
    let signalStarted!: () => void;
    const blockerStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const blocker = queue.run(async () => {
      signalStarted();
      await new Promise<void>((resolve) => { releaseBlocker = resolve; });
    }, abortSignal());
    await blockerStarted;

    const registry = {
      audioPreview: vi.fn(async () => ({ path: "/managed/cache/source.m4a", mime: "audio/mp4" })),
      resolve: vi.fn(),
      get: vi.fn(),
    } as unknown as ManagedAssetRegistry;
    const run = vi.fn();
    const jobs = new ManagedMediaJobs(registry, queue, { run });

    await expect(jobs.ensureAudioStream("asset-1", 0, abortSignal(), 1))
      .resolves.toBe("licketysplit-media://asset-1/audio-0-channel-1");
    expect(registry.audioPreview).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(registry.resolve).not.toHaveBeenCalled();

    releaseBlocker();
    await blocker;
  });

  it("rechecks a queued cache miss before starting another transcode", async () => {
    const queue = new HeavyJobQueue();
    let releaseBlocker!: () => void;
    let signalStarted!: () => void;
    const blockerStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const blocker = queue.run(async () => {
      signalStarted();
      await new Promise<void>((resolve) => { releaseBlocker = resolve; });
    }, abortSignal());
    await blockerStarted;

    const registry = {
      audioPreview: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ path: "/managed/cache/source.m4a", mime: "audio/mp4" }),
      get: vi.fn(async () => ({ identity: { assetId: "asset-2", sha256: "sha", byteLength: 2, mediaId: "media" } })),
      resolve: vi.fn(),
    } as unknown as ManagedAssetRegistry;
    const run = vi.fn();
    const jobs = new ManagedMediaJobs(registry, queue, { run });
    const result = jobs.ensureAudioStream("asset-2", 0, abortSignal());
    expect(registry.audioPreview).toHaveBeenCalledTimes(1);

    releaseBlocker();
    await expect(result).resolves.toBe("licketysplit-media://asset-2/audio-0");
    expect(registry.audioPreview).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(registry.resolve).not.toHaveBeenCalled();
    await blocker;
  });
});

describe("HeavyJobQueue scheduling", () => {
  it("does not release the next job when a queued caller is cancelled", async () => {
    const queue = new HeavyJobQueue();
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
    const first = queue.run(async () => {
      firstStarted();
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    }, abortSignal());
    await firstReady;

    const cancelled = new AbortController();
    const cancelledJob = queue.run(async () => { throw new Error("cancelled job must not start"); }, cancelled.signal);
    const starts: string[] = [];
    const next = queue.run(async () => { starts.push("next"); }, abortSignal());
    cancelled.abort(new Error("stale consumer"));
    await expect(cancelledJob).rejects.toThrow("stale consumer");

    let nextSettled = false;
    void next.then(() => { nextSettled = true; });
    await Promise.resolve();
    expect(starts).toEqual([]);
    expect(nextSettled).toBe(false);
    releaseFirst();
    await Promise.all([first, next]);
    expect(starts).toEqual(["next"]);
  });

  it("runs a foreground preparation before pending background work", async () => {
    const queue = new HeavyJobQueue();
    let releaseActive!: () => void;
    let activeStarted!: () => void;
    const activeReady = new Promise<void>((resolve) => { activeStarted = resolve; });
    const active = queue.run(async () => {
      activeStarted();
      await new Promise<void>((resolve) => { releaseActive = resolve; });
    }, abortSignal());
    await activeReady;

    const starts: string[] = [];
    const background = queue.run(async () => { starts.push("background"); }, abortSignal(), "background");
    const normal = queue.run(async () => { starts.push("normal"); }, abortSignal());
    const foreground = queue.run(async () => { starts.push("foreground"); }, abortSignal(), "foreground");
    releaseActive();
    await Promise.all([active, background, normal, foreground]);
    expect(starts).toEqual(["foreground", "normal", "background"]);
  });

  it("promotes an existing background request when foreground joins it", async () => {
    const queue = new HeavyJobQueue();
    let releaseActive!: () => void;
    let activeStarted!: () => void;
    const activeReady = new Promise<void>((resolve) => { activeStarted = resolve; });
    const active = queue.run(async () => {
      activeStarted();
      await new Promise<void>((resolve) => { releaseActive = resolve; });
    }, abortSignal());
    await activeReady;

    const starts: string[] = [];
    const sharedController = new AbortController();
    const background = queue.run(async () => { starts.push("shared"); }, sharedController.signal, "background");
    expect(queue.promote(sharedController.signal, "foreground")).toBe(true);
    const normal = queue.run(async () => { starts.push("normal"); }, abortSignal());
    releaseActive();
    await Promise.all([active, background, normal]);
    expect(starts).toEqual(["shared", "normal"]);
  });

  it("bounds foreground bursts so a queued normal job gets a turn", async () => {
    const queue = new HeavyJobQueue();
    let releaseActive!: () => void;
    let activeStarted!: () => void;
    const activeReady = new Promise<void>((resolve) => { activeStarted = resolve; });
    const active = queue.run(async () => {
      activeStarted();
      await new Promise<void>((resolve) => { releaseActive = resolve; });
    }, abortSignal());
    await activeReady;

    const starts: string[] = [];
    const foreground = [1, 2, 3, 4].map((n) => queue.run(async () => { starts.push(`foreground-${n}`); }, abortSignal(), "foreground"));
    const normal = queue.run(async () => { starts.push("normal"); }, abortSignal());
    releaseActive();
    await Promise.all([active, ...foreground, normal]);
    expect(starts).toEqual(["foreground-1", "foreground-2", "foreground-3", "normal", "foreground-4"]);
  });

  it("eventually runs aged background work during sustained higher-priority traffic", async () => {
    const now=vi.spyOn(Date,"now").mockReturnValue(1_000);
    try{
      const queue=new HeavyJobQueue();
      let releaseActive!:()=>void;
      let activeStarted!:()=>void;
      const activeReady=new Promise<void>(resolve=>{activeStarted=resolve;});
      const active=queue.run(async()=>{activeStarted();await new Promise<void>(resolve=>{releaseActive=resolve;});},abortSignal());
      await activeReady;
      const starts:string[]=[];
      const background=queue.run(async()=>{starts.push("background");},abortSignal(),"background");
      const normal=queue.run(async()=>{starts.push("normal");},abortSignal());
      const foreground=[1,2,3,4].map(n=>queue.run(async()=>{starts.push(`foreground-${n}`);},abortSignal(),"foreground"));
      now.mockReturnValue(12_000);
      releaseActive();
      await Promise.all([active,background,normal,...foreground]);
      expect(starts[0]).toBe("background");
      expect(starts).toContain("normal");
    }finally{now.mockRestore();}
  });
});

describe("MediaRequestControllers", () => {
  it("cancels one request ID independently and keeps legacy asset cancellation", () => {
    const requests = new MediaRequestControllers();
    const first = new AbortController();
    const second = new AbortController();
    const otherAsset = new AbortController();
    requests.register(first, "request-one", "asset-a");
    requests.register(second, "request-two", "asset-a");
    requests.register(otherAsset, "request-three", "asset-b");

    requests.cancel("request-one");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(otherAsset.signal.aborted).toBe(false);
    requests.cancel("asset-a");
    expect(second.signal.aborted).toBe(true);
    expect(otherAsset.signal.aborted).toBe(false);
    requests.remove(first, "request-one", "asset-a");
    requests.remove(second, "request-two", "asset-a");
    requests.remove(otherAsset, "request-three", "asset-b");
  });
});

describe("ManagedMediaJobs proxy cache", () => {
  it("returns a validated completed proxy while another job holds the heavy queue", async () => {
    const queue = new HeavyJobQueue();
    let releaseBlocker!: () => void;
    let blockerStarted!: () => void;
    const started = new Promise<void>((resolve) => { blockerStarted = resolve; });
    const blocker = queue.run(async () => {
      blockerStarted();
      await new Promise<void>((resolve) => { releaseBlocker = resolve; });
    }, abortSignal());
    await started;

    const receipt = {
      assetId: "asset-3", sourceSha256: "sha", proxyUri: "licketysplit-media://asset-3/proxy",
      width: 960, height: 540, sourceStartPTS: 0, proxyStartPTS: 0, durationMs: 1000, version: 1 as const,
    };
    const registry = { receipt: vi.fn(async () => receipt) } as unknown as ManagedAssetRegistry;
    const jobs = new ManagedMediaJobs(registry, queue);
    await expect(jobs.ensureProxy("asset-3", getResourceProfile(16 * 1024 ** 3), abortSignal())).resolves.toEqual(receipt);
    expect(registry.receipt).toHaveBeenCalledOnce();

    releaseBlocker();
    await blocker;
  });

  it("does not deliver a cached proxy after its consumer cancels", async () => {
    let resolveReceipt!:(receipt:unknown)=>void;
    const registry={receipt:vi.fn(()=>new Promise(resolve=>{resolveReceipt=resolve;}))} as unknown as ManagedAssetRegistry;
    const jobs=new ManagedMediaJobs(registry,new HeavyJobQueue());
    const controller=new AbortController();
    const receipt={assetId:"asset-cancel",sourceSha256:"sha",proxyUri:"licketysplit-media://asset-cancel/proxy",width:960,height:540,sourceStartPTS:0,proxyStartPTS:0,durationMs:1000,version:1 as const};
    const result=jobs.ensureProxy("asset-cancel",getResourceProfile(8*1024**3),controller.signal);
    const rejected=expect(result).rejects.toThrow("selection changed");
    controller.abort(new Error("selection changed"));
    resolveReceipt(receipt);
    await rejected;
  });

  it("rebuilds a missing proxy receipt from the registered original", async () => {
    const directory=await mkdtemp(path.join(os.tmpdir(),"lickety-proxy-cache-"));
    try{
      const source=path.join(directory,"original.mov");await writeFile(source,"source bytes");
      const registry=new ManagedAssetRegistry(path.join(directory,"registry"));
      const asset=await registry.registerOriginal("media-missing-proxy",source);
      const proxy=path.join(registry.cacheDir,"cached-proxy.mp4");await writeFile(proxy,"old proxy");
      await registry.promoteProxy(asset.identity.assetId,proxy,{assetId:asset.identity.assetId,sourceSha256:asset.identity.sha256,proxyUri:asset.originalUri,width:960,height:540,sourceStartPTS:0,proxyStartPTS:0,durationMs:1000,version:1});
      await unlink(proxy);
      const run=vi.fn(async(args:string[])=>{await writeFile(args.at(-1)!,"rebuilt proxy");});
      const jobs=new ManagedMediaJobs(registry,new HeavyJobQueue(),{run,probe:async()=>({width:1920,height:1080,durationMs:1000,startPTS:0}),freeBytes:async()=>10*1024**3});
      await expect(jobs.ensureProxy(asset.identity.assetId,getResourceProfile(8*1024**3),abortSignal())).resolves.toMatchObject({sourceSha256:asset.identity.sha256,width:960,height:540});
      expect(run).toHaveBeenCalledOnce();
    }finally{await rm(directory,{recursive:true,force:true});}
  });

  it("requires relinking when a cached proxy source has changed", async () => {
    const directory=await mkdtemp(path.join(os.tmpdir(),"lickety-proxy-relink-"));
    try{
      const source=path.join(directory,"original.mov");await writeFile(source,"source bytes");
      const registry=new ManagedAssetRegistry(path.join(directory,"registry"));
      const asset=await registry.registerOriginal("media-changed-proxy",source);
      const proxy=path.join(registry.cacheDir,"cached-proxy.mp4");await writeFile(proxy,"cached proxy");
      await registry.promoteProxy(asset.identity.assetId,proxy,{assetId:asset.identity.assetId,sourceSha256:asset.identity.sha256,proxyUri:asset.originalUri,width:960,height:540,sourceStartPTS:0,proxyStartPTS:0,durationMs:1000,version:1});
      await writeFile(source,"changed source bytes");await utimes(source,new Date(Date.now()+2000),new Date(Date.now()+2000));
      const probe=vi.fn(async()=>({width:1920,height:1080,durationMs:1000,startPTS:0}));
      const jobs=new ManagedMediaJobs(registry,new HeavyJobQueue(),{run:vi.fn(),probe,freeBytes:async()=>10*1024**3});
      await expect(jobs.ensureProxy(asset.identity.assetId,getResourceProfile(8*1024**3),abortSignal())).rejects.toThrow(/changed|relink/i);
      expect(probe).not.toHaveBeenCalled();
    }finally{await rm(directory,{recursive:true,force:true});}
  });
});

describe("ManagedMediaJobs shared audio preparation", () => {
  it("keeps shared work alive when one of two consumers cancels", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "lickety-media-jobs-"));
    try {
      let releaseRun!: () => void;
      let runStarted!: () => void;
      let underlyingSignal!: AbortSignal;
      const started = new Promise<void>((resolve) => { runStarted = resolve; });
      const get = vi.fn(async () => ({ identity: { assetId: "asset-4", sha256: "sha", byteLength: 2, mediaId: "media" } }));
      const registry = {
        cacheDir: directory,
        audioPreview: vi.fn(async () => undefined),
        get,
        resolve: vi.fn(async () => ({ path: "/source.wav", mime: "audio/wav" })),
        trimDerivedCache: vi.fn(async () => undefined),
        promoteAudioPreview: vi.fn(async () => undefined),
      } as unknown as ManagedAssetRegistry;
      const run = vi.fn(async (args: string[], signal: AbortSignal) => {
        underlyingSignal = signal;
        runStarted();
        await new Promise<void>((resolve, reject) => {
          releaseRun = resolve;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        await writeFile(args.at(-1)!, "prepared audio");
      });
      const jobs = new ManagedMediaJobs(registry, new HeavyJobQueue(), { run });
      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = jobs.ensureAudioStream("asset-4", 0, firstController.signal, 2);
      const second = jobs.ensureAudioStream("asset-4", 0, secondController.signal, 2);
      await started;
      await vi.waitFor(() => expect(get.mock.calls.length).toBeGreaterThanOrEqual(2));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const firstRejected = expect(first).rejects.toThrow("selection changed");
      firstController.abort(new Error("selection changed"));
      await firstRejected;
      expect(underlyingSignal.aborted).toBe(false);
      releaseRun();
      await expect(second).resolves.toBe("licketysplit-media://asset-4/audio-0-channel-2");
      expect(run).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not join work for a different asset with the same source hash", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "lickety-media-jobs-"));
    try {
      const registry = {
        cacheDir: directory,
        audioPreview: vi.fn(async () => undefined),
        get: vi.fn(async (assetId: string) => ({ identity: { assetId, sha256: "same-bytes", byteLength: 2, mediaId: assetId } })),
        resolve: vi.fn(async () => ({ path: "/source.wav", mime: "audio/wav" })),
        trimDerivedCache: vi.fn(async () => undefined),
        promoteAudioPreview: vi.fn(async () => undefined),
      } as unknown as ManagedAssetRegistry;
      const run = vi.fn(async (args: string[]) => { await writeFile(args.at(-1)!, "prepared audio"); });
      const jobs = new ManagedMediaJobs(registry, new HeavyJobQueue(), { run });
      await jobs.ensureAudioStream("asset-a", 0, abortSignal());
      await jobs.ensureAudioStream("asset-b", 0, abortSignal());
      expect(run).toHaveBeenCalledTimes(2);
      expect(registry.promoteAudioPreview).toHaveBeenNthCalledWith(1, "asset-a", 0, expect.any(String), undefined);
      expect(registry.promoteAudioPreview).toHaveBeenNthCalledWith(2, "asset-b", 0, expect.any(String), undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("promotes shared background work when a foreground consumer joins", async () => {
    const directory=await mkdtemp(path.join(os.tmpdir(),"lickety-media-jobs-"));
    try{
      const queue=new HeavyJobQueue();
      let releaseActive!:()=>void;
      let activeStarted!:()=>void;
      const activeReady=new Promise<void>(resolve=>{activeStarted=resolve;});
      const active=queue.run(async()=>{activeStarted();await new Promise<void>(resolve=>{releaseActive=resolve;});},abortSignal());
      await activeReady;
      const get=vi.fn(async()=>({identity:{assetId:"asset-priority",sha256:"sha",byteLength:2,mediaId:"media"}}));
      const registry={cacheDir:directory,audioPreview:vi.fn(async()=>undefined),get,resolve:vi.fn(async()=>({path:"/source.wav",mime:"audio/wav"})),trimDerivedCache:vi.fn(async()=>undefined),promoteAudioPreview:vi.fn(async()=>undefined)} as unknown as ManagedAssetRegistry;
      const order:string[]=[];
      const run=vi.fn(async(args:string[])=>{order.push("shared");await writeFile(args.at(-1)!,"prepared audio");});
      const jobs=new ManagedMediaJobs(registry,queue,{run});
      const background=jobs.ensureAudioStream("asset-priority",0,abortSignal(),undefined,"background");
      await vi.waitFor(()=>expect(get.mock.calls.length).toBeGreaterThanOrEqual(1));
      const normal=queue.run(async()=>{order.push("normal");},abortSignal());
      const foreground=jobs.ensureAudioStream("asset-priority",0,abortSignal(),undefined,"foreground");
      await vi.waitFor(()=>expect(get.mock.calls.length).toBeGreaterThanOrEqual(2));
      await new Promise<void>(resolve=>setImmediate(resolve));
      releaseActive();
      await Promise.all([active,background,foreground,normal]);
      expect(order).toEqual(["shared","normal"]);
    }finally{await rm(directory,{recursive:true,force:true});}
  });

  it("starts a fresh preparation after the last consumer cancels", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "lickety-media-jobs-"));
    try {
      let firstStarted!: () => void;
      const started = new Promise<void>((resolve) => { firstStarted = resolve; });
      const registry = {
        cacheDir: directory,
        audioPreview: vi.fn(async () => undefined),
        get: vi.fn(async () => ({ identity: { assetId: "asset-retry", sha256: "sha", byteLength: 2, mediaId: "media" } })),
        resolve: vi.fn(async () => ({ path: "/source.wav", mime: "audio/wav" })),
        trimDerivedCache: vi.fn(async () => undefined),
        promoteAudioPreview: vi.fn(async () => undefined),
      } as unknown as ManagedAssetRegistry;
      let attempts=0;
      const run=vi.fn(async (args:string[],signal:AbortSignal)=>{
        attempts++;
        if(attempts===1){firstStarted();await new Promise<void>((_resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));}
        await writeFile(args.at(-1)!,"prepared audio");
      });
      const jobs=new ManagedMediaJobs(registry,new HeavyJobQueue(),{run});
      const cancelled=new AbortController();
      const first=jobs.ensureAudioStream("asset-retry",0,cancelled.signal);
      await started;
      const firstRejected=expect(first).rejects.toThrow("source replaced");
      cancelled.abort(new Error("source replaced"));
      const retry=jobs.ensureAudioStream("asset-retry",0,abortSignal());
      await firstRejected;
      await expect(retry).resolves.toBe("licketysplit-media://asset-retry/audio-0");
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory,{recursive:true,force:true});
    }
  });
});
