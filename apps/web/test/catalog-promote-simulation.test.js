import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  createHash,
  randomBytes
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
  readdirSync,
  statSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '../src/artwork-schema.js';
import {
  ARTWORKS_JSON_KEY,
  DESTINATION_BUCKET,
  EXPECTED_IMAGES,
  PROMOTION_CONFIRM_PHRASE,
  SOURCE_BUCKET,
  buildReleaseManifest,
  extractBackupBucket,
  inventoryFingerprint,
  serializeReleaseManifest
} from '../../../scripts/lib/release-manifest-core.mjs';
import {
  buildRequiredKeys,
  buildCanonicalArtworksPayload
} from '../../../scripts/lib/catalog-import-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PROMOTE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'promote-catalog-production.mjs');
const CATALOG = JSON.parse(readFileSync(path.join(REPO_ROOT, 'catalog', 'catalog.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Fake wrangler: a fast bash script that simulates `r2 object get|put` against
// temp "bucket" directories selected by env. No network, no shell-from-args.
// ---------------------------------------------------------------------------

function writeFakeWrangler(dir) {
  const p = path.join(dir, 'fake-wrangler.sh');
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'mode=""; target=""; file=""; prev=""',
    'for a in "$@"; do',
    '  if [ "$a" = "get" ] || [ "$a" = "put" ]; then mode="$a"; fi',
    '  if [ "$prev" = "--file" ]; then file="$a"; fi',
    '  prev="$a"',
    'done',
    'for a in "$@"; do',
    '  case "$a" in',
    '    mj-art-images-preview/*|mj-art-images/*) target="$a"; break ;;',
    '  esac',
    'done',
    'if [ -z "$mode" ] || [ -z "$target" ] || [ -z "$file" ]; then',
    '  echo "fake-wrangler: could not parse mode/target/file" >&2; exit 2',
    'fi',
    'bucket="${target%%/*}"',
    'key="${target#*/}"',
    'case "$bucket" in',
    '  mj-art-images-preview) bdir="$FAKE_PREVIEW_DIR" ;;',
    '  mj-art-images) bdir="$FAKE_PRODUCTION_DIR" ;;',
    '  *) echo "fake-wrangler: unknown bucket: $bucket" >&2; exit 2 ;;',
    'esac',
    'body="$bdir/$key"',
    'if [ "$mode" = "get" ]; then',
    '  if [ ! -f "$body" ]; then echo "fake-wrangler: object not found: $target" >&2; exit 3; fi',
    '  mkdir -p "$(dirname "$file")"',
    '  cp "$body" "$file"',
    'elif [ "$mode" = "put" ]; then',
    '  mkdir -p "$(dirname "$body")"',
    '  cp "$file" "$body"',
    'fi'
  ];
  writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  chmodSync(p, 0o755);
  return p;
}

// Deterministic body for a key -> { bytes: Buffer, sha256, size }.
function bodyFor(key, salt) {
  const seed = createHash('sha256').update(salt + '\0' + key).digest();
  const len = 200 + (seed[0] % 400); // 200..599 bytes
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = seed[i % seed.length];
  return { buf, sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length };
}

function shaHex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Build the full scenario: preview bodies (173), release manifest, backup
// manifest template. Returns everything the per-test runners need.
function buildScenario(root) {
  const previewDir = path.join(root, 'buckets', 'preview');
  const prodDir = path.join(root, 'buckets', 'production');
  mkdirSync(previewDir, { recursive: true });
  mkdirSync(prodDir, { recursive: true });

  // Canonical artworks.json (real hash so validateReleaseManifest cross-check passes).
  const payload = buildCanonicalArtworksPayload(CATALOG, schema);
  const awBody = Buffer.from(payload.json, 'utf8');

  const imageKeys = [...buildRequiredKeys(CATALOG)].sort();
  const records = [];
  // preview bodies
  for (const key of imageKeys) {
    const b = bodyFor(key, 'preview-image');
    const dest = path.join(previewDir, key);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, b.buf);
    records.push({ rawKey: key, size: b.size, sha256: b.sha256, downloaded: true });
  }
  writeFileSync(path.join(previewDir, ARTWORKS_JSON_KEY), awBody);
  records.push({ rawKey: ARTWORKS_JSON_KEY, size: awBody.length, sha256: payload.sha256, downloaded: true });

  const release = buildReleaseManifest(records, {
    contentCommit: 'e52fc7f00234fc7e1741087ea046cec0f2175cfb',
    verifiedByBackupSnapshot: 'sim-snapshot',
    backupRecordedCommit: '97a11c2ae5d224bf5c6b96d0a65629fb0f0691d3'
  });
  const releasePath = path.join(root, 'release-manifest.json');
  writeFileSync(releasePath, serializeReleaseManifest(release), 'utf8');

  // Legacy production bodies: 18 legacy images + a legacy artworks.json.
  const legacyKeys = [];
  for (let i = 0; i < 18; i++) {
    const key = `artwork/legacy-${i}.jpg`;
    legacyKeys.push(key);
  }
  function seedProduction() {
    rmSync(prodDir, { recursive: true, force: true });
    mkdirSync(prodDir, { recursive: true });
    const prodObjects = [];
    for (const key of legacyKeys) {
      const b = bodyFor(key, 'legacy');
      const dest = path.join(prodDir, key);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, b.buf);
      prodObjects.push({ rawKey: key, size: b.size, sha256: b.sha256, downloaded: true });
    }
    // legacy artworks.json (distinct from the canonical one)
    const legacyAw = Buffer.from(JSON.stringify([{ id: 'legacy', title: 'old' }]) + '\n', 'utf8');
    writeFileSync(path.join(prodDir, ARTWORKS_JSON_KEY), legacyAw);
    prodObjects.push({ rawKey: ARTWORKS_JSON_KEY, size: legacyAw.length, sha256: shaHex(legacyAw), downloaded: true });
    return prodObjects;
  }

  function backupManifest(prodObjects, expectedProdCount) {
    return {
      buckets: [
        { name: DESTINATION_BUCKET, objectCount: expectedProdCount, objects: prodObjects },
        { name: SOURCE_BUCKET, objectCount: records.length, objects: records.map((r) => ({ ...r })) }
      ]
    };
  }

  return {
    previewDir, prodDir, releasePath, release, records,
    legacyKeys, seedProduction, backupManifest,
    canonicalAwSha: payload.sha256, canonicalAwSize: payload.size
  };
}

