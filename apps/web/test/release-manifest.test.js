import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '../src/artwork-schema.js';
import {
  ARTWORKS_JSON_KEY,
  DESTINATION_BUCKET,
  EXPECTED_IMAGES,
  EXPECTED_RECORDS,
  INVENTORY_FINGERPRINT_ALGORITHM,
  PROMOTION_CONFIRM_PHRASE,
  RELEASE_MANIFEST_KIND,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  SOURCE_BUCKET,
  buildReleaseManifest,
  hashReleaseManifest,
  hashReleaseManifestBytes,
  inventoryFingerprint,
  makeExpectedObject,
  serializeReleaseManifest,
  validateReleaseManifest,
  verifyPreviewInventoryMatchesRelease,
  verifyProductionBackupHandshake,
  extractBackupBucket
} from '../../../scripts/lib/release-manifest-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function readRel(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

const catalog = JSON.parse(readRel('catalog/catalog.json'));

// ---------------------------------------------------------------------------
// Fixed literals
// ---------------------------------------------------------------------------

test('source/destination bucket literals are the fixed preview/production names', () => {
  assert.equal(SOURCE_BUCKET, 'mj-art-images-preview');
  assert.equal(DESTINATION_BUCKET, 'mj-art-images');
  assert.notEqual(SOURCE_BUCKET, DESTINATION_BUCKET);
});

test('promotion confirm phrase is the exact strong literal', () => {
  assert.equal(PROMOTION_CONFIRM_PHRASE, 'I-CONFIRM-PRODUCTION-CATALOGUE-PROMOTION');
  assert.match(PROMOTION_CONFIRM_PHRASE, /^[A-Z0-9-]+$/);
});

test('release manifest schema version + kind are pinned', () => {
  assert.equal(RELEASE_MANIFEST_SCHEMA_VERSION, 1);
  assert.equal(RELEASE_MANIFEST_KIND, 'mj-art-production-catalogue-release');
});

// ---------------------------------------------------------------------------
// makeExpectedObject / serialization / hashing
// ---------------------------------------------------------------------------

test('makeExpectedObject accepts a canonical {key,size,sha256} only', () => {
  const e = makeExpectedObject('artwork/catalog/mj-001/full.jpg', 12345,
    'a'.repeat(64));
  assert.deepEqual(e, { key: 'artwork/catalog/mj-001/full.jpg', size: 12345, sha256: 'a'.repeat(64) });
});

test('makeExpectedObject rejects non-positive size, bad sha, empty key', () => {
  assert.throws(() => makeExpectedObject('k', 0, 'a'.repeat(64)));
  assert.throws(() => makeExpectedObject('k', 1, 'not-hex'));
  assert.throws(() => makeExpectedObject('', 1, 'a'.repeat(64)));
});

test('serializeReleaseManifest is deterministic and stable', () => {
  const m = buildReleaseManifest(
    [{ rawKey: 'artworks.json', size: 10, sha256: 'a'.repeat(64), downloaded: true }],
    { contentCommit: 'c', verifiedByBackupSnapshot: 's', backupRecordedCommit: 'b' }
  );
  const a = serializeReleaseManifest(m);
  const b = serializeReleaseManifest(JSON.parse(JSON.stringify(m)));
  assert.equal(a, b);
  assert.ok(a.endsWith('\n'));
});

test('hashReleaseManifest is stable for identical content', () => {
  const m = buildReleaseManifest(
    [{ rawKey: 'artworks.json', size: 10, sha256: 'a'.repeat(64), downloaded: true }],
    { contentCommit: 'c', verifiedByBackupSnapshot: 's', backupRecordedCommit: 'b' }
  );
  assert.equal(hashReleaseManifest(m), hashReleaseManifest(m));
  assert.match(hashReleaseManifest(m), /^[0-9a-f]{64}$/);
  assert.equal(hashReleaseManifestBytes(serializeReleaseManifest(m)), hashReleaseManifest(m));
});

// ---------------------------------------------------------------------------
// buildReleaseManifest + validateReleaseManifest
// ---------------------------------------------------------------------------

// Build a valid 173-object record set from the real catalogue (172 image keys
// derived from the catalogue + the canonical artworks.json payload), with
// deterministic fake image bodies. The artworks.json hash is the REAL canonical
// catalogue hash so validateReleaseManifest's cross-check passes.
import { buildRequiredKeys, buildCanonicalArtworksPayload } from '../../../scripts/lib/catalog-import-core.mjs';

