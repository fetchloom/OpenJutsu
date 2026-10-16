// OpenJutsu web UI. Plain ES modules, no build step.
const $ = (id) => document.getElementById(id);
const HELP = {
  motion_transfer: 'Keep a clip\'s movement and timing, rebuild the cast, setting or style around it.',
  object_swap: 'Change one element (a person, outfit, product or place) and leave the rest of the shot as filmed.',
};

const state = {
  mode: 'motion_transfer', config: null, video: null, // { name, url, w, h }
  refs: [], // { name, dataUrl }
  positive: [], negative: [], preset: null,
};

const headers = () => {
  const t = $('token').value.trim();
  return t ? { authorization: `Bearer ${t}` } : {};
};
const showError = (msg) => { $('err').textContent = msg || ''; $('err').hidden = !msg; };

async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `request failed (${res.status})`);
  return data;
}

async function upload(file, kind) {
  const res = await fetch(`/api/upload?kind=${kind}`, { method: 'POST', body: file, headers: { ...headers(), 'x-filename': file.name } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `upload failed (${res.status})`);
  return data.name;
}

// ---- mode + presets -------------------------------------------------------
function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  $('modeHelp').textContent = HELP[mode];
  $('controlWrap').hidden = mode !== 'motion_transfer';
  $('pickHint').hidden = mode !== 'object_swap' || !state.video;
  $('stage').classList.toggle('pickable', mode === 'object_swap');
  $('preview').controls = mode !== 'object_swap'; // the picker canvas sits on top of native controls
  state.preset = null;
  renderPresets();
  drawPoints();
  refreshGo();
}

function renderPresets() {
  const box = $('presets');
  box.replaceChildren();
  for (const p of state.config.presets.filter((x) => x.mode === state.mode)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.textContent = p.name;
    b.setAttribute('aria-pressed', String(state.preset === p.id));
    b.addEventListener('click', () => {
      state.preset = state.preset === p.id ? null : p.id;
      if (state.preset) $('prompt').value = p.prompt;
      renderPresets(); refreshGo();
    });
    box.append(b);
  }
}

// ---- source video + point picker -------------------------------------------
async function onVideo(file) {
  showError('');
  if (!file) return;
  $('videoDropText').textContent = 'Uploading…';
  try {
    const url = URL.createObjectURL(file);
    const v = $('preview');
    v.src = url;
    await new Promise((ok, no) => { v.onloadedmetadata = ok; v.onerror = () => no(new Error('this browser cannot read that video')); });
    const name = await upload(file, 'video');
    state.video = { name, url, w: v.videoWidth, h: v.videoHeight, duration: v.duration };
    state.positive = []; state.negative = [];
    $('stage').hidden = false; $('trimRow').hidden = false;
    $('videoDropText').textContent = `${file.name} · ${v.videoWidth}×${v.videoHeight} · ${v.duration.toFixed(1)}s (click to replace)`;
    $('seconds').max = String(Math.min(5, Math.floor(v.duration)) || 1);
    $('seconds').value = $('seconds').max;
    setMode(state.mode);
    seekToStart();
  } catch (e) {
    state.video = null;
    $('videoDropText').textContent = 'Drop a video or click to upload';
    showError(e.message);
  }
  refreshGo();
}

function seekToStart() {
  const v = $('preview');
  if (v.readyState >= 1) v.currentTime = Math.min(Number($('start').value) || 0, Math.max(0, v.duration - 0.05));
}

// Rect of the actual picture inside the letterboxed <video> element.
function contentRect() {
  const v = $('preview');
  const bw = v.clientWidth, bh = v.clientHeight;
  const s = Math.min(bw / v.videoWidth, bh / v.videoHeight);
  const w = v.videoWidth * s, h = v.videoHeight * s;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

function drawPoints() {
  const c = $('pick');
  if (!state.video) return;
  const dpr = devicePixelRatio || 1;
  c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  if (state.mode !== 'object_swap') return;
  const r = contentRect();
  for (const [list, color] of [[state.positive, '#3ecf8e'], [state.negative, '#ff6b6b']]) {
    for (const p of list) {
      g.beginPath(); g.arc(r.x + p.x * r.w, r.y + p.y * r.h, 7, 0, Math.PI * 2);
      g.fillStyle = color; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
    }
  }
}

function addPoint(ev, negative) {
  ev.preventDefault();
  const r = contentRect(), box = $('pick').getBoundingClientRect();
  const x = (ev.clientX - box.left - r.x) / r.w, y = (ev.clientY - box.top - r.y) / r.h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  (negative ? state.negative : state.positive).push({ x: +x.toFixed(4), y: +y.toFixed(4) });
  drawPoints(); refreshGo();
}

// ---- reference images -------------------------------------------------------
async function onRefs(files) {
  showError('');
  const room = state.config.limits.maxRefs - state.refs.length;
  for (const f of [...files].slice(0, room)) {
    try {
      const name = await upload(f, 'image');
      const dataUrl = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(f); });
      state.refs.push({ name, dataUrl });
    } catch (e) { showError(e.message); }
  }
  renderRefs(); refreshGo();
}

function renderRefs() {
  const box = $('refs');
  for (const t of box.querySelectorAll('.thumb')) t.remove();
  state.refs.forEach((r, i) => {
    const t = document.createElement('div');
    t.className = 'thumb'; t.style.backgroundImage = `url("${r.dataUrl}")`;
    const x = document.createElement('button');
    x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove reference image');
    x.addEventListener('click', () => { state.refs.splice(i, 1); renderRefs(); refreshGo(); });
    t.append(x);
    box.insertBefore(t, box.querySelector('.add'));
  });
  $('refCount').textContent = `${state.refs.length}/${state.config.limits.maxRefs}`;
  box.querySelector('.add').hidden = state.refs.length >= state.config.limits.maxRefs;
}

