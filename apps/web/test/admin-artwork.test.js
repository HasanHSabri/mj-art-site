import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_SIZES,
  MISC_SIZE_CATEGORY,
  deriveDimensionsLabel,
  deriveOrientation,
  formToRecord,
  isValidCatalogNumber,
  nextSortOrder,
  provenanceSummary,
  recordToForm,
  renumber,
  reorder
} from '../public/admin-artwork.js';

function catalogueValues(overrides = {}) {
  return {
    catalogNumber: 'MJ-001',
    category: 'catalogue',
    title: 'Still Waters',
    image: '/artwork-uploaded/artwork/catalog/mj-001/full.jpg',
    thumbnail: '/artwork-uploaded/artwork/catalog/mj-001/thumb.jpg',
    medium: 'Acrylic on canvas',
    widthCm: '20',
    heightCm: '20',
    sizeCategory: '20x20',
    availability: 'Available',
    priceAmount: '40',
    priceNote: 'postage extra',
    cardNote: 'A note',
    description: 'A description.',
    containImage: true,
    sortOrder: 1,
    ...overrides
  };
}

test('formToRecord builds a valid catalogue record with id from catalogNumber', () => {
  const { ok, record } = formToRecord(catalogueValues());
  assert.equal(ok, true);
  assert.equal(record.id, 'mj-001');
  assert.equal(record.catalogNumber, 'MJ-001');
  assert.deepEqual(record.dimensions, { widthCm: 20, heightCm: 20, label: '20x20 cm', orientation: 'Square' });
  assert.deepEqual(record.price, { amount: 40, currency: 'AUD', note: 'postage extra' });
  assert.equal(record.sizeCategory, '20x20');
  assert.equal(record.sortOrder, 1);
});

test('formToRecord forces sizeCategory miscellaneous and null dims for misc', () => {
  const { ok, record } = formToRecord(catalogueValues({
    category: 'miscellaneous',
    catalogNumber: 'MISC-001',
    widthCm: '',
    heightCm: '',
    sizeCategory: 'whatever'
  }));
  assert.equal(ok, true);
  assert.equal(record.id, 'misc-001');
  assert.equal(record.sizeCategory, MISC_SIZE_CATEGORY);
  assert.equal(record.dimensions.widthCm, null);
  assert.equal(record.dimensions.heightCm, null);
  assert.equal(record.dimensions.orientation, 'Unknown');
  assert.equal(record.dimensions.label, '');
});

test('formToRecord accepts misc with explicit dimensions', () => {
  const { ok, record } = formToRecord(catalogueValues({
    category: 'miscellaneous',
    catalogNumber: 'MISC-002',
    widthCm: '30',
    heightCm: '20'
  }));
  assert.equal(ok, true);
  assert.equal(record.dimensions.orientation, 'Horizontal');
  assert.equal(record.dimensions.label, '30x20 cm');
});

test('formToRecord never derives id from title (no title slug)', () => {
  const { ok, record } = formToRecord(catalogueValues({ title: 'Some Fancy Title' }));
  assert.equal(ok, true);
  assert.equal(record.id, 'mj-001');
});

test('formToRecord price empty -> null, currency always AUD', () => {
  const { ok, record } = formToRecord(catalogueValues({ priceAmount: '', priceNote: '' }));
  assert.equal(ok, true);
  assert.equal(record.price, null);
});