function validRecords() {
  const records = [];
  for (const key of [...buildRequiredKeys(catalog)].sort()) {
    records.push({ rawKey: key, size: 1000, sha256: 'f'.repeat(64), downloaded: true });
  }
  const payload = buildCanonicalArtworksPayload(catalog, schema);
  records.push({ rawKey: ARTWORKS_JSON_KEY, size: payload.size, sha256: payload.sha256, downloaded: true });
  return records;
}

test('buildReleaseManifest sorts 173 objects and shapes them as {key,size,sha256}', () => {
  const m = buildReleaseManifest(validRecords(), {
    contentCommit: 'e52fc7f', verifiedByBackupSnapshot: 'snap', backupRecordedCommit: '97a11c2'
  });
  assert.equal(m.expectedObjectCount, EXPECTED_IMAGES + 1);
  assert.equal(m.imageObjectCount, EXPECTED_IMAGES);
  assert.equal(m.expectedObjects.length, EXPECTED_IMAGES + 1);
  for (const e of m.expectedObjects) {
    assert.deepEqual(Object.keys(e).sort(), ['key', 'sha256', 'size']);
  }
  // sorted ascending
  for (let i = 1; i < m.expectedObjects.length; i++) {
    assert.ok(m.expectedObjects[i - 1].key < m.expectedObjects[i].key, 'not sorted');
  }
  assert.equal(m.expectedObjects[m.expectedObjects.length - 1].key, ARTWORKS_JSON_KEY);
});

test('validateReleaseManifest accepts a valid catalogue-derived manifest', () => {
  const m = buildReleaseManifest(validRecords(), {
    contentCommit: 'e52fc7f', verifiedByBackupSnapshot: 'snap', backupRecordedCommit: '97a11c2'
  });
  assert.equal(validateReleaseManifest(m, catalog, schema), true);
});

test('validateReleaseManifest rejects an inverted source/destination role', () => {
  const m = buildReleaseManifest(validRecords(), {
    contentCommit: 'e52fc7f', verifiedByBackupSnapshot: 'snap', backupRecordedCommit: '97a11c2'
  });
  m.source.role = 'write target (production)';
  assert.throws(() => validateReleaseManifest(m, catalog, schema));
});

test('validateReleaseManifest rejects a swapped destination bucket literal', () => {
  const m = buildReleaseManifest(validRecords(), {
    contentCommit: 'e52fc7f', verifiedByBackupSnapshot: 'snap', backupRecordedCommit: '97a11c2'
  });
  m.destination.bucket = 'mj-art-images-preview';
  assert.throws(() => validateReleaseManifest(m, catalog, schema));
});

test('validateReleaseManifest rejects an extra object (174)', () => {
  const m = buildReleaseManifest(validRecords(), {
    contentCommit: 'e52fc7f', verifiedByBackupSnapshot: 'snap', backupRecordedCommit: '97a11c2'
  });
  m.expectedObjects.push({ key: 'artwork/catalog/zzz-999/full.jpg', size: 1, sha256: 'a'.repeat(64) });
  m.expectedObjectCount = m.expectedObjects.length;
  assert.throws(() => validateReleaseManifest(m, catalog, schema));
});

test('validateReleaseManifest rejects a leaked etag/local-path field on an object', () => {
  const m = buildReleaseManifest(validRecords(), {
    contentCommit: 'e52fc7f', verifiedByBackupSnapshot: 'snap', backupRecordedCommit: '97a11c2'
  });
  m.expectedObjects[0].etag = 'leak';
  assert.throws(() => validateReleaseManifest(m, catalog, schema));
});

test('validateReleaseManifest rejects unsorted objects', () => {
  const m = buildReleaseManifest(validRecords(), {
    contentCommit: 'e52fc7f', verifiedByBackupSnapshot: 'snap', backupRecordedCommit: '97a11c2'
  });
  // swap first two
  const tmp = m.expectedObjects[0];
  m.expectedObjects[0] = m.expectedObjects[1];
  m.expectedObjects[1] = tmp;
  assert.throws(() => validateReleaseManifest(m, catalog, schema));
});

test('validateReleaseManifest rejects an artworks.json summary that disagrees with its object', () => {
  const m = buildReleaseManifest(validRecords(), {
    contentCommit: 'e52fc7f', verifiedByBackupSnapshot: 'snap', backupRecordedCommit: '97a11c2'
  });
  m.artworksJson.sha256 = 'b'.repeat(64);
  assert.throws(() => validateReleaseManifest(m, catalog, schema));
});

// ---------------------------------------------------------------------------
// Backup handshake + preview inventory cross-check
// ---------------------------------------------------------------------------