function runPromote(args, envExtra, opts = {}) {
  const env = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: 'fake-token',
    CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
    ...envExtra
  };
  const res = spawnSync(process.execPath, [PROMOTE_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: opts.timeout || 120000
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// List all keys under a bucket dir (relative to the bucket root).
function listKeys(bucketDir) {
  const out = [];
  function walk(d, rel) {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full, rel ? rel + '/' + name : name);
      else out.push(rel ? rel + '/' + name : name);
    }
  }
  walk(bucketDir, '');
  return out.sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let ROOT, SCN, FAKE_WRANGLER, BACKUP_PATH, PROD_FINGERPRINT;

test('simulation setup', () => {
  ROOT = mkdtempSync(path.join(os.tmpdir(), 'mj-promote-sim-'));
  FAKE_WRANGLER = writeFakeWrangler(ROOT);
  SCN = buildScenario(ROOT);
  const prodObjects = SCN.seedProduction();
  const bm = SCN.backupManifest(prodObjects, prodObjects.length);
  BACKUP_PATH = path.join(ROOT, 'backup-manifest.json');
  writeFileSync(BACKUP_PATH, JSON.stringify(bm), 'utf8');
  // Canonical content-exact fingerprint of the deterministic 19-object legacy
  // production inventory. Promotion runs must reproduce it exactly.
  PROD_FINGERPRINT = inventoryFingerprint(extractBackupBucket(bm, DESTINATION_BUCKET)).sha256;
  assert.equal(SCN.records.length, EXPECTED_IMAGES + 1);
  assert.equal(prodObjects.length, 19);
  assert.match(PROD_FINGERPRINT, /^[0-9a-f]{64}$/);
});

test('dry-run validates and plans without writing to production', () => {
  SCN.seedProduction();
  const r = runPromote([
    '--release-manifest', SCN.releasePath,
    '--backup-manifest', BACKUP_PATH,
    '--expected-production-count', '19',
    '--expected-production-fingerprint', PROD_FINGERPRINT,
    '--wrangler', FAKE_WRANGLER
  ], { FAKE_PREVIEW_DIR: SCN.previewDir, FAKE_PRODUCTION_DIR: SCN.prodDir });
  assert.equal(r.code, 0, 'dry-run should succeed: ' + r.stderr);
  assert.match(r.stdout, /DRY-RUN/);
  // production untouched: still 18 legacy + legacy artworks.json
  const keys = listKeys(SCN.prodDir);
  assert.equal(keys.length, 19);
  assert.ok(!keys.some((k) => k.startsWith('artwork/catalog/')));
});

test('execute promotes: 172 images + artworks.json, legacy retained (no deletes)', () => {
  SCN.seedProduction();
  const r = runPromote([
    '--release-manifest', SCN.releasePath,
    '--backup-manifest', BACKUP_PATH,
    '--expected-production-count', '19',
    '--expected-production-fingerprint', PROD_FINGERPRINT,
    '--execute',
    '--confirm', PROMOTION_CONFIRM_PHRASE,
    '--wrangler', FAKE_WRANGLER
  ], { FAKE_PREVIEW_DIR: SCN.previewDir, FAKE_PRODUCTION_DIR: SCN.prodDir });
  assert.equal(r.code, 0, 'execute should succeed: ' + r.stderr);
  assert.match(r.stdout, /PRODUCTION promotion complete/);

  const keys = listKeys(SCN.prodDir);
  // 18 legacy images + 172 canonical images + artworks.json = 191
  assert.equal(keys.length, 18 + EXPECTED_IMAGES + 1);
  // every legacy image retained
  for (const lk of SCN.legacyKeys) assert.ok(keys.includes(lk), `legacy missing: ${lk}`);
  // every canonical image present
  for (const r2 of SCN.release.expectedObjects) {
    if (r2.key !== ARTWORKS_JSON_KEY) assert.ok(keys.includes(r2.key), `canonical image missing: ${r2.key}`);
  }
  // artworks.json is the NEW canonical one
  const aw = readFileSync(path.join(SCN.prodDir, ARTWORKS_JSON_KEY));
  assert.equal(shaHex(aw), SCN.canonicalAwSha);
  assert.equal(aw.length, SCN.canonicalAwSize);
});

test('backup-handshake gate: wrong production count -> fail closed before writes', () => {
  SCN.seedProduction();
  const r = runPromote([
    '--release-manifest', SCN.releasePath,
    '--backup-manifest', BACKUP_PATH,
    '--expected-production-count', '18', // drift
    '--expected-production-fingerprint', PROD_FINGERPRINT,
    '--execute',
    '--confirm', PROMOTION_CONFIRM_PHRASE,
    '--wrangler', FAKE_WRANGLER
  ], { FAKE_PREVIEW_DIR: SCN.previewDir, FAKE_PRODUCTION_DIR: SCN.prodDir });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /drift guard|handshake/i);
  // production untouched
  const keys = listKeys(SCN.prodDir);
  assert.equal(keys.length, 19);
  assert.ok(!keys.some((k) => k.startsWith('artwork/catalog/')));
});

