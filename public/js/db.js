// Local-first storage in IndexedDB. Nothing here leaves the browser.
// Stores: patients, slides, fields (one per microscope field image), meta (settings).
const DB_NAME = 'sicklescan-lab';
const DB_VERSION = 1;
let dbPromise = null;

function req(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('patients')) {
        const s = db.createObjectStore('patients', { keyPath: 'id' });
        s.createIndex('code', 'code', { unique: true });
      }
      if (!db.objectStoreNames.contains('slides')) {
        const s = db.createObjectStore('slides', { keyPath: 'id' });
        s.createIndex('patientId', 'patientId');
      }
      if (!db.objectStoreNames.contains('fields')) {
        const s = db.createObjectStore('fields', { keyPath: 'id' });
        s.createIndex('slideId', 'slideId');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { dbPromise = null; reject(r.error); };
    r.onblocked = () => reject(new Error('Close other SickleScan tabs and reload.'));
  });
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

export const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- generic
export const getAll = (store) => tx([store], 'readonly', (t) => req(t.objectStore(store).getAll()));
export const get = (store, id) => tx([store], 'readonly', (t) => req(t.objectStore(store).get(id)));
export const put = (store, value) => tx([store], 'readwrite', (t) => req(t.objectStore(store).put(value)));
const byIndex = (store, index, key) => tx([store], 'readonly', (t) => req(t.objectStore(store).index(index).getAll(key)));

// ---------------------------------------------------------------- settings
export const DEFAULT_SETTINGS = Object.freeze({
  labName: 'My Haematology Lab',
  reportFooter: '',
  qcMinCells: 200,
  qcMaxClumpPct: 25,
  thresholds: null, // null = engine defaults
});
export async function getSettings() {
  const row = await get('meta', 'settings');
  return { ...DEFAULT_SETTINGS, ...(row ? row.value : {}) };
}
export const saveSettings = (value) => put('meta', { key: 'settings', value });

// ---------------------------------------------------------------- patients
export async function listPatients() {
  const ps = await getAll('patients');
  return ps.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}
export async function nextPatientCode(prefix = 'SC') {
  const ps = await getAll('patients');
  let max = 0;
  for (const p of ps) { const m = /^([A-Z]+)-(\d+)$/.exec(p.code); if (m && m[1] === prefix) max = Math.max(max, Number(m[2])); }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}
export async function savePatient(p) {
  const code = String(p.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,23}$/.test(code)) throw new Error('Patient code: 2–24 letters, digits or dashes.');
  const all = await getAll('patients');
  if (all.some((x) => x.code === code && x.id !== p.id)) throw new Error(`Code ${code} is already used.`);
  const rec = { ...p, code, id: p.id || uid(), createdAt: p.createdAt || now(), updatedAt: now() };
  await put('patients', rec);
  return rec;
}
export async function deletePatient(id) {
  const slides = await byIndex('slides', 'patientId', id);
  for (const s of slides) await deleteSlide(s.id);
  await tx(['patients'], 'readwrite', (t) => req(t.objectStore('patients').delete(id)));
}

// ---------------------------------------------------------------- slides & fields
export async function listSlides() {
  const s = await getAll('slides');
  return s.sort((a, b) => (b.sampleDate + b.createdAt).localeCompare(a.sampleDate + a.createdAt));
}
export const slidesForPatient = async (patientId) =>
  (await byIndex('slides', 'patientId', patientId)).sort((a, b) => a.sampleDate.localeCompare(b.sampleDate) || a.createdAt.localeCompare(b.createdAt));
export async function saveSlide(s) {
  const rec = { ...s, id: s.id || uid(), createdAt: s.createdAt || now(), updatedAt: now() };
  await put('slides', rec);
  return rec;
}
export async function deleteSlide(id) {
  const fields = await byIndex('fields', 'slideId', id);
  await tx(['slides', 'fields'], 'readwrite', (t) => {
    for (const f of fields) t.objectStore('fields').delete(f.id);
    t.objectStore('slides').delete(id);
  });
}
export const fieldsForSlide = async (slideId) => (await byIndex('fields', 'slideId', slideId)).sort((a, b) => a.index - b.index);
export async function saveField(f) {
  const rec = { ...f, id: f.id || uid(), createdAt: f.createdAt || now(), updatedAt: now() };
  await put('fields', rec);
  return rec;
}
export const deleteField = (id) => tx(['fields'], 'readwrite', (t) => req(t.objectStore('fields').delete(id)));

// ---------------------------------------------------------------- backup
async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
}
// Decode by hand: fetch(data:) is blocked by the site's connect-src CSP.
function dataUrlToBlob(url) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) throw new Error('Backup contains an unreadable image');
  const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: m[1] || 'application/octet-stream' });
}

export async function exportBackup({ includeImages = true } = {}) {
  const [patients, slides, fields, settings] = await Promise.all([getAll('patients'), getAll('slides'), getAll('fields'), getSettings()]);
  const outFields = [];
  for (const f of fields) {
    const { image, ...rest } = f;
    outFields.push(includeImages && image ? { ...rest, image: await blobToDataUrl(image) } : rest);
  }
  return { format: 'sicklescan-backup', version: 1, exportedAt: now(), settings, patients, slides, fields: outFields };
}

export async function importBackup(data, { replace = false } = {}) {
  if (!data || data.format !== 'sicklescan-backup') throw new Error('This is not a SickleScan backup file.');
  const fields = [];
  for (const f of data.fields || []) fields.push(f.image && typeof f.image === 'string' ? { ...f, image: await dataUrlToBlob(f.image) } : f);
  await tx(['patients', 'slides', 'fields', 'meta'], 'readwrite', (t) => {
    if (replace) for (const s of ['patients', 'slides', 'fields']) t.objectStore(s).clear();
    for (const p of data.patients || []) t.objectStore('patients').put(p);
    for (const s of data.slides || []) t.objectStore('slides').put(s);
    for (const f of fields) t.objectStore('fields').put(f);
    if (data.settings) t.objectStore('meta').put({ key: 'settings', value: data.settings });
  });
  return { patients: (data.patients || []).length, slides: (data.slides || []).length, fields: fields.length };
}

export async function eraseAll() {
  await tx(['patients', 'slides', 'fields', 'meta'], 'readwrite', (t) => {
    for (const s of ['patients', 'slides', 'fields', 'meta']) t.objectStore(s).clear();
  });
}

export async function storageEstimate() {
  try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch { return null; }
}
export async function requestPersistence() {
  try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; }
}
