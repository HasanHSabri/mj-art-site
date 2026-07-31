import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateArtworkList,
  validateArtworkRecord,
  projectPublic,
  toPublicList,
  sortByOrder,
  canonicalizeRecord,
  canonicalizeList,
  clone,
  dimensionsLabel,
  priceDisplay,
  PUBLIC_FIELDS,
  CANONICAL_FIELDS,
  PROVENANCE_FIELDS,
  ALLOWED_SOURCES,
  MAX_PUT_BODY_BYTES
} from '../src/artwork-schema.js';

// A minimal valid canonical record. Fields mirror catalog/catalog.json.
function validRecord(overrides = {}) {
  return {
    id: 'mj-001',
    catalogNumber: 'MJ-001',
    category: 'catalogue',
    title: 'Still Waters, Moving Souls',
    image: '/artwork-uploaded/artwork/catalog/mj-001/full.jpg',
    thumbnail: '/artwork-uploaded/artwork/catalog/mj-001/thumb.jpg',
    medium: 'Acrylic pouring paint',
    dimensions: { widthCm: 20, heightCm: 20, label: '20x20 cm', orientation: 'Square' },
    sizeCategory: '20x20',
    availability: 'Available',
    price: { amount: 40, currency: 'AUD', note: 'postage extra' },
    cardNote: '$40 (postage extra)',
    description: 'A painting.',
    containImage: true,
    sortOrder: 1,
    provenance: { source: 'google-drive', sha256: 'a'.repeat(64) },
    ...overrides
  };
}

test('validateArtworkList accepts a valid canonical list', () => {
  const records = [validRecord(), validRecord({ id: 'mj-002', catalogNumber: 'MJ-002', sortOrder: 2 })];
  const result = validateArtworkList(records);
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 2);
});

test('validateArtworkList rejects non-array', () => {
  const result = validateArtworkList({});
  assert.equal(result.ok, false);
  assert.match(result.error, /must be a list/);
});

test('validateArtworkList accepts an empty list (empty preview is valid)', () => {
  const result = validateArtworkList([]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.records, []);
});

test('validateArtworkList rejects extra/unknown keys', () => {
  const records = [validRecord({ extra: 'nope' })];
  const result = validateArtworkList(records);
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown field: extra/);
});

test('validateArtworkList rejects duplicate ids', () => {
  // id is coupled to catalogNumber (id === catalogNumber.toLowerCase()), so a
  // duplicate id necessarily duplicates the catalog number. Differing sortOrder
  // isolates the id collision as the first failure.
  const records = [validRecord(), validRecord({ sortOrder: 2 })];
  const result = validateArtworkList(records);
  assert.equal(result.ok, false);
  assert.match(result.error, /duplicate id/);
});

test('validateArtworkList rejects duplicate catalogNumbers', () => {
  // Because id === catalogNumber.toLowerCase(), the id guard fires first for a
  // duplicated catalog number. Either way the list must be rejected.
  const records = [validRecord(), validRecord({ sortOrder: 2 })];
  const result = validateArtworkList(records);
  assert.equal(result.ok, false);
  assert.match(result.error, /duplicate/);
});

test('validateArtworkList rejects duplicate sortOrders', () => {
  const records = [validRecord({ sortOrder: 5 }), validRecord({ id: 'mj-002', catalogNumber: 'MJ-002', sortOrder: 5 })];
  const result = validateArtworkList(records);
  assert.equal(result.ok, false);
  assert.match(result.error, /duplicate sortOrder/);
});

test('validateArtworkRecord rejects missing fields', () => {
  const r = validRecord();
  delete r.provenance;
  assert.match(validateArtworkRecord(r), /missing field: provenance/);
});

test('validateArtworkRecord rejects id not matching catalogNumber', () => {
  const r = validRecord({ id: 'mj-009', catalogNumber: 'MJ-001' });
  assert.match(validateArtworkRecord(r), /id must equal catalogNumber/);
});

test('validateArtworkRecord rejects malformed id slug', () => {
  const r = validRecord({ id: 'MJ-001', catalogNumber: 'MJ-001' });
  assert.match(validateArtworkRecord(r), /id must be a slug/);
});

test('validateArtworkRecord rejects malformed image path', () => {
  const r = validRecord({ image: './artwork/foo.jpg' });
  assert.match(validateArtworkRecord(r), /image path malformed/);
});

