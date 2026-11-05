// Run with: npm test   (Node 18+)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  segmentAndMeasure, classifyCells, otsuThreshold, fillHoles, labelRegions, cellsToCsv,
} from '../public/js/analysis.js';

const BG = [236, 226, 230];
const CELL = [196, 112, 128];
const PALLOR = [222, 180, 188];

function blank(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[4 * i] = BG[0]; data[4 * i + 1] = BG[1]; data[4 * i + 2] = BG[2]; data[4 * i + 3] = 255; }
  return { data, width: w, height: h };
}
function paint(img, x, y, rgb) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = 4 * (y * img.width + x);
  img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2];
}
// Filled ellipse with optional pale centre (like a normal discocyte)
function ellipse(img, cx, cy, rx, ry, angDeg, pallor = false) {
  const a = (angDeg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const r = Math.ceil(Math.max(rx, ry)) + 1;
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    const dx = x - cx, dy = y - cy;
    const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
    const d = (u * u) / (rx * rx) + (v * v) / (ry * ry);
    if (d <= 1) paint(img, x, y, pallor && d < 0.22 ? PALLOR : CELL);
  }
}
// Crescent = disc minus offset disc
function crescent(img, cx, cy, R, angDeg) {
  const a = (angDeg * Math.PI) / 180, ox = Math.cos(a) * R * 0.62, oy = Math.sin(a) * R * 0.62;
  for (let y = cy - R - 1; y <= cy + R + 1; y++) for (let x = cx - R - 1; x <= cx + R + 1; x++) {
    const in1 = (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
    const in2 = (x - cx - ox) ** 2 + (y - cy - oy) ** 2 <= (R * 0.92) ** 2;
    if (in1 && !in2) paint(img, x, y, CELL);
  }
}

test('otsu separates two levels', () => {
  const g = new Uint8Array(1000);
  g.fill(50, 0, 400); g.fill(200, 400);
  const t = otsuThreshold(g);
  assert.ok(t >= 50 && t < 200, `threshold ${t}`);
});

test('fillHoles fills an enclosed hole only', () => {
  const w = 7, h = 7, m = new Uint8Array(w * h);
  for (let y = 1; y <= 5; y++) for (let x = 1; x <= 5; x++) m[y * w + x] = 1;
  m[3 * w + 3] = 0;
  const f = fillHoles(m, w, h);
  assert.equal(f[3 * w + 3], 1);
  assert.equal(f[0], 0);
});

test('labelRegions counts separate blobs', () => {
  const w = 10, h = 3, m = new Uint8Array(w * h);
  m[11] = m[12] = 1; m[16] = m[17] = 1;
  assert.equal(labelRegions(m, w, h).count, 2);
});

test('circle measures as round', () => {
  const img = blank(120, 120);
  ellipse(img, 60, 60, 22, 22, 0, true);
  const r = segmentAndMeasure(img);
  assert.equal(r.cells.length, 1);
  const c = r.cells[0];
  assert.ok(c.circularity > 0.85, `circularity ${c.circularity}`);
  assert.ok(c.elongation < 1.1, `elongation ${c.elongation}`);
  assert.ok(c.solidity > 0.9, `solidity ${c.solidity}`);
  assert.ok(Math.abs(c.area - Math.PI * 22 * 22) / (Math.PI * 22 * 22) < 0.08, `area ${c.area}`);
});

test('mixed smear: normals, sickles, a clump, an edge cell', () => {
  const img = blank(480, 360);
  const normals = [[60, 60], [150, 70], [250, 60], [350, 80], [80, 170], [190, 180], [300, 300], [420, 190]];
  for (const [x, y] of normals) ellipse(img, x, y, 20, 19, 0, true);
  ellipse(img, 420, 300, 30, 9, 30);   // elongated sickle form
  crescent(img, 300, 180, 24, 200);   // crescent sickle
  ellipse(img, 80, 290, 30, 7, -50);   // another sickle
  ellipse(img, 175, 290, 20, 19, 0); ellipse(img, 205, 290, 20, 19, 0); ellipse(img, 190, 316, 20, 19, 0); // clump of 3
  ellipse(img, 470, 40, 20, 19, 0);    // touches the right edge
  const seg = segmentAndMeasure(img);
  const { summary, classes } = classifyCells(seg.cells);
  assert.equal(summary.normal, 8, JSON.stringify(summary));
  assert.equal(summary.sickled, 3, JSON.stringify(summary));
  assert.equal(summary.clump, 1, JSON.stringify(summary));
  assert.equal(summary.edge, 1, JSON.stringify(summary));
  assert.equal(summary.total, 11);
  assert.equal(summary.percentSickled, 27.3);
  const csv = cellsToCsv(seg.cells, classes);
  assert.ok(csv.split('\n').length === seg.cells.length + 2);
});

test('threshold changes reclassify without re-segmenting', () => {
  const img = blank(200, 120);
  ellipse(img, 60, 60, 26, 15, 0);   // elongation ~1.73 -> borderline by default
  ellipse(img, 150, 60, 20, 19, 0);
  const seg = segmentAndMeasure(img);
  const def = classifyCells(seg.cells).summary;
  assert.equal(def.borderline, 1, JSON.stringify(def));
  const strict = classifyCells(seg.cells, { sickleElongation: 1.7 }).summary;
  assert.equal(strict.sickled, 1, JSON.stringify(strict));
});
