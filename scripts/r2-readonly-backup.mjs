#!/usr/bin/env node
// R2 read-only inventory + backup utility for MJ-ART.
//
// Hard safety contract (enforced by construction and by static checks):
//   * Network access is limited to HTTPS GET requests against api.cloudflare.com.
//   * No remote mutation methods are implemented anywhere in this file.
//   * No external processes are launched; standard library modules only.
//   * No filesystem removal APIs are used. Local writes only.
//   * The read token / account id are never printed or logged.
//
// Modes:
//   inventory (default) -> lists every object in both buckets, downloads only
//                          artworks.json (when present) to run reference analysis.
//   backup              -> additionally downloads every object body.
//
// Run with --help for usage, --self-test for a fully offline deterministic check.

import { createHash } from 'node:crypto';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createWriteStream, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

const API_HOST = 'api.cloudflare.com';
const API_BASE = `https://${API_HOST}`;
const API_PREFIX = '/client/v4';
const BUCKETS = ['mj-art-images', 'mj-art-images-preview'];
const ARTWORKS_KEY = 'artworks.json';
const UPLOADED_PREFIX = '/artwork-uploaded/';
const STATIC_PREFIX = './artwork/';
const ARTWORK_OBJECT_PREFIX = 'artwork/';
const MAX_LIST_PAGES = 5000;
const MAX_ATTEMPTS = 6;
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const READ_ONLY_CONFIRM_VALUE = 'I-CONFIRM-READ-ONLY-SCOPE';

// ---------- pure helpers (unit tested by --self-test) ----------

function sha256hex(input) {
  return createHash('sha256').update(Buffer.from(input, 'utf8')).digest('hex');
}

