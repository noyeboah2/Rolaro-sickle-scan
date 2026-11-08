// Hash router: #/path?query. Each view module exports render(ctx) -> Node, and may set ctx.cleanup.
import { h } from './ui.js';
import { openDb, requestPersistence } from './db.js';

const routes = [
  [/^\/$/, () => import('./views/dashboard.js'), 'dashboard'],
  [/^\/patients$/, () => import('./views/patients.js'), 'patients'],
  [/^\/patients\/([\w-]+)$/, () => import('./views/patient.js'), 'patients'],
  [/^\/slides$/, () => import('./views/slides.js'), 'slides'],
  [/^\/slides\/new$/, () => import('./views/workspace.js'), 'slides'],
  [/^\/slides\/([\w-]+)\/edit$/, () => import('./views/workspace.js'), 'slides'],
  [/^\/slides\/([\w-]+)$/, () => import('./views/report.js'), 'slides'],
  [/^\/settings$/, () => import('./views/settings.js'), 'settings'],
  [/^\/guide$/, () => import('./views/guide.js'), 'guide'],
];

const app = document.getElementById('app');
let current = null;
let renderSeq = 0;

export function navigate(path) { location.hash = `#${path}`; }

async function route() {
  const seq = ++renderSeq;
  const raw = location.hash.slice(1) || '/';
  const [path, qs] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  let match = null;
  for (const [re, load, nav] of routes) { const m = re.exec(path); if (m) { match = { load, nav, params: m.slice(1) }; break; } }
  if (current?.cleanup) { try { current.cleanup(); } catch { /* ignore */ } }
  current = null;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', match && a.dataset.nav === match.nav));
  if (!match) { app.replaceChildren(h('div.page', h('h1', 'Page not found'), h('p', h('a', { href: '#/' }, 'Back to the dashboard')))); return; }
  try {
    const mod = await match.load();
    const ctx = { params: match.params, query, path, navigate, cleanup: null };
    const node = await mod.render(ctx);
    if (seq !== renderSeq) { ctx.cleanup?.(); return; } // user navigated away meanwhile
    current = ctx;
    app.replaceChildren(node);
    app.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    if (seq !== renderSeq) return;
    app.replaceChildren(h('div.page', h('h1', 'Something went wrong'), h('p.error', String(err.message || err)), h('p', h('a', { href: '#/' }, 'Back to the dashboard'))));
  }
}

window.addEventListener('hashchange', route);
openDb().then(() => { requestPersistence(); route(); }).catch((err) => {
  app.replaceChildren(h('div.page', h('h1', 'Storage unavailable'),
    h('p', 'SickleScan stores data in your browser, but storage is blocked here (private browsing can do this).'),
    h('p.error', String(err.message || err))));
});