function fakeBackupManifest(prodCount, prevRecords, { prodAllDownloaded = true } = {}) {
  const prodObjects = [];
  for (let i = 0; i < prodCount; i++) {
    prodObjects.push({
      rawKey: `legacy/img-${i}.jpg`,
      size: 100 + i,
      sha256:('a'.repeat(63) + String(i % 10)),
      downloaded: prodAllDownloaded
    });
  }
  return {
    buckets: [
      { name: DESTINATION_BUCKET, objectCount: prodCount, objects: prodObjects },
      { name: SOURCE_BUCKET, objectCount: prevRecords.length, objects: prevRecords.map((r) => ({ ...r })) }
    ]
  };
}

test('verifyProductionBackupHandshake passes when count + downloads match', () => {
  const recs = validRecords();
  const bm = fakeBackupManifest(19, recs);
  const inv = verifyProductionBackupHandshake(bm, 19);
  assert.equal(inv.objectCount, 19);
  assert.equal(inv.objects.length, 19);
});

test('verifyProductionBackupHandshake fails on count drift (production unseen change)', () => {
  const recs = validRecords();
  const bm = fakeBackupManifest(19, recs);
  assert.throws(() => verifyProductionBackupHandshake(bm, 18));
  assert.throws(() => verifyProductionBackupHandshake(bm, 20));
});

test('verifyProductionBackupHandshake fails when a production body was not downloaded', () => {
  const recs = validRecords();
  const bm = fakeBackupManifest(19, recs, { prodAllDownloaded: false });
  assert.throws(() => verifyProductionBackupHandshake(bm, 19));
});

test('verifyProductionBackupHandshake fails when a production object is missing its sha', () => {
  const recs = validRecords();
  const bm = fakeBackupManifest(19, recs);
  delete bm.buckets[0].objects[0].sha256;
  bm.buckets[0].objects[0].downloaded = true;
  assert.throws(() => verifyProductionBackupHandshake(bm, 19));
});

test('verifyProductionBackupHandshake passes when count + content fingerprint match', () => {
  const recs = validRecords();
  const bm = fakeBackupManifest(19, recs);
  const fp = inventoryFingerprint(extractBackupBucket(bm, DESTINATION_BUCKET)).sha256;
  const inv = verifyProductionBackupHandshake(bm, 19, fp);
  assert.equal(inv.objectCount, 19);
});

test('verifyProductionBackupHandshake fails on fingerprint mismatch (same-count byte drift)', () => {
  const recs = validRecords();
  const bm = fakeBackupManifest(19, recs);
  const fp = inventoryFingerprint(extractBackupBucket(bm, DESTINATION_BUCKET)).sha256;
  // Byte drift: same count, same keys/sizes, but one sha256 changes.
  bm.buckets[0].objects[0].sha256 = 'b'.repeat(63) + '1';
  assert.throws(
    () => verifyProductionBackupHandshake(bm, 19, fp),
    /fingerprint mismatch|content drift/i
  );
});

test('verifyProductionBackupHandshake fails on fingerprint mismatch (same-count key drift)', () => {
  const recs = validRecords();
  const bm = fakeBackupManifest(19, recs);
  const fp = inventoryFingerprint(extractBackupBucket(bm, DESTINATION_BUCKET)).sha256;
  // Key drift: same count and sizes/shas, but one key is renamed.
  bm.buckets[0].objects[0].rawKey = 'legacy/renamed-0.jpg';
  assert.throws(
    () => verifyProductionBackupHandshake(bm, 19, fp),
    /fingerprint mismatch|content drift/i
  );
});

test('verifyProductionBackupHandshake fails on a malformed expected fingerprint', () => {
  const recs = validRecords();
  const bm = fakeBackupManifest(19, recs);
  assert.throws(() => verifyProductionBackupHandshake(bm, 19, 'not-hex'));
  assert.throws(() => verifyProductionBackupHandshake(bm, 19, 'a'.repeat(63)));
});

test('verifyProductionBackupHandshake ignores the fingerprint when none is supplied (count-only)', () => {
  const recs = validRecords();
  const bm = fakeBackupManifest(19, recs);
  // No third argument: legacy count-only behaviour still works.
  const inv = verifyProductionBackupHandshake(bm, 19);
  assert.equal(inv.objectCount, 19);
});

test('inventoryFingerprint is content-exact: same count, different content -> different digest', () => {
  const bm = fakeBackupManifest(19, validRecords());
  const inv = extractBackupBucket(bm, DESTINATION_BUCKET);
  const a = inventoryFingerprint(inv);
  // Mutate one sha256 (byte change) without changing the count.
  const drifted = JSON.parse(JSON.stringify(inv));
  drifted.objects[0].sha256 = 'c'.repeat(64);
  const b = inventoryFingerprint(drifted);
  assert.equal(a.objectCount, b.objectCount);
  assert.notEqual(a.sha256, b.sha256);
});

