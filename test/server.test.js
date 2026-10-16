import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/server.js';

async function start(opts) {
  const server = createApp({ comfyUrl: '', mockMs: 50, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const up = (url, kind, name, body = Buffer.from('fake')) =>
  fetch(`${url}/api/upload?kind=${kind}`, { method: 'POST', body, headers: { 'x-filename': name } });

test('mock end-to-end: upload -> job -> done -> output', async () => {
  const { server, url } = await start();
  try {
    const cfg = await (await fetch(`${url}/api/config`)).json();
    assert.equal(cfg.mock, true);
    assert.ok(cfg.presets.length >= 6);
    const { name } = await (await up(url, 'video', 'clip.mp4')).json();
    assert.match(name, /^[0-9a-f-]{36}\.mp4$/); // client file name is never reused
    const r = await fetch(`${url}/api/jobs`, { method: 'POST', body: JSON.stringify({ mode: 'motion_transfer', video: name, prompt: 'anime', src: { w: 1280, h: 720 } }) });
    assert.equal(r.status, 202);
    const { id } = await r.json();
    await new Promise((r) => setTimeout(r, 120));
    const s = await (await fetch(`${url}/api/jobs/${id}`)).json();
    assert.equal(s.status, 'done');
    const out = await fetch(`${url}${s.output}`);
    assert.equal(out.status, 200);
    assert.equal(Buffer.from(await out.arrayBuffer()).toString(), 'fake');
  } finally { server.close(); }
});

test('rejects bad uploads and bad jobs', async () => {
  const { server, url } = await start();
  try {
    assert.equal((await up(url, 'video', 'evil.exe')).status, 400);
    assert.equal((await up(url, 'image', 'a.mp4')).status, 400);
    assert.equal((await up(url, 'video', 'a.mp4', Buffer.alloc(0))).status, 400);
    const bad = await fetch(`${url}/api/jobs`, { method: 'POST', body: JSON.stringify({ mode: 'object_swap', video: 'x.mp4', prompt: 'p', src: { w: 1, h: 1 } }) });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${url}/api/jobs`, { method: 'POST', body: '{' })).status, 400);
    assert.equal((await fetch(`${url}/api/jobs/00000000-0000-0000-0000-000000000000`)).status, 404);
  } finally { server.close(); }
});

test('static server blocks path traversal', async () => {
  const { server, url } = await start();
  try {
    assert.equal((await fetch(`${url}/`)).status, 200);
    const raw = await new Promise((resolve) => {
      import('node:net').then(({ connect }) => {
        const s = connect(server.address().port, '127.0.0.1', () => s.write('GET /../package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
        let d = ''; s.on('data', (c) => (d += c)); s.on('end', () => resolve(d));
      });
    });
    assert.doesNotMatch(raw, /"name": "openjutsu"/);
  } finally { server.close(); }
});

test('token auth gates the API but not the page', async () => {
  const { server, url } = await start({ token: 'secret' });
  try {
    assert.equal((await fetch(`${url}/api/config`)).status, 401);
    assert.equal((await fetch(`${url}/api/config`, { headers: { authorization: 'Bearer secret' } })).status, 200);
    assert.equal((await fetch(`${url}/`)).status, 200);
  } finally { server.close(); }
});
