// Builds ComfyUI API-format graphs for each OpenJutsu mode.
// Core nodes only, except: comfyui_controlnet_aux (DWPreprocessor, DepthAnythingV2Preprocessor)
// and ComfyUI-segment-anything-2 (DownloadAndLoadSAM2Model, Sam2Segmentation).
import { readFileSync } from 'node:fs';

const MODELS = JSON.parse(readFileSync(new URL('../models.json', import.meta.url), 'utf8'));

export const FPS = 16; // Wan native frame rate
export const MAX_FRAMES = 81; // 5 s per segment at 16 fps (4n+1 rule)
export const MAX_REFS = 8;

const SIZES = {
  '480p': { landscape: [832, 480], portrait: [480, 832], square: [624, 624] },
  '720p': { landscape: [1280, 720], portrait: [720, 1280], square: [960, 960] },
};

const NEGATIVE =
  'blurry, low quality, jpeg artifacts, static, deformed, extra limbs, bad hands, flicker, watermark, text, subtitles';

class Graph {
  constructor() {
    this.nodes = {};
    this.n = 0;
  }
  add(class_type, inputs) {
    const id = String(++this.n);
    this.nodes[id] = { class_type, inputs };
    return id;
  }
}
const out = (id, slot = 0) => [id, slot];

export class ValidationError extends Error {}

export function frameCount(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) throw new ValidationError('seconds must be a positive number');
  const raw = Math.min(MAX_FRAMES, Math.round(s * FPS));
  return Math.min(MAX_FRAMES, Math.max(5, Math.round((raw - 1) / 4) * 4 + 1));
}

export function validateParams(p) {
  if (!p || typeof p !== 'object') throw new ValidationError('body must be an object');
  if (!['motion_transfer', 'object_swap'].includes(p.mode)) throw new ValidationError('mode must be motion_transfer or object_swap');
  if (typeof p.video !== 'string' || !p.video) throw new ValidationError('video is required');
  const refs = Array.isArray(p.images) ? p.images : [];
  if (refs.length > MAX_REFS) throw new ValidationError(`at most ${MAX_REFS} reference images`);
  if (refs.some((r) => typeof r !== 'string' || !r)) throw new ValidationError('images must be file names');
  if (!refs.length && !String(p.prompt || '').trim()) throw new ValidationError('provide a reference image or a prompt');
  const prompt = String(p.prompt || '');
  if (prompt.length > 1500) throw new ValidationError('prompt too long');
  const tier = p.tier ?? 'fast';
  if (!MODELS.tiers[tier]) throw new ValidationError('unknown tier');
  const res = p.resolution ?? '480p';
  if (!SIZES[res]) throw new ValidationError('unknown resolution');
  const sw = Number(p.src?.w), sh = Number(p.src?.h);
  if (!(sw > 0 && sh > 0)) throw new ValidationError('src.w and src.h (source video size) are required');
  const ratio = sw / sh;
  const aspect = ratio > 1.2 ? 'landscape' : ratio < 0.83 ? 'portrait' : 'square';
  const [W, H] = SIZES[res][aspect];
  const control = p.control ?? 'pose';
  if (!['pose', 'depth'].includes(control)) throw new ValidationError('control must be pose or depth');
  // Click points arrive normalized (0..1) on the ORIGINAL frame. ImageScale(crop=center) covers W x H
  // then crops, so map through the same scale + crop offset to get pixels in the generation frame.
  const cover = Math.max(W / sw, H / sh);
  const offX = (sw * cover - W) / 2, offY = (sh * cover - H) / 2;
  const points = (a) =>
    (Array.isArray(a) ? a : []).slice(0, 32).map((q) => {
      const nx = Number(q?.x), ny = Number(q?.y);
      if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) throw new ValidationError('mask points must be normalized 0..1');
      const x = Math.round(nx * sw * cover - offX), y = Math.round(ny * sh * cover - offY);
      if (x < 0 || y < 0 || x >= W || y >= H) throw new ValidationError('a mask point falls in the cropped-away border; click nearer the center');
      return { x, y };
    });
  const positive = points(p.positive);
  const negative = points(p.negative);
  if (p.mode === 'object_swap' && !positive.length) throw new ValidationError('object_swap needs at least one positive mask point');
  const start = Number(p.start ?? 0);
  if (!Number.isFinite(start) || start < 0) throw new ValidationError('start must be >= 0');
  const seed = Number.isInteger(p.seed) ? p.seed : Math.floor(Math.random() * 2 ** 32);
  return {
    mode: p.mode, video: p.video, images: refs, prompt, tier, resolution: res, aspect, control,
    positive, negative, start, seed, frames: frameCount(p.seconds ?? 5),
    strength: Math.min(2, Math.max(0.2, Number(p.strength ?? 1)) || 1),
  };
}

