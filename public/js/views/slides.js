import { h, emptyState } from '../ui.js';
import { listSlides, listPatients } from '../db.js';
import { slidesTable, pageHead } from './common.js';

export async function render() {
  const [slides, patients] = await Promise.all([listSlides(), listPatients()]);
  const byId = new Map(patients.map((p) => [p.id, p]));
  const holder = h('div');
  const status = h('select', { 'aria-label': 'Filter by status' }, h('option', { value: '' }, 'All statuses'), h('option', { value: 'final' }, 'Final'), h('option', { value: 'draft' }, 'Draft'));
  const qc = h('label.check', h('input', { type: 'checkbox' }), ' Only slides with QC flags');
  const search = h('input.search', { type: 'search', placeholder: 'Patient code', 'aria-label': 'Search by patient code' });
  const draw = () => {
    const q = search.value.trim().toUpperCase();
    const rows = slides.filter((s) => (!status.value || (s.status || 'draft') === status.value)
      && (!qc.firstChild.checked || (s.summary?.flags || []).some((f) => f.level !== 'info'))
      && (!q || (byId.get(s.patientId)?.code || '').includes(q)));
    holder.replaceChildren(slidesTable(rows, byId));
  };
  [status, qc.firstChild, search].forEach((el) => el.addEventListener('input', draw));
  draw();
  return h('div.page',
    pageHead('Slides', `${slides.length} slide${slides.length === 1 ? '' : 's'} on this device`, h('a.btn.btn-primary', { href: '#/slides/new' }, '+ New analysis')),
    slides.length ? h('section.card', h('div.toolbar', search, status, qc), holder)
      : h('section.card', emptyState('No slides yet', 'Start a new analysis to add your first slide.', h('a.btn.btn-primary', { href: '#/slides/new' }, 'New analysis'))));
}
