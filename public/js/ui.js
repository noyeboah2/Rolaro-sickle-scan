// Small DOM helpers. All user text goes through textContent (no innerHTML), so stored data cannot inject markup.

/** h('div.card#id', {onclick, attrs...}, children...) */
export function h(tag, props, ...children) {
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) { children.unshift(props); props = {}; }
  const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// ---------------------------------------------------------------- formatting
export const fmtPct = (v) => (v == null || Number.isNaN(v) ? '–' : `${Number(v).toFixed(1)}%`);
export const fmtInt = (v) => (v == null ? '–' : Number(v).toLocaleString());
export function fmtDate(iso) {
  if (!iso) return '–';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
export const todayIso = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
export function ageFrom(birthYear) { const y = Number(birthYear); return y ? new Date().getFullYear() - y : null; }

// ---------------------------------------------------------------- feedback
export function toast(text, kind = 'ok') {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div#toasts.toasts', { role: 'status', 'aria-live': 'polite' }); document.body.append(host); }
  const t = h(`div.toast.toast-${kind}`, text);
  host.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3200);
}

/** Modal dialog. content: Node. Returns {close}. */
export function modal(title, content, { onClose, wide } = {}) {
  const dlg = h('dialog.modal' + (wide ? '.modal-wide' : ''), { 'aria-label': title },
    h('div.modal-head', h('h2', title), h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => close() }, '×')),
    h('div.modal-body', content));
  document.body.append(dlg);
  dlg.showModal();
  function close() { dlg.close(); dlg.remove(); onClose?.(); }
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  return { close, el: dlg };
}

export function confirmDialog(title, text, okLabel = 'Delete', danger = true) {
  return new Promise((resolve) => {
    let m;
    const done = (v) => { m.close(); resolve(v); };
    m = modal(title, h('div', h('p', text), h('div.row.end',
      h('button.btn', { type: 'button', onclick: () => done(false) }, 'Cancel'),
      h(`button.btn${danger ? '.btn-danger' : '.btn-primary'}`, { type: 'button', onclick: () => done(true) }, okLabel))), { onClose: () => resolve(false) });
  });
}

export function download(blob, filename) {
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
export const safeName = (s) => String(s || 'file').replace(/[^\w.-]+/g, '_').slice(0, 60);

export function pill(text, kind = '') { return h(`span.pill${kind ? '.' + kind : ''}`, text); }
export function emptyState(title, text, ...actions) { return h('div.empty', h('h3', title), h('p.muted', text), h('div.row.center', actions)); }

/** Field with label wrapping an input/select. */
export function field(label, control, hint) {
  return h('label.field', h('span', label), control, hint ? h('small.muted', hint) : null);
}
export function select(name, options, value) {
  return h('select', { name }, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
}