// Shared front half: models, prompts, trimmed + resized source frames, reference batch.
function head(g, p) {
  const tier = MODELS.tiers[p.tier];
  const [w, h] = SIZES[p.resolution][p.aspect];
  const unet = g.add('UNETLoader', { unet_name: tier.unet, weight_dtype: 'default' });
  const model = g.add('ModelSamplingSD3', { model: out(unet), shift: 8 });
  const clip = g.add('CLIPLoader', { clip_name: MODELS.clip, type: 'wan', device: 'default' });
  const vae = g.add('VAELoader', { vae_name: MODELS.vae });
  const pos = g.add('CLIPTextEncode', { text: p.prompt || 'high quality video', clip: out(clip) });
  const neg = g.add('CLIPTextEncode', { text: NEGATIVE, clip: out(clip) });

  const load = g.add('LoadVideo', { file: p.video });
  const slice = g.add('Video Slice', { video: out(load), start_time: p.start, duration: p.frames / FPS + 0.5, strict_duration: false });
  const comps = g.add('GetVideoComponents', { video: out(slice) });
  const frames = g.add('ImageFromBatch', { image: out(comps, 0), batch_index: 0, length: p.frames });
  const scaled = g.add('ImageScale', { image: out(frames), upscale_method: 'lanczos', width: w, height: h, crop: 'center' });

  let ref = null;
  for (const file of p.images) {
    const li = g.add('LoadImage', { image: file });
    const sc = g.add('ImageScale', { image: out(li), upscale_method: 'lanczos', width: w, height: h, crop: 'center' });
    ref = ref ? g.add('ImageBatch', { image1: out(ref), image2: out(sc) }) : sc;
  }
  return { g, tier, w, h, model, vae, pos, neg, scaled, ref };
}

// Shared back half: VACE conditioning -> sample -> trim -> decode -> save.
function tail(c, p, vaceInputs) {
  const { g } = c;
  const vace = g.add('WanVaceToVideo', {
    positive: out(c.pos), negative: out(c.neg), vae: out(c.vae),
    width: c.w, height: c.h, length: p.frames, batch_size: 1, strength: p.strength,
    ...vaceInputs,
  });
  const ks = g.add('KSampler', {
    model: out(c.model), seed: p.seed, steps: c.tier.steps, cfg: c.tier.cfg,
    sampler_name: 'uni_pc', scheduler: 'simple',
    positive: out(vace, 0), negative: out(vace, 1), latent_image: out(vace, 2), denoise: 1,
  });
  const trim = g.add('TrimVideoLatent', { samples: out(ks), trim_amount: out(vace, 3) });
  const dec = g.add('VAEDecode', { samples: out(trim), vae: out(c.vae) });
  g.add('SaveWEBM', { images: out(dec), filename_prefix: `openjutsu/${p.mode}`, codec: 'vp9', fps: FPS, crf: 24 });
  return g.nodes;
}

export function motionTransfer(p) {
  const c = head(new Graph(), p);
  const { g } = c;
  // pose: new setting and camera are free; depth: keeps scene layout and camera path.
  const ctrl = p.control === 'depth'
    ? g.add('DepthAnythingV2Preprocessor', { image: out(c.scaled), ckpt_name: MODELS.depth, resolution: Math.min(c.w, c.h) })
    : g.add('DWPreprocessor', {
        image: out(c.scaled), detect_hand: 'enable', detect_body: 'enable', detect_face: 'enable',
        resolution: Math.min(c.w, c.h), bbox_detector: MODELS.pose.bbox, pose_estimator: MODELS.pose.estimator,
      });
  return tail(c, p, { control_video: out(ctrl), ...(c.ref ? { reference_image: out(c.ref) } : {}) });
}

export function objectSwap(p) {
  const c = head(new Graph(), p);
  const { g } = c;
  const sam = g.add('DownloadAndLoadSAM2Model', { model: MODELS.sam2, segmentor: 'video', device: 'cuda', precision: 'bf16' });
  const seg = g.add('Sam2Segmentation', {
    sam2_model: out(sam), image: out(c.scaled), keep_model_loaded: false,
    coordinates_positive: JSON.stringify(p.positive),
    ...(p.negative.length ? { coordinates_negative: JSON.stringify(p.negative) } : {}),
    individual_objects: false,
  });
  const grow = g.add('GrowMask', { mask: out(seg), expand: 8, tapered_corners: true });
  const gray = g.add('EmptyImage', { width: c.w, height: c.h, batch_size: p.frames, color: 8421504 });
  const ctrl = g.add('ImageCompositeMasked', {
    destination: out(c.scaled), source: out(gray), x: 0, y: 0, resize_source: false, mask: out(grow),
  });
  return tail(c, p, { control_video: out(ctrl), control_masks: out(grow), ...(c.ref ? { reference_image: out(c.ref) } : {}) });
}

export function buildWorkflow(raw) {
  const p = validateParams(raw);
  return { params: p, graph: p.mode === 'motion_transfer' ? motionTransfer(p) : objectSwap(p) };
}

// Offline integrity check: every link points at an existing node. Used by tests and CI.
export function checkGraph(graph) {
  const errors = [];
  for (const [id, node] of Object.entries(graph)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1])) {
        if (!graph[v[0]]) errors.push(`node ${id}.${k} -> missing node ${v[0]}`);
      }
    }
  }
  return errors;
}

export { MODELS };
