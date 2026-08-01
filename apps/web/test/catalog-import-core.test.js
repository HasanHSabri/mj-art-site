import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_IMAGES,
  EXPECTED_RECORDS,
  MAX_ARTWORKS_JSON_BYTES,
  PREVIEW_BUCKET,
  assertPreviewBucket,
  buildCanonicalArtworksPayload,
  buildRequiredKeys,
  buildSourceMap,
  isProductionBucketName,
  isSafeRelPath,
  objectKeyFor,
  parseArgs,
  parseSha256Sums,
  runtimeUrl,
  utf8Bytes,
  validateManifest
} from '../../../scripts/lib/catalog-import-core.mjs';
import * as schema from '../src/artwork-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const KNOWN_ASSETS_DIR = '/workspace/projects/MJ-ART-catalog-assets';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function rec(id, sha) {
  return {
    id,
    catalogNumber: id === 'misc-001' ? 'MISC-001' : 'MJ-001',
    category: id.startsWith('misc') ? 'miscellaneous' : 'catalogue',
    title: 'T',
    image: `/artwork-uploaded/artwork/catalog/${id}/full.jpg`,
    thumbnail: `/artwork-uploaded/artwork/catalog/${id}/thumb.jpg`,
    medium: null,
    dimensions: { widthCm: 20, heightCm: 20, label: '20x20 cm', orientation: 'Square' },
    sizeCategory: id.startsWith('misc') ? 'miscellaneous' : '20x20',
    availability: 'Available',
    price: null,
    cardNote: '',
    description: '',
    containImage: false,
    sortOrder: 1,
    provenance: { source: 'google-drive', sha256: sha }
  };
}

// ---- parseArgs -------------------------------------------------------------
test('parseArgs: parses value flags and boolean flags', () => {
  const out = parseArgs(['--bucket', 'x', '--execute'], new Set(['execute']));
  assert.equal(out.bucket, 'x');
  assert.equal(out.execute, true);
});

test('parseArgs: rejects missing value and positionals', () => {
  assert.throws(() => parseArgs(['--bucket']), /Missing value for --bucket/);
  assert.throws(() => parseArgs(['--bucket', '--x']), /Missing value for --bucket/);
  assert.throws(() => parseArgs(['positional']), /Unexpected positional argument/);
});

// ---- parseSha256Sums -------------------------------------------------------
test('parseSha256Sums: parses canonical two-space format', () => {
  const map = parseSha256Sums(`${SHA_A}  originals/MJ-001.jpg\n${SHA_B}  misc-originals/MISC-001.jpeg\n`);
  assert.equal(map.get(SHA_A), 'originals/MJ-001.jpg');
  assert.equal(map.get(SHA_B), 'misc-originals/MISC-001.jpeg');
});

test('parseSha256Sums: rejects malformed, duplicate, single-space, unsafe paths', () => {
  assert.throws(() => parseSha256Sums('not-a-line\n'), /malformed/);
  assert.throws(() => parseSha256Sums(`${SHA_A}  a\n${SHA_A}  b\n`), /Duplicate sha256/);
  assert.throws(() => parseSha256Sums(`${SHA_A} single-space.txt\n`), /malformed/);
  assert.throws(() => parseSha256Sums(`${SHA_A}  /abs/path.jpg\n`), /unsafe path/);
  assert.throws(() => parseSha256Sums(`${SHA_A}  ..\/escape.jpg\n`), /unsafe path/);
  assert.throws(() => parseSha256Sums(`${SHA_A}  back\\slash.jpg\n`), /unsafe path/);
});

// ---- isSafeRelPath ---------------------------------------------------------
test('isSafeRelPath: accepts clean relative, rejects unsafe', () => {
  assert.equal(isSafeRelPath('originals/MJ-001.jpg'), true);
  assert.equal(isSafeRelPath('/abs'), false);
  assert.equal(isSafeRelPath('a/../b'), false);
  assert.equal(isSafeRelPath(''), false);
  assert.equal(isSafeRelPath('a\\b'), false);
});