// ---- generate ---------------------------------------------------------------
function refreshGo() {
  const hasInput = state.refs.length > 0 || $('prompt').value.trim().length > 0;
  const needsMask = state.mode === 'object_swap' && state.positive.length === 0;
  $('go').disabled = !state.video || !hasInput || needsMask;
  $('go').title = !state.video ? 'Upload a source video first' : needsMask ? 'Click the object to swap on the video' : !hasInput ? 'Add a reference image or a prompt' : '';
}

async function generate() {
  showError('');
  $('go').disabled = true;
  try {
    const seed = $('seed').value.trim();
    const body = {
      mode: state.mode, video: state.video.name, images: state.refs.map((r) => r.name), prompt: $('prompt').value.trim(),
      src: { w: state.video.w, h: state.video.h }, start: Number($('start').value) || 0, seconds: Number($('seconds').value) || 5,
      tier: $('tier').value, resolution: $('resolution').value, control: $('control').value, strength: Number($('strength').value) || 1,
      positive: state.positive, negative: state.negative, ...(seed ? { seed: Number(seed) } : {}),
    };
    const { id } = await api('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    addJob(id, state.mode, state.video.url, Number($('start').value) || 0);
  } catch (e) { showError(e.message); }
  refreshGo();
}

function addJob(id, mode, sourceUrl, start) {
  $('empty').hidden = true;
  const el = document.createElement('div');
  el.className = 'job';
  const head = document.createElement('div'); head.className = 'job-head';
  const title = document.createElement('span'); title.textContent = `${mode === 'motion_transfer' ? 'Motion Transfer' : 'Object Swap'} · ${id.slice(0, 8)}`;
  const status = document.createElement('span'); status.textContent = 'queued';
  head.append(title, status);
  const bar = document.createElement('div'); bar.className = 'bar'; const fill = document.createElement('i'); fill.style.width = '3%'; bar.append(fill);
  el.append(head, bar);
  $('jobs').prepend(el);

  const timer = setInterval(async () => {
    try {
      const s = await api(`/api/jobs/${id}`);
      status.textContent = s.status; status.className = `status-${s.status}`;
      if (s.progress != null) fill.style.width = `${Math.round(s.progress * 100)}%`;
      if (s.status === 'done') { clearInterval(timer); bar.remove(); showResult(el, id, s.output, sourceUrl, start); }
      if (s.status === 'error') { clearInterval(timer); bar.remove(); const p = document.createElement('p'); p.className = 'err'; p.textContent = s.error || 'failed'; el.append(p); }
    } catch (e) { status.textContent = e.message; }
  }, 2000);
}

async function showResult(el, id, url, sourceUrl, start) {
  // The output goes through fetch so the bearer token is sent; <video src> can't set headers.
  const res = await fetch(url, { headers: headers() });
  const blobUrl = URL.createObjectURL(await res.blob());
  const mk = (label, src) => {
    const f = document.createElement('figure'); const v = document.createElement('video');
    v.src = src; v.muted = true; v.loop = true; v.playsInline = true; v.controls = true;
    const c = document.createElement('figcaption'); c.textContent = label; f.append(v, c); return { f, v };
  };
  const a = mk('Original', sourceUrl), b = mk('OpenJutsu', blobUrl);
  a.v.addEventListener('loadedmetadata', () => { a.v.currentTime = start; }, { once: true });
  const wrap = document.createElement('div'); wrap.className = 'compare'; wrap.append(a.f, b.f);
  const actions = document.createElement('div'); actions.className = 'actions';
  const play = document.createElement('button'); play.type = 'button'; play.textContent = 'Play both';
  play.addEventListener('click', () => { a.v.currentTime = start; b.v.currentTime = 0; a.v.play(); b.v.play(); });
  const dl = document.createElement('a'); dl.href = blobUrl; dl.download = `openjutsu-${id.slice(0, 8)}.webm`; dl.textContent = 'Download';
  actions.append(play, dl);
  el.append(wrap, actions);
}

// ---- boot -------------------------------------------------------------------
async function boot() {
  try { $('token').value = localStorage.getItem('oj_token') || ''; } catch {}
  state.config = await api('/api/config').catch((e) => { showError(e.message + ' (enter the API token under Advanced)'); return null; });
  if (!state.config) { state.config = { presets: [], tiers: ['fast'], limits: { maxRefs: 8 } }; }
  $('mockBadge').hidden = !state.config.mock;
  for (const t of state.config.tiers) $('tier').add(new Option(t, t));
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setMode(b.dataset.mode));
  $('videoFile').addEventListener('change', (e) => onVideo(e.target.files[0]));
  const drop = $('videoDrop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); onVideo(e.dataTransfer.files[0]); });
  $('refFile').addEventListener('change', (e) => { onRefs(e.target.files); e.target.value = ''; });
  $('prompt').addEventListener('input', refreshGo);
  $('token').addEventListener('change', () => { try { localStorage.setItem('oj_token', $('token').value); } catch {} });
  $('start').addEventListener('change', seekToStart);
  $('clearPoints').addEventListener('click', () => { state.positive = []; state.negative = []; drawPoints(); refreshGo(); });
  const pick = $('pick');
  pick.addEventListener('click', (e) => addPoint(e, e.shiftKey));
  pick.addEventListener('contextmenu', (e) => addPoint(e, true));
  new ResizeObserver(drawPoints).observe($('stage'));
  $('go').addEventListener('click', generate);
  setMode('motion_transfer');
  renderRefs();
}
boot();
