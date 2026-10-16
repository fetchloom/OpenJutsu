// Minimal ComfyUI HTTP client (node built-ins only).
import { randomUUID } from 'node:crypto';

export class ComfyClient {
  constructor(baseUrl, { apiKey } = {}) {
    this.base = baseUrl.replace(/\/$/, '');
    this.clientId = randomUUID();
    this.headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  }

  async #json(path, init = {}) {
    const res = await fetch(this.base + path, { ...init, headers: { ...this.headers, ...(init.headers || {}) } });
    const text = await res.text();
    if (!res.ok) throw new Error(`ComfyUI ${path} -> ${res.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : {};
  }

  // Uploads any file (video or image) into ComfyUI's input directory.
  async upload(buffer, filename, contentType = 'application/octet-stream') {
    const boundary = '----openjutsu' + randomUUID().replace(/-/g, '');
    const part = (name, value) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      buffer,
      Buffer.from('\r\n'),
      part('type', 'input'),
      part('overwrite', 'false'),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    const r = await this.#json('/upload/image', { method: 'POST', body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
  }

  async submit(graph) {
    const r = await this.#json('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
    });
    if (r.node_errors && Object.keys(r.node_errors).length) throw new Error('ComfyUI rejected the graph: ' + JSON.stringify(r.node_errors).slice(0, 600));
    return r.prompt_id;
  }

  // -> { status: queued|running|done|error, output?: {filename, subfolder, type}, error? }
  async status(promptId) {
    const hist = await this.#json(`/history/${encodeURIComponent(promptId)}`);
    const h = hist[promptId];
    if (h) {
      if (h.status?.status_str === 'error') {
        const msg = h.status.messages?.find((m) => m[0] === 'execution_error')?.[1];
        return { status: 'error', error: msg?.exception_message || 'ComfyUI execution failed' };
      }
      for (const o of Object.values(h.outputs || {})) {
        const f = (o.images || o.videos || o.gifs || [])[0];
        if (f) return { status: 'done', output: { filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' } };
      }
      if (h.status?.completed) return { status: 'error', error: 'workflow finished without producing a video' };
    }
    const q = await this.#json('/queue');
    const running = (q.queue_running || []).some((e) => e[1] === promptId);
    return { status: running ? 'running' : 'queued' };
  }

  async view({ filename, subfolder, type }) {
    const qs = new URLSearchParams({ filename, subfolder, type });
    const res = await fetch(`${this.base}/view?${qs}`, { headers: this.headers });
    if (!res.ok) throw new Error(`ComfyUI /view -> ${res.status}`);
    return res;
  }

  objectInfo() {
    return this.#json('/object_info');
  }
}
