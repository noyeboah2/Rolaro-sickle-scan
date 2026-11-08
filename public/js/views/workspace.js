// Slide analysis workspace: slide details, many fields per slide, cell-level corrections, live pooled totals.
import { h, field, select, toast, fmtPct, fmtInt, todayIso, confirmDialog, pill } from '../ui.js';
import { get, listPatients, getSettings, saveSlide, saveField, deleteField, fieldsForSlide, uid } from '../db.js';
import { DEFAULT_THRESHOLDS, ENGINE } from '../analysis.js';
import { fieldClasses, slideSummary, OVERRIDE_CLASSES, band } from '../aggregate.js';
import { segment, loadImage, blobToCanvas, drawAnnotated, thumbnail, hitTest, sampleBlob, CLASS_LABELS, MAX_BYTES } from '../engine.js';
import { compositionBar } from '../charts.js';
import { STAINS, MAGS, patientDialog } from './common.js';

const COMP = [['normal', 'Normal', '#1f8f4e'], ['borderline', 'Borderline', '#c77c02'], ['sickled', 'Sickled', '#d62839']];

export async function render(ctx) {
  const settings = await getSettings();
  let patients = await listPatients();
  const editing = !!ctx.params[0];
  let slide;
  if (editing) {
    slide = await get('slides', ctx.params[0]);
    if (!slide) return h('div.page', h('h1', 'Slide not found'), h('a', { href: '#/slides' }, 'Back to slides'));
  } else {
    slide = {
      id: uid(), patientId: ctx.query.patient || '', sampleDate: todayIso(), stain: 'Giemsa', magnification: '100x',
      technician: '', notes: '', status: 'draft', engine: ENGINE,
      thresholds: { ...DEFAULT_THRESHOLDS, ...(settings.thresholds || {}) },
    };
  }
  slide.thresholds = { ...DEFAULT_THRESHOLDS, ...(slide.thresholds || {}) };
  let persisted = editing;
  const fields = editing ? await fieldsForSlide(slide.id) : [];
  const canvases = new Map(); // fieldId -> base canvas
  let activeId = fields[0]?.id || null;
  let selectedCell = null;
  let overlayOn = true;
  let busy = 0;
  let saveTimer = null;
  let dirtyThumbs = new Set();

  // ------------------------------------------------------------ elements
  const patientSel = h('select', { name: 'patientId', required: true, 'aria-label': 'Patient' });
  const fillPatients = () => {
    patientSel.replaceChildren(h('option', { value: '' }, '— Select patient —'), ...patients.map((p) => h('option', { value: p.id, selected: p.id === slide.patientId }, `${p.code}${p.genotype ? ' · ' + p.genotype : ''}`)));
  };
  fillPatients();
  const metaForm = h('form.meta-form', { onsubmit: (e) => e.preventDefault() },
    field('Patient', h('div.row.nowrap', patientSel, h('button.btn.btn-small', { type: 'button', onclick: async () => {
      const p = await patientDialog(); if (!p) return;
      patients = await listPatients(); slide.patientId = p.id; fillPatients(); scheduleSave();
    } }, '+ New'))),
    field('Sample date', h('input', { name: 'sampleDate', type: 'date', value: slide.sampleDate, max: todayIso(), required: true })),
    field('Stain', select('stain', STAINS, slide.stain)),
    field('Magnification', select('magnification', MAGS, slide.magnification)),
    field('Technician initials', h('input', { name: 'technician', value: slide.technician, maxlength: 8, autocomplete: 'off', placeholder: 'e.g. KA' })),
    field('Slide notes', h('input', { name: 'notes', value: slide.notes, maxlength: 300, placeholder: 'Smear quality, area used…' })));
  metaForm.addEventListener('input', () => {
    const fd = new FormData(metaForm);
    slide.patientId = fd.get('patientId') || '';
    slide.sampleDate = fd.get('sampleDate') || todayIso();
    slide.stain = fd.get('stain'); slide.magnification = fd.get('magnification');
    slide.technician = String(fd.get('technician') || '').toUpperCase().slice(0, 8);
    slide.notes = String(fd.get('notes') || '').slice(0, 300);
    scheduleSave();
  });

  const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, hidden: true });
  const camInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const fieldList = h('ol.field-list', { 'aria-label': 'Fields on this slide' });
  const addZone = h('div.add-zone', { tabindex: 0, role: 'button', 'aria-label': 'Add field images' },
    h('strong', 'Add fields'), h('small', 'Drop images, or choose'),
    h('div.row.center',
      h('label.btn.btn-small', 'Choose', fileInput),
      h('label.btn.btn-small.btn-mobile', 'Camera', camInput),
      h('button.btn.btn-small', { type: 'button', onclick: async (e) => { e.stopPropagation(); addFiles([new File([await sampleBlob()], 'sample-smear.jpg', { type: 'image/jpeg' })]); } }, 'Sample')));

  const canvas = h('canvas.viewer-canvas', { 'aria-label': 'Field image with detected cells outlined' });
  const g = canvas.getContext('2d');
  const viewerEmpty = h('div.viewer-empty', h('p', 'Add one or more microscope field images of this slide.'), h('p.muted.small', 'Use the thin monolayer area. 5–10 fields of ~50–100 cells give a reliable count.'));
  const busyEl = h('div.busy', { hidden: true }, h('span.spinner'), h('span.busy-text', 'Analysing…'));
  const overlayToggle = h('label.toggle', h('input', { type: 'checkbox', checked: true, onchange: (e) => { overlayOn = e.target.checked; drawActive(); } }), ' Outlines');
  const invertToggle = h('label.toggle', h('input', { type: 'checkbox', onchange: (e) => reanalyseActive(e.target.checked) }), ' Cells lighter than background');
  const includeToggle = h('label.toggle', h('input', { type: 'checkbox', checked: true, onchange: (e) => { const f = activeField(); if (f) { f.included = e.target.checked; persistField(f); refresh(); } } }), ' Include in slide total');
  const fieldTitle = h('strong.field-title');
  const inspector = h('div.inspector', { hidden: true });
  const viewer = h('section.card.viewer-card',
    h('div.viewer-bar', fieldTitle, h('div.row', overlayToggle, invertToggle, includeToggle)),
    h('div.viewer-wrap', canvas, viewerEmpty, busyEl),
    h('div.viewer-foot', legend(), h('p.muted.small', 'Click a cell to inspect it or correct its class. Corrected cells show a white dot.')),
    inspector);

  const totals = h('section.card.totals');
  const sliders = thresholdSliders();
  const statusEl = h('span.save-state.muted.small');
  const finaliseBtn = h('button.btn.btn-primary', { type: 'button', onclick: finalise }, 'Finalise & view report');

  const page = h('div.page.workspace',
    h('p.crumbs', h('a', { href: '#/slides' }, 'Slides'), ' / ', editing ? 'Edit slide' : 'New analysis'),
    h('header.page-head', h('div', h('h1', editing ? 'Edit slide' : 'New slide analysis'), h('p.muted', 'Every image is analysed on this device. Nothing is uploaded.')),
      h('div.row', statusEl, h('button.btn', { type: 'button', onclick: () => saveNow(true) }, 'Save draft'), finaliseBtn)),
    h('section.card', h('h2', 'Slide details'), metaForm),
    h('div.ws-grid',
      h('aside.ws-fields', h('section.card', h('h2', 'Fields ', h('span.count-badge', '0')), fieldList, addZone)),
      viewer,
      h('aside.ws-side', totals, h('section.card', h('h2', 'Classification thresholds'), h('p.muted.small', 'Applied to every field of this slide.'), sliders))));

  // ------------------------------------------------------------ inputs
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
  camInput.addEventListener('change', () => { addFiles([...camInput.files]); camInput.value = ''; });
  addZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  ['dragenter', 'dragover'].forEach((t) => addZone.addEventListener(t, (e) => { e.preventDefault(); addZone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => addZone.addEventListener(t, (e) => { e.preventDefault(); addZone.classList.remove('over'); }));
  addZone.addEventListener('drop', (e) => addFiles([...(e.dataTransfer?.files || [])]));
  const onPaste = (e) => { const it = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')); if (it.length) addFiles(it.map((i) => i.getAsFile())); };
  window.addEventListener('paste', onPaste);

  canvas.addEventListener('click', (e) => {
    const f = activeField(); if (!f) return;
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * canvas.width, y = ((e.clientY - r.top) / r.height) * canvas.height;
    const { classes } = fieldClasses(f, slide.thresholds);
    const c = hitTest(f.cells, classes, x, y);
    selectedCell = c ? c.id : null;
    drawActive(); drawInspector();
  });

  const onKey = (e) => {
    if (selectedCell == null || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const map = { n: 'normal', b: 'borderline', s: 'sickled', x: 'excluded' };
    if (map[e.key]) { setOverride(selectedCell, map[e.key]); e.preventDefault(); }
    if (e.key === 'r') { setOverride(selectedCell, null); e.preventDefault(); }
    if (e.key === 'Escape') { selectedCell = null; drawActive(); drawInspector(); }
  };
  window.addEventListener('keydown', onKey);
  const onLeave = (e) => { if (busy || saveTimer) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onLeave);
  ctx.cleanup = () => {
    window.removeEventListener('paste', onPaste); window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', onLeave);
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveNow(false); }
  };

  // ------------------------------------------------------------ fields
  function activeField() { return fields.find((f) => f.id === activeId) || null; }

  async function addFiles(files) {
    const list = files.filter(Boolean);
    if (!list.length) return;
    for (const file of list) {
      if (file.size > MAX_BYTES) { toast(`${file.name}: larger than 15 MB`, 'err'); continue; }
      busy++; setBusy(`Analysing ${file.name || 'image'}…`);
      try {
        const { canvas: base, imageData, blob } = await loadImage(file);
        const seg = await segment(imageData, { invert: false });
        const f = {
          id: uid(), slideId: slide.id, index: (fields.at(-1)?.index ?? 0) + 1,
          name: `Field ${fields.length + 1}`, source: (file.name || '').slice(0, 80),
          image: blob, width: seg.width, height: seg.height, cells: seg.cells,
          otsu: seg.threshold, foregroundFraction: seg.foregroundFraction, invert: false,
          included: true, overrides: {}, thumb: null,
        };
        canvases.set(f.id, base);
        f.thumb = thumbnail(base, f.cells, fieldClasses(f, slide.thresholds).classes, 360);
        fields.push(f);
        await ensureSlideSaved();
        await saveField(f);
        activeId = f.id; selectedCell = null;
        await refresh();
      } catch (err) {
        toast(`${file.name || 'Image'}: ${err.message}`, 'err');
      } finally {
        busy--; if (!busy) setBusy(null);
      }
    }
  }

  async function reanalyseActive(invert) {
    const f = activeField(); if (!f) return;
    busy++; setBusy('Re-analysing…');
    try {
      const base = await baseFor(f);
      const data = base.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, base.width, base.height);
      const seg = await segment(data, { invert });
      Object.assign(f, { cells: seg.cells, otsu: seg.threshold, foregroundFraction: seg.foregroundFraction, invert, overrides: {} });
      selectedCell = null;
      dirtyThumbs.add(f.id);
      await persistField(f);
      await refresh();
      toast('Field re-analysed; corrections on it were cleared');
    } catch (err) { toast(err.message, 'err'); } finally { busy--; if (!busy) setBusy(null); }
  }

  async function baseFor(f) {
    if (!canvases.has(f.id)) canvases.set(f.id, await blobToCanvas(f.image));
    return canvases.get(f.id);
  }

  async function removeField(f) {
    if (!(await confirmDialog(`Remove ${f.name}?`, 'The image and its corrections will be deleted from this slide.', 'Remove'))) return;
    const i = fields.indexOf(f);
    fields.splice(i, 1);
    canvases.delete(f.id);
    await deleteField(f.id);
    if (activeId === f.id) { activeId = fields[Math.min(i, fields.length - 1)]?.id || null; selectedCell = null; }
    await refresh(); scheduleSave();
  }

  function setOverride(cellId, cls) {
    const f = activeField(); if (!f) return;
    f.overrides = { ...(f.overrides || {}) };
    if (cls == null) delete f.overrides[cellId]; else f.overrides[cellId] = cls;
    dirtyThumbs.add(f.id);
    persistField(f);
    refresh();
  }

  async function persistField(f) {
    if (!persisted) await ensureSlideSaved();
    if (dirtyThumbs.has(f.id) && canvases.has(f.id)) {
      const { classes } = fieldClasses(f, slide.thresholds);
      f.thumb = thumbnail(canvases.get(f.id), f.cells, classes, 360, correctedSet(f));
      dirtyThumbs.delete(f.id);
    }
    await saveField(f);
    scheduleSave();
  }

  // ------------------------------------------------------------ saving
  async function ensureSlideSaved() {
    if (persisted) return;
    persisted = true;
    await saveSlide({ ...slide, summary: slideSummary(fields, slide.thresholds, settings) });
  }
  function scheduleSave() {
    statusEl.textContent = 'Unsaved changes';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveNow(false); }, 800);
  }
  async function saveNow(announce) {
    clearTimeout(saveTimer); saveTimer = null;
    if (!persisted && !fields.length) { if (announce) toast('Add at least one field first', 'err'); return false; }
    const summary = slideSummary(fields, slide.thresholds, settings);
    const saved = await saveSlide({ ...slide, summary });
    Object.assign(slide, { createdAt: saved.createdAt, updatedAt: saved.updatedAt });
    persisted = true;
    statusEl.textContent = `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    if (announce) toast('Draft saved');
    return true;
  }

  async function finalise() {
    if (!slide.patientId) { toast('Choose a patient for this slide', 'err'); patientSel.focus(); return; }
    if (!fields.some((f) => f.included !== false)) { toast('Add at least one included field', 'err'); return; }
    busy++; setBusy('Preparing report…');
    try {
      for (const f of fields) { // refresh every thumbnail with the final thresholds and corrections
        const base = await baseFor(f);
        f.thumb = thumbnail(base, f.cells, fieldClasses(f, slide.thresholds).classes, 520, correctedSet(f));
        await saveField(f);
      }
      slide.status = 'final';
      slide.finalisedAt = new Date().toISOString();
      await saveNow(false);
      ctx.navigate(`/slides/${slide.id}`);
    } catch (err) { toast(err.message, 'err'); } finally { busy--; if (!busy) setBusy(null); }
  }

  // ------------------------------------------------------------ drawing
  function correctedSet(f) {
    const { auto } = fieldClasses(f, slide.thresholds);
    return new Set(Object.entries(f.overrides || {}).filter(([id, k]) => auto[id] !== k).map(([id]) => id));
  }

  function setBusy(text) { busyEl.hidden = !text; if (text) busyEl.querySelector('.busy-text').textContent = text; }

  async function drawActive() {
    const f = activeField();
    viewerEmpty.hidden = !!f; canvas.hidden = !f;
    [overlayToggle, invertToggle, includeToggle].forEach((t) => { t.hidden = !f; });
    if (!f) { fieldTitle.textContent = 'No field selected'; return; }
    fieldTitle.textContent = `${f.name}${f.source ? ' · ' + f.source : ''}`;
    invertToggle.firstChild.checked = !!f.invert;
    includeToggle.firstChild.checked = f.included !== false;
    const base = await baseFor(f);
    if (canvas.width !== base.width || canvas.height !== base.height) { canvas.width = base.width; canvas.height = base.height; }
    const { classes } = fieldClasses(f, slide.thresholds);
    drawAnnotated(g, base, f.cells, classes, { selected: selectedCell, overlay: overlayOn, corrected: correctedSet(f) });
  }

  function drawInspector() {
    const f = activeField();
    const c = f && selectedCell != null ? f.cells.find((x) => x.id === selectedCell) : null;
    if (!c) { inspector.hidden = true; return; }
    const { classes, auto, medianArea } = fieldClasses(f, slide.thresholds);
    const cur = classes[c.id];
    inspector.hidden = false;
    inspector.replaceChildren(
      h('div.inspector-head', h('strong', `Cell #${c.id}`), pill(CLASS_LABELS[cur], cur),
        cur !== auto[c.id] ? h('small.muted', `auto: ${CLASS_LABELS[auto[c.id]]}`) : null,
        h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => { selectedCell = null; drawActive(); drawInspector(); } }, '×')),
      h('dl.mini-stats',
        stat('Area', `${c.area} px (${(c.area / (medianArea || 1)).toFixed(2)}× median)`), stat('Elongation', c.elongation),
        stat('Circularity', c.circularity), stat('Solidity', c.solidity), stat('Axes', `${c.majorAxis} × ${c.minorAxis} px`)),
      h('div.reclass', h('span.muted.small', 'Set class:'),
        OVERRIDE_CLASSES.map((k) => h(`button.btn.btn-small.cls-${k}${cur === k ? '.on' : ''}`, { type: 'button', onclick: () => setOverride(c.id, k) },
          `${CLASS_LABELS[k] === 'Excluded by you' ? 'Exclude' : CLASS_LABELS[k]} (${({ normal: 'N', borderline: 'B', sickled: 'S', excluded: 'X' })[k]})`)),
        f.overrides?.[c.id] != null ? h('button.btn.btn-small.btn-ghost', { type: 'button', onclick: () => setOverride(c.id, null) }, 'Reset to auto (R)') : null));
  }

  function drawFieldList() {
    page.querySelector('.count-badge').textContent = String(fields.length);
    fieldList.replaceChildren(...fields.map((f) => {
      const sum = slideSummary([f], slide.thresholds, settings).fields[0];
      return h(`li.field-item${f.id === activeId ? '.active' : ''}${f.included === false ? '.excluded' : ''}`,
        h('button.field-pick', { type: 'button', onclick: () => { activeId = f.id; selectedCell = null; drawFieldList(); drawActive(); drawInspector(); } },
          f.thumb ? h('img', { src: f.thumb, alt: '' }) : h('span.thumb-ph'),
          h('span.field-meta', h('strong', f.name), h('small', `${sum.total} cells · ${fmtPct(sum.percentSickled)}`), f.included === false ? h('small.muted', 'Not included') : null,
            sum.corrections ? h('small.muted', `${sum.corrections} corrected`) : null)),
        h('button.icon-btn.field-del', { type: 'button', 'aria-label': `Remove ${f.name}`, onclick: () => removeField(f) }, '×'));
    }));
  }

  function drawTotals() {
    const s = slideSummary(fields, slide.thresholds, settings);
    const b = band(s.percentSickled);
    totals.replaceChildren(
      h('h2', 'Slide total'),
      h('div.big', h('span.pct', s.total ? fmtPct(s.percentSickled) : '–'), h('span.muted', 'sickled')),
      s.ci95 ? h('p.muted.small', `95% interval ${s.ci95[0]}–${s.ci95[1]}% · ${s.includedFields} field${s.includedFields === 1 ? '' : 's'} pooled`) : h('p.muted.small', 'Add fields to see the total'),
      s.total ? h('p', pill(b.label, `band-${b.key}`)) : null,
      s.total ? compositionBar(COMP.map(([k, l, c]) => ({ key: k, label: l, value: s[k], color: c }))) : null,
      h('dl.stats',
        row('Cells counted', fmtInt(s.total)), row('Normal', fmtInt(s.normal), 'normal'), row('Borderline', fmtInt(s.borderline), 'borderline'),
        row('Sickled', fmtInt(s.sickled), 'sickled'), row('Clumps excluded', fmtInt(s.clump), 'clump'), row('Edge cells excluded', fmtInt(s.edge), 'edge'),
        row('Excluded by you', fmtInt(s.excluded), 'excluded'), row('Manual corrections', fmtInt(s.corrections))),
      s.flags.length ? h('ul.flags', s.flags.map((fl) => h(`li.flag-${fl.level}`, fl.text))) : (s.total ? h('p.ok-note', `QC passed (minimum ${settings.qcMinCells} cells)`) : null));
  }

  async function refresh() { drawFieldList(); drawTotals(); await drawActive(); drawInspector(); }

  function thresholdSliders() {
    const defs = [
      ['sickleElongation', 'Sickled if elongation ≥', 1.5, 3.5, 0.05, 2],
      ['borderlineElongation', 'Borderline if elongation ≥', 1.1, 2.5, 0.05, 2],
      ['sickleCircularity', '…or sickled if circularity <', 0.2, 0.9, 0.01, 2],
      ['clumpAreaRatio', 'Clump if area > × median', 1.5, 4, 0.1, 1],
    ];
    const outs = {};
    const wrap = h('div', defs.map(([k, label, min, max, step, dp]) => {
      const out = h('output'); outs[k] = [out, dp];
      const input = h('input', { type: 'range', min, max, step, value: slide.thresholds[k], 'aria-label': label });
      input.addEventListener('input', () => {
        slide.thresholds = { ...slide.thresholds, [k]: Number(input.value) };
        if (slide.thresholds.borderlineElongation > slide.thresholds.sickleElongation) {
          if (k === 'sickleElongation') slide.thresholds.borderlineElongation = slide.thresholds.sickleElongation;
          else slide.thresholds.sickleElongation = slide.thresholds.borderlineElongation;
        }
        sync(); fields.forEach((f) => dirtyThumbs.add(f.id)); refresh(); scheduleSave();
      });
      return h('div.slider', h('label', `${label} `, out), input);
    }), h('button.btn.btn-small', { type: 'button', onclick: () => {
      slide.thresholds = { ...DEFAULT_THRESHOLDS, ...(settings.thresholds || {}) };
      wrap.querySelectorAll('input[type=range]').forEach((inp, i) => { inp.value = slide.thresholds[defs[i][0]]; });
      sync(); refresh(); scheduleSave();
    } }, 'Reset to lab defaults'));
    function sync() {
      for (const [k, [out, dp]] of Object.entries(outs)) out.textContent = Number(slide.thresholds[k]).toFixed(dp);
      wrap.querySelectorAll('input[type=range]').forEach((inp, i) => { inp.value = slide.thresholds[defs[i][0]]; });
    }
    sync();
    return wrap;
  }

  await refresh();
  statusEl.textContent = editing ? (slide.status === 'final' ? 'Reported slide: edits update the report' : 'Draft') : 'Not saved yet';
  if (ctx.query.sample && !fields.length) setTimeout(async () => addFiles([new File([await sampleBlob()], 'sample-smear.jpg', { type: 'image/jpeg' })]), 50);
  return page;
}

function stat(k, v) { return h('div', h('dt', k), h('dd', String(v))); }
function row(k, v, sw) { return h('div', h('dt', sw ? h(`i.sw.sw-${sw}`) : null, k), h('dd', v)); }
function legend() {
  return h('ul.legend', [['normal', 'Normal'], ['borderline', 'Borderline'], ['sickled', 'Sickled'], ['clump', 'Clump'], ['edge', 'Edge cell'], ['excluded', 'Excluded by you']]
    .map(([k, l]) => h('li', h(`i.sw.sw-${k}`), l)));
}
