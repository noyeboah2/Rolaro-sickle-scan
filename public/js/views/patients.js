import { h, fmtDate, fmtPct, emptyState } from '../ui.js';
import { listPatients, listSlides } from '../db.js';
import { patientDialog, pageHead, bandPill } from './common.js';

export async function render(ctx) {
  const [patients, slides] = await Promise.all([listPatients(), listSlides()]);
  const stats = new Map();
  for (const s of [...slides].reverse()) { // oldest first, so the last write is the latest
    const st = stats.get(s.patientId) || { count: 0, last: null };
    st.count++;
    if (s.status === 'final') st.last = s;
    stats.set(s.patientId, st);
  }
  const add = async () => { const p = await patientDialog(); if (p) ctx.navigate(`/patients/${p.id}`); };
  if (ctx.query.add) setTimeout(add, 0);

  const search = h('input.search', { type: 'search', placeholder: 'Search code, genotype or notes', 'aria-label': 'Search patients' });
  const geno = h('select', { 'aria-label': 'Filter by genotype' }, h('option', { value: '' }, 'All genotypes'),
    [...new Set(patients.map((p) => p.genotype).filter(Boolean))].sort().map((g) => h('option', { value: g }, g)));
  const body = h('tbody');
  const count = h('span.muted');

  function draw() {
    const q = search.value.trim().toLowerCase(), g = geno.value;
    const rows = patients.filter((p) => (!g || p.genotype === g) && (!q || [p.code, p.genotype, p.notes].join(' ').toLowerCase().includes(q)));
    count.textContent = `${rows.length} of ${patients.length}`;
    body.replaceChildren(...rows.map((p) => {
      const st = stats.get(p.id) || { count: 0, last: null };
      const pct = st.last?.summary?.percentSickled;
      return h('tr.clickable', { onclick: () => ctx.navigate(`/patients/${p.id}`) },
        h('td', h('a', { href: `#/patients/${p.id}` }, h('strong', p.code))),
        h('td', p.genotype || h('span.muted', '—')),
        h('td', p.hydroxyurea ? 'Yes' : h('span.muted', 'No')),
        h('td.num', st.count),
        h('td.num.strong', pct != null ? fmtPct(pct) : '–'),
        h('td', pct != null ? bandPill(pct) : null),
        h('td', st.last ? fmtDate(st.last.sampleDate) : h('span.muted', '—')));
    }));
  }
  search.addEventListener('input', draw);
  geno.addEventListener('change', draw);
  draw();

  return h('div.page',
    pageHead('Patients', 'Coded records only. Names and contact details are never stored.', h('button.btn.btn-primary', { type: 'button', onclick: add }, '+ Add patient')),
    patients.length ? h('section.card',
      h('div.toolbar', search, geno, count),
      h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', 'Code'), h('th', 'Genotype'), h('th', 'Hydroxyurea'), h('th.num', 'Slides'), h('th.num', 'Latest %'), h('th', 'Band'), h('th', 'Last sample'))),
        body)))
      : h('section.card', emptyState('No patients yet', 'Add a patient with a coded ID to start.', h('button.btn.btn-primary', { type: 'button', onclick: add }, 'Add patient'))));
}
