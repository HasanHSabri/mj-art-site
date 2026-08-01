// Pure, dependency-free helpers shared by the catalogue-derivative generator,
// the preview-only import client, and their unit tests.
//
// Nothing here performs network I/O, filesystem mutation, or process launching.
// Every function is deterministic and safe to unit-test in isolation. The two
// CLI scripts (generate-catalog-derivatives.mjs, import-catalog-preview.mjs)
// compose these helpers with the impure parts (ImageMagick, wrangler, the FS).

export const EXPECTED_RECORDS = 86;
export const EXPECTED_IMAGES = 172; // 86 records * 2 derivatives

// Preview is the ONLY bucket this workflow may ever write to. The production
// bucket name is intentionally never spelled out as an allowed target anywhere
// in this module; assertPreviewBucket accepts the preview literal exclusively.
export const PREVIEW_BUCKET = 'mj-art-images-preview';

// Runtime artworks.json ceiling (mirrors apps/web/src/artwork-schema.js).
export const MAX_ARTWORKS_JSON_BYTES = 2 * 1024 * 1024;

// Derivative geometry. Parity with the browser reference in
// apps/web/public/admin.js (FULL_MAX_DIMENSION=2000 q0.9, THUMB=640 q0.85).
export const FULL_MAX_DIMENSION = 2000;
export const FULL_QUALITY = 90;
export const THUMB_MAX_DIMENSION = 640;
export const THUMB_QUALITY = 85;

export const ARTWORKS_JSON_KEY = 'artworks.json';

