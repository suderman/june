#!/usr/bin/env node
// Read-only source/normalization geometry. Does not ingest, upscale, segment or write files.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CANVAS, FACE, MARGIN, MAX_WIDTH, WIDTH_STEP, parseBox, parseNumbers, placePose } from '../../../../art/layout.mjs';

const help = `Usage: node preflight-pose.mjs SOURCE --face X,Y,W,H
  [--gesture NAME,X,Y,W,H]... [--normalized EXISTING.webp] [--max-width WIDTH]
Print JSON only, including explicit width refusals. Zero exit means report produced, not art approved.
SOURCE must already have genuine alpha. Face/gestures use source pixels.
Imports this checkout's actual variable-width placePose and default limit. Requires magick on PATH.`;
const args = process.argv.slice(2);
if (args.includes('--help')) { process.stdout.write(`${help}
`); process.exit(0); }
const source = args.shift();
let face, normalized, maxWidth = MAX_WIDTH;
const gestures = [];
try {
 if (!source) throw new Error(help);
 while (args.length) {
  const key = args.shift(), value = args.shift();
  if (!value) throw new Error(`Missing value for ${key}`);
  if (key === '--face') face = parseNumbers(value, 4);
  else if (key === '--normalized') normalized = value;
  else if (key === '--max-width') maxWidth = Number(value);
  else if (key === '--gesture') {
   const [name, ...parts] = value.split(',');
   if (!name || parts.length !== 4) throw new Error('Gesture needs NAME,X,Y,W,H');
   gestures.push({ name, box: parseNumbers(parts.join(','), 4) });
  } else throw new Error(`Unknown option ${key}`);
 }
 const magick = (...a) => execFileSync('magick', a, { maxBuffer: 64 * 1024 * 1024 });
 const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
 const image = path => {
  const [w, h] = String(magick(path, '-format', '%w %h', 'info:')).split(' ').map(Number);
  const alpha = magick(path, '-alpha', 'extract', '-depth', '8', 'gray:-');
  if (alpha.length !== w * h) throw new Error('Expected one image frame');
  const box = parseBox(magick(path, '-alpha', 'extract', '-threshold', '50%', '-bordercolor', 'black', '-border', '1', '-format', '%@', 'info:'));
  if (!box) throw new Error('No solid foreground');
  box.x--; box.y--;
  const edges = { left: 0, right: 0, top: 0, bottom: 0 };
  let transparent = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
   const a = alpha[y * w + x];
   if (!a) transparent++;
   if (a <= 127) continue;
   if (!x) edges.left++;
   if (x === w - 1) edges.right++;
   if (!y) edges.top++;
   if (y === h - 1) edges.bottom++;
  }
  return { w, h, alpha, box, edges, transparent };
 };
 const src = image(source);
 if (!src.transparent) throw new Error('Source has no fully transparent pixels; segment before preflight');
 const valid = b => b && b.every(Number.isFinite) && b[0] >= 0 && b[1] >= 0 && b[2] > 0 && b[3] > 0 && b[0] + b[2] <= src.w && b[1] + b[3] <= src.h;
 if (!valid(face)) throw new Error('Face must be a positive box inside source');
 for (const g of gestures) if (!valid(g.box)) throw new Error(`Invalid gesture box: ${g.name}`);
 if (!Number.isFinite(maxWidth) || maxWidth <= 0) throw new Error('Invalid maximum width');
 const placement = placePose('pose', src.box, { x: face[0], y: face[1], w: face[2], h: face[3] }, { maxWidth });
 const scale = FACE.pose.h * CANVAS.pose[1] / face[3];
 const required = Math.ceil(src.box.w * scale / (1 - 2 * MARGIN));
 const stepped = Math.max(CANVAS.pose[0], Math.ceil((src.box.w * scale / (1 - 2 * MARGIN)) / WIDTH_STEP) * WIDTH_STEP);
 const result = {
  implementation: { layout: fileURLToPath(new URL('../../../../art/layout.mjs', import.meta.url)), layout_sha256: hash(fileURLToPath(new URL('../../../../art/layout.mjs', import.meta.url))), ingester_sha256: hash(fileURLToPath(new URL('../../../../art/june-art.mjs', import.meta.url))), base_canvas: CANVAS.pose, margin: MARGIN, default_max_width: MAX_WIDTH, width_step: WIDTH_STEP },
  source: { file: source, sha256: hash(source), size: [src.w, src.h], face_box: face, solid_alpha_bounds: src.box, solid_edge_pixels: src.edges, note: 'Edge contact is evidence to inspect, not proof of unintended clipping. Bottom contact may be intentional.' },
  current: { placement },
  width_fit: { scale, normalized_silhouette_width: src.box.w * scale, required_width_with_current_side_margin: required, required_stepped_canvas_width: stepped, fits_base_width_by_span: required <= CANVAS.pose[0], max_width: maxWidth, accepted: !placement.refused, classification: placement.refused ? 'Composition review: current ingester refuses this width' : 'Fits current variable-width ingestion; inspect source, anatomy and panels separately' },
  gestures: gestures.map(g => ({ ...g, relative_to_face_in_face_heights: [(g.box[0] - face[0]) / face[3], (g.box[1] - face[1]) / face[3], g.box[2] / face[3], g.box[3] / face[3]] })),
  panel_visibility: 'Not established by normalization. Inspect actual frame/bubble geometry and rendered panels separately.'
 };
 if (!placement.refused) {
 const [W, H] = placement.size;
 // Same resize rounding and source-corner rounding as june-art.mjs. ESRGAN may change alpha edges.
 const raster = { width: Math.round(src.w * placement.scale), height: Math.round(src.h * placement.scale), x: Math.round(placement.x), y: Math.round(placement.y) };
 const sx = raster.width / src.w, sy = raster.height / src.h;
 const transform = b => [raster.x + b[0] * sx, raster.y + b[1] * sy, b[2] * sx, b[3] * sy];
 const overflow = b => ({ left: Math.max(0, -b[0]), right: Math.max(0, b[0] + b[2] - W), top: Math.max(0, -b[1]), bottom: Math.max(0, b[1] + b[3] - H) });
 const lostPixels = b => {
  let total = 0, outside = 0;
  for (let y = Math.floor(b[1]); y < Math.ceil(b[1] + b[3]); y++) for (let x = Math.floor(b[0]); x < Math.ceil(b[0] + b[2]); x++) {
   if (src.alpha[y * src.w + x] <= 127) continue;
   total++;
   const px = raster.x + (x + 0.5) * sx, py = raster.y + (y + 0.5) * sy;
   if (px < 0 || px >= W || py < 0 || py >= H) outside++;
  }
  return { solid_source_pixels: total, projected_outside_canvas: outside };
 };
 const solid = transform([src.box.x, src.box.y, src.box.w, src.box.h]);
 result.current = { placement, raster, normalized_solid_bounds: solid, overflow_px: overflow(solid), ...lostPixels([0, 0, src.w, src.h]) };
 result.gestures = result.gestures.map(g => ({ ...g, normalized_box: transform(g.box), overflow_px: overflow(transform(g.box)), ...lostPixels(g.box) }));
 }
 if (normalized) {
  const out = image(normalized);
  result.actual_normalized = { file: normalized, sha256: hash(normalized), size: [out.w, out.h], solid_alpha_bounds: out.box, solid_edge_pixels: out.edges, size_matches_current_prediction: placement.refused ? null : out.w === placement.size[0] && out.h === placement.size[1], note: 'Existing asset observation only. A size mismatch may indicate an older contract; do not compare its edge counts with the current transform as if they were one run. Upscale/Lanczos can change edges.' };
 }
 process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
} catch (error) {
 console.error(`preflight-pose: ${error.message}`); process.exit(1);
}
