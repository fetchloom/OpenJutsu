// Run against a LIVE ComfyUI (e.g. on your cloud GPU pod): COMFY_URL=http://pod:8188 npm run validate-comfy
// Checks that every node class and every combo value our graphs use actually exists in that install.
import { ComfyClient } from '../server/comfy.js';
import { buildWorkflow, MODELS } from '../server/workflows.js';

const url = process.env.COMFY_URL;
if (!url) { console.error('Set COMFY_URL'); process.exit(2); }
const info = await new ComfyClient(url, { apiKey: process.env.COMFY_API_KEY }).objectInfo();

const base = { video: 'x.mp4', images: ['r.png'], src: { w: 1920, h: 1080 }, seconds: 5, seed: 1 };
const cases = [
  { ...base, mode: 'motion_transfer', control: 'pose' },
  { ...base, mode: 'motion_transfer', control: 'depth' },
  ...Object.keys(MODELS.tiers).map((tier) => ({ ...base, mode: 'motion_transfer', tier })),
  { ...base, mode: 'object_swap', positive: [{ x: 0.5, y: 0.5 }] },
];
const problems = new Set();
for (const c of cases) {
  const { graph } = buildWorkflow(c);
  for (const [id, n] of Object.entries(graph)) {
    const def = info[n.class_type];
    if (!def) { problems.add(`missing node class: ${n.class_type}`); continue; }
    const specs = { ...def.input?.required, ...def.input?.optional };
    for (const [k, v] of Object.entries(n.inputs)) {
      if (!(k in specs)) { problems.add(`${n.class_type}: unknown input "${k}"`); continue; }
      const opts = Array.isArray(specs[k]?.[0]) ? specs[k][0] : null; // combo list
      if (opts && typeof v === 'string' && !opts.includes(v) && !['file', 'image'].includes(k))
        problems.add(`${n.class_type}.${k}: "${v}" not in [${opts.slice(0, 6).join(', ')}${opts.length > 6 ? ', …' : ''}]`);
    }
  }
}
if (problems.size) { console.error('PROBLEMS:\n- ' + [...problems].join('\n- ')); process.exit(1); }
console.log(`OK: ${cases.length} graphs match this ComfyUI install`);
