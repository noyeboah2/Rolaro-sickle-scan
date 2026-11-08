import { h, fmtPct, fmtDate, confirmDialog, toast } from '../ui.js';
import { get, slidesForPatient, deletePatient } from '../db.js';
import { timelineChart } from '../charts.js';
import { patientDialog, patientMeta, slidesTable, pageHead, bandPill } from './common.js';

export async function render(ctx) {
  const p = await get('patients', ctx.params[0]);
  if (!p) return h('div.page', h('h1', 'Patient not found'), h('a', { href: '#/patients' }, 'Back to patients'));
  const slides = await slidesForPatient(p.id);
  const final = slides.filter((s) => s.status === 'final' && s.summary?.total);
  const latest = final.at(-1), prev = final.at(-2), first = final[0];

  const points = final.map((s) => ({ date: s.sampleDate, value: s.summary.percentSickled, lo: s.summary.ci95?.[0], hi: s.summary.ci95?.[1] }));
  const marker = p.hydroxyurea && p.huStart ? { date: p.huStart, label: 'Hydroxyurea start' } : null;

  const edit = async () => { if (await patientDialog(p)) ctx.navigate(`/patients/${p.id}?r=${Date.now()}`); };
  const del = async () => {
    if (!(await confirmDialog(`Delete ${p.code}?`, `This deletes the patient and all ${slides.length} slide(s) and images. It cannot be undone.`))) return;
    await deletePatient(p.id);
    toast(`${p.code} deleted`);
    ctx.navigate('/patients');
  };

  const delta = (a, b) => {
    const d = a.summary.percentSickled - b.summary.percentSickled;
    return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toFixed(1)} pts`;
  };

  return h('div.page',
    h('p.crumbs', h('a', { href: '#/patients' }, 'Patients'), ' / ', p.code),
    pageHead(p.code, patientMeta(p),
      h('button.btn', { type: 'button', onclick: edit }, 'Edit'),
      h('a.btn.btn-primary', { href: `#/slides/new?patient=${p.id}` }, '+ New analysis')),
    h('div.kpis',
      kpi('Latest % sickled', latest ? fmtPct(latest.summary.percentSickled) : '–', latest ? bandPill(latest.summary.percentSickled) : 'No reported slide'),
      kpi('Change since previous', latest && prev ? delta(latest, prev) : '–', prev ? `vs ${fmtDate(prev.sampleDate)}` : 'Needs two slides'),
      kpi('Change since first', latest && first && first !== latest ? delta(latest, first) : '–', first && first !== latest ? `vs ${fmtDate(first.sampleDate)}` : ''),
      kpi('Slides', String(slides.length), `${final.length} reported`)),
    h('section.card', h('h2', '% sickled over time'),
      h('p.muted.small', 'Reported slides only. Whiskers show the 95% interval; wider whiskers mean fewer cells were counted.'),
      timelineChart(points, { marker })),
    h('section.card', h('h2', 'Slides'), slidesTable([...slides].reverse(), null, { showPatient: false })),
    p.notes ? h('section.card', h('h2', 'Notes'), h('p.prewrap', p.notes)) : null,
    h('div.danger-zone', h('button.btn.btn-danger-ghost', { type: 'button', onclick: del }, 'Delete patient')));
}

function kpi(label, value, sub) { return h('div.kpi.card', h('span.kpi-label', label), h('span.kpi-value', value), h('span.kpi-sub', sub)); }
