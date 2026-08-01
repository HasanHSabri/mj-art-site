import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_IMAGES,
  EXPECTED_RECORDS,
  MAX_ARTWORKS_JSON_BYTES,
  MASTER_VERSION_RE,
  PREVIEW_BUCKET,
  assertPreviewBucket,
  buildCanonicalArtworksPayload,
  buildRequiredKeys,
  buildSourceMap,
  findInputsInRunBlocks,
  findSecretsInRunBlocks,
  isProductionBucketName,
  isSafeRelPath,
  isSafeTarPath,
  isSafeVpsMasterRoot,
  masterArchiveBasename,
  masterSidecarBasename,
  maxDimensionForVariant,
  objectKeyFor,
  parseArgs,
  parseMasterSidecar,
  parseSha256Sums,
  runtimeUrl,
  utf8Bytes,
  validateManifest,
  validateMasterVersion,
  validateTarVerboseListing,
  validateVpsHost,
  validateVpsMasterRoot,
  validateVpsPort,
  validateVpsUser,
  verifyArtworksReadback
} from '../../../scripts/lib/catalog-import-core.mjs';
import * as schema from '../src/artwork-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const KNOWN_ASSETS_DIR = path.join(REPO_ROOT, '.local-assets', 'catalog-assets');

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
  // Dimensions are per-variant: full <=2000, thumb <=640 (enforced by validateManifest).
  const w = variant === 'full' ? 2000 : 640;
  const h = variant === 'full' ? 1500 : 480;
  return {
    id, variant, key, localRelFile: key, sha256: sha, sourceSha: SHA_A,
    width: w, height: h, bytes: 12345
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

// ===========================================================================
// Finding 4: per-variant dimension caps (thumb <=640, full <=2000)
// ===========================================================================

test('maxDimensionForVariant: returns 640 for thumb, 2000 for full', () => {
  assert.equal(maxDimensionForVariant('thumb'), 640);
  assert.equal(maxDimensionForVariant('full'), 2000);
  assert.throws(() => maxDimensionForVariant('huge'), /Invalid variant/);
});

test('validateManifest: enforces per-variant dimension cap (thumb rejects >640)', () => {
  const records = [rec('mj-001', SHA_A)];
  const mk = (entries) => ({ expectedImages: entries.length, baseDir: '/tmp/x', entries });
  const good = () => mk([
    manifestEntryFor('mj-001', 'full', 'artwork/catalog/mj-001/full.jpg', 'c'.repeat(64)),
    manifestEntryFor('mj-001', 'thumb', 'artwork/catalog/mj-001/thumb.jpg', 'd'.repeat(64))
  ]);
  // Baseline: a valid manifest with thumb 640 passes.
  const okThumb = good();
  okThumb.entries[1] = { ...okThumb.entries[1], width: 640, height: 480 };
  assert.equal(validateManifest(okThumb, records), true);
  // A thumb at 1000px (under the OLD full-only cap of 2000) must now be rejected.
  const bigThumb = good();
  bigThumb.entries[1] = { ...bigThumb.entries[1], width: 1000, height: 800 };
  assert.throws(() => validateManifest(bigThumb, records), /cap 640 for thumb/);
  // A full at 2000 passes; a full at 2001 fails.
  const okFull = good();
  okFull.entries[0] = { ...okFull.entries[0], width: 2000, height: 1500 };
  assert.equal(validateManifest(okFull, records), true);
  const bigFull = good();
  bigFull.entries[0] = { ...bigFull.entries[0], width: 2001, height: 1500 };
  assert.throws(() => validateManifest(bigFull, records), /cap 2000 for full/);
});

// ===========================================================================
// Finding 5: artworks.json readback exact hash/bytes/count verification
// ===========================================================================

test('verifyArtworksReadback: accepts an exact byte-for-byte match', () => {
  const json = '[{"id":"mj-001"}]\n';
  const { sha256 } = { sha256: requireSha(json) };
  const buf = Buffer.from(json, 'utf8');
  assert.equal(
    verifyArtworksReadback(buf, { sha256, size: buf.length, count: 1 }),
    true
  );
});

test('verifyArtworksReadback: rejects size/hash/count mismatch + bad JSON', () => {
  const json = '[{"id":"mj-001"}]\n';
  const buf = Buffer.from(json, 'utf8');
  const goodSha = requireSha(json);
  // Wrong size (truncated).
  assert.throws(
    () => verifyArtworksReadback(buf.slice(0, buf.length - 1), { sha256: goodSha, size: buf.length, count: 1 }),
    /size mismatch/
  );
  // Wrong hash (corrupted byte).
  const corrupt = Buffer.from(json, 'utf8'); corrupt[0] = 32;
  assert.throws(
    () => verifyArtworksReadback(corrupt, { sha256: goodSha, size: corrupt.length, count: 1 }),
    /sha256 mismatch/
  );
  // Wrong count (valid JSON, wrong length).
  const two = Buffer.from('[{"id":"a"},{"id":"b"}]\n', 'utf8');
  assert.throws(
    () => verifyArtworksReadback(two, { sha256: requireSha('[{"id":"a"},{"id":"b"}]\n'), size: two.length, count: 1 }),
    /record count mismatch/
  );
  // Invalid JSON with a matching size/hash of the garbage bytes -> JSON parse error.
  const garbage = Buffer.from('not json at all!!', 'utf8');
  assert.throws(
    () => verifyArtworksReadback(garbage, { sha256: requireShaBytes(garbage), size: garbage.length, count: 1 }),
    /not valid JSON/
  );
  // Bad expected spec.
  assert.throws(() => verifyArtworksReadback(buf, { sha256: 'x', size: 1, count: 1 }), /64-char/);
});

test('buildCanonicalArtworksPayload: now exposes sha256 for readback verification', () => {
  const catalog = JSON.parse(readFileSync(path.join(REPO_ROOT, 'catalog', 'catalog.json'), 'utf8'));
  const { json, size, count, sha256 } = buildCanonicalArtworksPayload(catalog, schema);
  assert.equal(typeof sha256, 'string');
  assert.match(sha256, /^[a-f0-9]{64}$/);
  // The exposed sha256 must match a fresh hash of the exact uploaded bytes.
  assert.equal(sha256, requireSha(json));
  assert.equal(size, Buffer.byteLength(json, 'utf8'));
  // readback of those exact bytes must verify.
  assert.equal(verifyArtworksReadback(Buffer.from(json, 'utf8'), { sha256, size, count }), true);
});

// ===========================================================================
// Finding 2: archive extraction safety (malicious tar entry rejection)
// ===========================================================================

test('isSafeTarPath: accepts clean relative + dirs, rejects unsafe', () => {
  assert.equal(isSafeTarPath('originals/MJ-001.jpg'), true);
  assert.equal(isSafeTarPath('originals/'), true); // dir entry (trailing slash)
  assert.equal(isSafeTarPath('./originals/MJ-001.jpg'), true); // '.' root is harmless
  assert.equal(isSafeTarPath('./'), true); // tar's root dir marker
  assert.equal(isSafeTarPath('/etc/passwd'), false); // absolute
  assert.equal(isSafeTarPath('../escape.jpg'), false); // parent traversal
  assert.equal(isSafeTarPath('a/../../b'), false);
  assert.equal(isSafeTarPath(''), false);
  assert.equal(isSafeTarPath('back\\slash'), false);
});

test('validateTarVerboseListing: accepts a clean file+dir listing', () => {
  const clean = [
    'drwxr-xr-x 0/0            0 2026-08-01 00:00 originals/',
    '-rw-r--r-- 0/0         1234 2026-08-01 00:00 originals/MJ-001.jpg'
  ].join('\n');
  assert.equal(validateTarVerboseListing(clean), true);
});

test('validateTarVerboseListing: rejects symlink, hardlink, absolute, traversal', () => {
  const symlinkLine = 'lrwxrwxrwx 0/0            0 2026-08-01 00:00 evil -> /etc/passwd';
  assert.throws(() => validateTarVerboseListing(symlinkLine), /symlink/);
  const hardLine = 'hrw-r--r-- 0/0            0 2026-08-01 00:00 hl link to sub/orig.txt';
  assert.throws(() => validateTarVerboseListing(hardLine), /hardlink/);
  const absLine = '-rw-r--r-- 0/0            1 2026-08-01 00:00 /etc/shadow';
  assert.throws(() => validateTarVerboseListing(absLine), /unsafe path/);
  const travLine = '-rw-r--r-- 0/0            1 2026-08-01 00:00 ../escape.jpg';
  assert.throws(() => validateTarVerboseListing(travLine), /unsafe path/);
  assert.throws(() => validateTarVerboseListing('garbage not a tar line'), /unparseable/);
  assert.throws(() => validateTarVerboseListing('\n\n'), /no entries/);
});

// Real-tar integration: craft a genuinely malicious archive and confirm the
// validator rejects its verbose listing (requires GNU tar).
function hasTar() {
  try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

test('validateTarVerboseListing: rejects a real crafted malicious tar (symlink + hardlink + traversal)', { skip: !hasTar() ? 'requires GNU tar' : false }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mj-art-tarsafety-'));
  try {
    execFileSync('sh', ['-c', [
      `cd "${dir}"`,
      'mkdir -p sub',
      'printf data > sub/orig.txt',
      'ln sub/orig.txt sub/hl.txt 2>/dev/null || true',
      'ln -s /etc/passwd evil-link',
      'printf payload > real.txt',
      'tar -czf malicious.tar.gz sub/orig.txt sub/hl.txt evil-link real.txt',
      'tar -czf trav.tar.gz --transform "s,^,../," real.txt 2>/dev/null'
    ].join(' && ')], { stdio: 'pipe' });
    const malicious = execFileSync('tar', ['-tvzf', path.join(dir, 'malicious.tar.gz')], { encoding: 'utf8' });
    assert.throws(() => validateTarVerboseListing(malicious), /symlink|hardlink/);
    const trav = execFileSync('tar', ['-tvzf', path.join(dir, 'trav.tar.gz')], { encoding: 'utf8' });
    assert.throws(() => validateTarVerboseListing(trav), /unsafe path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// Finding 1: no raw ${{ inputs.* }} inside run: scripts (static guard helper)
// ===========================================================================

test('findInputsInRunBlocks: flags input interpolation in run scripts only', () => {
  // Block run with input interpolation -> flagged.
  const bad = [
    'steps:',
    '  - name: x',
    '    env:',
    '      FOO: ${{ inputs.foo }}',
    '    run: |',
    '      curl "${{ inputs.url }}"',
    '      echo done'
  ].join('\n');
  const badHits = findInputsInRunBlocks(bad);
  assert.equal(badHits.length, 1, 'only the run-script line should be flagged');
  assert.match(badHits[0].text, /\$\{\{\s*inputs\.url/);

  // env:/if:/with: interpolation is allowed; clean run script -> no hits.
  const good = [
    'steps:',
    '  - name: x',
    '    if: ${{ inputs.execute_upload == true }}',
    '    env:',
    '      URL: ${{ inputs.assets_archive_url }}',
    '    run: |',
    '      set -euo pipefail',
    '      curl "${URL}"'
  ].join('\n');
  assert.deepEqual(findInputsInRunBlocks(good), []);

  // Inline run with interpolation -> flagged.
  const inlineBad = '    run: echo "${{ inputs.evil }}"';
  assert.equal(findInputsInRunBlocks(inlineBad).length, 1);
  const inlineGood = '    run: echo "${URL}"';
  assert.deepEqual(findInputsInRunBlocks(inlineGood), []);
});

test('catalog-import.yml workflow has NO raw ${{ inputs.* }} in any run script', () => {
  const wf = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'catalog-import.yml'), 'utf8');
  const hits = findInputsInRunBlocks(wf);
  assert.deepEqual(hits, [], 'run scripts must not interpolate inputs; offending: ' + JSON.stringify(hits));
});

// small helper: sha256 of a utf8 string (test-local)
function requireSha(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}
function requireShaBytes(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ===========================================================================
// VPS private masters: version validator, basename builder, master-root guard
// ===========================================================================

test('MASTER_VERSION_RE: accepts safe tokens, rejects injection shapes', () => {
  assert.match('2026-08-01', MASTER_VERSION_RE);
  assert.match('v1.2-3', MASTER_VERSION_RE);
  assert.match('a', MASTER_VERSION_RE);
  assert.match('A'.repeat(64), MASTER_VERSION_RE);
  // Rejects: slash (path), space, control, shell metacharacters, empty, too long.
  assert.doesNotMatch('a/b', MASTER_VERSION_RE);
  assert.doesNotMatch('a b', MASTER_VERSION_RE);
  assert.doesNotMatch('a;b', MASTER_VERSION_RE);
  assert.doesNotMatch('$(x)', MASTER_VERSION_RE);
  assert.doesNotMatch('a\nb', MASTER_VERSION_RE);
  assert.doesNotMatch('', MASTER_VERSION_RE);
  assert.doesNotMatch('A'.repeat(65), MASTER_VERSION_RE);
});

test('validateMasterVersion: throws on invalid, silent on valid', () => {
  assert.doesNotThrow(() => validateMasterVersion('2026-08-01'));
  assert.throws(() => validateMasterVersion('a/b'), /Invalid master archive version/);
  assert.throws(() => validateMasterVersion(''), /Invalid master archive version/);
  assert.throws(() => validateMasterVersion(undefined), /Invalid master archive version/);
});

test('masterArchiveBasename / masterSidecarBasename: exact version-derived names', () => {
  assert.equal(masterArchiveBasename('2026-08-01'), 'mj-art-master-2026-08-01.tar.gz');
  assert.equal(masterSidecarBasename('2026-08-01'), 'mj-art-master-2026-08-01.sha256');
  // No path separators or metacharacters can sneak in via the version.
  assert.throws(() => masterArchiveBasename('../x'), /Invalid master archive version/);
  assert.throws(() => masterSidecarBasename('a b'), /Invalid master archive version/);
});

// ---- isSafeVpsMasterRoot / validateVpsMasterRoot --------------------------------
test('isSafeVpsMasterRoot: accepts absolute POSIX paths, rejects unsafe shapes', () => {
  assert.equal(isSafeVpsMasterRoot('/srv/mj-art/masters'), true);
  assert.equal(isSafeVpsMasterRoot('/home/mjart-1.0/masters'), true);
  assert.equal(isSafeVpsMasterRoot('/'), true);
  // Rejects: relative, control char, whitespace, traversal, backslash, metachar.
  assert.equal(isSafeVpsMasterRoot('srv/masters'), false);
  assert.equal(isSafeVpsMasterRoot('/srv/../etc'), false);
  assert.equal(isSafeVpsMasterRoot('/srv x'), false);
  assert.equal(isSafeVpsMasterRoot('/srv\nx'), false);
  assert.equal(isSafeVpsMasterRoot('/srv;x'), false);
  assert.equal(isSafeVpsMasterRoot('/srv$(x)'), false);
  assert.equal(isSafeVpsMasterRoot('/a:b'), false);
  assert.equal(isSafeVpsMasterRoot('/a\\b'), false);
  assert.equal(isSafeVpsMasterRoot(''), false);
  assert.equal(isSafeVpsMasterRoot(undefined), false);
});

test('validateVpsMasterRoot: throws on invalid', () => {
  assert.doesNotThrow(() => validateVpsMasterRoot('/srv/masters'));
  assert.throws(() => validateVpsMasterRoot('relative'), /Invalid VPS_MASTER_ROOT/);
});

test('validateVpsHost/Port/User: strict shape gates', () => {
  assert.doesNotThrow(() => validateVpsHost('master.example.com'));
  assert.doesNotThrow(() => validateVpsHost('10.0.0.1'));
  assert.throws(() => validateVpsHost('host name'), /Invalid VPS_HOST/);
  assert.throws(() => validateVpsHost('ssh://x'), /Invalid VPS_HOST/);
  assert.doesNotThrow(() => validateVpsPort('22'));
  assert.doesNotThrow(() => validateVpsPort(65535));
  assert.throws(() => validateVpsPort('0'), /Invalid VPS_PORT/);
  assert.throws(() => validateVpsPort('99999'), /Invalid VPS_PORT/);
  assert.throws(() => validateVpsPort('abc'), /Invalid VPS_PORT/);
  assert.doesNotThrow(() => validateVpsUser('mjart'));
  assert.doesNotThrow(() => validateVpsUser('mj-art.deploy'));
  assert.throws(() => validateVpsUser('bad name'), /Invalid VPS_USER/);
  assert.throws(() => validateVpsUser('a;b'), /Invalid VPS_USER/);
});

// ---- parseMasterSidecar -------------------------------------------------------
test('parseMasterSidecar: accepts the exact two-space basename form', () => {
  const sha = 'a'.repeat(64);
  const base = 'mj-art-master-2026-08-01.tar.gz';
  assert.equal(parseMasterSidecar(`${sha}  ${base}\n`, base), sha);
  // No trailing newline is fine.
  assert.equal(parseMasterSidecar(`${sha}  ${base}`, base), sha);
});

test('parseMasterSidecar: rejects empty, multiple records, bare hash, single-space, control, wrong/unsafe basename', () => {
  const sha = 'a'.repeat(64);
  const base = 'mj-art-master-2026-08-01.tar.gz';
  assert.throws(() => parseMasterSidecar('', base), /empty/);
  assert.throws(() => parseMasterSidecar('\n\n', base), /empty/);
  assert.throws(() => parseMasterSidecar(`${sha}  ${base}\n${sha}  ${base}\n`, base), /exactly one record/);
  // Bare hash (no basename) is rejected: basename is required.
  assert.throws(() => parseMasterSidecar(`${sha}\n`, base), /malformed/);
  // Single-space form is rejected (must be two-space GNU coreutils form).
  assert.throws(() => parseMasterSidecar(`${sha} ${base}\n`, base), /malformed/);
  // Wrong basename (arbitrary path) is rejected.
  assert.throws(() => parseMasterSidecar(`${sha}  /etc/passwd\n`, base), /does not match/);
  assert.throws(() => parseMasterSidecar(`${sha}  other.tar.gz\n`, base), /does not match/);
  // A basename that tries to traverse is rejected via the exact match.
  assert.throws(() => parseMasterSidecar(`${sha}  ../${base}\n`, base), /does not match/);
  // Control character in text.
  assert.throws(() => parseMasterSidecar(`${sha}  ${base}\x00`, base), /control character/);
  // Bad expected basename.
  assert.throws(() => parseMasterSidecar(`${sha}  ${base}\n`, ''), /non-empty/);
});

// ---- findSecretsInRunBlocks ---------------------------------------------------
test('findSecretsInRunBlocks: flags secret interpolation in run scripts only', () => {
  const bad = [
    'steps:',
    '  - name: x',
    '    env:',
    '      KEY: ${{ secrets.VPS_SSH_PRIVATE_KEY }}',
    '    run: |',
    '      echo "${{ secrets.VPS_KNOWN_HOSTS }}"'
  ].join('\n');
  const badHits = findSecretsInRunBlocks(bad);
  assert.equal(badHits.length, 1, 'only the run-script line should be flagged');
  assert.match(badHits[0].text, /\$\{\{\s*secrets\.VPS_KNOWN_HOSTS/);

  // env: interpolation of a secret is allowed; clean run script -> no hits.
  const good = [
    'steps:',
    '  - name: x',
    '    env:',
    '      KEY: ${{ secrets.VPS_SSH_PRIVATE_KEY }}',
    '    run: |',
    '      set -euo pipefail',
    '      printf "%s" "${KEY}" > file'
  ].join('\n');
  assert.deepEqual(findSecretsInRunBlocks(good), []);
});

test('catalog-import.yml workflow has NO raw ${{ secrets.* }} in any run script', () => {
  const wf = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'catalog-import.yml'), 'utf8');
  const hits = findSecretsInRunBlocks(wf);
  assert.deepEqual(hits, [], 'run scripts must not interpolate secrets; offending: ' + JSON.stringify(hits));
});
