// SickleScan analysis engine (v1, rule-based).
// Pure functions only: no DOM access, so it runs in a Web Worker and in Node tests.
// Pipeline: channel -> blur -> Otsu threshold -> opening -> fill holes -> label
//           -> contour trace + shape measures -> classify (cheap, re-runnable).

export const ENGINE = 'rules-v1';

export const DEFAULT_THRESHOLDS = Object.freeze({
  sickleElongation: 2.0,     // elongation at or above this = sickled
  sickleElongationLow: 1.6,  // ...or at/above this AND circularity below sickleCircularity
  sickleCircularity: 0.55,
  borderlineElongation: 1.5, // elongated but not sickled
  debrisAreaRatio: 0.25,     // area < ratio * median -> debris (ignored)
  clumpAreaRatio: 2.2,       // area > ratio * median -> clump (excluded)
  clumpSolidity: 0.80,       // low solidity + area > 1.5 * median -> clump
});

export const MIN_ABS_AREA = 12; // pixels; anything smaller is noise

// ---------------------------------------------------------------- pixels

/** Extract one channel (0=R,1=G,2=B) from RGBA bytes. Green gives the best cell/background contrast. */
export function extractChannel(rgba, width, height, channel = 1) {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0, j = channel; i < n; i++, j += 4) out[i] = rgba[j];
  return out;
}

/** 3x3 box blur (separable), edges clamped. */
export function boxBlur3(src, w, h) {
  const tmp = new Uint16Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? x - 1 : x, r = x < w - 1 ? x + 1 : x;
      tmp[row + x] = src[row + l] + src[row + x] + src[row + r];
    }
  }
  for (let y = 0; y < h; y++) {
    const u = (y > 0 ? y - 1 : y) * w, m = y * w, d = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) out[m + x] = Math.round((tmp[u + x] + tmp[m + x] + tmp[d + x]) / 9);
  }
  return out;
}

/** Otsu's threshold on 8-bit data. Returns t such that class 0 = values <= t. */
export function otsuThreshold(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let wB = 0, sumB = 0, best = 0, bestT = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = t; }
  }
  return bestT;
}

/** Foreground mask: 1 where the pixel is cell. Cells are darker than background unless invert=true. */
export function thresholdMask(gray, t, invert = false) {
  const m = new Uint8Array(gray.length);
  if (invert) { for (let i = 0; i < gray.length; i++) m[i] = gray[i] > t ? 1 : 0; }
  else { for (let i = 0; i < gray.length; i++) m[i] = gray[i] <= t ? 1 : 0; }
  return m;
}

function erode3(m, w, h) {
  const o = new Uint8Array(m.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      o[i] = (m[i - 1] & m[i + 1] & m[i - w] & m[i + w] & m[i - w - 1] & m[i - w + 1] & m[i + w - 1] & m[i + w + 1]);
    }
  }
  return o;
}

function dilate3(m, w, h) {
  const o = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      const y0 = y > 0 ? -1 : 0, y1 = y < h - 1 ? 1 : 0, x0 = x > 0 ? -1 : 0, x1 = x < w - 1 ? 1 : 0;
      for (let dy = y0; dy <= y1; dy++) for (let dx = x0; dx <= x1; dx++) o[i + dy * w + dx] = 1;
    }
  }
  return o;
}

/** Morphological opening with a 3x3 square: removes specks and thin bridges. */
export function open3(m, w, h) { return dilate3(erode3(m, w, h), w, h); }

/** Fill background regions that do not touch the image border (e.g. the pale centre of a normal cell). */
export function fillHoles(m, w, h) {
  const reach = new Uint8Array(m.length);
  const stack = new Int32Array(m.length);
  let sp = 0;
  const push = (i) => { if (!m[i] && !reach[i]) { reach[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < m.length - w) push(i + w);
  }
  const o = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) o[i] = m[i] || !reach[i] ? 1 : 0;
  return o;
}

/** 4-connected component labelling. Returns labels (0 = background), region count and each region's first raster pixel. */
export function labelRegions(m, w, h) {
  const labels = new Int32Array(m.length);
  const stack = new Int32Array(m.length);
  const starts = [];
  let count = 0;
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || labels[s]) continue;
    count++;
    starts.push(s);
    let sp = 0;
    labels[s] = count; stack[sp++] = s;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      if (x > 0 && m[i - 1] && !labels[i - 1]) { labels[i - 1] = count; stack[sp++] = i - 1; }
      if (x < w - 1 && m[i + 1] && !labels[i + 1]) { labels[i + 1] = count; stack[sp++] = i + 1; }
      if (i >= w && m[i - w] && !labels[i - w]) { labels[i - w] = count; stack[sp++] = i - w; }
      if (i < m.length - w && m[i + w] && !labels[i + w]) { labels[i + w] = count; stack[sp++] = i + w; }
    }
  }
  return { labels, count, starts };
}

// ---------------------------------------------------------------- geometry

// 8 directions, clockwise on screen (y grows downward): E, SE, S, SW, W, NW, N, NE
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];
function dirOf(dx, dy) { for (let k = 0; k < 8; k++) if (DX[k] === dx && DY[k] === dy) return k; return -1; }

