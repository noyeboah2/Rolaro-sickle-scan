import { DEFAULT_THRESHOLDS, ENGINE, classifyCells, cellsToCsv } from './analysis.js';
import { detectMode, getMode, listHistory, saveAnalysis, deleteAnalysis } from './history.js';

const MAX_SIDE = 1400;
const MAX_BYTES = 15 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const COLORS = {
  normal: '#4ade80', borderline: '#fbbf24', sickled: '#ff5a6a', clump: '#c4bdca', edge: '#e5e0e3', debris: null,
};
const LABELS = { normal: 'Normal', borderline: 'Borderline', sickled: 'Sickled', clump: 'Clump', edge: 'Edge cell', debris: 'Debris' };

const $ = (id) => document.getElementById(id);
const el = {
  dropzone: $('dropzone'), fileInput: $('file-input'), cameraInput: $('camera-input'), sampleBtn: $('sample-btn'),
  stage: $('stage'), canvas: $('canvas'), busy: $('busy'), imageName: $('image-name'), error: $('error'),
  overlay: $('overlay-toggle'), invert: $('invert-toggle'), newBtn: $('new-btn'),
  pct: $('pct'), quality: $('quality'),
  cellCard: $('cell-card'), cellId: $('cell-id'), cellClass: $('cell-class'), cellStats: $('cell-stats'),
  tSickle: $('t-sickle'), tBorder: $('t-border'), tCirc: $('t-circ'), tClump: $('t-clump'),
  oSickle: $('o-sickle'), oBorder: $('o-border'), oCirc: $('o-circ'), oClump: $('o-clump'), resetBtn: $('reset-btn'),
  label: $('label-input'), saveBtn: $('save-btn'), csvBtn: $('csv-btn'), pngBtn: $('png-btn'), saveStatus: $('save-status'),
  history: $('history'), histEmpty: $('hist-empty'), histMode: $('hist-mode'),
};
const ctx = el.canvas.getContext('2d');

const state = {
  name: '', base: null, imageData: null, seg: null, cls: null, selected: null,
  thresholds: { ...DEFAULT_THRESHOLDS }, jobId: 0,
};

// ------------------------------------------------------------- worker
const worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
worker.onmessage = (e) => {
  const p = pending.get(e.data.id);
  if (!p) return;
  pending.delete(e.data.id);
  e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error));
};
worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'Analysis worker failed')); pending.clear(); };
function runSegmentation(imageData, options) {
  const id = ++state.jobId;
  const copy = imageData.data.slice().buffer;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, width: imageData.width, height: imageData.height, buffer: copy, options }, [copy]);
  });
}

// ------------------------------------------------------------- loading
function showError(msg) { el.error.textContent = msg; el.error.hidden = !msg; }

async function loadFile(file, name) {
  showError('');
  if (!file) return;
  if (file.type && !TYPES.includes(file.type) && !file.type.startsWith('image/')) return showError('Please choose a JPG, PNG or WebP image.');
  if (file.size > MAX_BYTES) return showError('That image is larger than 15 MB. Please use a smaller one.');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return showError('This image could not be opened. Try a JPG or PNG.');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
  const base = document.createElement('canvas');
  base.width = w; base.height = h;
  const bctx = base.getContext('2d', { willReadFrequently: true });
  bctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  state.base = base;
  state.imageData = bctx.getImageData(0, 0, w, h);
  state.name = name || file.name || 'image';
  state.selected = null;
  el.canvas.width = w; el.canvas.height = h;
  el.imageName.textContent = `${state.name} · ${w}×${h}px`;
  el.dropzone.hidden = true;
  el.stage.hidden = false;
  el.label.value = '';
  el.saveStatus.textContent = '';
  await analyse();
}

async function analyse() {
  if (!state.imageData) return;
  el.busy.hidden = false;
  setActionsEnabled(false);
  drawBase();
  try {
    state.seg = await runSegmentation(state.imageData, { invert: el.invert.checked });
    reclassify();
  } catch (err) {
    showError(`Analysis failed: ${err.message}`);
  } finally {
    el.busy.hidden = true;
  }
}