// ---- buildSourceMap --------------------------------------------------------
test('buildSourceMap: resolves by sha, fails closed on problems', () => {
  const sums = new Map([[SHA_A, 'originals/MJ-001.jpg'], [SHA_B, 'misc-originals/MISC-001.jpeg']]);
  const map = buildSourceMap([rec('mj-001', SHA_A), rec('misc-001', SHA_B)], sums);
  assert.equal(map.get('mj-001').sourceRelPath, 'originals/MJ-001.jpg');
  assert.throws(() => buildSourceMap([rec('mj-001', SHA_A)], new Map()), /not present in SHA256SUMS/);
  const bad = { ...rec('mj-001', 'x'), provenance: { source: 'google-drive', sha256: 'short' } };
  assert.throws(() => buildSourceMap([bad], sums), /64-char hex/);
  // two records same source -> collision
  assert.throws(
    () => buildSourceMap([rec('mj-001', SHA_A), rec('mj-002', SHA_A)], sums),
    /same source file/
  );
});

// ---- keys & urls -----------------------------------------------------------
test('objectKeyFor / runtimeUrl: canonical and strict', () => {
  assert.equal(objectKeyFor('mj-001', 'full'), 'artwork/catalog/mj-001/full.jpg');
  assert.equal(runtimeUrl('artwork/catalog/mj-001/thumb.jpg'), '/artwork-uploaded/artwork/catalog/mj-001/thumb.jpg');
  assert.throws(() => objectKeyFor('bad', 'full'), /Invalid record id/);
  assert.throws(() => runtimeUrl('not/canonical'), /noncanonical key/);
});

test('buildRequiredKeys: two per record', () => {
  const keys = buildRequiredKeys([rec('mj-001', SHA_A)]);
  assert.equal(keys.size, 2);
  assert.ok(keys.has('artwork/catalog/mj-001/full.jpg'));
});

// ---- bucket guard ----------------------------------------------------------
test('assertPreviewBucket: preview ok, everything else rejected', () => {
  assert.doesNotThrow(() => assertPreviewBucket(PREVIEW_BUCKET));
  assert.throws(() => assertPreviewBucket('mj-art-images'), /preview/);
  assert.throws(() => assertPreviewBucket('mj-art-images-production'), /preview/);
  assert.throws(() => assertPreviewBucket('any-other'), /preview/);
  assert.throws(() => assertPreviewBucket(undefined), /non-string/);
});

test('isProductionBucketName: only the exact prod literal', () => {
  assert.equal(isProductionBucketName('mj-art-images'), true);
  assert.equal(isProductionBucketName(PREVIEW_BUCKET), false);
});

// ---- validateManifest ------------------------------------------------------
function manifestEntryFor(id, variant, key, sha) {
  return {
    id, variant, key, localRelFile: key, sha256: sha, sourceSha: SHA_A,
    width: 2000, height: 1500, bytes: 12345
  };
}

test('validateManifest: accepts a complete valid manifest', () => {
  const records = [rec('mj-001', SHA_A), rec('mj-002', SHA_B)];
  const full1 = 'artwork/catalog/mj-001/full.jpg';
  const thumb1 = 'artwork/catalog/mj-001/thumb.jpg';
  const full2 = 'artwork/catalog/mj-002/full.jpg';
  const thumb2 = 'artwork/catalog/mj-002/thumb.jpg';
  const manifest = {
    expectedImages: 4, baseDir: '/tmp/x',
    entries: [
      manifestEntryFor('mj-001', 'full', full1, 'c'.repeat(64)),
      manifestEntryFor('mj-001', 'thumb', thumb1, 'd'.repeat(64)),
      manifestEntryFor('mj-002', 'full', full2, 'e'.repeat(64)),
      manifestEntryFor('mj-002', 'thumb', thumb2, 'f'.repeat(64))
    ]
  };
  assert.equal(validateManifest(manifest, records), true);
});