/**
 * Moore-neighbour contour trace of the region containing `start` (its first pixel in raster order).
 * Returns the outline as [x0,y0,x1,y1,...] and a chain-code perimeter estimate
 * (Vossepoel & Smeulders: 0.980*Ne + 1.406*No - 0.091*Nc).
 */
export function traceContour(labels, w, h, start, id) {
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === id;
  const sx = start % w, sy = (start / w) | 0;
  let px = sx, py = sy, bx = sx - 1, by = sy; // backtrack starts west (background by construction)
  const sbx = bx, sby = by;
  const pts = [px, py];
  let ne = 0, no = 0, nc = 0, lastDir = -1, firstDir = -1;
  const cap = 4 * w * h + 16;
  for (let step = 0; step < cap; step++) {
    let k = dirOf(bx - px, by - py);
    let found = false;
    for (let i = 1; i <= 8; i++) {
      const kk = (k + i) % 8;
      const cx = px + DX[kk], cy = py + DY[kk];
      if (inside(cx, cy)) {
        const kb = (k + i - 1) % 8;
        bx = px + DX[kb]; by = py + DY[kb];
        px = cx; py = cy;
        if (kk % 2 === 0) ne++; else no++;
        if (lastDir !== -1 && kk !== lastDir) nc++;
        if (firstDir === -1) firstDir = kk;
        lastDir = kk;
        found = true;
        break;
      }
    }
    if (!found) break; // isolated pixel
    if (px === sx && py === sy && bx === sbx && by === sby) break;
    pts.push(px, py);
  }
  if (lastDir !== -1 && firstDir !== -1 && lastDir !== firstDir) nc++;
  if (pts.length >= 4 && pts[pts.length - 2] === sx && pts[pts.length - 1] === sy) pts.length -= 2;
  const perimeter = ne + no === 0 ? 3.0 : 0.980 * ne + 1.406 * no - 0.091 * nc;
  return { points: pts, perimeter };
}

/** Convex hull (Andrew's monotone chain) of flat [x,y,...] points. Returns flat hull points. */
export function convexHull(flat) {
  const n = flat.length / 2;
  if (n < 3) return flat.slice();
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => flat[2 * a] - flat[2 * b] || flat[2 * a + 1] - flat[2 * b + 1]);
  const cross = (o, a, b) => (flat[2 * a] - flat[2 * o]) * (flat[2 * b + 1] - flat[2 * o + 1]) - (flat[2 * a + 1] - flat[2 * o + 1]) * (flat[2 * b] - flat[2 * o]);
  const lower = [], upper = [];
  for (const i of idx) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), i) <= 0) lower.pop(); lower.push(i); }
  for (let j = idx.length - 1; j >= 0; j--) { const i = idx[j]; while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), i) <= 0) upper.pop(); upper.push(i); }
  upper.pop(); lower.pop();
  const hull = lower.concat(upper);
  const out = [];
  for (const i of hull) out.push(flat[2 * i], flat[2 * i + 1]);
  return out;
}

/** Shoelace area and perimeter of a flat polygon. */
export function polygonAreaPerimeter(flat) {
  const n = flat.length / 2;
  if (n < 3) return { area: 0, perimeter: n === 2 ? 2 * Math.hypot(flat[2] - flat[0], flat[3] - flat[1]) : 0 };
  let a = 0, p = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += flat[2 * i] * flat[2 * j + 1] - flat[2 * j] * flat[2 * i + 1];
    p += Math.hypot(flat[2 * j] - flat[2 * i], flat[2 * j + 1] - flat[2 * i + 1]);
  }
  return { area: Math.abs(a) / 2, perimeter: p };
}

/** Keep every k-th outline point so overlays stay light. */
function decimate(flat, maxPts = 120) {
  const n = flat.length / 2;
  if (n <= maxPts) return flat;
  const step = n / maxPts, out = [];
  for (let i = 0; i < maxPts; i++) { const j = Math.floor(i * step); out.push(flat[2 * j], flat[2 * j + 1]); }
  return out;
}

