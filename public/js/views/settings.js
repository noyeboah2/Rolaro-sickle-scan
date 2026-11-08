import { h, field, toast, download, confirmDialog, modal, fmtDate, todayIso } from '../ui.js';
import { getSettings, saveSettings, exportBackup, importBackup, eraseAll, storageEstimate, listSlides, listPatients, DEFAULT_SETTINGS } from '../db.js';
import { DEFAULT_THRESHOLDS } from '../analysis.js';
import { csvSafe } from '../aggregate.js';
import { pageHead } from './common.js';

export async function render(ctx) {
  const st = await getSettings();
  const est = await storageEstimate();
  const th = { ...DEFAULT_THRESHOLDS, ...(st.thresholds || {}) };

  const form = h('form.form',
    h('div.grid2',
      field('Lab name (on reports)', h('input', { name: 'labName', value: st.labName, maxlength: 80 })),
      field('Report footer', h('input', { name: 'reportFooter', value: st.reportFooter, maxlength: 160, placeholder: 'Address, accreditation number…' })),
      field('QC: minimum cells per slide', h('input', { name: 'qcMinCells', type: 'number', min: 20, max: 5000, value: st.qcMinCells })),
      field('QC: maximum clumps (%)', h('input', { name: 'qcMaxClumpPct', type: 'number', min: 1, max: 100, value: st.qcMaxClumpPct }))),
    h('h3', 'Default thresholds for new slides'),
    h('div.grid2',
      field('Sickled if elongation ≥', h('input', { name: 'sickleElongation', type: 'number', step: 0.05, min: 1.5, max: 3.5, value: th.sickleElongation })),
      field('Borderline if elongation ≥', h('input', { name: 'borderlineElongation', type: 'number', step: 0.05, min: 1.1, max: 2.5, value: th.borderlineElongation })),
      field('…or sickled if circularity <', h('input', { name: 'sickleCircularity', type: 'number', step: 0.01, min: 0.2, max: 0.9, value: th.sickleCircularity })),
      field('Clump if area > × median', h('input', { name: 'clumpAreaRatio', type: 'number', step: 0.1, min: 1.5, max: 4, value: th.clumpAreaRatio }))),
    h('div.row', h('button.btn.btn-primary', { type: 'submit' }, 'Save settings'),
      h('button.btn', { type: 'button', onclick: async () => { await saveSettings({ ...DEFAULT_SETTINGS, labName: st.labName, reportFooter: st.reportFooter }); toast('Thresholds and QC reset'); ctx.navigate(`/settings?r=${Date.now()}`); } }, 'Reset QC & thresholds')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const num = (k, lo, hi, d) => { const v = Number(fd.get(k)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
    let se = num('sickleElongation', 1.5, 3.5, 2), be = num('borderlineElongation', 1.1, 2.5, 1.5);
    if (be > se) be = se;
    await saveSettings({
      labName: String(fd.get('labName') || '').slice(0, 80), reportFooter: String(fd.get('reportFooter') || '').slice(0, 160),
      qcMinCells: Math.round(num('qcMinCells', 20, 5000, 200)), qcMaxClumpPct: num('qcMaxClumpPct', 1, 100, 25),
      thresholds: { ...DEFAULT_THRESHOLDS, sickleElongation: se, borderlineElongation: be, sickleCircularity: num('sickleCircularity', 0.2, 0.9, 0.55), clumpAreaRatio: num('clumpAreaRatio', 1.5, 4, 2.2) },
    });
    toast('Settings saved');
  });

  const withImages = h('input', { type: 'checkbox', checked: true });
  const importInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  const replaceBox = h('input', { type: 'checkbox' });
  importInput.addEventListener('change', async () => {
    const f = importInput.files[0]; importInput.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (replaceBox.checked && !(await confirmDialog('Replace all data?', 'Everything currently on this device will be replaced by the backup.', 'Replace'))) return;
      const r = await importBackup(data, { replace: replaceBox.checked });
      toast(`Imported ${r.patients} patients, ${r.slides} slides, ${r.fields} fields`);
      ctx.navigate('/');
    } catch (err) { toast(`Import failed: ${err.message}`, 'err'); }
  });

  const backup = async () => {
    toast('Preparing backup…');
    const data = await exportBackup({ includeImages: withImages.checked });
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `sicklescan-backup-${todayIso()}.json`);
  };
  const summaryCsv = async () => {
    const [slides, patients] = await Promise.all([listSlides(), listPatients()]);
    const byId = new Map(patients.map((p) => [p.id, p]));
    const head = ['patient_code', 'genotype', 'hydroxyurea', 'sample_date', 'status', 'stain', 'magnification', 'technician', 'fields', 'cells', 'normal', 'borderline', 'sickled', 'percent_sickled', 'ci_low', 'ci_high', 'qc_flags'];
    const rows = slides.map((s) => { const p = byId.get(s.patientId) || {}; const m = s.summary || {};
      return [p.code, p.genotype, p.hydroxyurea ? 'yes' : 'no', s.sampleDate, s.status, s.stain, s.magnification, s.technician, m.includedFields, m.total, m.normal, m.borderline, m.sickled, m.percentSickled, m.ci95?.[0], m.ci95?.[1], (m.flags || []).map((f) => f.code).join(' ')].map(csvSafe).join(','); });
    download(new Blob([[head.join(','), ...rows].join('\n')], { type: 'text/csv' }), `sicklescan-slides-${todayIso()}.csv`);
  };
  const erase = () => {
    const box = h('input', { placeholder: 'Type ERASE', 'aria-label': 'Type ERASE to confirm', autocomplete: 'off' });
    const go = h('button.btn.btn-danger', { type: 'button', disabled: true, onclick: async () => { m.close(); await eraseAll(); toast('All data erased'); ctx.navigate('/'); } }, 'Erase everything');
    box.addEventListener('input', () => { go.disabled = box.value.trim() !== 'ERASE'; });
    const m = modal('Erase all data on this device?', h('div',
      h('p', 'All patients, slides and images will be deleted from this browser. Export a backup first.'),
      field('Type ERASE to confirm', box),
      h('div.row.end', h('button.btn', { type: 'button', onclick: () => m.close() }, 'Cancel'), go)));
    box.focus();
  };

  const used = est ? `${(est.usage / 1048576).toFixed(1)} MB used of about ${(est.quota / 1073741824).toFixed(1)} GB available to this site` : 'Storage size not available in this browser';
  return h('div.page',
    pageHead('Settings', 'Applies to this device only.'),
    h('section.card', h('h2', 'Lab & quality control'), form),
    h('section.card', h('h2', 'Data on this device'),
      h('p.muted', used),
      h('p', 'Your data lives only in this browser. Clearing browser data, or using another computer, means it is not there. Export a backup regularly and keep it somewhere safe.'),
      h('div.data-actions',
        h('div', h('h3', 'Backup'), h('label.check', withImages, ' Include images (larger file)'), h('button.btn.btn-primary', { type: 'button', onclick: backup }, 'Export backup (.json)')),
        h('div', h('h3', 'Restore'), h('label.check', replaceBox, ' Replace existing data'), h('label.btn', 'Import backup…', importInput)),
        h('div', h('h3', 'Spreadsheet'), h('p.muted.small', 'One row per slide, for Excel or statistics.'), h('button.btn', { type: 'button', onclick: summaryCsv }, 'Export slides (.csv)')))),
    h('section.card.danger', h('h2', 'Danger zone'), h('p', 'Delete every patient, slide and image stored in this browser.'), h('button.btn.btn-danger', { type: 'button', onclick: erase }, 'Erase all data')),
    h('p.muted.small', `SickleScan Lab · engine rules-v1 · ${fmtDate(todayIso())}`));
}
