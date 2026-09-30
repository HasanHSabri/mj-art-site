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
  reorder,
  filterCatalogue,
  paginateList,
  canReorder,
  formValuesEqual,
  editorNeedsReload,
  fieldIdForError,
  fieldIdsForErrors
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

test('reorder boundary no-op returns the same array reference (no save needed)', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  // First item move-up -> same reference (boundary no-op)
  assert.equal(reorder(list, 0, 'up'), list);
  // Last item move-down -> same reference (boundary no-op)
  assert.equal(reorder(list, list.length - 1, 'down'), list);
  // Out-of-range index -> same reference
  assert.equal(reorder(list, -1, 'up'), list);
  assert.equal(reorder(list, 99, 'down'), list);
});

test('reorder non-boundary returns a new array reference', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.notEqual(reorder(list, 0, 'down'), list);
  assert.notEqual(reorder(list, 1, 'up'), list);
  assert.notEqual(reorder(list, 2, 'up'), list);
});

test('reorder does not mutate the source array on boundary no-op', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  reorder(list, 0, 'up');
  assert.deepEqual(list.map((r) => r.id), ['a', 'b', 'c']);
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

// ===========================================================================
// Catalogue list helpers: filterCatalogue / paginateList / canReorder
// ===========================================================================

function catalogueRecords() {
  return [
    { id: 'mj-001', catalogNumber: 'MJ-001', title: 'Still Waters', category: 'catalogue', sizeCategory: '20x20', availability: 'Available', sortOrder: 1 },
    { id: 'mj-002', catalogNumber: 'MJ-002', title: 'Moving Souls', category: 'catalogue', sizeCategory: '20x20', availability: 'Sold', sortOrder: 2 },
    { id: 'mj-003', catalogNumber: 'MJ-003', title: 'Red River', category: 'catalogue', sizeCategory: '58x73', availability: 'Available', sortOrder: 3 },
    { id: 'misc-001', catalogNumber: 'MISC-001', title: 'Sketch Card', category: 'miscellaneous', sizeCategory: 'miscellaneous', availability: 'Available', sortOrder: 4 }
  ];
}

test('filterCatalogue returns everything in order with no filters', () => {
  const out = filterCatalogue(catalogueRecords());
  assert.deepEqual(out.map((r) => r.id), ['mj-001', 'mj-002', 'mj-003', 'misc-001']);
  assert.deepEqual(filterCatalogue(null), []);
});

test('filterCatalogue term matches title or catalog number, case-insensitive', () => {
  assert.deepEqual(filterCatalogue(catalogueRecords(), { term: 'river' }).map((r) => r.id), ['mj-003']);
  assert.deepEqual(filterCatalogue(catalogueRecords(), { term: 'MJ-002' }).map((r) => r.id), ['mj-002']);
  assert.equal(filterCatalogue(catalogueRecords(), { term: 'nope' }).length, 0);
});

test('filterCatalogue availability is an exact match and all means no filter', () => {
  assert.deepEqual(filterCatalogue(catalogueRecords(), { availability: 'Sold' }).map((r) => r.id), ['mj-002']);
  assert.equal(filterCatalogue(catalogueRecords(), { availability: 'all' }).length, 4);
});

test('filterCatalogue size groups use the canonical sizes and a miscellaneous group', () => {
  assert.deepEqual(filterCatalogue(catalogueRecords(), { size: '20x20' }).map((r) => r.id), ['mj-001', 'mj-002']);
  assert.deepEqual(filterCatalogue(catalogueRecords(), { size: 'miscellaneous' }).map((r) => r.id), ['misc-001']);
  // A miscellaneous work never matches a numeric size, and vice versa.
  assert.equal(filterCatalogue(catalogueRecords(), { size: '58x73' }).length, 1);
});

test('filterCatalogue combines term, availability, and size with AND semantics', () => {
  const out = filterCatalogue(catalogueRecords(), { term: 'still', availability: 'Sold', size: '20x20' });
  assert.equal(out.length, 0);
  const both = filterCatalogue(catalogueRecords(), { availability: 'Available', size: '20x20' });
  assert.deepEqual(both.map((r) => r.id), ['mj-001']);
});

const PAGE_ITEMS = Array.from({ length: 30 }, (_, i) => ({ id: `r${i + 1}` }));

test('paginateList slices 12-per-page windows with 1-based start/end', () => {
  const p1 = paginateList(PAGE_ITEMS, 1, 12);
  assert.deepEqual(p1, { items: PAGE_ITEMS.slice(0, 12), page: 1, pageSize: 12, total: 30, pageCount: 3, start: 1, end: 12 });
  const p3 = paginateList(PAGE_ITEMS, 3, 12);
  assert.equal(p3.items.length, 6);
  assert.equal(p3.start, 25);
  assert.equal(p3.end, 30);
  assert.equal(p3.page, 3);
});

test('paginateList clamps invalid and oversized pages to the last real page', () => {
  assert.equal(paginateList(PAGE_ITEMS, 0, 12).page, 1);
  assert.equal(paginateList(PAGE_ITEMS, -3, 12).page, 1);
  assert.equal(paginateList(PAGE_ITEMS, 99, 12).page, 3);
  assert.equal(paginateList(PAGE_ITEMS, 'x', 12).page, 1);
  const empty = paginateList([], 5, 12);
  assert.equal(empty.page, 1);
  assert.equal(empty.total, 0);
  assert.equal(empty.start, 0);
  assert.equal(empty.pageCount, 1);
});

test('canReorder allows every UNFILTERED page and disables only under search/filters', () => {
  assert.equal(canReorder({ term: '', availability: 'all', size: 'all' }), true);
  assert.equal(canReorder({ term: '', availability: 'all', size: 'all', page: 2 }), true, 'later unfiltered pages may reorder');
  assert.equal(canReorder({ term: '', availability: 'all', size: 'all', page: 7 }), true);
  assert.equal(canReorder({ term: 'river', availability: 'all', size: 'all' }), false);
  assert.equal(canReorder({ term: '', availability: 'Sold', size: 'all' }), false);
  assert.equal(canReorder({ term: '', availability: 'all', size: '20x20' }), false);
  assert.equal(canReorder({ term: '  ', availability: 'all', size: 'all' }), true, 'whitespace-only term is no filter');
});

test('reorder on a later page uses the GLOBAL index and preserves order across the page boundary', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ id: `r${i + 1}`, sortOrder: i + 1 }));
  const page2 = paginateList(items, 2, 12);
  assert.deepEqual(page2.items.map((r) => r.id), Array.from({ length: 12 }, (_, i) => `r${i + 13}`));

  // Move the FIRST item of page 2 (global index 12) up: it swaps with the last
  // item of page 1; the global sequence stays contiguous.
  const movedUp = reorder(items, 12, 'up');
  assert.notEqual(movedUp, items, 'a real move returns a new array');
  assert.equal(movedUp[11].id, 'r13', 'page-2 first item moves into page-1 territory');
  assert.equal(movedUp[12].id, 'r12', 'page-1 last item moves into page-2 territory');
  const movedPage2 = paginateList(movedUp, 2, 12);
  assert.equal(movedPage2.items[0].id, 'r12', 'the swapped-in item leads page 2 after the move');

  // Move the LAST item of page 2 (global index 23) down into page 3.
  const movedDown = reorder(items, 23, 'down');
  assert.equal(movedDown[23].id, 'r25');
  assert.equal(movedDown[24].id, 'r24');

  // The global last item (page 3) cannot move further: boundary no-op.
  assert.equal(reorder(items, 24, 'down'), items, 'global last stays put');
  // The global first item (page 1) cannot move up either.
  assert.equal(reorder(items, 0, 'up'), items, 'global first stays put');
});