// Percent-encode a single path segment at the byte level using UTF-8.
// Keeps the RFC-3986 unreserved set (plus '-', '_', '~', '.') and encodes the
// rest. Pure-dot segments are neutralized separately by the caller site.
function encodeSegment(seg) {
  const bytes = Buffer.from(seg, 'utf8');
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const keep =
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      (b >= 0x30 && b <= 0x39) || // 0-9
      b === 0x2d || // -
      b === 0x5f || // _
      b === 0x7e || // ~
      b === 0x2e;   // .
    out += keep ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

// Encode an object key for use as trailing path segments. Slashes within the key
// are preserved as path separators. Pure-dot segments ('.', '..') are neutralized
// so they cannot be collapsed by path normalization.
function encodeObjectKeyForPath(key) {
  const segs = String(key).split('/');
  let out = '';
  for (let i = 0; i < segs.length; i++) {
    const raw = segs[i];
    let enc = encodeSegment(raw);
    if (/^\.+$/.test(raw)) {
      enc = '%2E'.repeat(raw.length);
    }
    out += (i > 0 ? '/' : '') + enc;
  }
  return out;
}

// Deterministic, collision-proof local backup filename for an object body.
// Hashes (bucket + NUL + rawKey) so the SAME raw key living in two different
// buckets (production `mj-art-images` and preview `mj-art-images-preview` both
// host `artworks.json`) maps to two DISTINCT body files instead of one silently
// overwriting the other. The NUL separator makes the hashed input unambiguous:
// no bucket/key pair can collide with another via plain concatenation (e.g.
// ("a","bc") vs ("ab","c") would collide under concatenation but not here).
// The manifest retains both the bucket and rawKey so restore resolves the exact
// origin; the filename is a 64-hex sha256, so path traversal and
// filesystem-special names are impossible. Two keys that happen to share the
// same bytes still each get their own file (dedup is intentionally not done);
// every manifest line resolves to its own correct body and SHA.
function backupFilenameFor(bucket, key) {
  return sha256hex(bucket + '\u0000' + String(key));
}

// Case/separator-tolerant field lookup. Normalizes record keys by lowercasing
// and stripping '-' and '_', so documented and common variants all resolve:
// 'ETag'/'etag', 'Last-Modified'/'last_modified'/'lastModified',
// 'httpMetadata'/'http-metadata'/'http_metadata', 'StorageClass'/'storage_class'.
function pickField(rec, names) {
  const lower = Object.create(null);
  for (const k of Object.keys(rec)) {
    lower[k.toLowerCase().replace(/[-_]/g, '')] = rec[k];
  }
  for (const n of names) {
    const v = lower[n.toLowerCase().replace(/[-_]/g, '')];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function sanitizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // Preserve every field the API returns; normalize the small set we rely on.
  const rec = Object.assign({}, raw);
  const keyVal = pickField(rec, ['key']);
  const rawKey = keyVal != null ? String(keyVal) : null;
  const sizeVal = pickField(rec, ['size']);
  const sizeNum =
    typeof sizeVal === 'number'
      ? sizeVal
      : sizeVal != null && sizeVal !== '' && Number.isFinite(Number(sizeVal))
      ? Number(sizeVal)
      : null;
  const etagVal = pickField(rec, ['etag']);
  return {
    rawKey,
    size: sizeNum,
    etag: etagVal != null ? String(etagVal) : null,
    lastModified: pickField(rec, ['uploaded', 'lastmodified']) || null,
    httpMetadata: pickField(rec, ['httpmetadata']) || null,
    customMetadata: pickField(rec, ['custommetadata']) || null,
    storageClass: pickField(rec, ['storageclass']) || null,
    rawRecord: rec
  };
}

function decodeStaticFile(imageValue) {
  const rel = imageValue.slice(STATIC_PREFIX.length);
  try {
    return decodeURIComponent(rel);
  } catch {
    return rel;
  }
}

// Pure reference analysis. Returns deterministic, sorted findings.
//   objects:               list of { rawKey } (or sanitized records)
//   artworksJsonText:      raw text of live artworks.json (or null/undefined)
//   staticFallbackFiles:   array of filenames present in apps/web/public/artwork
function analyzeReferences(objects, artworksJsonText, staticFallbackFiles) {
  const findings = {
    invalidMetadata: false,
    metadataError: null,
    missingReferences: [],
    orphanedImages: [],
    missingStaticFallback: [],
    referencedUploadedKeys: []
  };
  const keys = new Set();
  for (const o of objects || []) {
    const k = o && o.rawKey != null ? o.rawKey : o && o.key != null ? String(o.key) : null;
    if (k != null) keys.add(k);
  }
  const referenced = new Set();
  const staticSet = new Set(staticFallbackFiles || []);

  let parsed = null;
  if (artworksJsonText != null) {
    try {
      parsed = JSON.parse(artworksJsonText);
    } catch (e) {
      findings.invalidMetadata = true;
      findings.metadataError = 'invalid JSON: ' + (e && e.message ? e.message : String(e));
    }
  }
  if (parsed !== null && !findings.invalidMetadata) {
    if (!Array.isArray(parsed)) {
      findings.invalidMetadata = true;
      findings.metadataError = 'artworks.json root is not an array';
    } else {
      for (let i = 0; i < parsed.length; i++) {
        const a = parsed[i];
        if (!a || typeof a !== 'object' || typeof a.image !== 'string') {
          findings.invalidMetadata = true;
          findings.metadataError = 'entry ' + i + ' has invalid schema (image must be a string)';
          break;
        }
        const img = a.image;
        if (img.startsWith(UPLOADED_PREFIX)) {
          const key = img.slice(UPLOADED_PREFIX.length);
          findings.referencedUploadedKeys.push({ index: i, key });
          referenced.add(key);
          if (!keys.has(key)) {
            findings.missingReferences.push({ index: i, key });
          }
        } else if (img.startsWith(STATIC_PREFIX)) {
          const file = decodeStaticFile(img);
          if (!staticSet.has(file)) {
            findings.missingStaticFallback.push({ index: i, reference: img, file });
          }
        }
      }
    }
  }

  const sortedKeys = Array.from(keys).sort();
  for (const k of sortedKeys) {
    if (k.startsWith(ARTWORK_OBJECT_PREFIX) && !referenced.has(k)) {
      findings.orphanedImages.push({ key: k });
    }
  }

  findings.referencedUploadedKeys.sort((x, y) =>
    x.key < y.key ? -1 : x.key > y.key ? 1 : x.index - y.index
  );
  findings.missingReferences.sort((x, y) =>
    x.key < y.key ? -1 : x.key > y.key ? 1 : x.index - y.index
  );
  findings.missingStaticFallback.sort((x, y) =>
    x.file < y.file ? -1 : x.file > y.file ? 1 : x.index - y.index
  );
  return findings;
}

// ---------- network: GET-only, host-restricted, redirect-blocking ----------

function backoffMs(attempt) {
  const base = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    const lk = k.toLowerCase();
    if (lk === 'authorization' || lk === 'cookie' || lk === 'set-cookie') continue;
    out[lk] = v;
  }
  return out;
}

// Pure Cloudflare API URL builder. Applies the /client/v4 REST prefix and
// host-locks the result. The prefix is prepended to the argument rather than
// folded into API_BASE because an absolute-path argument to the URL constructor
// discards any path component of the base; prepending keeps the prefix for
// every endpoint. No network access; fully unit-testable.
function buildCfUrl(pathAndQuery) {
  if (typeof pathAndQuery !== 'string' || pathAndQuery[0] !== '/') {
    throw new Error('internal: path must start with /');
  }
  const url = new URL(API_PREFIX + pathAndQuery, API_BASE);
  if (url.host !== API_HOST) {
    throw new Error('blocked: request to non-cloudflare host ' + url.host);
  }
  return url;
}

// The only network function. It accepts no method argument and therefore can
// only ever issue GET requests by construction. It restricts the host, blocks
// redirects, retries bounded transient failures, and never returns credentials.
async function cfGet(pathAndQuery, { token, expectJson }) {
  const url = buildCfUrl(pathAndQuery);
  // JSON endpoints negotiate application/json; raw object GETs negotiate bytes.
  const accept = expectJson ? 'application/json' : 'application/octet-stream, */*';
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp;
    try {
      resp = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { authorization: 'Bearer ' + token, accept }
      });
    } catch (e) {
      lastErr = e;
      await sleep(backoffMs(attempt));
      continue;
    }
    const status = resp.status;
    if (status === 401 || status === 403) {
      throw new Error('auth failure: HTTP ' + status + ' from ' + pathAndQuery);
    }
    if (status >= 200 && status < 300) {
      const headers = captureHeaders(resp.headers);
      if (expectJson) {
        let body;
        try {
          body = await resp.json();
        } catch (e) {
          throw new Error('non-JSON response from ' + pathAndQuery + ': ' + (e && e.message));
        }
        return { status, headers, body };
      }
      return { status, headers, body: resp.body };
    }
    if (status >= 300 && status < 400) {
      throw new Error('redirect blocked: HTTP ' + status + ' from ' + pathAndQuery);
    }
    if (status === 429 || status >= 500) {
      lastErr = new Error('retryable HTTP ' + status + ' from ' + pathAndQuery);
      await sleep(backoffMs(attempt));
      continue;
    }
    throw new Error('unexpected HTTP ' + status + ' from ' + pathAndQuery);
  }
  throw new Error(
    'exhausted retries for ' + pathAndQuery + ': ' + (lastErr && lastErr.message ? lastErr.message : 'unknown')
  );
}

// ---------- listing + downloading ----------