test('content-exact guard: same-count byte drift (changed sha256) -> fail closed before writes', () => {
  SCN.seedProduction();
  // Simulate a fresh backup that caught a byte-level production change: the
  // count is still 19, but one object's sha256 differs. The handshake must fail
  // on the fingerprint, NOT pass on the count.
  const bm = JSON.parse(readFileSync(BACKUP_PATH, 'utf8'));
  const prodBucket = bm.buckets.find((b) => b.name === DESTINATION_BUCKET);
  prodBucket.objects[0].sha256 = '0'.repeat(63) + '1';
  const driftedPath = path.join(ROOT, 'backup-drifted-byte.json');
  writeFileSync(driftedPath, JSON.stringify(bm), 'utf8');
  const r = runPromote([
    '--release-manifest', SCN.releasePath,
    '--backup-manifest', driftedPath,
    '--expected-production-count', '19',
    '--expected-production-fingerprint', PROD_FINGERPRINT,
    '--execute',
    '--confirm', PROMOTION_CONFIRM_PHRASE,
    '--wrangler', FAKE_WRANGLER
  ], { FAKE_PREVIEW_DIR: SCN.previewDir, FAKE_PRODUCTION_DIR: SCN.prodDir });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /fingerprint mismatch|content drift/i);
  // production untouched
  const keys = listKeys(SCN.prodDir);
  assert.equal(keys.length, 19);
  assert.ok(!keys.some((k) => k.startsWith('artwork/catalog/')));
});