test('validateManifest: rejects wrong count, dup, unknown key, bad fields', () => {
  const records = [rec('mj-001', SHA_A)];
  const mk = (entries) => ({ expectedImages: entries.length, baseDir: '/tmp/x', entries });
  const good = () => mk([
    manifestEntryFor('mj-001', 'full', 'artwork/catalog/mj-001/full.jpg', 'c'.repeat(64)),
    manifestEntryFor('mj-001', 'thumb', 'artwork/catalog/mj-001/thumb.jpg', 'd'.repeat(64))
  ]);
  assert.equal(validateManifest(good(), records), true);
  assert.throws(() => validateManifest({ ...good(), expectedImages: 99 }, records), /expectedImages/);
  const dup = good();
  dup.entries[1] = { ...dup.entries[1], key: dup.entries[0].key };
  assert.throws(() => validateManifest(dup, records), /duplicate key/);
  const unknown = good();
  unknown.entries[0] = { ...unknown.entries[0], key: 'artwork/catalog/mj-099/full.jpg' };
  assert.throws(() => validateManifest(unknown, records), /not required/);
  const badWidth = good();
  badWidth.entries[0] = { ...badWidth.entries[0], width: 99999 };
  assert.throws(() => validateManifest(badWidth, records), /invalid width/);
  const badRel = good();
  badRel.entries[0] = { ...badRel.entries[0], localRelFile: 'other.jpg' };
  assert.throws(() => validateManifest(badRel, records), /localRelFile/);
});

// ---- canonical payload on the REAL catalogue -------------------------------
test('buildCanonicalArtworksPayload: real catalogue is valid, sorted, < 2MiB', () => {
  const catalog = JSON.parse(readFileSync(path.join(REPO_ROOT, 'catalog', 'catalog.json'), 'utf8'));
  assert.equal(catalog.length, EXPECTED_RECORDS);
  const { json, size, count } = buildCanonicalArtworksPayload(catalog, schema);
  assert.equal(count, EXPECTED_RECORDS);
  assert.ok(size < MAX_ARTWORKS_JSON_BYTES, `artworks.json ${size} >= ${MAX_ARTWORKS_JSON_BYTES}`);
  const parsed = JSON.parse(json);
  for (let i = 1; i < parsed.length; i++) {
    assert.ok(parsed[i - 1].sortOrder <= parsed[i].sortOrder, 'must be sorted by sortOrder asc');
  }
});

test('utf8Bytes: counts multi-byte correctly', () => {
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes('é'), 2);
});

// ---- integration: real generation (skip-safe) ------------------------------
function hasImageMagick() {
  try { execFileSync('command', ['-v', 'magick'], { stdio: 'ignore', shell: '/bin/sh' }); return true; }
  catch { /* fall through */ }
  try {
    execFileSync('command', ['-v', 'convert'], { stdio: 'ignore', shell: '/bin/sh' });
    execFileSync('command', ['-v', 'identify'], { stdio: 'ignore', shell: '/bin/sh' });
    return true;
  } catch { return false; }
}

test('generate-catalog-derivatives: real assets -> 172 derivatives + manifest', { skip: (!existsSync(KNOWN_ASSETS_DIR) || !hasImageMagick()) ? 'requires external assets + ImageMagick' : false }, () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'mj-art-gen-'));
  try {
    execFileSync('node', [
      path.join(REPO_ROOT, 'scripts', 'generate-catalog-derivatives.mjs'),
      '--assets-dir', KNOWN_ASSETS_DIR,
      '--output-dir', out
    ], { stdio: 'pipe' });
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    const catalog = JSON.parse(readFileSync(path.join(REPO_ROOT, 'catalog', 'catalog.json'), 'utf8'));
    assert.equal(manifest.entries.length, EXPECTED_IMAGES);
    assert.equal(validateManifest(manifest, catalog), true);
    // longest-edge / no-upscale invariant on every entry
    for (const e of manifest.entries) {
      const cap = e.variant === 'full' ? 2000 : 640;
      assert.ok(Math.max(e.width, e.height) <= cap, `${e.key} exceeds ${cap}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