// Pure parser for a Cloudflare R2 list-objects response (no network). Official
// REST shape: payload.result IS the object array, and pagination metadata lives
// in payload.result_info (cursor, is_truncated). For defensive compatibility we
// also accept a nested payload.result.objects. An unknown shape throws (fail
// closed) rather than silently yielding an incomplete inventory. result_info /
// truncated consistency and cursor progress are enforced.
function parseListResponse(body, bucket, prevCursor) {
  if (body && body.success === false) {
    const msgs = (body.errors || [])
      .map((e) => e.message || JSON.stringify(e))
      .join('; ');
    throw new Error('list objects failed for ' + bucket + ': ' + msgs);
  }
  let objects;
  if (Array.isArray(body && body.result)) {
    objects = body.result;
  } else if (body && body.result && Array.isArray(body.result.objects)) {
    objects = body.result.objects;
  } else {
    throw new Error(
      'unexpected list response shape for bucket ' + bucket +
      ': result is not an object array (fail closed; refusing to produce an incomplete inventory)'
    );
  }
  const info = (body && body.result_info) || {};
  const next = info.cursor || null;
  const truncated = info.is_truncated;
  if (truncated !== undefined && truncated !== null && typeof truncated !== 'boolean') {
    throw new Error('list response for ' + bucket + ' has non-boolean is_truncated; refusing ambiguous pagination');
  }
  if (truncated === true && !next) {
    throw new Error('list response for ' + bucket + ' claims is_truncated=true but returned no cursor');
  }
  if (truncated === false && next) {
    throw new Error('list response for ' + bucket + ' claims is_truncated=false but returned a cursor');
  }
  const more = truncated === true || (truncated === undefined || truncated === null ? Boolean(next) : false);
  if (more && next === prevCursor) {
    throw new Error('cursor stall while listing bucket ' + bucket);
  }
  return { objects, nextCursor: next, more };
}

async function listAllObjects(bucket, ctx) {
  const all = [];
  let cursor = null;
  let pages = 0;
  while (true) {
    pages++;
    if (pages > MAX_LIST_PAGES) {
      throw new Error('page cap exceeded while listing bucket ' + bucket);
    }
    // Cursor-only pagination; the per_page query parameter is not part of the
    // documented R2 list contract, so it is intentionally omitted.
    let p =
      '/accounts/' + ctx.accountId + '/r2/buckets/' + encodeURIComponent(bucket) +
      '/objects';
    if (cursor) p += '?cursor=' + encodeURIComponent(cursor);
    const { body } = await cfGet(p, { token: ctx.token, expectJson: true });
    const { objects, nextCursor, more } = parseListResponse(body, bucket, cursor);
    for (const o of objects) all.push(o);
    if (!more || !nextCursor) break;
    cursor = nextCursor;
  }
  return all.map(sanitizeRecord).filter(Boolean);
}

function streamToFileAndHash(webBody, tmpPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    let nodeStream;
    try {
      nodeStream = Readable.fromWeb(webBody);
    } catch (e) {
      reject(e);
      return;
    }
    const ws = createWriteStream(tmpPath);
    nodeStream.on('data', (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    nodeStream.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', () => resolve({ sha256: hash.digest('hex'), bytes }));
    nodeStream.pipe(ws);
  });
}

function randomId() {
  return createHash('sha256')
    .update(Date.now() + ':' + Math.random() + ':' + process.pid)
    .digest('hex')
    .slice(0, 16);
}

async function downloadObject(bucket, rawKey, objectsDir, listRecord, ctx) {
  const p =
    '/accounts/' + ctx.accountId + '/r2/buckets/' + encodeURIComponent(bucket) +
    '/objects/' + encodeObjectKeyForPath(rawKey);
  const result = await cfGet(p, { token: ctx.token, expectJson: false });
  const finalPath = path.join(objectsDir, backupFilenameFor(bucket, rawKey));
  const tmpPath = finalPath + '.partial-' + randomId();

  // On any failure below the .partial-* temp file is intentionally left in place
  // (it lives under the temp output dir only); this tool never uses filesystem
  // deletion APIs. The workflow never packages an artifact on failure.
  let outcome;
  try {
    outcome = await streamToFileAndHash(result.body, tmpPath);
  } catch (e) {
    throw new Error('stream failed for ' + bucket + '/' + rawKey + ': ' + (e && e.message));
  }

  const contentLength = result.headers['content-length'];
  if (contentLength !== undefined && Number(contentLength) !== outcome.bytes) {
    throw new Error(
      'size mismatch (concurrent change suspected) for ' + bucket + '/' + rawKey +
      ': content-length=' + contentLength + ' written=' + outcome.bytes
    );
  }
  if (listRecord && typeof listRecord.size === 'number' && listRecord.size !== outcome.bytes) {
    throw new Error(
      'size mismatch vs listing for ' + bucket + '/' + rawKey +
      ': list=' + listRecord.size + ' written=' + outcome.bytes
    );
  }

  await fs.rename(tmpPath, finalPath);

  const responseEtag = result.headers['etag'] || null;
  return {
    rawKey,
    size: outcome.bytes,
    sha256: outcome.sha256,
    backupPath: path.relative(ctx.outputDir, finalPath).split(path.sep).join('/'),
    responseEtag,
    etagNonAuthoritativeNote: responseEtag != null ? 'ETag is not a full-file hash for multipart objects' : null,
    responseHeaders: result.headers
  };
}

// ---------- orchestration ----------

function readStaticFallbackFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.isFile ? f.isFile() : true).map((f) => f.name || f);
  } catch {
    return [];
  }
}

function buildInventory(records) {
  const sorted = records.slice().sort((a, b) => (a.rawKey < b.rawKey ? -1 : a.rawKey > b.rawKey ? 1 : 0));
  return {
    objectCount: sorted.length,
    totalBytes: sorted.reduce((n, o) => n + (typeof o.size === 'number' ? o.size : 0), 0),
    objects: sorted.map((o) => ({
      rawKey: o.rawKey,
      size: o.size,
      etag: o.etag,
      lastModified: o.lastModified,
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
      storageClass: o.storageClass
    }))
  };
}

// Warnings about records whose listing lacked fields needed for restore or
// integrity comparison. Sorted deterministically.
function collectListingFindings(records) {
  const warnings = [];
  for (const rec of records) {
    if (typeof rec.size !== 'number') {
      warnings.push({ rawKey: rec.rawKey, issue: 'size missing from listing' });
    }
    if (rec.etag == null) {
      warnings.push({ rawKey: rec.rawKey, issue: 'etag missing from listing' });
    }
  }
  warnings.sort((a, b) =>
    a.rawKey < b.rawKey ? -1 : a.rawKey > b.rawKey ? 1 : a.issue < b.issue ? -1 : a.issue > b.issue ? 1 : 0
  );
  return warnings;
}

