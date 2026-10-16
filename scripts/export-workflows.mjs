// Writes sample API-format graphs to workflows/ so people can inspect, diff, or POST them to ComfyUI by hand.
import { writeFileSync } from 'node:fs';
import { buildWorkflow } from '../server/workflows.js';

const base = { video: 'sample.mp4', images: ['reference.png'], prompt: 'a knight in ornate armor', src: { w: 1920, h: 1080 }, seconds: 5, seed: 1 };
const samples = {
  motion_transfer: { ...base, mode: 'motion_transfer' },
  object_swap: { ...base, mode: 'object_swap', positive: [{ x: 0.5, y: 0.5 }], negative: [{ x: 0.1, y: 0.1 }] },
};
for (const [name, body] of Object.entries(samples)) {
  const { graph } = buildWorkflow(body);
  writeFileSync(new URL(`../workflows/${name}.api.json`, import.meta.url), JSON.stringify(graph, null, 2) + '\n');
  console.log(`workflows/${name}.api.json (${Object.keys(graph).length} nodes)`);
}
