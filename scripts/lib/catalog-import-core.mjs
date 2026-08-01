// Pure, dependency-free helpers shared by the catalogue-derivative generator,
// the preview-only import client, and their unit tests.
//
// Nothing here performs network I/O, filesystem mutation, or process launching.
// Every function is deterministic and safe to unit-test in isolation. The two
// CLI scripts (generate-catalog-derivatives.mjs, import-catalog-preview.mjs)
// compose these helpers with the impure parts (ImageMagick, wrangler, the FS).

import { createHash } from 'node:crypto';

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

// Per-variant dimension cap: thumb is bounded to 640, full to 2000. Used both by
// the generator (post-generation check) and by manifest validation so the cap is
// enforced per variant, not uniformly at the full cap (which would let an
// over-large thumb slip through).
export function maxDimensionForVariant(variant) {
  if (variant === 'full') return FULL_MAX_DIMENSION;
  if (variant === 'thumb') return THUMB_MAX_DIMENSION;
  throw new Error(`Invalid variant (expected full|thumb): ${String(variant)}`);
}

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
// VPS private master-assets library
// ---------------------------------------------------------------------------
//
// Private originals live as a VERSIONED library on a hardened VPS (no Neon).
// The operator builds a deterministic archive `mj-art-master-<version>.tar.gz`
// plus a matching sidecar `mj-art-master-<version>.sha256` under the configured
// VPS_MASTER_ROOT. The catalogue-import workflow fetches both over key-only,
// strict-host-checking SSH/SCP, parses the sidecar safely, re-hashes the
// archive bytes, and only then extracts. Public derivatives + artworks.json are
// R2 (preview) only.