// Restore-relevant manifest entry for one object: normalized list metadata plus
// (when downloaded) sanitized GET response headers and body hash. Auth/cookie
// headers are stripped by captureHeaders before this point; no token is ever
// written. Missing size/etag are made explicit rather than omitted. The bucket
// is recorded on every entry (in addition to the parent bucket array) so that
// body files, which are now dispersed by bucket, resolve to their exact origin
// even if entries are flattened out of the per-bucket structure.
function buildManifestEntry(bucket, record, download) {
  return {
    bucket,
    rawKey: record.rawKey,
    size: typeof record.size === 'number' ? record.size : download ? download.size : null,
    sizeSource: typeof record.size === 'number' ? 'listing' : download ? 'download' : 'missing',
    etag: record.etag != null ? record.etag : null,
    etagMissing: record.etag == null,
    lastModified: record.lastModified || null,
    httpMetadata: record.httpMetadata || null,
    customMetadata: record.customMetadata || null,
    storageClass: record.storageClass || null,
    rawRecord: record.rawRecord || null,
    downloaded: Boolean(download),
    sha256: download ? download.sha256 : null,
    backupPath: download ? download.backupPath : null,
    responseEtag: download ? download.responseEtag : null,
    responseHeaders: download ? download.responseHeaders : null,
    note: 'ETag is not a full-file hash for multipart objects; rely on sha256 for integrity.'
  };
}

function utcStamp(d) {
  return d.toISOString().replace(/[:.]/g, '-');
}

function sortManifest(manifest) {
  for (const b of manifest.buckets) {
    b.objects.sort((a, c) => (a.rawKey < c.rawKey ? -1 : a.rawKey > c.rawKey ? 1 : 0));
  }
  return manifest;
}