test('validateArtworkRecord rejects malformed thumbnail path', () => {
  const r = validRecord({ thumbnail: '/artwork-uploaded/wrong.png' });
  assert.match(validateArtworkRecord(r), /thumbnail path malformed/);
});

test('validateArtworkRecord accepts null medium and null price', () => {
  const r = validRecord({ medium: null, price: null });
  assert.equal(validateArtworkRecord(r), null);
});

test('validateArtworkRecord rejects non-null non-string medium', () => {
  const r = validRecord({ medium: 5 });
  assert.match(validateArtworkRecord(r), /medium must be a string or null/);
});

test('validateArtworkRecord accepts empty cardNote and description', () => {
  const r = validRecord({ cardNote: '', description: '' });
  assert.equal(validateArtworkRecord(r), null);
});

test('validateArtworkRecord rejects non-string cardNote', () => {
  const r = validRecord({ cardNote: null });
  assert.match(validateArtworkRecord(r), /cardNote must be a string/);
});

test('validateArtworkRecord rejects price amount <= 0', () => {
  const r = validRecord({ price: { amount: 0, currency: 'AUD', note: null } });
  assert.match(validateArtworkRecord(r), /price.amount must be a positive/);
});

test('validateArtworkRecord rejects non-AUD currency', () => {
  const r = validRecord({ price: { amount: 10, currency: 'USD', note: null } });
  assert.match(validateArtworkRecord(r), /currency must be AUD/);
});

test('validateArtworkRecord accepts price with string note and null note', () => {
  assert.equal(validateArtworkRecord(validRecord({ price: { amount: 70, currency: 'AUD', note: 'framed' } })), null);
  assert.equal(validateArtworkRecord(validRecord({ price: { amount: 70, currency: 'AUD', note: null } })), null);
});

test('validateArtworkRecord rejects unknown price keys', () => {
  const r = validRecord({ price: { amount: 70, currency: 'AUD', note: null, tax: 5 } });
  assert.match(validateArtworkRecord(r), /unknown price field: tax/);
});

test('validateArtworkRecord validates dimensions orientation consistency', () => {
  assert.match(
    validateArtworkRecord(validRecord({ dimensions: { widthCm: 30, heightCm: 20, label: '30x20', orientation: 'Vertical' } })),
    /expected Horizontal/
  );
  assert.equal(
    validateArtworkRecord(validRecord({ dimensions: { widthCm: 30, heightCm: 20, label: '30x20', orientation: 'Horizontal' } })),
    null
  );
});

test('validateArtworkRecord accepts null widthCm/heightCm with Unknown orientation', () => {
  const r = validRecord({
    category: 'miscellaneous',
    id: 'misc-001',
    catalogNumber: 'MISC-001',
    dimensions: { widthCm: null, heightCm: null, label: 'To be added', orientation: 'Unknown' },
    sizeCategory: 'miscellaneous'
  });
  assert.equal(validateArtworkRecord(r), null);
});

test('validateArtworkRecord rejects invalid availability', () => {
  const r = validRecord({ availability: 'Reserved' });
  assert.match(validateArtworkRecord(r), /invalid availability/);
});

test('validateArtworkRecord rejects non-integer sortOrder', () => {
  const r = validRecord({ sortOrder: 1.5 });
  assert.match(validateArtworkRecord(r), /sortOrder must be an integer/);
});

test('validateArtworkRecord rejects provenance missing source', () => {
  const r = validRecord({ provenance: { sha256: 'a'.repeat(64) } });
  assert.match(validateArtworkRecord(r), /provenance.source must be a non-empty string/);
});

test('validateArtworkRecord rejects catalogue catalogNumber with MISC format', () => {
  const r = validRecord({ catalogNumber: 'MISC-001' });
  assert.match(validateArtworkRecord(r), /catalogue catalogNumber must be MJ-xxx/);
});

// ----- projection & ordering -----

test('projectPublic omits catalogNumber, sortOrder, and provenance', () => {
  const projected = projectPublic(validRecord());
  for (const field of PUBLIC_FIELDS) {
    assert.ok(field in projected, `public field present: ${field}`);
  }
  assert.equal('catalogNumber' in projected, false);
  assert.equal('sortOrder' in projected, false);
  assert.equal('provenance' in projected, false);
});