test('formToRecord rejects non-positive price amount', () => {
  const r = formToRecord(catalogueValues({ priceAmount: '0' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /positive number/.test(e)));
});

test('formToRecord requires title', () => {
  const r = formToRecord(catalogueValues({ title: '   ' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /Title is required/.test(e)));
});

test('formToRecord requires positive dimensions for catalogue', () => {
  const r = formToRecord(catalogueValues({ widthCm: '', heightCm: '' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /width/.test(e)));
  assert.ok(r.errors.some((e) => /height/.test(e)));
});

test('formToRecord rejects bad catalog number for category', () => {
  assert.ok(!formToRecord(catalogueValues({ catalogNumber: 'mj-1' })).ok);
  assert.ok(!formToRecord(catalogueValues({ category: 'miscellaneous', catalogNumber: 'MJ-001', widthCm: '', heightCm: '' })).ok);
});

test('formToRecord requires a canonical size category for catalogue', () => {
  const r = formToRecord(catalogueValues({ sizeCategory: '' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /canonical size category/.test(e)));
});

test('formToRecord rejects non-positive sortOrder', () => {
  assert.ok(!formToRecord(catalogueValues({ sortOrder: 0 })).ok);
  assert.ok(!formToRecord(catalogueValues({ sortOrder: -3 })).ok);
  assert.ok(!formToRecord(catalogueValues({ sortOrder: 1.5 })).ok);
});

test('recordToForm round-trips a canonical record', () => {
  const record = formToRecord(catalogueValues()).record;
  const values = recordToForm(record);
  const { ok, record: roundtrip } = formToRecord(values);
  assert.equal(ok, true);
  assert.deepEqual(roundtrip, record);
});

test('isValidCatalogNumber is category-aware', () => {
  assert.equal(isValidCatalogNumber('MJ-001', 'catalogue'), true);
  assert.equal(isValidCatalogNumber('mj-001', 'catalogue'), true);
  assert.equal(isValidCatalogNumber('MISC-001', 'miscellaneous'), true);
  assert.equal(isValidCatalogNumber('MJ-001', 'miscellaneous'), false);
  assert.equal(isValidCatalogNumber('MISC-001', 'catalogue'), false);
});

test('CANONICAL_SIZES matches the catalogue size set', () => {
  assert.deepEqual(CANONICAL_SIZES, ['20x20', '20x25', '25x25', '30x23', '30x30', '35x28', '40x30', '47x57', '50x25', '55x30', '58x73']);
});

test('deriveOrientation covers all cases', () => {
  assert.equal(deriveOrientation(20, 20), 'Square');
  assert.equal(deriveOrientation(30, 20), 'Horizontal');
  assert.equal(deriveOrientation(20, 30), 'Vertical');
  assert.equal(deriveOrientation(null, 20), 'Unknown');
  assert.equal(deriveOrientation(20, null), 'Unknown');
});

test('deriveDimensionsLabel formats or empties', () => {
  assert.equal(deriveDimensionsLabel(30, 20), '30x20 cm');
  assert.equal(deriveDimensionsLabel(null, 20), '');
});

test('nextSortOrder is max+1 or 1', () => {
  assert.equal(nextSortOrder([]), 1);
  assert.equal(nextSortOrder([{ sortOrder: 2 }, { sortOrder: 5 }]), 6);
});

test('reorder swaps and respects boundaries, returning a new array', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(reorder(list, 0, 'up').map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(reorder(list, 2, 'down').map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(reorder(list, 1, 'up').map((r) => r.id), ['b', 'a', 'c']);
  assert.deepEqual(reorder(list, 0, 'down').map((r) => r.id), ['b', 'a', 'c']);
  assert.notEqual(reorder(list, 0, 'down'), list);
});

test('renumber produces contiguous 1..N preserving order, new array', () => {
  const list = [{ id: 'a', sortOrder: 9 }, { id: 'b', sortOrder: 4 }, { id: 'c', sortOrder: 7 }];
  const out = renumber(list);
  assert.deepEqual(out.map((r) => r.sortOrder), [1, 2, 3]);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'c']);
  assert.notEqual(out, list);
  // Source not mutated.
  assert.equal(list[0].sortOrder, 9);
});

test('provenanceSummary labels sources and never leaks hashes', () => {
  assert.equal(provenanceSummary({ source: 'admin' }), 'Admin');
  assert.equal(provenanceSummary({ source: 'google-drive', sha256: 'a'.repeat(64) }), 'Google Drive import');
  assert.equal(provenanceSummary({ source: 'r2-backup-or-live-fetch' }), 'R2 backup / live fetch');
  assert.equal(provenanceSummary(null), 'None');
  assert.equal(provenanceSummary({ source: 'google-drive', sha256: 'a'.repeat(64) }).includes('a'.repeat(64)), false);
});