async function run(config) {
  const ctx = {
    token: config.token,
    accountId: config.accountId,
    outputDir: config.outputDir,
    mode: config.mode,
    maxBackupBytes: config.maxBackupBytes,
    commitSha: config.commitSha || null,
    staticDir: config.staticDir
  };

  // Verify the bearer token is active. Scope is attested out-of-band.
  const verify = await cfGet('/user/tokens/verify', { token: ctx.token, expectJson: true });
  const vStatus = verify.body && verify.body.result && verify.body.result.status;
  if (vStatus !== 'active') {
    throw new Error('read token is not active (status=' + vStatus + '). Scope must be verified separately.');
  }

  const tmpDir = path.join(ctx.outputDir, 'objects');
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(ctx.outputDir, { recursive: true });

  const staticFiles = readStaticFallbackFiles(ctx.staticDir);

  // 1) List both buckets completely (no body downloads yet).
  const perBucket = [];
  let grandTotalBytes = 0;
  let grandTotalCount = 0;
  for (const bucket of BUCKETS) {
    const records = await listAllObjects(bucket, ctx);
    const inv = buildInventory(records);
    grandTotalBytes += inv.totalBytes;
    grandTotalCount += inv.objectCount;
    const byKey = new Map(records.map((r) => [r.rawKey, r]));
    perBucket.push({ bucket, records, inv, byKey });
  }

  // 2) In backup mode, guard total size before downloading anything.
  if (ctx.mode === 'backup' && grandTotalBytes > ctx.maxBackupBytes) {
    throw new Error(
      'combined object bytes (' + grandTotalBytes + ') exceed max_backup_bytes (' +
      ctx.maxBackupBytes + '). Aborting before any body download.'
    );
  }

  // 2b) In backup mode, fail closed if any object lacks a listing size: a
  //     downloaded body's integrity could not then be compared to the listing.
  if (ctx.mode === 'backup') {
    for (const { bucket, records } of perBucket) {
      const noSize = records.filter((r) => typeof r.size !== 'number').map((r) => r.rawKey);
      if (noSize.length) {
        throw new Error(
          'fail closed (backup mode): ' + noSize.length + ' object(s) in bucket ' + bucket +
          ' have no listing size, so downloaded body integrity cannot be compared: ' +
          noSize.slice(0, 10).join(', ') + (noSize.length > 10 ? ' ...' : '')
        );
      }
    }
  }

  const downloaded = []; // { bucket, rawKey, size, sha256, backupPath }
  const manifestBuckets = [];

  for (const { bucket, records, inv, byKey } of perBucket) {
    // 3) artworks.json: always fetched (when present) for reference analysis.
    let artworksText = null;
    let artworksDownload = null;
    const artworksRecord = byKey.get(ARTWORKS_KEY);
    if (artworksRecord) {
      artworksDownload = await downloadObject(bucket, ARTWORKS_KEY, tmpDir, artworksRecord, ctx);
      downloaded.push({ bucket, rawKey: ARTWORKS_KEY, size: artworksDownload.size, sha256: artworksDownload.sha256, backupPath: artworksDownload.backupPath });
      artworksText = readFileSync(path.join(ctx.outputDir, artworksDownload.backupPath), 'utf8');
    }

    const findings = analyzeReferences(records, artworksText, staticFiles);
    const listingFindings = collectListingFindings(records);
    const refsPayload = Object.assign({}, findings, { listingFindings });

    // Persist findings early so diagnostics survive any later abort.
    const refsFile = path.join(ctx.outputDir, 'refs-' + bucket + '.json');
    await fs.writeFile(refsFile, JSON.stringify(refsPayload, null, 2) + '\n', 'utf8');

    // 3b) Fail closed on invalid live metadata immediately after reference
    //     analysis and BEFORE any bulk object downloads. Missing artworks.json
    //     is an explicit fallback state (artworksText stays null), not a crash.
    if (findings.invalidMetadata) {
      throw new Error(
        'fail closed: live artworks.json in bucket ' + bucket + ' is invalid (' +
        findings.metadataError + '). Findings written to ' + refsFile + '; no artifact packaged.'
      );
    }

    // 4) backup mode: download every remaining object.
    const objectResults = {};
    for (const rec of records) {
      if (rec.rawKey === ARTWORKS_KEY) {
        objectResults[rec.rawKey] = buildManifestEntry(bucket, rec, artworksDownload);
        continue;
      }
      if (ctx.mode === 'backup') {
        const dl = await downloadObject(bucket, rec.rawKey, tmpDir, rec, ctx);
        downloaded.push({ bucket, rawKey: rec.rawKey, size: dl.size, sha256: dl.sha256, backupPath: dl.backupPath });
        objectResults[rec.rawKey] = buildManifestEntry(bucket, rec, dl);
      } else {
        objectResults[rec.rawKey] = buildManifestEntry(bucket, rec, null);
      }
    }

    // Per-bucket inventory file (deterministic ordering).
    const invFile = path.join(ctx.outputDir, 'inventory-' + bucket + '.json');
    await fs.writeFile(invFile, JSON.stringify(inv, null, 2) + '\n', 'utf8');

    manifestBuckets.push({
      name: bucket,
      objectCount: inv.objectCount,
      totalBytes: inv.totalBytes,
      listingFindingsCount: listingFindings.length,
      objects: Object.keys(objectResults)
        .sort()
        .map((k) => objectResults[k]),
      inventoryFile: 'inventory-' + bucket + '.json',
      refsFile: 'refs-' + bucket + '.json'
    });
  }

  // 5) Top-level manifest.
  const generatedUtc = new Date().toISOString();
  const manifest = sortManifest({
    generatedUtc,
    commitSha: ctx.commitSha,
    mode: ctx.mode,
    downloadedBodies: ctx.mode === 'backup',
    maxBackupBytes: ctx.maxBackupBytes,
    buckets: manifestBuckets,
    totals: { objectCount: grandTotalCount, totalBytes: grandTotalBytes, downloadedCount: downloaded.length },
    note: 'ETag values are non-authoritative for multipart objects. Every object records normalized list metadata, the raw list record, and its origin bucket; downloaded bodies also record sanitized GET response headers and a content SHA-256. Body files are dispersed by bucket: the on-disk body name is the SHA-256 of (bucket + NUL + rawKey), so the same raw key in production and preview (e.g. artworks.json) is stored as two separate, independently verifiable bodies rather than one overwriting the other. No credentials, cookies, or Authorization data are ever recorded.'
  });
  const manifestFile = path.join(ctx.outputDir, 'manifest.json');
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  await fs.writeFile(manifestFile, manifestText, 'utf8');
  const manifestSha = createHash('sha256').update(Buffer.from(manifestText, 'utf8')).digest('hex');
  await fs.writeFile(path.join(ctx.outputDir, 'manifest.sha256'), manifestSha + '  manifest.json\n', 'utf8');

  // 6) Sorted SHA256SUMS for downloaded bodies.
  const sums = downloaded
    .slice()
    .sort((a, b) => (a.backupPath < b.backupPath ? -1 : a.backupPath > b.backupPath ? 1 : 0))
    .map((d) => d.sha256 + '  ' + d.backupPath);
  await fs.writeFile(path.join(ctx.outputDir, 'SHA256SUMS'), sums.join('\n') + (sums.length ? '\n' : ''), 'utf8');

  // 7) Sanitized summary.
  const lines = [];
  lines.push('# MJ-ART R2 read-only ' + (ctx.mode === 'backup' ? 'backup' : 'inventory') + ' summary');
  lines.push('');
  lines.push('- generated (UTC): ' + generatedUtc);
  if (ctx.commitSha) lines.push('- commit: ' + ctx.commitSha);
  lines.push('- mode: ' + ctx.mode);
  lines.push('- total objects: ' + grandTotalCount);
  lines.push('- total bytes: ' + grandTotalBytes);
  lines.push('- bodies downloaded: ' + downloaded.length);
  for (const b of manifestBuckets) {
    lines.push('- bucket `' + b.name + '`: ' + b.objectCount + ' objects, ' + b.totalBytes + ' bytes');
  }
  lines.push('');
  lines.push('Body files are dispersed by bucket: each body name is SHA-256(bucket + NUL + rawKey), so the same raw key in two buckets is stored as two separate bodies. Restore each entry from its recorded `bucket`, `rawKey`, `backupPath`, and content SHA-256 in manifest.json.');
  lines.push('');
  lines.push('No token or authorization data is included in this artifact.');
  await fs.writeFile(path.join(ctx.outputDir, 'SUMMARY.md'), lines.join('\n') + '\n', 'utf8');

  // 8) Invalid-live-metadata handling already ran per bucket immediately after
  //    reference analysis (step 3b), before any bulk body downloads. The
  //    workflow never packages an artifact on that failure path.

  return { generatedUtc, objectCount: grandTotalCount, totalBytes: grandTotalBytes, downloadedCount: downloaded.length };
}

// ---------- config + entrypoint ----------

function parseArgs(argv) {
  const out = { help: false, selfTest: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--self-test') out.selfTest = true;
  }
  return out;
}

const HELP = [
  'r2-readonly-backup.mjs - MJ-ART R2 read-only inventory and backup',
  '',
  'Usage:',
  '  node scripts/r2-readonly-backup.mjs --self-test   # offline deterministic check',
  '  node scripts/r2-readonly-backup.mjs --help         # this text',
  '  (normal run, driven by environment variables - see below)',
  '',
  'Environment variables for a normal run (all required unless noted):',
  '  CLOUDFLARE_R2_READ_TOKEN   read-only R2 bearer token (scoped by maintainers)',
  '  CLOUDFLARE_ACCOUNT_ID      32-hex Cloudflare account id',
  '  R2_BACKUP_MODE             "inventory" (default) or "backup"',
  '  R2_READ_ONLY_CONFIRMED     must equal "' + READ_ONLY_CONFIRM_VALUE + '"',
  '  R2_BACKUP_OUTPUT_DIR       writable directory for the artifact (use $RUNNER_TEMP)',
  '  R2_MAX_BACKUP_BYTES        byte budget enforced in backup mode',
  '  GIT_COMMIT_SHA             optional commit sha recorded in the manifest',
  '  STATIC_FALLBACK_DIR        optional, defaults to apps/web/public/artwork',
  '',
  'Safety: GET-only network to api.cloudflare.com, no redirects, no remote mutation,',
  'no child processes, no filesystem removal APIs. Tokens are never printed.'
].join('\n');

