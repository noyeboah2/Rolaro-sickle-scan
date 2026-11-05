// SickleScan API Worker.
// Static files in /public are served by Cloudflare's asset handler before this code runs;
// this Worker only sees requests that match no file (the /api routes and 404s).

const VERSION = '1.0.0';
const MAX_BODY = 32 * 1024;
const MAX_COUNT = 100000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS analyses (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    total_cells INTEGER NOT NULL,
    normal_count INTEGER NOT NULL,
    borderline_count INTEGER NOT NULL,
    sickled_count INTEGER NOT NULL,
    clump_count INTEGER NOT NULL,
    percent_sickled REAL NOT NULL,
    thresholds TEXT NOT NULL DEFAULT '{}',
    image_width INTEGER,
    image_height INTEGER,
    engine TEXT NOT NULL DEFAULT 'rules-v1'
  )`,
  'CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses (created_at DESC)',
];

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cache-control': 'no-store',
};

function json(data, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS },
  });
}
const fail = (status, error, extra = {}) => json({ error, ...extra }, status);

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch(SCHEMA.map((s) => db.prepare(s))).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

const isInt = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;

/** Validate a POST body. Returns { value } or { field } naming the first bad field. */
export function validateAnalysis(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { field: 'body' };
  const label = typeof b.label === 'string' ? b.label.trim() : '';
  if (label.length > 80) return { field: 'label' };
  for (const k of ['total_cells', 'normal_count', 'borderline_count', 'sickled_count', 'clump_count']) {
    if (!isInt(b[k])) return { field: k };
  }
  if (b.normal_count + b.borderline_count + b.sickled_count !== b.total_cells) return { field: 'total_cells' };
  if (typeof b.percent_sickled !== 'number' || !(b.percent_sickled >= 0 && b.percent_sickled <= 100)) return { field: 'percent_sickled' };
  for (const k of ['image_width', 'image_height']) {
    if (b[k] != null && !(Number.isInteger(b[k]) && b[k] > 0 && b[k] <= 20000)) return { field: k };
  }
  let thresholds = '{}';
  if (b.thresholds != null) {
    if (typeof b.thresholds !== 'object' || Array.isArray(b.thresholds)) return { field: 'thresholds' };
    const clean = {};
    for (const [k, v] of Object.entries(b.thresholds)) {
      if (!/^[a-zA-Z]{1,40}$/.test(k) || typeof v !== 'number' || !Number.isFinite(v)) return { field: 'thresholds' };
      clean[k] = v;
    }
    thresholds = JSON.stringify(clean);
  }
  const engine = typeof b.engine === 'string' && /^[a-z0-9.-]{1,20}$/.test(b.engine) ? b.engine : 'rules-v1';
  return {
    value: {
      label, thresholds, engine,
      total_cells: b.total_cells, normal_count: b.normal_count, borderline_count: b.borderline_count,
      sickled_count: b.sickled_count, clump_count: b.clump_count,
      percent_sickled: Math.round(b.percent_sickled * 10) / 10,
      image_width: b.image_width ?? null, image_height: b.image_height ?? null,
    },
  };
}

function rowOut(r) {
  let thresholds = {};
  try { thresholds = JSON.parse(r.thresholds || '{}'); } catch { /* keep {} */ }
  return { ...r, thresholds };
}

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (path === '/api/health') {
    if (method !== 'GET') return fail(405, 'method_not_allowed');
    let db = false;
    if (env.DB) { try { await ensureSchema(env.DB); db = true; } catch { db = false; } }
    return json({ ok: true, db, version: VERSION });
  }

  if (path !== '/api/analyses' && !path.startsWith('/api/analyses/')) return fail(404, 'not_found');
  if (!env.DB) return fail(503, 'database_not_configured');
  await ensureSchema(env.DB);

  if (path === '/api/analyses') {
    if (method === 'GET') {
      const raw = Number(url.searchParams.get('limit') || 50);
      const limit = Number.isInteger(raw) && raw >= 1 && raw <= 100 ? raw : 50;
      const { results } = await env.DB.prepare('SELECT * FROM analyses ORDER BY created_at DESC LIMIT ?').bind(limit).all();
      return json({ items: results.map(rowOut) });
    }
    if (method === 'POST') {
      if (!(request.headers.get('content-type') || '').includes('application/json')) return fail(415, 'expected_json');
      const declared = Number(request.headers.get('content-length') || 0);
      if (declared > MAX_BODY) return fail(413, 'payload_too_large');
      const text = await request.text();
      if (text.length > MAX_BODY) return fail(413, 'payload_too_large');
      let body;
      try { body = JSON.parse(text); } catch { return fail(400, 'invalid_json', { field: 'body' }); }
      const { value, field } = validateAnalysis(body);
      if (!value) return fail(400, 'invalid_field', { field });
      const id = crypto.randomUUID();
      const created_at = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO analyses (id, created_at, label, total_cells, normal_count, borderline_count, sickled_count,
          clump_count, percent_sickled, thresholds, image_width, image_height, engine)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, created_at, value.label, value.total_cells, value.normal_count, value.borderline_count,
        value.sickled_count, value.clump_count, value.percent_sickled, value.thresholds,
        value.image_width, value.image_height, value.engine).run();
      return json({ id, created_at }, 201);
    }
    return fail(405, 'method_not_allowed');
  }

  const id = decodeURIComponent(path.slice('/api/analyses/'.length));
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(404, 'not_found');
  if (method === 'GET') {
    const row = await env.DB.prepare('SELECT * FROM analyses WHERE id = ?').bind(id).first();
    return row ? json(rowOut(row)) : fail(404, 'not_found');
  }
  if (method === 'DELETE') {
    const r = await env.DB.prepare('DELETE FROM analyses WHERE id = ?').bind(id).run();
    return r.meta && r.meta.changes ? json(null, 204) : fail(404, 'not_found');
  }
  return fail(405, 'method_not_allowed');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        console.error('API error', err);
        return fail(500, 'internal_error');
      }
    }
    // Anything else that reached the Worker matched no static file.
    return env.ASSETS.fetch(request);
  },
};
