import { h, fmtInt, fmtPct, fmtDate, todayIso, emptyState } from '../ui.js';
import { listPatients, listSlides, savePatient, getAll } from '../db.js';
import { barChart } from '../charts.js';
import { slidesTable, pageHead, bandPill } from './common.js';

function weekStart(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export async function render(ctx) {
  const [patients, slides] = await Promise.all([listPatients(), listSlides()]);
  const byId = new Map(patients.map((p) => [p.id, p]));

  if (!patients.length && !slides.length) {
    const startDemo = async () => {
      const all = await getAll('patients');
      let demo = all.find((p) => p.code === 'DEMO-0001');
      if (!demo) demo = await savePatient({ code: 'DEMO-0001', sex: '', birthYear: '', genotype: 'HbSS', hydroxyurea: false, huStart: '', notes: 'Demo record using the synthetic sample image.' });
      ctx.navigate(`/slides/new?patient=${demo.id}&sample=1`);
    };
    return h('div.page',
      pageHead('Welcome to SickleScan Lab', 'Analyse blood smears field by field, track each patient over time, and print reports.'),
      h('div.card', emptyState('No patients yet', 'Add a patient with a coded ID, then start a slide analysis. Or try the whole flow with a synthetic sample image.',
        h('a.btn.btn-primary', { href: '#/patients?add=1' }, 'Add first patient'),
        h('button.btn', { type: 'button', onclick: startDemo }, 'Try with sample image'))),
      h('div.steps',
        step('1', 'Register a patient', 'Coded ID, genotype on record, hydroxyurea status. No names.'),
        step('2', 'Analyse a slide', 'Upload several microscope fields. Correct any cell with a click.'),
        step('3', 'Review and report', 'Pooled % sickled with a 95% interval, QC flags, printable PDF.'),
        step('4', 'Track over time', 'Each patient gets a timeline of results, with treatment start marked.')));
  }

  const final = slides.filter((s) => s.status === 'final');
  const month = todayIso().slice(0, 7);
  const cells = final.reduce((a, s) => a + (s.summary?.total || 0), 0);
  const thisMonth = final.filter((s) => s.sampleDate.startsWith(month)).length;

  // slides per week, last 12 weeks
  const weeks = [];
  const w0 = new Date(`${weekStart(todayIso())}T00:00:00Z`);
  for (let i = 11; i >= 0; i--) { const d = new Date(w0); d.setUTCDate(d.getUTCDate() - 7 * i); weeks.push(d.toISOString().slice(0, 10)); }
  const counts = new Map(weeks.map((w) => [w, 0]));
  for (const s of final) { const w = weekStart(s.sampleDate); if (counts.has(w)) counts.set(w, counts.get(w) + 1); }
  const bars = weeks.map((w) => ({ label: new Date(`${w}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), value: counts.get(w) }));

  // latest final result per patient
  const latest = new Map();
  for (const s of [...final].sort((a, b) => a.sampleDate.localeCompare(b.sampleDate))) latest.set(s.patientId, s);
  const latestRows = [...latest.values()].filter((s) => byId.has(s.patientId)).sort((a, b) => (b.summary?.percentSickled || 0) - (a.summary?.percentSickled || 0)).slice(0, 8);

  const attention = slides.filter((s) => s.status !== 'final' || (s.summary?.flags || []).some((f) => f.level !== 'info')).slice(0, 6);

  return h('div.page',
    pageHead('Dashboard', `${fmtDate(todayIso())}`, h('a.btn.btn-primary', { href: '#/slides/new' }, '+ New analysis')),
    h('div.kpis',
      kpi('Patients', fmtInt(patients.length), h('a', { href: '#/patients' }, 'View all')),
      kpi('Slides reported', fmtInt(final.length), `${slides.length - final.length} draft${slides.length - final.length === 1 ? '' : 's'}`),
      kpi('Cells counted', fmtInt(cells), 'across reported slides'),
      kpi('This month', fmtInt(thisMonth), 'slides reported')),
    h('div.grid-2-1',
      h('section.card', h('h2', 'Slides reported per week'), h('p.muted.small', 'Last 12 weeks, by sample date'), barChart(bars, { title: 'Slides reported per week', height: 210 })),
      h('section.card', h('h2', 'Needs attention'),
        attention.length ? h('ul.list', attention.map((s) => {
          const p = byId.get(s.patientId);
          const why = s.status !== 'final' ? 'Draft, not reported yet' : (s.summary.flags.find((f) => f.level !== 'info') || {}).text;
          return h('li', h('a', { href: s.status === 'final' ? `#/slides/${s.id}` : `#/slides/${s.id}/edit` }, `${p ? p.code : '?'} · ${fmtDate(s.sampleDate)}`), h('small.muted', why));
        })) : h('p.muted', 'Nothing needs attention.'))),
    h('div.grid-1-1',
      h('section.card', h('h2', 'Latest result per patient'),
        latestRows.length ? h('ul.rank', latestRows.map((s) => {
          const pct = s.summary.percentSickled;
          return h('li', h('a', { href: `#/patients/${s.patientId}` }, byId.get(s.patientId).code),
            h('span.rank-bar', h('i', { style: { width: `${Math.min(100, pct * 2)}%` } })),
            h('strong', fmtPct(pct)), bandPill(pct));
        })) : h('p.muted', 'No reported slides yet.')),
      h('section.card', h('h2', 'Recent slides'), slidesTable(slides.slice(0, 6), byId))));
}

function kpi(label, value, sub) { return h('div.kpi.card', h('span.kpi-label', label), h('span.kpi-value', value), h('span.kpi-sub', sub)); }
function step(n, title, text) { return h('div.step.card', h('span.step-n', n), h('h3', title), h('p.muted', text)); }