test('content-exact guard: same-count key drift (renamed key) -> fail closed before writes', () => {
  SCN.seedProduction();
  // Simulate a fresh backup that caught a renamed production object: the count
  // is still 19 and sizes/shas are unchanged, but one key differs.
  const bm = JSON.parse(readFileSync(BACKUP_PATH, 'utf8'));
  const prodBucket = bm.buckets.find((b) => b.name === DESTINATION_BUCKET);
  prodBucket.objects[0].rawKey = 'artwork/legacy-RENAMED-0.jpg';
  const driftedPath = path.join(ROOT, 'backup-drifted-key.json');
  writeFileSync(driftedPath, JSON.stringify(bm), 'utf8');
  const r = runPromote([
    '--release-manifest', SCN.releasePath,
    '--backup-manifest', driftedPath,
    '--expected-production-count', '19',
    '--expected-production-fingerprint', PROD_FINGERPRINT,
    '--execute',
    '--confirm', PROMOTION_CONFIRM_PHRASE,
    '--wrangler', FAKE_WRANGLER
  ], { FAKE_PREVIEW_DIR: SCN.previewDir, FAKE_PRODUCTION_DIR: SCN.prodDir });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /fingerprint mismatch|content drift/i);
  // production untouched
  const keys = listKeys(SCN.prodDir);
  assert.equal(keys.length, 19);
  assert.ok(!keys.some((k) => k.startsWith('artwork/catalog/')));
});

test('content-exact guard: malformed expected fingerprint -> fail closed', () => {
  SCN.seedProduction();
  const r = runPromote([
    '--release-manifest', SCN.releasePath,
    '--backup-manifest', BACKUP_PATH,
    '--expected-production-count', '19',
    '--expected-production-fingerprint', 'not-hex',
    '--execute',
    '--confirm', PROMOTION_CONFIRM_PHRASE,
    '--wrangler', FAKE_WRANGLER
  ], { FAKE_PREVIEW_DIR: SCN.previewDir, FAKE_PRODUCTION_DIR: SCN.prodDir });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /64 lowercase hex/i);
  // production untouched
  const keys = listKeys(SCN.prodDir);
  assert.equal(keys.length, 19);
});

test('missing backup manifest -> fail closed', () => {
  SCN.seedProduction();
  const r = runPromote([
    '--release-manifest', SCN.releasePath,
    '--backup-manifest', path.join(ROOT, 'does-not-exist.json'),
    '--expected-production-count', '19',
    '--expected-production-fingerprint', PROD_FINGERPRINT,
    '--execute',
    '--confirm', PROMOTION_CONFIRM_PHRASE,
    '--wrangler', FAKE_WRANGLER
  ], { FAKE_PREVIEW_DIR: SCN.previewDir, FAKE_PRODUCTION_DIR: SCN.prodDir });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /backup manifest not found/i);
});

test('hash mismatch in a preview object -> fail before any production write', () => {
  SCN.seedProduction();
  // corrupt one preview image body so its downloaded sha mismatches the manifest
  const oneImageKey = SCN.release.expectedObjects.find((e) => e.key !== ARTWORKS_JSON_KEY).key;
  const victim = path.join(SCN.previewDir, oneImageKey);
  const original = readFileSync(victim);
  try {
    writeFileSync(victim, Buffer.concat([original, Buffer.from('CORRUPT')]));
    const r = runPromote([
      '--release-manifest', SCN.releasePath,
      '--backup-manifest', BACKUP_PATH,
      '--expected-production-count', '19',
      '--expected-production-fingerprint', PROD_FINGERPRINT,
      '--execute',
      '--confirm', PROMOTION_CONFIRM_PHRASE,
      '--wrangler', FAKE_WRANGLER
    ], { FAKE_PREVIEW_DIR: SCN.previewDir, FAKE_PRODUCTION_DIR: SCN.prodDir });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /mismatch/i);
    // production untouched: no canonical images, legacy artworks.json intact
    const keys = listKeys(SCN.prodDir);
    assert.equal(keys.length, 19);
    assert.ok(!keys.some((k) => k.startsWith('artwork/catalog/')));
  } finally {
    // restore the preview body so subsequent tests see a clean preview bucket
    writeFileSync(victim, original);
  }
});