function reclassify() {
  if (!state.seg) return;
  state.cls = classifyCells(state.seg.cells, state.thresholds);
  renderSummary();
  render();
  if (state.selected != null) showCell(state.selected);
  setActionsEnabled(state.cls.summary.total > 0);
}

// ------------------------------------------------------------- drawing
function drawBase() { ctx.drawImage(state.base, 0, 0); }

function tracePath(c, g) {
  const p = c.contour;
  g.beginPath();
  g.moveTo(p[0] + 0.5, p[1] + 0.5);
  for (let i = 2; i < p.length; i += 2) g.lineTo(p[i] + 0.5, p[i + 1] + 0.5);
  g.closePath();
}

function drawOverlay(g, w, showSelection = true) {
  const lw = Math.max(1.5, w / 650);
  for (const c of state.seg.cells) {
    const k = state.cls.classes[c.id];
    const color = COLORS[k];
    if (!color || c.contour.length < 6) continue;
    const width = k === 'edge' ? lw * 0.8 : k === 'sickled' ? lw * 1.5 : lw;
    tracePath(c, g);
    g.setLineDash(k === 'edge' ? [lw * 3, lw * 2] : []);
    if (k !== 'edge') { // dark halo keeps outlines visible on any stain colour
      g.lineWidth = width + lw * 1.4;
      g.strokeStyle = 'rgba(15, 10, 12, 0.6)';
      g.stroke();
    }
    g.lineWidth = width;
    g.strokeStyle = color;
    g.stroke();
  }
  g.setLineDash([]);
  if (showSelection && state.selected != null) {
    const c = state.seg.cells.find((x) => x.id === state.selected);
    if (c) {
      tracePath(c, g);
      g.lineWidth = lw * 3.2; g.strokeStyle = 'rgba(0,0,0,.65)'; g.stroke();
      g.lineWidth = lw * 1.6; g.strokeStyle = '#ffffff'; g.stroke();
    }
  }
}

function render() {
  drawBase();
  if (el.overlay.checked && state.seg && state.cls) drawOverlay(ctx, el.canvas.width);
}

// ------------------------------------------------------------- results
function renderSummary() {
  const s = state.cls.summary;
  el.pct.textContent = s.total ? `${s.percentSickled}%` : '–';
  for (const k of ['total', 'normal', 'borderline', 'sickled', 'clump', 'edge']) $(`s-${k}`).textContent = s[k];
  const notes = [];
  if (state.seg.foregroundFraction > 0.6) notes.push('Most of the image was detected as cell. If your cells look lighter than the background, tick “Cells lighter than background”.');
  if (s.total < 20) notes.push(`Only ${s.total} cells were counted. Use a field with more cells, or analyse several fields, for a reliable percentage.`);
  if (s.total && s.clump > s.total * 0.25) notes.push('Many overlapping clumps were excluded. A thinner area of the smear (the monolayer) gives better counts.');
  el.quality.textContent = notes.join(' ');
  el.quality.hidden = notes.length === 0;
}

function showCell(id) {
  const c = state.seg.cells.find((x) => x.id === id);
  if (!c) { el.cellCard.hidden = true; return; }
  const k = state.cls.classes[c.id];
  el.cellId.textContent = `#${c.id}`;
  el.cellClass.textContent = LABELS[k];
  el.cellClass.className = `pill ${k}`;
  const rows = [
    ['Area', `${c.area} px`], ['Perimeter', `${c.perimeter} px`], ['Circularity', c.circularity],
    ['Elongation', c.elongation], ['Solidity', c.solidity], ['Long × short axis', `${c.majorAxis} × ${c.minorAxis} px`],
    ['Area vs median', `${(c.area / state.cls.summary.medianArea).toFixed(2)}×`],
  ];
  el.cellStats.replaceChildren(...rows.map(([dt, dd]) => {
    const d = document.createElement('div');
    const a = document.createElement('dt'); a.textContent = dt;
    const b = document.createElement('dd'); b.textContent = dd;
    d.append(a, b);
    return d;
  }));
  el.cellCard.hidden = false;
}

