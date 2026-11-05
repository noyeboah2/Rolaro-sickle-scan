// History storage: Cloudflare D1 through /api when available, otherwise on-device (localStorage).
const LOCAL_KEY = 'sicklescan.history.v1';
let mode = null; // 'server' | 'local'

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch { return []; }
}
function writeLocal(items) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(items.slice(0, 200))); return true; } catch { return false; }
}

export async function detectMode() {
  try {
    const res = await fetch('/api/health', { headers: { accept: 'application/json' } });
    const body = res.ok ? await res.json() : null;
    mode = body && body.db ? 'server' : 'local';
  } catch {
    mode = 'local';
  }
  return mode;
}

export function getMode() { return mode; }

export async function listHistory() {
  if (mode === 'server') {
    const res = await fetch('/api/analyses?limit=50');
    if (res.ok) return (await res.json()).items;
    mode = 'local';
  }
  return readLocal();
}

export async function saveAnalysis(record) {
  if (mode === 'server') {
    const res = await fetch('/api/analyses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
    });
    if (res.ok) return { ...(await res.json()), where: 'server' };
    if (res.status === 400) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.field ? `Invalid ${err.field}` : 'Invalid data');
    }
    mode = 'local'; // server unavailable: fall through to local
  }
  const item = { ...record, id: crypto.randomUUID(), created_at: new Date().toISOString() };
  const items = readLocal();
  items.unshift(item);
  if (!writeLocal(items)) throw new Error('Could not save on this device');
  return { id: item.id, where: 'local' };
}

export async function deleteAnalysis(id) {
  if (mode === 'server') {
    const res = await fetch(`/api/analyses/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) return;
  }
  writeLocal(readLocal().filter((x) => x.id !== id));
}
