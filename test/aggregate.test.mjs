import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldSummary, slideSummary, band, csvSafe, slideCellsCsv } from '../public/js/aggregate.js';

// Minimal measured cells: round ones are normal, elongated ones sickled
const round = (id, area = 1000) => ({ id, area, circularity: 0.95, elongation: 1.05, solidity: 0.98, touchesEdge: false, majorAxis: 36, minorAxis: 34, cx: 1, cy: 1 });
const long = (id, area = 900) => ({ id, area, circularity: 0.45, elongation: 3.2, solidity: 0.9, touchesEdge: false, majorAxis: 70, minorAxis: 18, cx: 1, cy: 1 });
const field = (id, cells, extra = {}) => ({ id, name: id, cells, ...extra });

test('field summary counts and corrections', () => {
  const f = field('f1', [round(1), round(2), round(3), long(4)], { overrides: { 3: 'sickled', 2: 'normal' } });
  const s = fieldSummary(f);
  assert.equal(s.total, 4);
  assert.equal(s.sickled, 2);
  assert.equal(s.corrections, 1, 'override equal to auto class is not a correction');
  assert.equal(s.percentSickled, 50);
});

test('excluded override removes a cell from the count', () => {
  const s = fieldSummary(field('f', [round(1), long(2)], { overrides: { 2: 'excluded' } }));
  assert.equal(s.total, 1);
  assert.equal(s.excluded, 1);
  assert.equal(s.percentSickled, 0);
});

test('slide pools counts across included fields only', () => {
  const a = field('a', [round(1), round(2), round(3), long(4)]);         // 1/4
  const b = field('b', [round(1), long(2)]);                            // 1/2
  const c = field('c', [long(1), long(2), long(3)], { included: false }); // ignored
  const s = slideSummary([a, b, c], undefined, { qcMinCells: 5 });
  assert.equal(s.total, 6);
  assert.equal(s.sickled, 2);
  assert.equal(s.percentSickled, 33.3);
  assert.equal(s.includedFields, 2);
  assert.ok(s.ci95[0] < 33.3 && s.ci95[1] > 33.3);
  assert.equal(s.flags.length, 0);
});

test('QC flags: low count and no fields', () => {
  const s = slideSummary([field('a', [round(1), round(2)])], undefined, { qcMinCells: 200 });
  assert.ok(s.flags.some((f) => f.code === 'low_count'));
  const e = slideSummary([], undefined, {});
  assert.ok(e.flags.some((f) => f.code === 'no_fields'));
});

test('bands', () => {
  assert.equal(band(0).key, 'none');
  assert.equal(band(3).key, 'low');
  assert.equal(band(10).key, 'moderate');
  assert.equal(band(40).key, 'high');
});

test('csv escapes and blocks formula injection', () => {
  assert.equal(csvSafe('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvSafe('a,b'), '"a,b"');
  const csv = slideCellsCsv({ sampleDate: '2026-11-07' }, { code: 'SC-0001' }, [field('f', [round(1), long(2)])]);
  assert.equal(csv.split('\n').length, 4);
});