export const SHA256_RE = /^[a-f0-9]{64}$/;
export const ID_RE = /^[a-z]+-\d{3}$/;
// Canonical R2 object key shape for a served catalog derivative. Mirrors
// SERVED_IMAGE_KEY_RE in apps/web/src/worker.js.
export const OBJECT_KEY_RE = /^artwork\/catalog\/(mj|misc)-\d{3}\/(full|thumb)\.jpg$/;
export const HTTPS_URL_RE = /^https:\/\/[^\s'"]+$/i;
// Conservative R2 bucket name shape (lowercase, digits, hyphens).
export const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

// Minimal, strict --flag parser. `booleanFlags` marks flags that take no value.
// Rejects unknown positionals, missing values, and values that look like flags.
export function parseArgs(argv, booleanFlags = new Set()) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${a}`);
    }
    const key = a.slice(2);
    if (!key) throw new Error('Empty flag "--" is not allowed');
    if (booleanFlags.has(key)) {
      out[key] = true;
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    out[key] = val;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SHA256SUMS manifest parsing
// ---------------------------------------------------------------------------

// Parse a GNU coreutils `sha256sum` text into a Map<sha, relativePath>.
// Strict: requires the canonical "<64-hex>  <path>" two-space format, unique
// hashes, and forward-slash relative paths with no absolute/parent traversal.
export function parseSha256Sums(text) {
  if (typeof text !== 'string') throw new Error('SHA256SUMS text must be a string');
  const map = new Map();
  const lines = text.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    if (raw === '') continue;
    const m = raw.match(/^([a-f0-9]{64}) {2}(\S[^\r\n]*)$/);
    if (!m) throw new Error(`SHA256SUMS line ${idx + 1} is malformed`);
    const [, sha, rel] = m;
    const trimmed = rel.trim();
    if (trimmed === '' ) throw new Error(`SHA256SUMS line ${idx + 1} has an empty path`);
    if (trimmed !== rel) throw new Error(`SHA256SUMS line ${idx + 1} path has surrounding whitespace`);
    if (!isSafeRelPath(trimmed)) throw new Error(`SHA256SUMS line ${idx + 1} unsafe path: ${trimmed}`);
    if (map.has(sha)) throw new Error(`Duplicate sha256 in SHA256SUMS: ${sha}`);
    map.set(sha, trimmed);
  }
  return map;
}

// A safe relative path: no leading slash, no backslashes, no '..' segments,
// no NUL/control chars. Allows nested forward-slash subdirs only.
export function isSafeRelPath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
    if (/[\x00-\x1f]/.test(s)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Source resolution (checksum -> relative path)
// ---------------------------------------------------------------------------

// Resolve each record's source file solely from provenance.sha256 against the
// parsed SHA256SUMS map. Fails closed on missing/mismatched sha, on a record
// lacking provenance.sha256, or on two records resolving to the same source.
// Returns Map<id, { id, sourceRelPath, sourceSha }>.
export function buildSourceMap(records, sumsMap) {
  if (!Array.isArray(records)) throw new Error('records must be an array');
  if (!(sumsMap instanceof Map)) throw new Error('sumsMap must be a Map');
  const out = new Map();
  const usedRel = new Set();
  for (const r of records) {
    const id = r && typeof r.id === 'string' ? r.id : '(unknown)';
    const sha = r && r.provenance && r.provenance.sha256;
    if (typeof sha !== 'string' || !SHA256_RE.test(sha)) {
      throw new Error(`[${id}] provenance.sha256 missing or not 64-char hex`);
    }
    if (!sumsMap.has(sha)) {
      throw new Error(`[${id}] source sha ${sha} not present in SHA256SUMS`);
    }
    const rel = sumsMap.get(sha);
    if (usedRel.has(rel)) {
      throw new Error(`[${id}] two records resolve to the same source file: ${rel}`);
    }
    usedRel.add(rel);
    out.set(r.id, { id: r.id, sourceRelPath: rel, sourceSha: sha });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Object keys & URLs
// ---------------------------------------------------------------------------

export function objectKeyFor(id, variant) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new Error(`Invalid record id for object key: ${String(id)}`);
  }
  if (variant !== 'full' && variant !== 'thumb') {
    throw new Error(`Invalid variant (expected full|thumb): ${String(variant)}`);
  }
  return `artwork/catalog/${id}/${variant}.jpg`;
}

// Runtime public image URL for a canonical R2 key. Mirrors worker.js routing.
export function runtimeUrl(key) {
  if (typeof key !== 'string' || !OBJECT_KEY_RE.test(key)) {
    throw new Error(`Refusing to build runtime URL for noncanonical key: ${String(key)}`);
  }
  return `/artwork-uploaded/${key}`;
}

// The complete set of derivative keys a catalogue requires (full+thumb each).
export function buildRequiredKeys(records) {
  const keys = new Set();
  for (const r of records) {
    keys.add(objectKeyFor(r.id, 'full'));
    keys.add(objectKeyFor(r.id, 'thumb'));
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Bucket guards (preview-only)
// ---------------------------------------------------------------------------

// The ONLY accepted value is the exact preview bucket literal. Any other value
// (including the production bucket, or a typo) is rejected. This is the hard
// gate that makes production import impossible from this code path.
export function assertPreviewBucket(name) {
  if (typeof name !== 'string') {
    throw new Error(`Refusing import: bucket must be the preview literal "${PREVIEW_BUCKET}", got non-string`);
  }
  if (!BUCKET_NAME_RE.test(name)) {
    throw new Error(`Refusing import: bucket name is not a valid R2 name: "${name}"`);
  }
  if (name !== PREVIEW_BUCKET) {
    throw new Error(
      `Refusing import: bucket must be exactly "${PREVIEW_BUCKET}" (preview). ` +
      `Got "${name}". Production catalogue import is blocked in this workflow.`
    );
  }
}

// True only for the production bucket literal. Used by tests/policy guards.
export function isProductionBucketName(name) {
  return typeof name === 'string' && name === 'mj-art-images';
}

// ---------------------------------------------------------------------------
// Derivative manifest validation
// ---------------------------------------------------------------------------

// Validate the machine-readable manifest produced by the generator against the
// catalogue records. Confirms: exact entry count, unique canonical keys, every
// required key present, sane dimensions/bytes/hashes, and safe relative paths.
export function validateManifest(manifest, records) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest must be an object');
  }
  if (typeof manifest.baseDir !== 'string' || manifest.baseDir.length === 0) {
    throw new Error('manifest.baseDir must be a non-empty string');
  }
  const entries = manifest.entries;
  if (!Array.isArray(entries)) throw new Error('manifest.entries must be an array');
  if (manifest.expectedImages !== entries.length) {
    throw new Error(`manifest.expectedImages (${manifest.expectedImages}) must equal entries.length (${entries.length})`);
  }
  const required = buildRequiredKeys(records);
  const seen = new Set();
  for (const e of entries) {
    if (!e || typeof e !== 'object') throw new Error('manifest entry must be an object');
    const { key, localRelFile, sha256, width, height, bytes, sourceSha, id, variant } = e;
    if (typeof key !== 'string' || !OBJECT_KEY_RE.test(key)) {
      throw new Error(`manifest entry has invalid key: ${String(key)}`);
    }
    if (seen.has(key)) throw new Error(`manifest duplicate key: ${key}`);
    seen.add(key);
    if (!required.has(key)) {
      throw new Error(`manifest key not required by catalogue: ${key}`);
    }
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      throw new Error(`manifest entry ${key} has invalid id`);
    }
    if (variant !== 'full' && variant !== 'thumb') {
      throw new Error(`manifest entry ${key} has invalid variant`);
    }
    if (typeof localRelFile !== 'string' || !isSafeRelPath(localRelFile)) {
      throw new Error(`manifest entry ${key} has invalid localRelFile`);
    }
    if (localRelFile !== key) {
      throw new Error(`manifest entry ${key} localRelFile must equal key (deterministic staging)`);
    }
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
      throw new Error(`manifest entry ${key} has invalid sha256`);
    }
    if (typeof sourceSha !== 'string' || !SHA256_RE.test(sourceSha)) {
      throw new Error(`manifest entry ${key} has invalid sourceSha`);
    }
    if (!Number.isInteger(width) || width <= 0 || width > FULL_MAX_DIMENSION) {
      throw new Error(`manifest entry ${key} has invalid width ${width}`);
    }
    if (!Number.isInteger(height) || height <= 0 || height > FULL_MAX_DIMENSION) {
      throw new Error(`manifest entry ${key} has invalid height ${height}`);
    }
    if (!Number.isInteger(bytes) || bytes <= 0) {
      throw new Error(`manifest entry ${key} has invalid bytes ${bytes}`);
    }
  }
  for (const k of required) {
    if (!seen.has(k)) throw new Error(`manifest missing required key: ${k}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Catalogue JSON canonicalization for runtime upload
// ---------------------------------------------------------------------------

export function utf8Bytes(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

// Canonical, runtime-ready artworks.json payload: exact canonical field set per
// record (in canonical order), sorted ascending by sortOrder. `schemaFns` is the
// imported artwork-schema module (validateArtworkList, canonicalizeList,
// sortByOrder) so this stays decoupled from the import path. Throws on invalid.
export function buildCanonicalArtworksPayload(records, schemaFns) {
  const { validateArtworkList, canonicalizeList, sortByOrder } = schemaFns;
  const vr = validateArtworkList(records);
  if (!vr.ok) throw new Error(`catalogue fails runtime schema: ${vr.error}`);
  const canonical = canonicalizeList(sortByOrder(records));
  const json = JSON.stringify(canonical, null, 2) + '\n';
  const size = utf8Bytes(json);
  if (size >= MAX_ARTWORKS_JSON_BYTES) {
    throw new Error(
      `canonical artworks.json is ${size} bytes, must be < ${MAX_ARTWORKS_JSON_BYTES} bytes`
    );
  }
  return { json, size, count: canonical.length };
}
