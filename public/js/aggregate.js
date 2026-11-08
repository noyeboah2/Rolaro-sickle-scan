// Pure slide-level logic: apply manual corrections, combine fields, raise QC flags.
import { classifyCells } from './analysis.js';

export const COUNTED = ['normal', 'borderline', 'sickled'];
export const OVERRIDE_CLASSES = ['normal', 'borderline', 'sickled', 'excluded'];

/** Classes for one field: automatic rules first, then the technician's corrections on top. */
export function fieldClasses(field, thresholds) {
  const auto = classifyCells(field.cells || [], thresholds);
  const classes = { ...auto.classes };
  const ov = field.overrides || {};
  for (const [id, k] of Object.entries(ov)) if (id in classes && OVERRIDE_CLASSES.includes(k)) classes[id] = k;
  return { classes, auto: auto.classes, medianArea: auto.summary.medianArea };
}

/** Counts for one field. */
export function fieldSummary(field, thresholds) {
  const { classes, auto, medianArea } = fieldClasses(field, thresholds);
  const counts = { normal: 0, borderline: 0, sickled: 0, clump: 0, debris: 0, edge: 0, excluded: 0 };
  for (const k of Object.values(classes)) counts[k] = (counts[k] || 0) + 1;
  const total = counts.normal + counts.borderline + counts.sickled;
  const corrections = Object.keys(field.overrides || {}).filter((id) => (field.overrides[id] !== auto[id])).length;
  return {
    ...counts, total, corrections, medianArea,
    percentSickled: total ? Math.round((1000 * counts.sickled) / total) / 10 : 0,
  };
}

/**
 * Combine the included fields of a slide.
 * Counts are pooled (sum of cells), not an average of field percentages,
 * so a field with few cells cannot swing the result.
 */
export function slideSummary(fields, thresholds, qc = {}) {
  const minCells = qc.qcMinCells ?? 200;
  const maxClumpPct = qc.qcMaxClumpPct ?? 25;
  const per = fields.map((f) => ({ id: f.id, name: f.name, included: f.included !== false, ...fieldSummary(f, thresholds) }));
  const inc = per.filter((p) => p.included);
  const sum = (k) => inc.reduce((a, p) => a + (p[k] || 0), 0);
  const total = sum('total');
  const sickled = sum('sickled');
  const clump = sum('clump');
  const pct = total ? Math.round((1000 * sickled) / total) / 10 : 0;
  // 95% Wilson interval for the pooled proportion
  let ci = null;
  if (total > 0) {
    const z = 1.96, p = sickled / total, n = total;
    const d = 1 + (z * z) / n;
    const c = (p + (z * z) / (2 * n)) / d;
    const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    ci = [Math.max(0, Math.round(1000 * (c - h)) / 10), Math.min(100, Math.round(1000 * (c + h)) / 10)];
  }
  const flags = [];
  if (inc.length === 0) flags.push({ level: 'critical', code: 'no_fields', text: 'No fields included in this slide.' });
  if (inc.length && total < minCells) flags.push({ level: 'warning', code: 'low_count', text: `Only ${total} cells counted; the lab minimum is ${minCells}. Add more fields.` });
  if (total && (100 * clump) / (total + clump) > maxClumpPct) flags.push({ level: 'warning', code: 'clumps', text: `${clump} clumps excluded (over ${maxClumpPct}%). Use a thinner area of the smear.` });
  const pcts = inc.filter((p) => p.total >= 20).map((p) => p.percentSickled);
  if (pcts.length >= 2 && Math.max(...pcts) - Math.min(...pcts) > 25) flags.push({ level: 'info', code: 'spread', text: 'Fields disagree by more than 25 points. Check focus and smear quality.' });
  return {
    fields: per,
    includedFields: inc.length,
    normal: sum('normal'), borderline: sum('borderline'), sickled, clump,
    edge: sum('edge'), excluded: sum('excluded'), corrections: sum('corrections'),
    total, percentSickled: pct, ci95: ci, flags,
  };
}

/** Banding used in the UI and report. Purely descriptive, not diagnostic. */
export function band(pct) {
  if (pct < 1) return { key: 'none', label: 'No sickled cells seen' };
  if (pct < 5) return { key: 'low', label: 'Occasional sickled cells' };
  if (pct < 15) return { key: 'moderate', label: 'Moderate sickled-cell fraction' };
  return { key: 'high', label: 'High sickled-cell fraction' };
}

/** CSV of every cell across a slide's fields. */
export function slideCellsCsv(slide, patient, fields, thresholds) {
  const head = ['patient_code', 'sample_date', 'field', 'included', 'cell_id', 'class', 'auto_class', 'corrected', 'area_px', 'circularity', 'elongation', 'solidity', 'major_axis_px', 'minor_axis_px', 'centroid_x', 'centroid_y'];
  const rows = [];
  for (const f of fields) {
    const { classes, auto } = fieldClasses(f, thresholds);
    for (const c of f.cells || []) {
      rows.push([patient?.code ?? '', slide.sampleDate, csvSafe(f.name), f.included !== false, c.id, classes[c.id], auto[c.id], classes[c.id] !== auto[c.id], c.area, c.circularity, c.elongation, c.solidity, c.majorAxis, c.minorAxis, c.cx, c.cy].join(','));
    }
  }
  return ['# SickleScan export - research and education use only, not a diagnosis', head.join(','), ...rows].join('\n');
}

export function csvSafe(v) {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
