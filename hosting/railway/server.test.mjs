import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from './server.mjs';

test('production hosting contracts without provider calls', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'licketysplit-hosting-'));
  await writeFile(join(root, 'index.html'), '<html>editor</html>');
  await writeFile(join(root, 'worker.js'), 'self.postMessage("ready")');
  await writeFile(join(root, 'sample.wasm'), Buffer.from([0,97,115,109,1,0,0,0]));
  const server = createServer({ root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true }); });
  await t.test('document headers and application route', async () => {
    const res = await fetch(base + '/editor');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await res.text(), /editor/);
  });
  await t.test('workers and WASM use correct MIME; missing assets are 404', async () => {
    assert.match((await fetch(base+'/worker.js')).headers.get('content-type'), /javascript/);
    assert.equal((await fetch(base+'/sample.wasm')).headers.get('content-type'), 'application/wasm');
    assert.equal((await fetch(base+'/missing.wasm')).status, 404);
    assert.equal((await fetch(base+'/.env')).status, 404);
    assert.equal((await fetch(base+'/%2e%2e%2fsecret')).status, 404);
  });
  await t.test('byte ranges, HEAD and conditional responses', async () => {
    const res = await fetch(base+'/sample.wasm', { headers: {Range:'bytes=0-3'} });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 0-3/8');
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0,97,115,109]);
    assert.equal((await fetch(base+'/sample.wasm', {headers:{Range:'bytes=50-'}})).status,416);
    const head = await fetch(base+'/sample.wasm',{method:'HEAD'});
    assert.equal(head.headers.get('content-length'),'8');
    assert.equal(await head.text(),'');
    assert.equal((await fetch(base+'/sample.wasm',{headers:{'If-None-Match':head.headers.get('etag')}})).status,304);
  });
  await t.test('proxy retains upstream errors and same-origin preflight', async () => {
    const missing = await fetch(base+'/api/proxy/openai/models');
    assert.equal(missing.status,401);
    assert.match((await missing.json()).error,/Missing x-proxy-api-key/);
    assert.equal((await fetch(base+'/api/proxy/unknown/models')).status,400);
    assert.equal((await fetch(base+'/api/proxy/openai/disallowed')).status,403);
    const options = await fetch(base+'/api/proxy/openai/models',{method:'OPTIONS',headers:{Origin:base}});
    assert.equal(options.status,204);
    assert.equal(options.headers.get('access-control-allow-origin'),base);
    assert.equal((await fetch(base+'/api/proxy/openai/models',{method:'POST',headers:{Origin:'https://unrelated.example'}})).status,403);
  });
});