test('inventoryFingerprint algorithm label is pinned', () => {
  assert.equal(INVENTORY_FINGERPRINT_ALGORITHM, 'mj-art-inventory-fingerprint-v1');
});

test('verifyPreviewInventoryMatchesRelease passes on exact match', () => {
  const recs = validRecords();
  const m = buildReleaseManifest(recs, {
    contentCommit: 'e52fc7f', verifiedByBackupSnapshot: 'snap', backupRecordedCommit: '97a11c2'
  });
  const bm = fakeBackupManifest(19, recs);
  assert.equal(verifyPreviewInventoryMatchesRelease(bm, m), true);
});

test('verifyPreviewInventoryMatchesRelease rejects a missing preview object', () => {
  const recs = validRecords();
  const m = buildReleaseManifest(recs, {
    contentCommit: 'e52fc7f', verifiedByBackupSnapshot: 'snap', backupRecordedCommit: '97a11c2'
  });
  const bm = fakeBackupManifest(19, recs);
  // remove one preview object from the backup inventory
  bm.buckets[1].objects.pop();
  assert.throws(() => verifyPreviewInventoryMatchesRelease(bm, m));
});

test('verifyPreviewInventoryMatchesRelease rejects an extra preview object', () => {
  const recs = validRecords();
  const m = buildReleaseManifest(recs, {
    contentCommit: 'e52fc7f', verifiedByBackupSnapshot: 'snap', backupRecordedCommit: '97a11c2'
  });
  const bm = fakeBackupManifest(19, recs);
  bm.buckets[1].objects.push({ rawKey: 'artwork/catalog/zzz-999/full.jpg', size: 1, sha256: 'c'.repeat(64), downloaded: true });
  assert.throws(() => verifyPreviewInventoryMatchesRelease(bm, m));
});

test('inventoryFingerprint is deterministic and order-independent', () => {
  const inv = extractBackupBucket(fakeBackupManifest(3, validRecords()), DESTINATION_BUCKET);
  const a = inventoryFingerprint(inv);
  const shuffled = { ...inv, objects: inv.objects.slice().reverse() };
  const b = inventoryFingerprint(shuffled);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.objectCount, 3);
});

// ---------------------------------------------------------------------------
// Committed manifest: structure + cross-validation against the catalogue
// ---------------------------------------------------------------------------

const committedPath = path.join(REPO_ROOT, 'catalog', 'production-release-manifest.json');

test('catalog/production-release-manifest.json exists and is committed-valid', () => {
  assert.ok(existsSync(committedPath), 'committed release manifest must exist');
  const m = JSON.parse(readFileSync(committedPath, 'utf8'));
  assert.equal(validateReleaseManifest(m, catalog, schema), true);
});

test('committed release manifest pins 173 objects, 86 records, 172 image keys', () => {
  const m = JSON.parse(readFileSync(committedPath, 'utf8'));
  assert.equal(m.expectedObjectCount, 173);
  assert.equal(m.catalog.recordCount, EXPECTED_RECORDS);
  assert.equal(m.catalog.canonicalImageKeyCount, EXPECTED_IMAGES);
  assert.equal(m.imageObjectCount, EXPECTED_IMAGES);
  assert.equal(m.artworksJson.recordCount, EXPECTED_RECORDS);
});

test('committed release manifest carries no local paths, etags, timestamps, or secrets', () => {
  const text = readFileSync(committedPath, 'utf8');
  for (const forbidden of [/backupPath/i, /etag/i, /lastModified/i, /\.local-assets/, /\/tmp\//, /token/i, /secret/i, /password/i]) {
    assert.doesNotMatch(text, forbidden, `forbidden pattern in committed manifest: ${forbidden}`);
  }
});

test('committed release manifest source is preview, destination is production', () => {
  const m = JSON.parse(readFileSync(committedPath, 'utf8'));
  assert.equal(m.source.bucket, 'mj-art-images-preview');
  assert.equal(m.destination.bucket, 'mj-art-images');
  assert.match(m.destination.role, /write/);
});

test('committed release manifest on-disk sha256 is stable', () => {
  const text = readFileSync(committedPath, 'utf8');
  const m = JSON.parse(text);
  // Re-serializing the parsed object must reproduce the exact committed bytes:
  // the generator writes serializeReleaseManifest(manifest).
  assert.equal(serializeReleaseManifest(m), text);
});