// Strict master archive version: the dispatch input that selects which versioned
// archive to fetch. Conservative, injection-safe token shape (no slashes,
// spaces, control chars, or shell metacharacters).
export const MASTER_VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Hostname / IP shape for the configured VPS host (no scheme, no port, no path).
export const VPS_HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
// TCP port, 1-65535.
export const VPS_PORT_RE = /^([1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/;
// POSIX account name shape (conservative; mirrors adduser NAME_REGEX).
export const VPS_USER_RE = /^[A-Za-z0-9._-]{1,32}$/;

export function validateMasterVersion(version) {
  if (typeof version !== 'string' || !MASTER_VERSION_RE.test(version)) {
    throw new Error(
      `Invalid master archive version: must match [A-Za-z0-9._-]{1,64}, got: ${String(version)}`
    );
  }
}

// The exact remote archive basename for a version (`mj-art-master-<v>.tar.gz`).
// Constructed ONLY from the validated version, so it can never contain a path
// separator, whitespace, or metacharacter.
export function masterArchiveBasename(version) {
  validateMasterVersion(version);
  return `mj-art-master-${version}.tar.gz`;
}

// The exact remote sidecar basename for a version (`mj-art-master-<v>.sha256`).
export function masterSidecarBasename(version) {
  validateMasterVersion(version);
  return `mj-art-master-${version}.sha256`;
}

// Validate the configured VPS_MASTER_ROOT. It is a remote POSIX absolute path
// interpolated into the SCP target spec `user@host:<root>/<basename>`, so it is
// held to a positive allowlist (letters, digits, '/', '_', '-', '.') plus: must
// be absolute, no control chars, no parent traversal. This keeps the configured
// variable safe to interpolate even though it is admin-set (defense in depth).
export function isSafeVpsMasterRoot(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.length > 4096) return false;
  if (!p.startsWith('/')) return false;
  if (/[\x00-\x1f]/.test(p)) return false;
  if (!/^[A-Za-z0-9/_.-]+$/.test(p)) return false;
  for (const s of p.split('/')) {
    if (s === '..') return false;
  }
  return true;
}

export function validateVpsMasterRoot(p) {
  if (!isSafeVpsMasterRoot(p)) {
    throw new Error(`Invalid VPS_MASTER_ROOT: must be an absolute POSIX path of [A-Za-z0-9/_.-] with no parent traversal, got shape rejected`);
  }
}

export function validateVpsHost(host) {
  if (typeof host !== 'string' || !VPS_HOST_RE.test(host)) {
    throw new Error('Invalid VPS_HOST: must be a hostname or IP');
  }
}
export function validateVpsPort(port) {
  const s = typeof port === 'number' ? String(port) : port;
  if (typeof s !== 'string' || !VPS_PORT_RE.test(s)) {
    throw new Error('Invalid VPS_PORT: must be an integer 1-65535');
  }
}
export function validateVpsUser(user) {
  if (typeof user !== 'string' || !VPS_USER_RE.test(user)) {
    throw new Error('Invalid VPS_USER: must match [A-Za-z0-9._-]{1,32}');
  }
}

// Strictly parse a fetched master sidecar (`.sha256`). It must contain EXACTLY
// one record of the GNU coreutils form `<64-hex>  <basename>` (two spaces),
// where <basename> is EXACTLY the expected archive basename (no arbitrary path,
// no absolute/parent path, no extra fields). Returns the validated sha256.
// Rejects: empty, multiple records, single-space form, bare hash, a basename
// other than expected, surrounding whitespace, and control characters.
//
// This deliberately does NOT feed the sidecar to `sha256sum -c` (which would
// read a path straight from the file). The caller re-hashes the archive itself
// and compares against the returned digest.
export function parseMasterSidecar(text, expectedArchiveBasename) {
  if (typeof text !== 'string') throw new Error('sidecar text must be a string');
  if (typeof expectedArchiveBasename !== 'string' || expectedArchiveBasename.length === 0) {
    throw new Error('expectedArchiveBasename must be a non-empty string');
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
    throw new Error('sidecar contains control characters');
  }
  const lines = text.split(/\r?\n/);
  const content = lines.filter((l) => l.trim() !== '');
  if (content.length === 0) throw new Error('sidecar is empty');
  if (content.length > 1) throw new Error('sidecar must contain exactly one record');
  const line = content[0];
  const m = line.match(/^([a-f0-9]{64}) {2}(\S[^\r\n]*)$/);
  if (!m) {
    throw new Error(
      'sidecar line is malformed (expected exactly "<sha256>  <basename>" two-space form)'
    );
  }
  const [, sha, name] = m;
  if (name !== expectedArchiveBasename) {
    throw new Error(
      `sidecar basename "${name}" does not match expected archive basename "${expectedArchiveBasename}"`
    );
  }
  return sha;
}

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
    // Dimension cap is enforced PER VARIANT: thumb <= THUMB_MAX_DIMENSION (640),
    // full <= FULL_MAX_DIMENSION (2000). The previous uniform check let an
    // over-large thumb pass because it only compared against the full cap.
    const dimCap = maxDimensionForVariant(variant);
    if (!Number.isInteger(width) || width <= 0 || width > dimCap) {
      throw new Error(`manifest entry ${key} has invalid width ${width} (cap ${dimCap} for ${variant})`);
    }
    if (!Number.isInteger(height) || height <= 0 || height > dimCap) {
      throw new Error(`manifest entry ${key} has invalid height ${height} (cap ${dimCap} for ${variant})`);
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
  // Precompute the sha256 of the exact bytes that will be uploaded so the import
  // client can verify the readback by hash (not only by parsed record count).
  const sha256 = createHash('sha256').update(json, 'utf8').digest('hex');
  return { json, size, count: canonical.length, sha256 };
}

// Verify an artworks.json readback by EXACT byte-for-byte integrity: the
// downloaded buffer must hash to the expected sha256, match the expected byte
// size, and parse to the expected record count. A count-only check cannot catch
// silent corruption, truncation, or a partial/rewritten object; this closes that
// gap. Pure and dependency-free (crypto only); safe to unit-test in isolation.
export function verifyArtworksReadback(readBackBuf, expected) {
  if (!expected || typeof expected !== 'object') {
    throw new Error('expected readback spec is required');
  }
  const { sha256, size, count } = expected;
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
    throw new Error('expected.sha256 must be 64-char lowercase hex');
  }
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('expected.size must be a positive integer');
  }
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('expected.count must be a positive integer');
  }
  const buf = Buffer.isBuffer(readBackBuf)
    ? readBackBuf
    : Buffer.from(String(readBackBuf), 'utf8');
  if (buf.length !== size) {
    throw new Error(
      `artworks.json readback size mismatch: got ${buf.length} bytes, expected ${size}`
    );
  }
  const hash = createHash('sha256').update(buf).digest('hex');
  if (hash !== sha256) {
    throw new Error(
      `artworks.json readback sha256 mismatch: got ${hash}, expected ${sha256}`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new Error(`artworks.json readback is not valid JSON: ${(e && e.message) || e}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== count) {
    throw new Error(
      `artworks.json readback record count mismatch: got ${parsed && parsed.length}, expected ${count}`
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Archive extraction safety (tar entry validation)
// ---------------------------------------------------------------------------

// A safe tar entry path: no leading slash (absolute), no backslashes, no
// control chars, and no '..' segments. The '.' segment is allowed (tar commonly
// emits a './' root entry) since it cannot escape the target dir; only '..'
// (parent traversal) is dangerous. Allows a trailing slash (directory entries)
// and nested forward-slash subdirs only.
export function isSafeTarPath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  if (/[\x00-\x1f]/.test(p)) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '..') return false;
  }
  return true;
}

// GNU tar `tar -tvzf` verbose listing format:
//   <10-char perms> <owner/group> <size> <YYYY-MM-DD HH:MM> <name>[ -> <target>]
// The perms type char (index 0) is 'l' for symlinks and 'h' for hardlinks; a
// symlink line also carries ' -> <target>' and a hardlink line ' link to <t>'.
const GNU_TAR_VERBOSE_RE = /^(.{10})\s+\S.*?\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/;

// Validate a GNU tar verbose listing: reject any entry that is a symlink or
// hardlink (so extraction can never create a link that escapes the target dir),
// and reject any entry whose path is absolute or contains parent traversal.
// Fail-closed: an unparseable non-blank line is rejected rather than ignored.
export function validateTarVerboseListing(text) {
  if (typeof text !== 'string') throw new Error('verbose listing must be a string');
  const lines = text.split(/\r?\n/);
  let entryCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const m = line.match(GNU_TAR_VERBOSE_RE);
    if (!m) {
      throw new Error(`tar verbose listing line ${i + 1} is unparseable: ${line}`);
    }
    const typeChar = m[1][0];
    const name = m[2];
    const arrowIdx = name.indexOf(' -> ');
    const hardIdx = name.indexOf(' link to ');
    // The captured name already carries the link suffix for links; print it as-is.
    if (typeChar === 'l' || arrowIdx !== -1) {
      throw new Error(`tar entry is a symlink, refused: ${name}`);
    }
    if (typeChar === 'h' || hardIdx !== -1) {
      throw new Error(`tar entry is a hardlink, refused: ${name}`);
    }
    if (!isSafeTarPath(name)) {
      throw new Error(`tar entry has unsafe path: ${name}`);
    }
    entryCount++;
  }
  if (entryCount === 0) throw new Error('tar verbose listing has no entries');
  return true;
}

// ---------------------------------------------------------------------------
// Static guard helper: detect raw ${{ inputs.* }} inside workflow run: scripts
// ---------------------------------------------------------------------------

// Scan a workflow YAML text for a `${{ <expr> }}` that appears INSIDE a step
// `run:` script body (block `run: |` or inline `run: ...`). Values passed
// through `env:`/`if:`/`with:` are NOT run-script interpolation and are allowed.
// Returns an array of { line, text } offenders (empty when clean). This is the
// testable core of the no-interpolation-in-run static guards.
function findExprInRunBlocks(text, exprRe) {
  if (typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  const hits = [];
  let inRunBlock = false;
  let runKeyIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const indent = raw.length - raw.replace(/^\s+/, '').length;
    const runMatch = raw.match(/^(\s*)run:\s*(.*)$/);
    if (runMatch) {
      runKeyIndent = runMatch[1].length;
      const rest = runMatch[2];
      if (rest === '' ) {
        inRunBlock = false;
      } else if (rest.startsWith('|') || rest.startsWith('>')) {
        inRunBlock = true;
      } else {
        if (exprRe.test(raw)) {
          hits.push({ line: i + 1, text: raw });
        }
        inRunBlock = false;
      }
      continue;
    }
    if (inRunBlock) {
      if (indent > runKeyIndent) {
        if (exprRe.test(raw)) {
          hits.push({ line: i + 1, text: raw });
        }
      } else {
        inRunBlock = false;
      }
    }
  }
  return hits;
}

// Detect raw `${{ inputs.* }}` interpolated inside a run script (shell
// injection surface: an attacker-controlled input value could become syntax).
export function findInputsInRunBlocks(text) {
  return findExprInRunBlocks(text, /\$\{\{\s*inputs\./);
}

// Detect raw `${{ secrets.* }}` interpolated inside a run script. Secrets must
// flow through `env:` (then quoted shell vars) so a value can never leak into a
// command line, log line, or be re-echoed. Mirrors the inputs guard.
export function findSecretsInRunBlocks(text) {
  return findExprInRunBlocks(text, /\$\{\{\s*secrets\./);
}