test('rollback-safe: failure mid-image-upload leaves legacy artworks.json live', () => {
  // Seed production fresh. Simulate a put failure after 10 image uploads by
  // counting puts via a state dir the fake wrangler reads.
  const stateDir = path.join(ROOT, 'fail-state');
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'put_count'), '0');
  SCN.seedProduction();
  const beforeKeys = listKeys(SCN.prodDir);
  const beforeAw = readFileSync(path.join(SCN.prodDir, ARTWORKS_JSON_KEY));

  // Rewrite the fake wrangler to count via the state file and fail after N puts.
  const failingWrangler = path.join(ROOT, 'fake-wrangler-fail.sh');
  const flines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'mode=""; target=""; file=""; prev=""',
    'for a in "$@"; do',
    '  if [ "$a" = "get" ] || [ "$a" = "put" ]; then mode="$a"; fi',
    '  if [ "$prev" = "--file" ]; then file="$a"; fi',
    '  prev="$a"',
    'done',
    'for a in "$@"; do',
    '  case "$a" in mj-art-images-preview/*|mj-art-images/*) target="$a"; break ;; esac',
    'done',
    'bucket="${target%%/*}"; key="${target#*/}"',
    'case "$bucket" in',
    '  mj-art-images-preview) bdir="$FAKE_PREVIEW_DIR" ;;',
    '  mj-art-images) bdir="$FAKE_PRODUCTION_DIR" ;;',
    '  *) exit 2 ;;',
    'esac',
    'body="$bdir/$key"',
    'if [ "$mode" = "get" ]; then',
    '  [ -f "$body" ] || exit 3',
    '  mkdir -p "$(dirname "$file")"; cp "$body" "$file"',
    'elif [ "$mode" = "put" ]; then',
    '  n="$(cat "$FAKE_STATE_DIR/put_count" 2>/dev/null || echo 0)"',
    '  n=$((n+1))',
    '  echo "$n" > "$FAKE_STATE_DIR/put_count"',
    '  if [ -n "$FAKE_FAIL_AFTER" ] && [ "$n" -gt "$FAKE_FAIL_AFTER" ]; then exit 5; fi',
    '  mkdir -p "$(dirname "$body")"; cp "$file" "$body"',
    'fi'
  ];
  writeFileSync(failingWrangler, flines.join('\n') + '\n', 'utf8');
  chmodSync(failingWrangler, 0o755);

  const r = runPromote([
    '--release-manifest', SCN.releasePath,
    '--backup-manifest', BACKUP_PATH,
    '--expected-production-count', '19',
    '--expected-production-fingerprint', PROD_FINGERPRINT,
    '--execute',
    '--confirm', PROMOTION_CONFIRM_PHRASE,
    '--wrangler', failingWrangler
  ], {
    FAKE_PREVIEW_DIR: SCN.previewDir,
    FAKE_PRODUCTION_DIR: SCN.prodDir,
    FAKE_STATE_DIR: stateDir,
    FAKE_FAIL_AFTER: '10'
  });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /simulated put failure|exited 5/i);

  // artworks.json must still be the LEGACY one (metadata cutover is last).
  const afterAw = readFileSync(path.join(SCN.prodDir, ARTWORKS_JSON_KEY));
  assert.deepEqual(Buffer.from(afterAw), Buffer.from(beforeAw), 'artworks.json must NOT have been cut over');

  // Some images may have uploaded (<=10) but legacy objects are all retained.
  const afterKeys = listKeys(SCN.prodDir);
  for (const lk of SCN.legacyKeys) assert.ok(afterKeys.includes(lk), `legacy deleted: ${lk}`);
  // No delete happened: every pre-existing key still present.
  for (const k of beforeKeys) assert.ok(afterKeys.includes(k), `pre-existing key deleted: ${k}`);
});

test('wrong confirmation phrase -> execute fails before writes', () => {
  SCN.seedProduction();
  const r = runPromote([
    '--release-manifest', SCN.releasePath,
    '--backup-manifest', BACKUP_PATH,
    '--expected-production-count', '19',
    '--expected-production-fingerprint', PROD_FINGERPRINT,
    '--execute',
    '--confirm', 'WRONG-PHRASE',
    '--wrangler', FAKE_WRANGLER
  ], { FAKE_PREVIEW_DIR: SCN.previewDir, FAKE_PRODUCTION_DIR: SCN.prodDir });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /exact promotion phrase/i);
  const keys = listKeys(SCN.prodDir);
  assert.equal(keys.length, 19);
});

test('cleanup simulation temp', () => {
  rmSync(ROOT, { recursive: true, force: true });
  assert.ok(true);
});
