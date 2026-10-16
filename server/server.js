// OpenJutsu API + static web server. Zero dependencies.
//   COMFY_URL=https://your-comfyui:8188 node server/server.js     real GPU backend
//   node server/server.js                                         mock backend (no GPU)
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ComfyClient } from './comfy.js';
import { buildWorkflow, ValidationError, MAX_REFS, MAX_FRAMES, FPS, MODELS } from './workflows.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB = path.join(ROOT, 'web');
const MAX_VIDEO = 200 * 1024 * 1024;
const MAX_IMAGE = 15 * 1024 * 1024;
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' };
const PRESETS = JSON.parse(await readFile(path.join(ROOT, 'presets.json'), 'utf8'));

export function createApp({ comfyUrl = process.env.COMFY_URL, token = process.env.OPENJUTSU_TOKEN, mockMs = 4000 } = {}) {
  const comfy = comfyUrl ? new ComfyClient(comfyUrl, { apiKey: process.env.COMFY_API_KEY }) : null;
  const mockDir = path.join(tmpdir(), 'openjutsu-mock');
  const jobs = new Map(); // id -> { params, comfyId?, created, mockVideo?, mockDone? }
  const hits = new Map(); // ip -> [timestamps]

  const send = (res, code, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
    res.writeHead(code, { 'content-type': isBuf ? 'text/plain' : 'application/json', 'x-content-type-options': 'nosniff', ...headers });
    res.end(isBuf ? body : JSON.stringify(body));
  };

  const limited = (ip) => {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
    list.push(now);
    hits.set(ip, list);
    return list.length > 600;
  };

  const authed = (req) => {
    if (!token) return true;
    const given = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
    const want = Buffer.from(token);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw Object.assign(new Error('file too large'), { status: 413 });
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  async function upload(req, res, url) {
    const kind = url.searchParams.get('kind');
    if (!['video', 'image'].includes(kind)) return send(res, 400, { error: 'kind must be video or image' });
    const ext = path.extname(String(req.headers['x-filename'] || '')).toLowerCase();
    if (!(kind === 'video' ? VIDEO_EXT : IMAGE_EXT).has(ext)) return send(res, 400, { error: `unsupported ${kind} type` });
    const buf = await readBody(req, kind === 'video' ? MAX_VIDEO : MAX_IMAGE);
    if (!buf.length) return send(res, 400, { error: 'empty upload' });
    const name = `${randomUUID()}${ext}`; // never trust the client's file name
    if (comfy) {
      const stored = await comfy.upload(buf, name, MIME[ext]);
      return send(res, 200, { name: stored });
    }
    await mkdir(mockDir, { recursive: true });
    await writeFile(path.join(mockDir, name), buf);
    return send(res, 200, { name });
  }

  async function createJob(req, res) {
    let body;
    try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')); } catch { return send(res, 400, { error: 'invalid JSON' }); }
    const { params, graph } = buildWorkflow(body);
    const id = randomUUID();
    const job = { params, created: Date.now() };
    if (comfy) job.comfyId = await comfy.submit(graph);
    else job.mockVideo = path.join(mockDir, path.basename(params.video));
    jobs.set(id, job);
    if (jobs.size > 500) jobs.delete(jobs.keys().next().value);
    send(res, 202, { id });
  }

  async function jobStatus(id) {
    const job = jobs.get(id);
    if (!job) return null;
    const base = { id, mode: job.params.mode, created: job.created };
    if (!comfy) {
      const elapsed = Date.now() - job.created;
      if (elapsed < mockMs) return { ...base, status: elapsed < 800 ? 'queued' : 'running', progress: Math.min(0.95, elapsed / mockMs) };
      return existsSync(job.mockVideo)
        ? { ...base, status: 'done', progress: 1, output: `/api/jobs/${id}/output` }
        : { ...base, status: 'error', error: 'mock input video missing' };
    }
    const s = await comfy.status(job.comfyId);
    if (s.output) job.output = s.output;
    return { ...base, status: s.status, error: s.error, output: s.status === 'done' ? `/api/jobs/${id}/output` : undefined };
  }

  async function jobOutput(req, res, id) {
    const job = jobs.get(id);
    if (!job) return send(res, 404, { error: 'unknown job' });
    if (!comfy) return serveFile(req, res, job.mockVideo);
    if (!job.output) await jobStatus(id);
    if (!job.output) return send(res, 409, { error: 'job not finished' });
    const up = await comfy.view(job.output);
    res.writeHead(200, { 'content-type': up.headers.get('content-type') || 'video/webm', 'x-content-type-options': 'nosniff', 'content-disposition': `inline; filename="openjutsu-${id.slice(0, 8)}${path.extname(job.output.filename)}"` });
    res.end(Buffer.from(await up.arrayBuffer()));
  }

  function serveFile(req, res, file) {
    if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found');
    const size = statSync(file).size;
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return send(res, 416, 'bad range', { 'content-range': `bytes */${size}` });
      res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'x-content-type-options': 'nosniff' });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'x-content-type-options': 'nosniff' });
    createReadStream(file).pipe(res);
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(WEB, rel);
    if (file !== WEB && !file.startsWith(WEB + path.sep)) return send(res, 403, 'forbidden');
    serveFile(req, res, file);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      if (!p.startsWith('/api/')) return serveStatic(req, res, p);
      if (limited(req.socket.remoteAddress || '?')) return send(res, 429, { error: 'slow down' });
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET' && p === '/api/config')
        return send(res, 200, { mock: !comfy, presets: PRESETS, tiers: Object.keys(MODELS.tiers),
          limits: { maxRefs: MAX_REFS, maxSeconds: Math.floor(MAX_FRAMES / FPS), maxVideoMB: MAX_VIDEO >> 20 } });
      if (req.method === 'POST' && p === '/api/upload') return await upload(req, res, url);
      if (req.method === 'POST' && p === '/api/jobs') return await createJob(req, res);
      const m = /^\/api\/jobs\/([0-9a-f-]{36})(\/output)?$/.exec(p);
      if (m && req.method === 'GET') {
        if (m[2]) return await jobOutput(req, res, m[1]);
        const s = await jobStatus(m[1]);
        return s ? send(res, 200, s) : send(res, 404, { error: 'unknown job' });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof ValidationError) return send(res, 400, { error: e.message });
      if (e.status) return send(res, e.status, { error: e.message });
      console.error(e);
      if (!res.headersSent) send(res, 502, { error: 'backend error' });
    }
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8500);
  const host = process.env.HOST || '127.0.0.1';
  createApp().listen(port, host, () => {
    console.log(`OpenJutsu on http://${host}:${port}  (${process.env.COMFY_URL ? 'ComfyUI: ' + process.env.COMFY_URL : 'MOCK backend, set COMFY_URL for real generation'})`);
  });
}