// ===========================================================================
// Editor dirty tracking: formValuesEqual
// ===========================================================================

test('formValuesEqual treats identical snapshots as equal regardless of padding', () => {
  const a = catalogueValues();
  const b = { ...catalogueValues(), title: '  Still Waters ', widthCm: '20' };
  assert.equal(formValuesEqual(a, b), true);
});

test('formValuesEqual detects edits to any tracked field, image paths, and the file name', () => {
  const base = { ...catalogueValues(), imageFileName: '' };
  for (const patch of [
    { title: 'New Title' },
    { image: '/artwork-uploaded/artwork/catalog/mj-009/full.jpg' },
    { thumbnail: '/artwork-uploaded/artwork/catalog/mj-009/thumb.jpg' },
    { containImage: false },
    { priceAmount: '' },
    { sizeCategory: '25x25' }
  ]) {
    assert.equal(formValuesEqual({ ...base, ...patch }, base), false, JSON.stringify(patch));
  }
  assert.equal(formValuesEqual({ ...base, imageFileName: 'source.jpg' }, base), false, 'a selected source file is a change');
});

test('formValuesEqual tolerates missing/null fields defensively', () => {
  assert.equal(formValuesEqual(null, null), true);
  assert.equal(formValuesEqual(null, { title: 'x' }), false);
  assert.equal(formValuesEqual({ title: 'x' }, undefined), false);
});