/** Measure every labelled region. */
export function measureRegions(labels, w, h, count, starts) {
  const A = new Float64Array(count + 1), SX = new Float64Array(count + 1), SY = new Float64Array(count + 1);
  const SXX = new Float64Array(count + 1), SYY = new Float64Array(count + 1), SXY = new Float64Array(count + 1);
  const minX = new Int32Array(count + 1).fill(w), minY = new Int32Array(count + 1).fill(h);
  const maxX = new Int32Array(count + 1).fill(-1), maxY = new Int32Array(count + 1).fill(-1);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const id = labels[i];
      if (!id) continue;
      A[id]++; SX[id] += x; SY[id] += y; SXX[id] += x * x; SYY[id] += y * y; SXY[id] += x * y;
      if (x < minX[id]) minX[id] = x; if (x > maxX[id]) maxX[id] = x;
      if (y < minY[id]) minY[id] = y; if (y > maxY[id]) maxY[id] = y;
    }
  }
  const cells = [];
  for (let id = 1; id <= count; id++) {
    const area = A[id];
    if (area < MIN_ABS_AREA) continue;
    const cx = SX[id] / area, cy = SY[id] / area;
    // central second moments (+1/12 for pixel extent)
    const a = SXX[id] / area - cx * cx + 1 / 12;
    const c = SYY[id] / area - cy * cy + 1 / 12;
    const b = SXY[id] / area - cx * cy;
    const half = Math.sqrt(((a - c) / 2) ** 2 + b * b);
    const l1 = (a + c) / 2 + half, l2 = Math.max((a + c) / 2 - half, 1e-6);
    const { points, perimeter } = traceContour(labels, w, h, starts[id - 1], id);
    const hull = convexHull(points);
    const hp = polygonAreaPerimeter(hull);
    // Pick's-theorem style correction: pixel count ~ polygon area + boundary/2 + 1
    const hullPixelArea = hp.area + hp.perimeter / 2 + 1;
    cells.push({
      id,
      area,
      perimeter: round(perimeter, 2),
      circularity: round(Math.min(1, (4 * Math.PI * area) / (perimeter * perimeter)), 3),
      elongation: round(Math.sqrt(l1 / l2), 3),
      solidity: round(Math.min(1, area / hullPixelArea), 3),
      majorAxis: round(4 * Math.sqrt(l1), 1),
      minorAxis: round(4 * Math.sqrt(l2), 1),
      angle: round((0.5 * Math.atan2(2 * b, a - c) * 180) / Math.PI, 1),
      cx: round(cx, 1), cy: round(cy, 1),
      bbox: [minX[id], minY[id], maxX[id], maxY[id]],
      touchesEdge: minX[id] === 0 || minY[id] === 0 || maxX[id] === w - 1 || maxY[id] === h - 1,
      contour: decimate(points),
    });
  }
  return cells;
}

function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }

// ---------------------------------------------------------------- pipeline

/**
 * Segment and measure an image. Expensive; run once per image.
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img RGBA image
 * @param {{invert?: boolean, channel?: number}} opts
 */
export function segmentAndMeasure(img, opts = {}) {
  const { width: w, height: h, data } = img;
  const t0 = Date.now();
  const gray = boxBlur3(extractChannel(data, w, h, opts.channel ?? 1), w, h);
  const threshold = otsuThreshold(gray);
  let mask = thresholdMask(gray, threshold, !!opts.invert);
  mask = open3(mask, w, h);
  mask = fillHoles(mask, w, h);
  let fg = 0;
  for (let i = 0; i < mask.length; i++) fg += mask[i];
  const { labels, count, starts } = labelRegions(mask, w, h);
  const cells = measureRegions(labels, w, h, count, starts);
  return {
    width: w, height: h, threshold,
    foregroundFraction: round(fg / mask.length, 3),
    cells,
    ms: Date.now() - t0,
  };
}

/** Median of a numeric array (copy-sorted). */
export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Classify measured cells. Cheap; re-run whenever thresholds change.
 * Returns per-cell classes (by cell id) and a summary.
 */
export function classifyCells(cells, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const inner = cells.filter((c) => !c.touchesEdge);
  // Median of plausible single cells: drop tiny bits first so debris does not drag it down
  const prelim = median(inner.map((c) => c.area));
  const medArea = median(inner.filter((c) => c.area >= prelim * 0.4 && c.area <= prelim * 2.5).map((c) => c.area)) || prelim;
  const classes = {};
  const counts = { normal: 0, borderline: 0, sickled: 0, clump: 0, debris: 0, edge: 0 };
  for (const c of cells) {
    let k;
    if (c.touchesEdge) k = 'edge';
    else if (c.area < t.debrisAreaRatio * medArea) k = 'debris';
    else if (c.area > t.clumpAreaRatio * medArea || (c.solidity < t.clumpSolidity && c.area > 1.5 * medArea)) k = 'clump';
    else if (c.elongation >= t.sickleElongation || (c.elongation >= t.sickleElongationLow && c.circularity < t.sickleCircularity)) k = 'sickled';
    else if (c.elongation >= t.borderlineElongation) k = 'borderline';
    else k = 'normal';
    classes[c.id] = k;
    counts[k]++;
  }
  const total = counts.normal + counts.borderline + counts.sickled;
  return {
    classes,
    summary: {
      ...counts,
      total,
      percentSickled: total ? round((100 * counts.sickled) / total, 1) : 0,
      medianArea: round(medArea, 1),
    },
    thresholds: t,
  };
}

/** CSV of per-cell measurements with classes. */
export function cellsToCsv(cells, classes) {
  const head = ['cell_id', 'class', 'area_px', 'perimeter_px', 'circularity', 'elongation', 'solidity', 'major_axis_px', 'minor_axis_px', 'angle_deg', 'centroid_x', 'centroid_y', 'touches_edge'];
  const rows = cells.map((c) => [c.id, classes[c.id], c.area, c.perimeter, c.circularity, c.elongation, c.solidity, c.majorAxis, c.minorAxis, c.angle, c.cx, c.cy, c.touchesEdge].join(','));
  return [
    '# SickleScan export - research and education use only, not a diagnosis',
    head.join(','),
    ...rows,
  ].join('\n');
}
