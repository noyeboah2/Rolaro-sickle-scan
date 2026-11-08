// Image loading, background analysis and drawing shared by every page.
export const MAX_SIDE = 1400;
export const MAX_BYTES = 15 * 1024 * 1024;

export const CLASS_COLORS = {
  normal: '#4ade80', borderline: '#fbbf24', sickled: '#ff5a6a', clump: '#c4bdca', edge: '#e5e0e3', excluded: '#60a5fa', debris: null,
};
export const CLASS_LABELS = {
  normal: 'Normal', borderline: 'Borderline', sickled: 'Sickled', clump: 'Clump', edge: 'Edge cell', excluded: 'Excluded by you', debris: 'Debris',
};

// ---------------------------------------------------------------- worker
let worker = null, jobId = 0;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error));
  };
  worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'Analysis failed')); pending.clear(); worker = null; };
  return worker;
}
export function segment(imageData, options = {}) {
  const id = ++jobId;
  const copy = imageData.data.slice().buffer;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, width: imageData.width, height: imageData.height, buffer: copy, options }, [copy]);
  });
}

// ---------------------------------------------------------------- images
/** Decode, orient and downscale an image file/blob. Returns {canvas, imageData, blob}. */
export async function loadImage(fileOrBlob) {
  if (fileOrBlob.size > MAX_BYTES) throw new Error('Image is larger than 15 MB.');
  let bitmap;
  try { bitmap = await createImageBitmap(fileOrBlob, { imageOrientation: 'from-image' }); }
  catch { throw new Error('This image could not be opened. Use JPG, PNG or WebP.'); }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const imageData = ctx.getImageData(0, 0, w, h);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  return { canvas, imageData, blob };
}

/** Stored blob -> canvas (no resizing: stored images are already <= MAX_SIDE). */
export async function blobToCanvas(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return canvas;
}

// ---------------------------------------------------------------- drawing
function tracePath(g, c, k = 1) {
  const p = c.contour;
  g.beginPath();
  g.moveTo((p[0] + 0.5) * k, (p[1] + 0.5) * k);
  for (let i = 2; i < p.length; i += 2) g.lineTo((p[i] + 0.5) * k, (p[i + 1] + 0.5) * k);
  g.closePath();
}

/** Draw base image plus class outlines onto g (scaled by k). */
export function drawAnnotated(g, base, cells, classes, { k = 1, selected = null, overlay = true, corrected = null } = {}) {
  g.drawImage(base, 0, 0, base.width * k, base.height * k);
  if (!overlay) return;
  const lw = Math.max(1.5, (base.width * k) / 650);
  for (const c of cells) {
    const cls = classes[c.id];
    const color = CLASS_COLORS[cls];
    if (!color || !c.contour || c.contour.length < 6) continue;
    const width = cls === 'edge' ? lw * 0.8 : cls === 'sickled' ? lw * 1.5 : lw;
    tracePath(g, c, k);
    g.setLineDash(cls === 'edge' ? [lw * 3, lw * 2] : []);
    if (cls !== 'edge') { g.lineWidth = width + lw * 1.4; g.strokeStyle = 'rgba(15,10,12,.6)'; g.stroke(); }
    g.lineWidth = width; g.strokeStyle = color; g.stroke();
    if (corrected && corrected.has(String(c.id))) { // small dot marks a manual correction
      g.setLineDash([]);
      g.beginPath(); g.arc(c.cx * k, c.cy * k, Math.max(2.5, lw * 1.3), 0, Math.PI * 2);
      g.fillStyle = '#fff'; g.fill(); g.lineWidth = lw * 0.8; g.strokeStyle = '#111'; g.stroke();
    }
  }
  g.setLineDash([]);
  if (selected != null) {
    const c = cells.find((x) => x.id === selected);
    if (c && c.contour) {
      tracePath(g, c, k);
      g.lineWidth = lw * 3.2; g.strokeStyle = 'rgba(0,0,0,.65)'; g.stroke();
      g.lineWidth = lw * 1.6; g.strokeStyle = '#fff'; g.stroke();
    }
  }
}

/** Small annotated JPEG for reports and lists. */
export function thumbnail(base, cells, classes, width = 520, corrected = null) {
  const k = Math.min(1, width / base.width);
  const c = document.createElement('canvas');
  c.width = Math.round(base.width * k); c.height = Math.round(base.height * k);
  drawAnnotated(c.getContext('2d'), base, cells, classes, { k, corrected });
  return c.toDataURL('image/jpeg', 0.85);
}

function pointInPolygon(x, y, p) {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Cell under image coordinates (x,y), or null. */
export function hitTest(cells, classes, x, y) {
  let hit = null, best = Infinity;
  for (const c of cells) {
    if (!CLASS_COLORS[classes[c.id]] || !c.contour) continue;
    const [x0, y0, x1, y1] = c.bbox;
    if (x < x0 - 3 || x > x1 + 3 || y < y0 - 3 || y > y1 + 3) continue;
    const d = pointInPolygon(x, y, c.contour) ? -1 / c.area : Math.hypot(c.cx - x, c.cy - y);
    if (d < best) { best = d; hit = c; }
  }
  return hit && (best < 0 || best < 14) ? hit : null;
}

export async function sampleBlob() {
  const res = await fetch('sample-smear.jpg');
  if (!res.ok) throw new Error('Sample image not found');
  return res.blob();
}