test('projectPublic exposes category, sizeCategory, dimensions, price, thumbnail', () => {
  const projected = projectPublic(validRecord());
  assert.equal(projected.category, 'catalogue');
  assert.equal(projected.sizeCategory, '20x20');
  assert.deepEqual(projected.dimensions, { widthCm: 20, heightCm: 20, label: '20x20 cm', orientation: 'Square' });
  assert.deepEqual(projected.price, { amount: 40, currency: 'AUD', note: 'postage extra' });
  assert.equal(projected.thumbnail, '/artwork-uploaded/artwork/catalog/mj-001/thumb.jpg');
});

test('toPublicList sorts by sortOrder ascending and projects', () => {
  const records = [
    validRecord({ sortOrder: 3, id: 'mj-003', catalogNumber: 'MJ-003' }),
    validRecord({ sortOrder: 1, id: 'mj-001', catalogNumber: 'MJ-001' }),
    validRecord({ sortOrder: 2, id: 'mj-002', catalogNumber: 'MJ-002' })
  ];
  const list = toPublicList(records);
  assert.deepEqual(list.map((r) => r.id), ['mj-001', 'mj-002', 'mj-003']);
  for (const r of list) {
    assert.equal('sortOrder' in r, false);
    assert.equal('catalogNumber' in r, false);
    assert.equal('provenance' in r, false);
  }
});

test('sortByOrder is stable and ascending, returns a copy', () => {
  const records = [validRecord({ sortOrder: 2, id: 'a-002', catalogNumber: 'A-002' }), validRecord({ sortOrder: 1, id: 'a-001', catalogNumber: 'A-001' })];
  const sorted = sortByOrder(records);
  assert.notEqual(sorted, records);
  assert.deepEqual(sorted.map((r) => r.sortOrder), [1, 2]);
});

test('PUBLIC_FIELDS and CANONICAL_FIELDS contain expected keys', () => {
  assert.ok(CANONICAL_FIELDS.includes('provenance'));
  assert.ok(CANONICAL_FIELDS.includes('catalogNumber'));
  assert.ok(CANONICAL_FIELDS.includes('sortOrder'));
  assert.ok(!PUBLIC_FIELDS.includes('provenance'));
  assert.ok(!PUBLIC_FIELDS.includes('catalogNumber'));
  assert.ok(!PUBLIC_FIELDS.includes('sortOrder'));
});

// ----- display helpers -----

test('dimensionsLabel returns the dimensions label', () => {
  assert.equal(dimensionsLabel(validRecord()), '20x20 cm');
  assert.equal(dimensionsLabel(validRecord({ dimensions: { widthCm: null, heightCm: null, label: 'To be added', orientation: 'Unknown' } })), 'To be added');
  assert.equal(dimensionsLabel({}), '');
  assert.equal(dimensionsLabel(null), '');
});

test('priceDisplay renders amount and optional note', () => {
  assert.equal(priceDisplay(validRecord({ price: { amount: 40, currency: 'AUD', note: 'postage extra' } })), '$40 (postage extra)');
  assert.equal(priceDisplay(validRecord({ price: { amount: 70, currency: 'AUD', note: null } })), '$70');
  assert.equal(priceDisplay(validRecord({ price: null })), '');
  assert.equal(priceDisplay({}), '');
});

test('MAX_PUT_BODY_BYTES is a sane positive cap', () => {
  assert.ok(typeof MAX_PUT_BODY_BYTES === 'number');
  assert.ok(MAX_PUT_BODY_BYTES > 0);
  assert.ok(MAX_PUT_BODY_BYTES <= 4 * 1024 * 1024);
});

// ----- provenance hardening (allowlist / source enum / hash / leak) -----

test('PROVENANCE_FIELDS allowlist matches the canonical catalogue keys', () => {
  assert.deepEqual(PROVENANCE_FIELDS, [
    'source',
    'sha256',
    'driveFileId',
    'driveFolder',
    'sourceFilename',
    'sourceBytes',
    'photoTimestamp',
    'mappedFromMiscLabel',
    'mappedFromLiveId',
    'originalMiscLabel',
    'liveId',
    'originalImageUrl',
    'r2BackupRun'
  ]);
});