// ===========================================================================
// Editor reload predicate (regression: the discard bug)
// ===========================================================================

test('editorNeedsReload reloads a different requested artwork', () => {
  const editor = { editingId: 'mj-001', formBaseline: { title: 'x' } };
  assert.equal(editorNeedsReload(editor, 'mj-002'), true);
  assert.equal(editorNeedsReload(editor, 'mj-001'), false);
});

test('editorNeedsReload RELOADS the same artwork after a discard (baseline gone)', () => {
  // Regression: a confirmed discard clears the baseline but the editor must
  // also lose its identity, otherwise re-entering the SAME artwork skipped the
  // refill and resurrected discarded values with dirty tracking off.
  const afterDiscard = { editingId: null, formBaseline: null };
  assert.equal(editorNeedsReload(afterDiscard, 'mj-001'), true, 'same-record re-entry refills the canonical record');
});

test('editorNeedsReload covers the add form and fresh bootstrap states', () => {
  assert.equal(editorNeedsReload({ editingId: null, formBaseline: {} }, null), false, 'blank add form with baseline needs nothing');
  assert.equal(editorNeedsReload({ editingId: 'mj-001', formBaseline: {} }, null), true, 'an edit identity on the add view resets to defaults');
  assert.equal(editorNeedsReload({ editingId: null, formBaseline: null }, null), true, 'no baseline yet -> reset to defaults');
  assert.equal(editorNeedsReload(null, 'mj-001'), true, 'defensive: no editor state at all');
});

// ===========================================================================
// Validation error -> field association
// ===========================================================================

test('fieldIdForError maps every formToRecord message to its control id', () => {
  const cases = [
    ['Catalog number must be MJ-xxx.', 'catalog-number'],
    ['Catalog number must be MISC-xxx.', 'catalog-number'],
    ['Title is required.', 'title'],
    ['A positive width (cm) is required for catalogue works.', 'width-cm'],
    ['A positive height (cm) is required for catalogue works.', 'height-cm'],
    ['Width (cm) must be a positive number or empty.', 'width-cm'],
    ['Height (cm) must be a positive number or empty.', 'height-cm'],
    ['Select a canonical size category.', 'size-category'],
    ['Availability must be Available or Sold.', 'availability'],
    ['Price amount must be a positive number or empty.', 'price-amount']
  ];
  for (const [message, id] of cases) {
    assert.equal(fieldIdForError(message), id, message);
  }
  // No visible control for the hidden sort-order input or unknown messages.
  assert.equal(fieldIdForError('Sort order must be a positive integer.'), null);
  assert.equal(fieldIdForError('Something else entirely.'), null);
  assert.equal(fieldIdForError(null), null);
});

test('fieldIdsForErrors returns ordered de-duplicated ids (first = focus target)', () => {
  const ids = fieldIdsForErrors([
    'Title is required.',
    'A positive width (cm) is required for catalogue works.',
    'Title is required.',
    'Price amount must be a positive number or empty.',
    'Sort order must be a positive integer.'
  ]);
  assert.deepEqual(ids, ['title', 'width-cm', 'price-amount']);
  assert.deepEqual(fieldIdsForErrors([]), []);
  assert.deepEqual(fieldIdsForErrors('not-an-array'), []);
});
