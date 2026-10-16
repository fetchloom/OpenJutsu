import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflow, checkGraph, frameCount, ValidationError } from '../server/workflows.js';

const base = { video: 'a.mp4', images: ['r.png'], src: { w: 1920, h: 1080 }, seconds: 5, seed: 7 };
const classes = (g) => new Set(Object.values(g).map((n) => n.class_type));

test('frameCount obeys the 4n+1 rule and the 5s cap', () => {
  assert.equal(frameCount(5), 81);
  assert.equal(frameCount(30), 81);
  assert.equal(frameCount(1), 17);
  for (const s of [1, 2, 3, 4, 5]) assert.equal((frameCount(s) - 1) % 4, 0);
  assert.throws(() => frameCount(0), ValidationError);
});

test('motion transfer graph is self-consistent and uses VACE', () => {
  const { graph } = buildWorkflow({ ...base, mode: 'motion_transfer' });
  assert.deepEqual(checkGraph(graph), []);
  assert.ok(classes(graph).has('WanVaceToVideo') && classes(graph).has('DWPreprocessor'));
  assert.ok(!classes(graph).has('Sam2Segmentation'));
});

test('depth control swaps the preprocessor', () => {
  const { graph } = buildWorkflow({ ...base, mode: 'motion_transfer', control: 'depth' });
  assert.ok(classes(graph).has('DepthAnythingV2Preprocessor') && !classes(graph).has('DWPreprocessor'));
});

test('object swap graph masks, composites and feeds VACE', () => {
  const { graph } = buildWorkflow({ ...base, mode: 'object_swap', positive: [{ x: 0.5, y: 0.5 }] });
  assert.deepEqual(checkGraph(graph), []);
  for (const c of ['Sam2Segmentation', 'GrowMask', 'ImageCompositeMasked', 'WanVaceToVideo']) assert.ok(classes(graph).has(c), c);
  const vace = Object.values(graph).find((n) => n.class_type === 'WanVaceToVideo');
  assert.ok(vace.inputs.control_masks && vace.inputs.control_video);
});

test('object swap requires a positive point', () => {
  assert.throws(() => buildWorkflow({ ...base, mode: 'object_swap' }), /positive mask point/);
});

test('mask points are mapped through the center-crop to generation pixels', () => {
  // 1920x1080 -> 832x480 (cover scale 0.4444): center of frame must land at the center of 832x480.
  const { graph } = buildWorkflow({ ...base, mode: 'object_swap', positive: [{ x: 0.5, y: 0.5 }] });
  const seg = Object.values(graph).find((n) => n.class_type === 'Sam2Segmentation');
  assert.deepEqual(JSON.parse(seg.inputs.coordinates_positive), [{ x: 416, y: 240 }]);
  // A portrait source gets center-cropped vertically into a 480x832 frame... and a square into 624x624.
  const sq = buildWorkflow({ ...base, src: { w: 1000, h: 1000 }, mode: 'object_swap', positive: [{ x: 0, y: 0 }] });
  const s2 = Object.values(sq.graph).find((n) => n.class_type === 'Sam2Segmentation');
  assert.deepEqual(JSON.parse(s2.inputs.coordinates_positive), [{ x: 0, y: 0 }]);
});

test('a click in the cropped-away border is rejected, not silently misplaced', () => {
  // 21:9 source squeezed into 16:9: horizontal edges are cropped.
  assert.throws(() => buildWorkflow({ ...base, src: { w: 2520, h: 1080 }, mode: 'object_swap', positive: [{ x: 0.01, y: 0.5 }] }), /cropped-away/);
});

test('input validation', () => {
  assert.throws(() => buildWorkflow({ ...base, mode: 'nope' }), /mode/);
  assert.throws(() => buildWorkflow({ ...base, mode: 'motion_transfer', images: [], prompt: '' }), /reference image or a prompt/);
  assert.throws(() => buildWorkflow({ ...base, mode: 'motion_transfer', images: Array(9).fill('x.png') }), /at most/);
  assert.throws(() => buildWorkflow({ ...base, mode: 'motion_transfer', tier: 'ultra' }), /tier/);
  assert.throws(() => buildWorkflow({ ...base, src: undefined, mode: 'motion_transfer' }), /src/);
  assert.throws(() => buildWorkflow({ ...base, mode: 'object_swap', positive: [{ x: 5, y: 5 }] }), /normalized/);
});

test('several references are chained with ImageBatch', () => {
  const { graph } = buildWorkflow({ ...base, mode: 'motion_transfer', images: ['a.png', 'b.png', 'c.png'] });
  assert.equal(Object.values(graph).filter((n) => n.class_type === 'ImageBatch').length, 2);
  assert.deepEqual(checkGraph(graph), []);
});
