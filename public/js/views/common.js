import { h, modal, field, select, toast, fmtDate, fmtPct, fmtInt, pill, ageFrom, todayIso } from '../ui.js';
import { savePatient, nextPatientCode } from '../db.js';
import { band } from '../aggregate.js';

export const GENOTYPES = [
  ['', 'Not recorded'], ['HbSS', 'HbSS'], ['HbSC', 'HbSC'], ['HbS/β0-thal', 'HbS/β⁰-thalassaemia'], ['HbS/β+-thal', 'HbS/β⁺-thalassaemia'],
  ['HbAS', 'HbAS (trait)'], ['HbAA', 'HbAA'], ['Other', 'Other'], ['Pending', 'Pending confirmation'],
];
export const STAINS = [['Giemsa', 'Giemsa'], ['Wright', 'Wright'], ['Leishman', 'Leishman'], ['Field', 'Field'], ['Wright-Giemsa', 'Wright-Giemsa'], ['Unstained / wet prep', 'Unstained / wet prep'], ['Other', 'Other']];
export const MAGS = [['40x', '40×'], ['60x', '60×'], ['100x', '100× oil'], ['Other', 'Other']];

export function statusPill(status) { return status === 'final' ? pill('Final', 'ok') : pill('Draft', 'draft'); }
export function bandPill(pct) { const b = band(pct); return pill(b.label, `band-${b.key}`); }

/** Open the add/edit patient dialog. Resolves with the saved patient or null. */
export function patientDialog(existing = null) {
  return new Promise(async (resolve) => {
    const p = existing || { code: await nextPatientCode(), sex: '', birthYear: '', genotype: '', hydroxyurea: false, huStart: '', notes: '' };
    const err = h('p.error', { hidden: true });
    const form = h('form.form', { novalidate: true },
      h('p.notice', 'Use a coded ID only. Do not enter names, phone numbers, addresses or hospital numbers.'),
      h('div.grid2',
        field('Patient code', h('input', { name: 'code', value: p.code, required: true, maxlength: 24, autocomplete: 'off', pattern: '[A-Za-z0-9-]{2,24}' }), 'Letters, digits and dashes'),
        field('Sex', select('sex', [['', 'Not recorded'], ['F', 'Female'], ['M', 'Male']], p.sex)),
        field('Birth year', h('input', { name: 'birthYear', type: 'number', min: 1900, max: new Date().getFullYear(), value: p.birthYear || '' })),
        field('Genotype on record', select('genotype', GENOTYPES, p.genotype), 'From HPLC / electrophoresis, if known'),
      ),
      h('div.grid2',
        h('label.check', h('input', { type: 'checkbox', name: 'hydroxyurea', checked: !!p.hydroxyurea }), ' On hydroxyurea'),
        field('Hydroxyurea start date', h('input', { name: 'huStart', type: 'date', value: p.huStart || '', max: todayIso() })),
      ),
      field('Notes', h('textarea', { name: 'notes', rows: 3, maxlength: 1000 }, p.notes || ''), 'Clinical context, no identifying details'),
      err,
      h('div.row.end', h('button.btn', { type: 'button', onclick: () => { m.close(); } }, 'Cancel'), h('button.btn.btn-primary', { type: 'submit' }, existing ? 'Save changes' : 'Add patient')));
    let saved = null;
    const m = modal(existing ? `Edit ${p.code}` : 'Add patient', form, { onClose: () => resolve(saved) });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        saved = await savePatient({
          ...p,
          code: fd.get('code'), sex: fd.get('sex'), birthYear: fd.get('birthYear') ? Number(fd.get('birthYear')) : '',
          genotype: fd.get('genotype'), hydroxyurea: fd.get('hydroxyurea') === 'on', huStart: fd.get('huStart') || '',
          notes: String(fd.get('notes') || '').slice(0, 1000),
        });
        toast(existing ? 'Patient updated' : `Patient ${saved.code} added`);
        m.close();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
    form.querySelector('[name=code]').focus();
  });
}

export function patientMeta(p) {
  const age = ageFrom(p.birthYear);
  return [p.sex === 'F' ? 'Female' : p.sex === 'M' ? 'Male' : null, age != null ? `${age} y` : null, p.genotype || 'Genotype not recorded', p.hydroxyurea ? `Hydroxyurea${p.huStart ? ' since ' + fmtDate(p.huStart) : ''}` : null].filter(Boolean).join(' · ');
}

/** Table of slides. patientsById: Map */
export function slidesTable(slides, patientsById, { showPatient = true } = {}) {
  if (!slides.length) return h('p.muted', 'No slides yet.');
  return h('div.table-wrap', h('table.table',
    h('thead', h('tr', h('th', 'Sample date'), showPatient ? h('th', 'Patient') : null, h('th.num', 'Fields'), h('th.num', 'Cells'), h('th.num', '% sickled'), h('th', 'Flags'), h('th', 'Status'))),
    h('tbody', slides.map((s) => {
      const p = patientsById?.get(s.patientId);
      const sum = s.summary || {};
      const href = s.status === 'final' ? `#/slides/${s.id}` : `#/slides/${s.id}/edit`;
      return h('tr.clickable', { onclick: (e) => { if (!e.target.closest('a')) location.hash = href; } },
        h('td', h('a', { href }, fmtDate(s.sampleDate))),
        showPatient ? h('td', p ? h('a', { href: `#/patients/${p.id}` }, p.code) : h('span.muted', s.patientId ? 'Deleted' : 'Not assigned')) : null,
        h('td.num', fmtInt(sum.includedFields ?? 0)),
        h('td.num', fmtInt(sum.total ?? 0)),
        h('td.num.strong', sum.total ? fmtPct(sum.percentSickled) : '–'),
        h('td', (sum.flags || []).filter((f) => f.level !== 'info').length ? pill(`${(sum.flags || []).filter((f) => f.level !== 'info').length} QC`, 'warn') : h('span.muted', '—')),
        h('td', statusPill(s.status)));
    }))));
}

export function pageHead(title, sub, ...actions) {
  return h('header.page-head', h('div', h('h1', title), sub ? h('p.muted', sub) : null), h('div.row', actions));
}