function buildConfigFromEnv() {
  const token = process.env.CLOUDFLARE_R2_READ_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const mode = process.env.R2_BACKUP_MODE === 'backup' ? 'backup' : 'inventory';
  const confirmed = process.env.R2_READ_ONLY_CONFIRMED;
  const outputDir = process.env.R2_BACKUP_OUTPUT_DIR;
  const maxBackupBytesRaw = process.env.R2_MAX_BACKUP_BYTES;
  const commitSha = process.env.GIT_COMMIT_SHA || null;
  const staticDir = process.env.STATIC_FALLBACK_DIR || 'apps/web/public/artwork';

  const errors = [];
  if (!token) errors.push('CLOUDFLARE_R2_READ_TOKEN is required');
  if (!accountId) errors.push('CLOUDFLARE_ACCOUNT_ID is required');
  else if (!ACCOUNT_ID_RE.test(accountId)) errors.push('CLOUDFLARE_ACCOUNT_ID must be 32 hex characters');
  if (confirmed !== READ_ONLY_CONFIRM_VALUE) {
    errors.push('R2_READ_ONLY_CONFIRMED must equal "' + READ_ONLY_CONFIRM_VALUE + '"');
  }
  if (!outputDir) errors.push('R2_BACKUP_OUTPUT_DIR is required');
  let maxBackupBytes = mode === 'backup' ? Number(maxBackupBytesRaw) : 0;
  if (mode === 'backup') {
    if (!Number.isFinite(maxBackupBytes) || maxBackupBytes <= 0) {
      errors.push('R2_MAX_BACKUP_BYTES must be a positive number in backup mode');
    }
  }
  if (errors.length) {
    throw new Error('configuration errors:\n  - ' + errors.join('\n  - '));
  }
  return { token, accountId, mode, outputDir, maxBackupBytes, commitSha, staticDir };
}