function pointInPolygon(x, y, p) {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

el.canvas.addEventListener('click', (e) => {
  if (!state.seg) return;
  const r = el.canvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * el.canvas.width;
  const y = ((e.clientY - r.top) / r.height) * el.canvas.height;
  let hit = null, best = Infinity;
  for (const c of state.seg.cells) {
    if (!COLORS[state.cls.classes[c.id]]) continue;
    const [x0, y0, x1, y1] = c.bbox;
    if (x < x0 - 3 || x > x1 + 3 || y < y0 - 3 || y > y1 + 3) continue;
    const inside = pointInPolygon(x, y, c.contour);
    const d = inside ? -1 / c.area : Math.hypot(c.cx - x, c.cy - y);
    if (d < best) { best = d; hit = c; }
  }
  state.selected = hit && (best < 0 || best < 14) ? hit.id : null;
  if (state.selected == null) el.cellCard.hidden = true; else showCell(state.selected);
  render();
});

// ------------------------------------------------------------- thresholds
const sliders = [
  [el.tSickle, el.oSickle, 'sickleElongation', 2],
  [el.tBorder, el.oBorder, 'borderlineElongation', 2],
  [el.tCirc, el.oCirc, 'sickleCircularity', 2],
  [el.tClump, el.oClump, 'clumpAreaRatio', 1],
];
function syncSliders() {
  for (const [input, out, key, dp] of sliders) { input.value = state.thresholds[key]; out.textContent = Number(state.thresholds[key]).toFixed(dp); }
}
for (const [input, out, key, dp] of sliders) {
  input.addEventListener('input', () => {
    state.thresholds[key] = Number(input.value);
    if (key === 'sickleElongation' && state.thresholds.borderlineElongation > state.thresholds.sickleElongation) state.thresholds.borderlineElongation = state.thresholds.sickleElongation;
    if (key === 'borderlineElongation' && state.thresholds.borderlineElongation > state.thresholds.sickleElongation) state.thresholds.sickleElongation = state.thresholds.borderlineElongation;
    syncSliders();
    out.textContent = Number(input.value).toFixed(dp);
    reclassify();
  });
}
el.resetBtn.addEventListener('click', () => { state.thresholds = { ...DEFAULT_THRESHOLDS }; syncSliders(); reclassify(); });

// ------------------------------------------------------------- export & save
function setActionsEnabled(on) { el.saveBtn.disabled = el.csvBtn.disabled = el.pngBtn.disabled = !on; }

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function baseName() { return (state.name.replace(/\.[a-z0-9]+$/i, '') || 'smear').replace(/[^\w.-]+/g, '_'); }

el.csvBtn.addEventListener('click', () => {
  download(new Blob([cellsToCsv(state.seg.cells, state.cls.classes)], { type: 'text/csv' }), `${baseName()}_cells.csv`);
});

el.pngBtn.addEventListener('click', () => {
  const w = el.canvas.width, h = el.canvas.height;
  const band = Math.max(64, Math.round(w / 14));
  const out = document.createElement('canvas');
  out.width = w; out.height = h + band;
  const g = out.getContext('2d');
  g.drawImage(state.base, 0, 0);
  drawOverlay(g, w, false);
  g.fillStyle = '#ffffff'; g.fillRect(0, h, w, band);
  const s = state.cls.summary, fs = Math.round(band / 3.4);
  g.fillStyle = '#1d1a1c'; g.font = `600 ${fs}px system-ui, sans-serif`;
  g.fillText(`${s.percentSickled}% sickled · ${s.total} cells (${s.normal} normal, ${s.borderline} borderline, ${s.sickled} sickled)`, 12, h + fs * 1.3);
  g.fillStyle = '#6b6468'; g.font = `${Math.round(fs * 0.8)}px system-ui, sans-serif`;
  g.fillText('SickleScan · research and education use only, not a diagnosis', 12, h + fs * 2.6);
  out.toBlob((b) => b && download(b, `${baseName()}_annotated.png`), 'image/png');
});

el.saveBtn.addEventListener('click', async () => {
  const s = state.cls.summary;
  const record = {
    label: el.label.value.trim().slice(0, 80) || state.name.slice(0, 80),
    total_cells: s.total, normal_count: s.normal, borderline_count: s.borderline,
    sickled_count: s.sickled, clump_count: s.clump, percent_sickled: s.percentSickled,
    thresholds: state.thresholds, image_width: state.seg.width, image_height: state.seg.height, engine: ENGINE,
  };
  el.saveBtn.disabled = true;
  el.saveStatus.textContent = 'Saving…';
  try {
    const r = await saveAnalysis(record);
    el.saveStatus.textContent = r.where === 'server' ? 'Saved to your SickleScan database.' : 'Saved on this device.';
    await refreshHistory();
  } catch (err) {
    el.saveStatus.textContent = `Not saved: ${err.message}`;
  } finally {
    el.saveBtn.disabled = false;
  }
});

async function refreshHistory() {
  let items = [];
  try { items = await listHistory(); } catch { items = []; }
  el.histMode.textContent = getMode() === 'server' ? 'Cloud' : 'This device';
  el.histEmpty.hidden = items.length > 0;
  el.history.replaceChildren(...items.map((it) => {
    const li = document.createElement('li');
    const label = document.createElement('span'); label.className = 'h-label'; label.textContent = it.label || 'Untitled'; label.title = it.label || '';
    const pct = document.createElement('span'); pct.className = 'h-pct'; pct.textContent = `${Number(it.percent_sickled).toFixed(1)}%`;
    const meta = document.createElement('span'); meta.className = 'h-meta';
    meta.textContent = `${new Date(it.created_at).toLocaleString()} · ${it.total_cells} cells · ${it.sickled_count} sickled`;
    const del = document.createElement('button'); del.className = 'h-del'; del.type = 'button'; del.textContent = 'Delete';
    del.setAttribute('aria-label', `Delete ${it.label || 'result'}`);
    del.addEventListener('click', async () => { await deleteAnalysis(it.id); refreshHistory(); });
    li.append(label, pct, meta, del);
    return li;
  }));
}

// ------------------------------------------------------------- inputs
el.fileInput.addEventListener('change', () => { loadFile(el.fileInput.files[0]); el.fileInput.value = ''; });
el.cameraInput.addEventListener('change', () => { loadFile(el.cameraInput.files[0], 'Camera photo'); el.cameraInput.value = ''; });
el.sampleBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('sample-smear.jpg');
    if (!res.ok) throw new Error();
    await loadFile(await res.blob(), 'Synthetic sample smear');
  } catch { showError('The sample image could not be loaded.'); }
});
el.dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); } });
['dragenter', 'dragover'].forEach((t) => el.dropzone.addEventListener(t, (e) => { e.preventDefault(); el.dropzone.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => el.dropzone.addEventListener(t, (e) => { e.preventDefault(); el.dropzone.classList.remove('over'); }));
el.dropzone.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f); });
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile(), 'Pasted image');
});
el.overlay.addEventListener('change', render);
el.invert.addEventListener('change', analyse);
el.newBtn.addEventListener('click', () => {
  state.seg = state.cls = state.imageData = state.base = null; state.selected = null;
  el.stage.hidden = true; el.dropzone.hidden = false; el.cellCard.hidden = true; el.quality.hidden = true;
  el.pct.textContent = '–';
  for (const k of ['total', 'normal', 'borderline', 'sickled', 'clump', 'edge']) $(`s-${k}`).textContent = '–';
  setActionsEnabled(false);
  showError('');
});

// ------------------------------------------------------------- start
syncSliders();
detectMode().then(refreshHistory);
