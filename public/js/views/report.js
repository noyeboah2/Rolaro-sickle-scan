import { h, fmtPct, fmtInt, fmtDate, confirmDialog, toast, download, safeName, ageFrom } from '../ui.js';
import { get, fieldsForSlide, getSettings, deleteSlide, saveSlide } from '../db.js';
import { slideSummary, band, slideCellsCsv } from '../aggregate.js';
import { compositionBar } from '../charts.js';
import { DEFAULT_THRESHOLDS } from '../analysis.js';

const COMP = [['normal', 'Normal', '#1f8f4e'], ['borderline', 'Borderline', '#c77c02'], ['sickled', 'Sickled', '#d62839']];

export async function render(ctx) {
  const slide = await get('slides', ctx.params[0]);
  if (!slide) return h('div.page', h('h1', 'Slide not found'), h('a', { href: '#/slides' }, 'Back to slides'));
  const [patient, fields, settings] = await Promise.all([slide.patientId ? get('patients', slide.patientId) : null, fieldsForSlide(slide.id), getSettings()]);
  const t = { ...DEFAULT_THRESHOLDS, ...(slide.thresholds || {}) };
  const s = slideSummary(fields, t, settings);
  const b = band(s.percentSickled);
  const isFinal = slide.status === 'final';
  const reportId = slide.id.slice(0, 8).toUpperCase();

  const del = async () => {
    if (!(await confirmDialog('Delete this slide?', 'The slide, its field images and corrections will be deleted. This cannot be undone.'))) return;
    await deleteSlide(slide.id); toast('Slide deleted');
    ctx.navigate(patient ? `/patients/${patient.id}` : '/slides');
  };
  const csv = () => download(new Blob([slideCellsCsv(slide, patient, fields, t)], { type: 'text/csv' }), `${safeName(patient?.code || 'slide')}_${slide.sampleDate}_cells.csv`);
  const reopen = async () => { await saveSlide({ ...slide, status: 'draft' }); ctx.navigate(`/slides/${slide.id}/edit`); };

  const age = patient ? ageFrom(patient.birthYear) : null;
  const sheet = h(`article.report${isFinal ? '' : '.is-draft'}`,
    h('header.report-head',
      h('div', h('p.report-lab', settings.labName || 'Laboratory'), h('h1', 'Blood smear sickled-cell analysis')),
      h('dl.report-ids', kv('Report', reportId), kv('Status', isFinal ? 'Final' : 'Draft'), kv('Issued', fmtDate(slide.finalisedAt || slide.updatedAt)))),
    h('section.report-grid',
      h('div', h('h3', 'Patient'), h('dl.kv',
        kv('Code', patient?.code || 'Not assigned'), kv('Sex', patient?.sex === 'F' ? 'Female' : patient?.sex === 'M' ? 'Male' : 'Not recorded'),
        kv('Age', age != null ? `${age} years` : 'Not recorded'), kv('Genotype on record', patient?.genotype || 'Not recorded'),
        kv('Hydroxyurea', patient?.hydroxyurea ? `Yes${patient.huStart ? ', since ' + fmtDate(patient.huStart) : ''}` : 'No / not recorded'))),
      h('div', h('h3', 'Sample'), h('dl.kv',
        kv('Sample date', fmtDate(slide.sampleDate)), kv('Stain', slide.stain || '–'), kv('Magnification', (slide.magnification || '–').replace('x', '×')),
        kv('Technician', slide.technician || '–'), kv('Fields analysed', `${s.includedFields} of ${fields.length}`)))),
    h('section.report-result',
      h('div.result-main', h('span.result-label', 'Sickled cells'), h('span.result-value', s.total ? fmtPct(s.percentSickled) : '–'),
        s.ci95 ? h('span.result-ci', `95% interval ${s.ci95[0]}–${s.ci95[1]}%`) : null, h('span.result-band', b.label)),
      h('div.result-counts',
        compositionBar(COMP.map(([k, l, c]) => ({ key: k, label: l, value: s[k], color: c }))),
        h('table.table.compact', h('tbody',
          trow('Cells counted', fmtInt(s.total)), trow('Normal', fmtInt(s.normal)), trow('Borderline (elongated, not sickled)', fmtInt(s.borderline)),
          trow('Sickled', fmtInt(s.sickled)), trow('Excluded: clumps / edge / by technician', `${s.clump} / ${s.edge} / ${s.excluded}`),
          trow('Manual corrections', fmtInt(s.corrections)))))),
    s.flags.length ? h('section.report-qc', h('h3', 'Quality notes'), h('ul.flags', s.flags.map((f) => h(`li.flag-${f.level}`, f.text)))) : h('section.report-qc', h('h3', 'Quality notes'), h('p', `QC passed: at least ${settings.qcMinCells} cells counted, clumps within limits.`)),
    h('section', h('h3', 'Fields'), h('table.table.compact',
      h('thead', h('tr', h('th', 'Field'), h('th', 'Included'), h('th.num', 'Cells'), h('th.num', 'Sickled'), h('th.num', '% sickled'), h('th.num', 'Corrections'))),
      h('tbody', s.fields.map((f) => h('tr', h('td', f.name), h('td', f.included ? 'Yes' : 'No'), h('td.num', f.total), h('td.num', f.sickled), h('td.num', fmtPct(f.percentSickled)), h('td.num', f.corrections)))))),
    h('section.report-thumbs', fields.filter((f) => f.included !== false && f.thumb).map((f) => h('figure', h('img', { src: f.thumb, alt: `${f.name} with cells outlined` }), h('figcaption', f.name)))),
    slide.notes ? h('section', h('h3', 'Slide notes'), h('p.prewrap', slide.notes)) : null,
    h('section.report-method', h('h3', 'Method'),
      h('p', `Automated shape analysis (SickleScan ${slide.engine || 'rules-v1'}) on the green channel with Otsu thresholding. A cell is classed as sickled if elongation ≥ ${t.sickleElongation.toFixed(2)}, or elongation ≥ ${t.sickleElongationLow.toFixed(2)} with circularity < ${t.sickleCircularity.toFixed(2)}; borderline if elongation ≥ ${t.borderlineElongation.toFixed(2)}. Overlapping clumps (area > ${t.clumpAreaRatio.toFixed(1)}× median) and cells cut by the image edge are excluded. Counts are pooled across included fields; the interval is a 95% Wilson interval. Classes may have been corrected by the technician.`)),
    h('p.report-disclaimer', 'For research and education. This is not a diagnosis. Sickle cell disease must be confirmed by HPLC, haemoglobin electrophoresis or another validated method, and results interpreted by a qualified clinician.'),
    h('div.sign', h('div', h('span'), h('small', 'Analysed by')), h('div', h('span'), h('small', 'Reviewed by')), h('div', h('span'), h('small', 'Date'))),
    settings.reportFooter ? h('p.report-footer', settings.reportFooter) : null);

  return h('div.page.report-page',
    h('div.report-actions.no-print',
      h('p.crumbs', patient ? h('a', { href: `#/patients/${patient.id}` }, patient.code) : h('a', { href: '#/slides' }, 'Slides'), ' / Report'),
      h('div.row',
        h('button.btn.btn-primary', { type: 'button', onclick: () => window.print() }, 'Print / Save as PDF'),
        h('button.btn', { type: 'button', onclick: csv }, 'Cell data (CSV)'),
        isFinal ? h('button.btn', { type: 'button', onclick: reopen }, 'Reopen to edit') : h('a.btn', { href: `#/slides/${slide.id}/edit` }, 'Continue editing'),
        h('button.btn.btn-danger-ghost', { type: 'button', onclick: del }, 'Delete'))),
    sheet);
}

function kv(k, v) { return h('div', h('dt', k), h('dd', v)); }
function trow(k, v) { return h('tr', h('th', k), h('td.num', v)); }