test('ALLOWED_SOURCES is exactly the supported source enum', () => {
  assert.deepEqual([...ALLOWED_SOURCES].sort(), ['admin', 'google-drive', 'r2-backup-or-live-fetch']);
});

test('validateArtworkRecord rejects unknown provenance field', () => {
  const r = validRecord({ provenance: { source: 'google-drive', malicious: 'x' } });
  assert.match(validateArtworkRecord(r), /unknown provenance field: malicious/);
});

test('validateArtworkRecord rejects disallowed provenance source', () => {
  const r = validRecord({ provenance: { source: 'manual-upload' } });
  assert.match(validateArtworkRecord(r), /invalid provenance.source/);
});

test('validateArtworkRecord rejects malformed sha256', () => {
  const r = validRecord({ provenance: { source: 'google-drive', sha256: 'XYZ' } });
  assert.match(validateArtworkRecord(r), /sha256 must be 64-char lowercase hex/);
});

test('validateArtworkRecord accepts admin source without a hash', () => {
  const r = validRecord({ provenance: { source: 'admin' } });
  assert.equal(validateArtworkRecord(r), null);
});

test('validateArtworkRecord accepts full canonical provenance with sourceBytes', () => {
  const r = validRecord({
    provenance: {
      source: 'google-drive',
      sha256: 'a'.repeat(64),
      driveFileId: 'id',
      driveFolder: 'folder',
      sourceFilename: 'full.jpg',
      sourceBytes: 12345,
      photoTimestamp: '2024-01-01T00:00:00Z'
    }
  });
  assert.equal(validateArtworkRecord(r), null);
});

test('validateArtworkRecord rejects non-integer sourceBytes', () => {
  const r = validRecord({ provenance: { source: 'google-drive', sourceBytes: 1.5 } });
  assert.match(validateArtworkRecord(r), /sourceBytes must be a non-negative integer/);
});

test('validateArtworkRecord rejects secret-like provenance value', () => {
  const r = validRecord({ provenance: { source: 'google-drive', driveFileId: 'my-api-key-leak' } });
  assert.match(validateArtworkRecord(r), /secret-like value in provenance/);
});

test('validateArtworkRecord rejects local-path provenance value', () => {
  const r = validRecord({ provenance: { source: 'google-drive', sourceFilename: '/tmp/evil.jpg' } });
  assert.match(validateArtworkRecord(r), /local-path value in provenance/);
});

test('validateArtworkRecord rejects non-positive sortOrder', () => {
  assert.match(validateArtworkRecord(validRecord({ sortOrder: 0 })), /sortOrder must be a positive integer/);
  assert.match(validateArtworkRecord(validRecord({ sortOrder: -1 })), /sortOrder must be a positive integer/);
});

// ----- deep-copy projection & canonicalization -----

test('projectPublic deep-copies dimensions and price (no shared reference)', () => {
  const record = validRecord();
  const projected = projectPublic(record);
  assert.notEqual(projected.dimensions, record.dimensions);
  assert.notEqual(projected.price, record.price);
  projected.dimensions.widthCm = 9999;
  projected.price.amount = 9999;
  assert.equal(record.dimensions.widthCm, 20);
  assert.equal(record.price.amount, 40);
});

test('canonicalizeRecord returns exactly the canonical field set, deep-cloned', () => {
  const record = validRecord();
  const canon = canonicalizeRecord(record);
  assert.deepEqual(Object.keys(canon), CANONICAL_FIELDS);
  assert.notEqual(canon.dimensions, record.dimensions);
  assert.notEqual(canon.provenance, record.provenance);
  canon.dimensions.widthCm = 0;
  assert.equal(record.dimensions.widthCm, 20);
});

test('canonicalizeList maps over records and drops stray keys', () => {
  const list = canonicalizeList([validRecord({ extra: 'stray', another: 1 })]);
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]), CANONICAL_FIELDS);
  assert.equal('extra' in list[0], false);
});

test('clone handles primitives, null, and nested structures', () => {
  assert.equal(clone(5), 5);
  assert.equal(clone('x'), 'x');
  assert.equal(clone(null), null);
  const obj = { a: [1, { b: 2 }] };
  const copy = clone(obj);
  assert.deepEqual(copy, obj);
  assert.notEqual(copy, obj);
  assert.notEqual(copy.a, obj.a);
});