async function selfTest() {
  const failures = [];
  function assert(name, cond, detail) {
    if (!cond) failures.push(name + (detail ? ' :: ' + detail : ''));
  }

  // --- key URL encoding ---
  assert('space encoded', encodeObjectKeyForPath('a/b c') === 'a/b%20c', encodeObjectKeyForPath('a/b c'));
  assert('question encoded', encodeObjectKeyForPath('a?b') === 'a%3Fb', encodeObjectKeyForPath('a?b'));
  assert('hash encoded', encodeObjectKeyForPath('a#b') === 'a%23b', encodeObjectKeyForPath('a#b'));
  assert('percent encoded', encodeObjectKeyForPath('a%b') === 'a%25b', encodeObjectKeyForPath('a%b'));
  assert('slash preserved', encodeObjectKeyForPath('artwork/x.jpg').startsWith('artwork/'), encodeObjectKeyForPath('artwork/x.jpg'));
  {
    const enc = encodeObjectKeyForPath('artwork/' + '\u00fcni.jpg');
    assert('unicode encoded', enc === 'artwork/%C3%BCni.jpg', enc);
  }
  {
    const enc = encodeObjectKeyForPath('a/../b');
    assert('dotdot neutralized', enc === 'a/%2E%2E/b', enc);
  }
  {
    const enc = encodeObjectKeyForPath('a/./b');
    assert('dot neutralized', enc === 'a/%2E/b', enc);
  }

  // --- deterministic path mapping / checksum (now bucket-dispersed) ---
  assert('sha256 known vector', sha256hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', sha256hex('abc'));
  {
    const k = 'artwork/2026-01-02-painting.jpeg';
    const fn = backupFilenameFor('mj-art-images', k);
    assert('backup filename is sha256 of bucket+NUL+key', fn === sha256hex('mj-art-images' + '\u0000' + k), fn);
    assert('backup filename is 64 hex', /^[0-9a-f]{64}$/.test(fn), fn);
    assert('distinct keys map distinctly (same bucket)', backupFilenameFor('mj-art-images', 'a') !== backupFilenameFor('mj-art-images', 'b'));
    // The dual-bucket collision the bug hinged on: identical raw key, two buckets.
    assert('same key distinct across buckets', backupFilenameFor('mj-art-images', 'a') !== backupFilenameFor('mj-art-images-preview', 'a'), 'BUCKET COLLISION');
    assert('artworks.json distinct prod vs preview', backupFilenameFor('mj-art-images', ARTWORKS_KEY) !== backupFilenameFor('mj-art-images-preview', ARTWORKS_KEY), 'BUCKET COLLISION on artworks.json');
    // NUL separator prevents concatenation ambiguity.
    assert('separator disambiguates ("a","bc") vs ("ab","c")', backupFilenameFor('a', 'bc') !== backupFilenameFor('ab', 'c'), 'CONCAT COLLISION');
  }

  // --- dual-bucket body-file dispersion (the actual bug): identical raw key in
  //     two buckets with DIFFERENT bytes must produce two distinct body files
  //     that each exist and each verify against their own SHA. This exercises the
  //     real on-disk naming path used by downloadObject (no network). The tool's
  //     hard contract forbids filesystem-deletion APIs, so the scratch dir is
  //     left under os.tmpdir() (cleaned by the OS) rather than removed here. ---
  {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'r2-backup-selftest-'));
    const objectsDir = path.join(scratch, 'objects');
    await fs.mkdir(objectsDir, { recursive: true });
    const prodBody = Buffer.from('PRODUCTION-ARTWORKS-BYTES-1234567890');
    const prevBody = Buffer.from('PREVIEW-ARTWORKS-BYTES-0987654321');
    const prodName = backupFilenameFor('mj-art-images', ARTWORKS_KEY);
    const prevName = backupFilenameFor('mj-art-images-preview', ARTWORKS_KEY);
    assert('dual: distinct body filenames', prodName !== prevName, prodName + ' == ' + prevName);
    await fs.writeFile(path.join(objectsDir, prodName), prodBody);
    await fs.writeFile(path.join(objectsDir, prevName), prevBody);
    const prodRead = await fs.readFile(path.join(objectsDir, prodName));
    const prevRead = await fs.readFile(path.join(objectsDir, prevName));
    assert('dual: production body preserved (not overwritten)', prodRead.equals(prodBody), prodRead.toString());
    assert('dual: preview body preserved (not overwritten)', prevRead.equals(prevBody), prevRead.toString());
    const prodSha = createHash('sha256').update(prodRead).digest('hex');
    const prevSha = createHash('sha256').update(prevRead).digest('hex');
    assert('dual: production sha matches body', prodSha === createHash('sha256').update(prodBody).digest('hex'), prodSha);
    assert('dual: preview sha matches body', prevSha === createHash('sha256').update(prevBody).digest('hex'), prevSha);
    assert('dual: two distinct body shas', prodSha !== prevSha, 'bodies identical despite different bytes');
    // Mirror the tool's SHA256SUMS dedup-free listing: every (bucket,key) gets
    // its own line; both must resolve.
    const sums = [prodSha + '  objects/' + prodName, prevSha + '  objects/' + prevName].sort();
    assert('dual: SHA256SUMS lists two distinct paths', new Set(sums.map((l) => l.slice(64))).size === 2, JSON.stringify(sums));
  }

  // --- body-name traversal/special-key safety: regardless of bucket or key
  //     content, the body filename is always a pure 64-hex sha256, so traversal,
  //     dot-segments, NULs, and unicode in the key can never reach the
  //     filesystem via the body name (they remain confined to the list URL via
  //     encodeObjectKeyForPath, covered above). ---
  {
    const hostile = ['../../etc/passwd', '..', '.', 'a/\u0000b', 'a\x00b', 'artwork/\u00fc\u00f1.jpg', 'CON', ' ', '', 'a/b/c'];
    for (const h of hostile) {
      const prodFn = backupFilenameFor('mj-art-images', h);
      const prevFn = backupFilenameFor('mj-art-images-preview', h);
      assert('body name hex-only for hostile key: ' + JSON.stringify(h), /^[0-9a-f]{64}$/.test(prodFn), prodFn);
      assert('body name hex-only (preview) for hostile key: ' + JSON.stringify(h), /^[0-9a-f]{64}$/.test(prevFn), prevFn);
      // No slash, dot, or NUL can appear in the body filename.
      assert('body name has no path/meta chars: ' + JSON.stringify(h), !/[\/\.\u0000]/.test(prodFn), prodFn);
      // Same hostile key still disperses across buckets.
      assert('hostile key still bucket-dispersed: ' + JSON.stringify(h), prodFn !== prevFn, 'BUCKET COLLISION');
    }
  }

  // --- reference analysis ---
  {
    const objects = [
      { rawKey: 'artworks.json' },
      { rawKey: 'artwork/a.jpg' },
      { rawKey: 'artwork/b.jpg' }
    ];
    const artworks = JSON.stringify([
      { id: 'p1', image: '/artwork-uploaded/artwork/a.jpg' },
      { id: 'p2', image: '/artwork-uploaded/artwork/missing.jpg' },
      { id: 'p3', image: './artwork/1.jpg' }
    ]);
    const staticFiles = ['1.jpg', '2.jpg'];
    const f = analyzeReferences(objects, artworks, staticFiles);
    assert('ref: no invalid metadata', f.invalidMetadata === false, JSON.stringify(f));
    assert('ref: one missing reference', f.missingReferences.length === 1 && f.missingReferences[0].key === 'artwork/missing.jpg', JSON.stringify(f.missingReferences));
    assert('ref: one orphan', f.orphanedImages.length === 1 && f.orphanedImages[0].key === 'artwork/b.jpg', JSON.stringify(f.orphanedImages));
    assert('ref: no missing static', f.missingStaticFallback.length === 0, JSON.stringify(f.missingStaticFallback));
  }
  {
    const f = analyzeReferences([{ rawKey: 'artworks.json' }], 'not-json{', []);
    assert('ref: invalid json detected', f.invalidMetadata === true && /invalid JSON/.test(f.metadataError), JSON.stringify(f));
  }

  // --- Cloudflare R2 list response parsing (official shape) ---
  {
    const body = {
      success: true,
      result: [
        { key: 'a.jpg', size: 10, etag: '"a"', uploaded: '2026-01-01T00:00:00Z' },
        { key: 'b.jpg', size: 20, etag: '"b"', uploaded: '2026-01-02T00:00:00Z' }
      ],
      result_info: { cursor: 'cur-1', is_truncated: true }
    };
    const r = parseListResponse(body, 'bkt', null);
    assert('list: official shape returns objects array', Array.isArray(r.objects) && r.objects.length === 2, JSON.stringify(r));
    assert('list: cursor extracted from result_info', r.nextCursor === 'cur-1', String(r.nextCursor));
    assert('list: is_truncated true -> more', r.more === true, String(r.more));
  }
  {
    const body = { success: true, result: [{ key: 'a.jpg', size: 10 }], result_info: { is_truncated: false } };
    const r = parseListResponse(body, 'bkt', null);
    assert('list: terminal page no cursor', r.nextCursor === null && r.more === false, JSON.stringify(r));
  }
  {
    // Defensive compatibility: nested result.objects; pagination via result_info.
    const body = { success: true, result: { objects: [{ key: 'a', size: 1 }] }, result_info: { cursor: 'c', is_truncated: true } };
    const r = parseListResponse(body, 'bkt', null);
    assert('list: nested result.objects accepted', r.objects.length === 1 && r.nextCursor === 'c' && r.more === true, JSON.stringify(r));
  }
  {
    // Malformed/unknown shape must throw, never silently produce empty inventory.
    let threw = false;
    try { parseListResponse({ success: true, result: 'nope' }, 'bkt', null); } catch { threw = true; }
    assert('list: non-array result throws (fail closed)', threw, 'expected throw');
    threw = false;
    try { parseListResponse({ success: true, result_info: { is_truncated: false } }, 'bkt', null); } catch { threw = true; }
    assert('list: missing result throws', threw, 'expected throw');
  }
  {
    // result_info / truncated consistency must throw on contradiction.
    let threw = false;
    try { parseListResponse({ success: true, result: [], result_info: { is_truncated: true } }, 'bkt', null); } catch { threw = true; }
    assert('list: truncated=true without cursor throws', threw, 'expected throw');
    threw = false;
    try { parseListResponse({ success: true, result: [], result_info: { is_truncated: false, cursor: 'x' } }, 'bkt', null); } catch { threw = true; }
    assert('list: truncated=false with cursor throws', threw, 'expected throw');
  }
  {
    // Cursor progress: a cursor that does not advance must throw.
    let threw = false;
    try { parseListResponse({ success: true, result: [{ key: 'a' }], result_info: { cursor: 'same', is_truncated: true } }, 'bkt', 'same'); } catch { threw = true; }
    assert('list: non-advancing cursor throws', threw, 'expected throw');
  }

  // --- field normalization (case/separator tolerant) ---
  {
    const rec = sanitizeRecord({ Key: 'ART/x', Size: '42', ETag: '"e"', 'Last-Modified': '2026-01-01T00:00:00Z', 'http-metadata': { a: 1 }, 'custom_metadata': { b: 2 }, StorageClass: 'Standard' });
    assert('norm: key case-insensitive', rec.rawKey === 'ART/x', rec.rawKey);
    assert('norm: size string coerced to number', rec.size === 42, String(rec.size));
    assert('norm: etag preserved', rec.etag === '"e"', rec.etag);
    assert('norm: last-modified hyphen accepted', rec.lastModified === '2026-01-01T00:00:00Z', rec.lastModified);
    assert('norm: http-metadata hyphen accepted', rec.httpMetadata && rec.httpMetadata.a === 1, JSON.stringify(rec.httpMetadata));
    assert('norm: custom_metadata underscore accepted', rec.customMetadata && rec.customMetadata.b === 2, JSON.stringify(rec.customMetadata));
    assert('norm: storage class case-insensitive', rec.storageClass === 'Standard', rec.storageClass);
    assert('norm: rawRecord preserved', rec.rawRecord && rec.rawRecord.Key === 'ART/x', JSON.stringify(rec.rawRecord));
  }
  {
    const rec = sanitizeRecord({ key: 'y', uploaded: '2026-02-02T00:00:00Z' });
    assert('norm: uploaded maps to lastModified', rec.lastModified === '2026-02-02T00:00:00Z', rec.lastModified);
    assert('norm: missing size explicit null', rec.size === null, String(rec.size));
    assert('norm: missing etag explicit null', rec.etag === null, String(rec.etag));
  }

  // --- Cloudflare API URL building (REST prefix + host lock) ---
  {
    const acct = 'a'.repeat(32);
    const verify = buildCfUrl('/user/tokens/verify');
    assert('url: verify includes client prefix', verify.pathname === '/client/v4/user/tokens/verify', verify.pathname);
    assert('url: verify host correct', verify.host === API_HOST, verify.host);
    assert('url: verify href', verify.href === 'https://api.cloudflare.com/client/v4/user/tokens/verify', verify.href);

    const list = buildCfUrl('/accounts/' + acct + '/r2/buckets/mj-art-images/objects');
    assert('url: list includes client prefix', list.pathname === '/client/v4/accounts/' + acct + '/r2/buckets/mj-art-images/objects', list.pathname);
    assert('url: list host correct', list.host === API_HOST, list.host);

    const get = buildCfUrl('/accounts/' + acct + '/r2/buckets/mj-art-images/objects/artwork/x.jpg');
    assert('url: get includes client prefix', get.pathname === '/client/v4/accounts/' + acct + '/r2/buckets/mj-art-images/objects/artwork/x.jpg', get.pathname);
  }
  {
    // Query string is preserved verbatim (cursor pagination survives the prefix).
    const acct = 'a'.repeat(32);
    const q = buildCfUrl('/accounts/' + acct + '/r2/buckets/foo/objects?cursor=cur-9');
    assert('url: query preserved', q.search === '?cursor=cur-9', q.search);
    assert('url: query href', q.href === 'https://api.cloudflare.com/client/v4/accounts/' + acct + '/r2/buckets/foo/objects?cursor=cur-9', q.href);
  }
  {
    // The suffix-in-base trap: a /client/v4 suffix on the base is discarded by
    // an absolute-path argument, so the prefix must be applied to the argument
    // instead. Show the constructor behavior directly.
    const naive = new URL('/user/tokens/verify', 'https://' + API_HOST + '/client/v4');
    assert('url: absolute path discards base suffix', naive.pathname === '/user/tokens/verify', naive.pathname);
    const correct = buildCfUrl('/user/tokens/verify');
    assert('url: prefix survives via arg prepend', correct.pathname === '/client/v4/user/tokens/verify', correct.pathname);
  }
  {
    // Leading slash is required; other shapes must throw.
    let threw = false;
    try { buildCfUrl('no-leading-slash'); } catch { threw = true; }
    assert('url: missing leading slash throws', threw, 'expected throw');
    threw = false;
    try { buildCfUrl(''); } catch { threw = true; }
    assert('url: empty path throws', threw, 'expected throw');
  }

  if (failures.length) {
    console.error('self-test FAILED:\n  - ' + failures.join('\n  - '));
    process.exitCode = 1;
    return;
  }
  console.log('self-test OK: key encoding, bucket-dispersed path mapping, dual-bucket body integrity, traversal safety, checksum, reference analysis, list parsing, field normalization, API URL building');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (args.selfTest) {
    await selfTest();
    return;
  }
  const config = buildConfigFromEnv();
  const summary = await run(config);
  console.log(
    'r2-readonly-backup complete: mode=' + config.mode +
    ' objects=' + summary.objectCount +
    ' bytes=' + summary.totalBytes +
    ' downloaded=' + summary.downloadedCount +
    ' generated=' + summary.generatedUtc
  );
}

main().catch((e) => {
  console.error('r2-readonly-backup failed: ' + (e && e.message ? e.message : String(e)));
  process.exitCode = 1;
});
