// Hand-drawn SVG charts (no library), sized by viewBox so they scale to their container.
import { s } from './ui.js';

const INK = '#1d1a1c', MUTED = '#6b6468', GRID = '#ece6e3', ACCENT = '#8f1d33', SICKLE = '#d62839';

function niceMax(v) {
  if (v <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
const shortDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/**
 * % sickled over time for one patient.
 * points: [{date:'YYYY-MM-DD', value, lo, hi, label}], marker: {date, label} (e.g. hydroxyurea start)
 */
export function timelineChart(points, { marker, height = 240, title = '% sickled over time' } = {}) {
  const W = 1000, H = height, L = 52, R = 56, T = 28, B = 36;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': title });
  if (!points.length) {
    svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: MUTED, 'font-size': 13 }, 'No slides yet'));
    return svg;
  }
  const t = (d) => Date.parse(`${d}T00:00:00Z`) / 864e5;
  const dates = points.map((p) => t(p.date)).concat(marker ? [t(marker.date)] : []);
  let lo = Math.min(...dates), hi = Math.max(...dates);
  if (hi - lo < 14) { lo -= 7; hi += 7; }
  const ymax = niceMax(Math.max(10, ...points.map((p) => p.hi ?? p.value)) * 1.1);
  const X = (d) => L + ((t(d) - lo) / (hi - lo)) * (W - L - R);
  const Y = (v) => T + (1 - v / ymax) * (H - T - B);
  // grid + y labels
  for (let i = 0; i <= 4; i++) {
    const v = (ymax / 4) * i, y = Y(v);
    svg.append(s('line', { x1: L, x2: W - R, y1: y, y2: y, stroke: GRID }));
    svg.append(s('text', { x: L - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: MUTED }, `${+v.toFixed(1)}%`));
  }
  // x labels: first, last, and up to 4 between
  const idx = points.length <= 6 ? points.map((_, i) => i) : [0, ...[1, 2, 3, 4].map((k) => Math.round((k * (points.length - 1)) / 5)), points.length - 1];
  for (const i of new Set(idx)) {
    svg.append(s('text', { x: X(points[i].date), y: H - 12, 'text-anchor': 'middle', 'font-size': 11, fill: MUTED }, shortDate(points[i].date)));
  }
  if (marker) {
    const x = X(marker.date);
    svg.append(s('line', { x1: x, x2: x, y1: T - 6, y2: H - B, stroke: ACCENT, 'stroke-dasharray': '4 4' }));
    svg.append(s('text', { x: x + 6, y: T + 4, 'font-size': 11, fill: ACCENT, 'font-weight': 600 }, marker.label));
  }
  // CI whiskers
  for (const p of points) {
    if (p.lo == null) continue;
    const x = X(p.date);
    svg.append(s('line', { x1: x, x2: x, y1: Y(p.hi), y2: Y(p.lo), stroke: SICKLE, 'stroke-opacity': 0.35, 'stroke-width': 2 }));
  }
  // line + dots
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.date).toFixed(1)} ${Y(p.value).toFixed(1)}`).join('');
  svg.append(s('path', { d, fill: 'none', stroke: SICKLE, 'stroke-width': 2 }));
  for (const p of points) {
    svg.append(s('circle', { cx: X(p.date), cy: Y(p.value), r: 4.5, fill: '#fff', stroke: SICKLE, 'stroke-width': 2 },
      s('title', {}, `${shortDate(p.date)}: ${p.value.toFixed(1)}%${p.lo != null ? ` (95% CI ${p.lo}–${p.hi}%)` : ''}`)));
  }
  const last = points.at(-1);
  svg.append(s('text', { x: X(last.date) + 10, y: Y(last.value) + 4, 'font-size': 12, 'font-weight': 700, fill: INK }, `${last.value.toFixed(1)}%`));
  return svg;
}

/** Vertical bars: [{label, value}] */
export function barChart(bars, { height = 200, title = 'Bar chart', unit = '' } = {}) {
  const W = 680, H = height, L = 36, R = 12, T = 18, B = 30;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': title });
  const ymax = Math.max(2, Math.ceil(niceMax(Math.max(1, ...bars.map((b) => b.value))) / 2) * 2); // even, so the midline is a whole number
  const Y = (v) => T + (1 - v / ymax) * (H - T - B);
  for (let i = 0; i <= 2; i++) {
    const v = (ymax / 2) * i, y = Y(v);
    svg.append(s('line', { x1: L, x2: W - R, y1: y, y2: y, stroke: GRID }));
    svg.append(s('text', { x: L - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: MUTED }, +v.toFixed(1)));
  }
  const slot = (W - L - R) / Math.max(1, bars.length), bw = Math.min(36, slot * 0.62);
  bars.forEach((b, i) => {
    const x = L + slot * i + (slot - bw) / 2, y = Y(b.value);
    svg.append(s('rect', { x, y, width: bw, height: Math.max(0, H - B - y), rx: 3, fill: b.value ? ACCENT : GRID },
      s('title', {}, `${b.label}: ${b.value}${unit}`)));
    if (b.value) svg.append(s('text', { x: x + bw / 2, y: y - 4, 'text-anchor': 'middle', 'font-size': 11, fill: INK }, b.value));
    if (bars.length <= 12 || i % 2 === 0) svg.append(s('text', { x: x + bw / 2, y: H - 10, 'text-anchor': 'middle', 'font-size': 10.5, fill: MUTED }, b.label));
  });
  return svg;
}

/** Horizontal stacked composition bar for one slide. parts: [{key,label,value,color}] */
export function compositionBar(parts) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const W = 680, H = 18;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart comp', role: 'img', 'aria-label': 'Cell composition' });
  let x = 0;
  for (const p of parts) {
    const w = (p.value / total) * W;
    if (w > 0) svg.append(s('rect', { x, y: 0, width: w, height: H, fill: p.color }, s('title', {}, `${p.label}: ${p.value}`)));
    x += w;
  }
  return svg;
}
