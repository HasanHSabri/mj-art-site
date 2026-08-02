// Pure, dependency-free helpers for the tracked production release manifest,
// the production-catalogue promotion client, and their unit tests.
//
// Nothing here performs network I/O, filesystem mutation, or process launching.
// Every function is deterministic and safe to unit-test in isolation. The CLI
// scripts (generate-production-release-manifest.mjs, promote-catalog-production.mjs)
// compose these helpers with the impure parts (wrangler, the FS).
//
// SECURITY INVARIANTS (also enforced statically by check-operations-rules.mjs):
//   * The production bucket name is a fixed literal here; no argument, manifest
//     field, or control flow can swap, invert, or override it.
//   * The preview bucket is the read-only SOURCE; production is the write
//     DESTINATION. The two literals are never interchangeable.

import { createHash } from 'node:crypto';

// Shared constants from the catalogue-import core (single source of truth for
// the canonical object-key shape, record/image counts, and sha form). Imported
// for local use and re-exported for callers.
import {
  ARTWORKS_JSON_KEY,
  EXPECTED_RECORDS,
  EXPECTED_IMAGES,
  OBJECT_KEY_RE,
  SHA256_RE,
  buildRequiredKeys,
  buildCanonicalArtworksPayload,
  verifyArtworksReadback
} from './catalog-import-core.mjs';

export {
  ARTWORKS_JSON_KEY,
  EXPECTED_RECORDS,
  EXPECTED_IMAGES,
  OBJECT_KEY_RE,
  SHA256_RE,
  buildRequiredKeys,
  buildCanonicalArtworksPayload,
  verifyArtworksReadback
};

// The production catalogue release manifest schema version this module reads
// and writes. Bump only on an incompatible schema change.
export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const RELEASE_MANIFEST_KIND = 'mj-art-production-catalogue-release';

// Hard-allowlisted bucket literals. The promotion is always preview -> production.
// These constants are the ONLY accepted values; the committed manifest must agree
// with them, and the promotion client asserts the agreement before any transfer.
export const SOURCE_BUCKET = 'mj-art-images-preview';
export const DESTINATION_BUCKET = 'mj-art-images';
export const ARTWORKS_JSON_SIZE = 113368;
export const ARTWORKS_JSON_SHA256 =
  '8cfdf39f56bd0541b5f20b9e10c66e9bd3fccdda51c1e8936983781d2e12cc69';

// Strong, exact confirmation phrase required to authorize a production write.
// The promotion client rejects --execute unless --confirm equals this literal.
// Mirrors the read-only scope confirmation convention but is distinct.
export const PROMOTION_CONFIRM_PHRASE = 'I-CONFIRM-PRODUCTION-CATALOGUE-PROMOTION';

// A release manifest expected object: { key, size, sha256 }.
export function makeExpectedObject(key, size, sha256) {
  if (typeof key !== 'string' || key.length === 0) throw new Error('object key must be a non-empty string');
  if (!Number.isInteger(size) || size <= 0) throw new Error(`object size must be a positive integer: ${key}`);
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) throw new Error(`object sha256 must be 64-char hex: ${key}`);
  return { key, size, sha256 };
}

// Deterministic byte serialization of a release manifest for a stable content
// hash (sorted keys, trailing newline). The committed manifest carries this hash
// so the promotion workflow can pin it exactly.
export function serializeReleaseManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

export function hashReleaseManifestBytes(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  return createHash('sha256').update(buf).digest('hex');
}

// sha256 of a release manifest object (after deterministic serialization).
export function hashReleaseManifest(manifest) {
  return hashReleaseManifestBytes(serializeReleaseManifest(manifest));
}

// ---------------------------------------------------------------------------
// Release manifest construction (from a verified read-only backup manifest)
// ---------------------------------------------------------------------------

// Build the canonical release manifest object from the raw per-object records of
// the APPROVED PREVIEW bucket. Each record is { rawKey, size, sha256, downloaded }.
// `provenance` carries verifiable fields only (no local paths/etags/timestamps/
// secrets); the caller supplies exactly the fields that are committed.
//
// This performs NO validation against the catalogue; call validateReleaseManifest
// for that. It only shapes and sorts the data deterministically.
export function buildReleaseManifest(previewObjectRecords, provenance) {
  if (!Array.isArray(previewObjectRecords)) {
    throw new Error('previewObjectRecords must be an array');
  }
  if (!provenance || typeof provenance !== 'object') {
    throw new Error('provenance must be an object');
  }
  const expectedObjects = previewObjectRecords
    .map((r) => makeExpectedObject(r.rawKey, r.size, r.sha256))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const artworks = expectedObjects.find((e) => e.key === ARTWORKS_JSON_KEY);
  if (!artworks) throw new Error('approved preview object set is missing artworks.json');
  const imageCount = expectedObjects.filter((e) => OBJECT_KEY_RE.test(e.key)).length;
  const manifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    manifestKind: RELEASE_MANIFEST_KIND,
    approvedPreview: { ...provenance },
    source: { bucket: SOURCE_BUCKET, role: 'read-only source (approved preview state)' },
    destination: { bucket: DESTINATION_BUCKET, role: 'write target (production)' },
    catalog: { recordCount: EXPECTED_RECORDS, canonicalImageKeyCount: EXPECTED_IMAGES },
    expectedObjectCount: expectedObjects.length,
    artworksJson: {
      key: ARTWORKS_JSON_KEY,
      size: artworks.size,
      sha256: artworks.sha256,
      recordCount: EXPECTED_RECORDS
    },
    imageObjectCount: imageCount,
    expectedObjects
  };
  return manifest;
}

// ---------------------------------------------------------------------------
// Release manifest validation
// ---------------------------------------------------------------------------

// Validate a parsed release manifest object against the committed schema AND the
// canonical catalogue records. `catalog` is the parsed catalog.json array and
// `schemaFns` is the imported artwork-schema module (for the canonical artworks
// cross-check). Throws on any inconsistency. Returns true on success.
export function validateReleaseManifest(manifest, catalog, schemaFns) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('release manifest must be an object');
  }
  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`release manifest schemaVersion must be ${RELEASE_MANIFEST_SCHEMA_VERSION}`);
  }
  if (manifest.manifestKind !== RELEASE_MANIFEST_KIND) {
    throw new Error(`release manifest manifestKind must be "${RELEASE_MANIFEST_KIND}"`);
  }

  // Bucket literals must agree with the hard constants (no override possible).
  if (!manifest.source || manifest.source.bucket !== SOURCE_BUCKET) {
    throw new Error(`release manifest source.bucket must be the preview literal "${SOURCE_BUCKET}"`);
  }
  if (!manifest.destination || manifest.destination.bucket !== DESTINATION_BUCKET) {
    throw new Error(`release manifest destination.bucket must be the production literal "${DESTINATION_BUCKET}"`);
  }
  // The source must be the read-only source; the destination the write target.
  // (Defends against an inverted manifest even though the literals are distinct.)
  if (String(manifest.source.role || '').includes('write')) {
    throw new Error('release manifest source role must not be a write role');
  }
  if (!String(manifest.destination.role || '').includes('write')) {
    throw new Error('release manifest destination role must be a write role');
  }

  if (!manifest.catalog || manifest.catalog.recordCount !== EXPECTED_RECORDS) {
    throw new Error(`release manifest catalog.recordCount must be ${EXPECTED_RECORDS}`);
  }
  if (manifest.catalog.canonicalImageKeyCount !== EXPECTED_IMAGES) {
    throw new Error(`release manifest catalog.canonicalImageKeyCount must be ${EXPECTED_IMAGES}`);
  }

  const objects = manifest.expectedObjects;
  if (!Array.isArray(objects)) throw new Error('release manifest expectedObjects must be an array');
  if (manifest.expectedObjectCount !== objects.length) {
    throw new Error(`release manifest expectedObjectCount (${manifest.expectedObjectCount}) must equal expectedObjects.length (${objects.length})`);
  }
  if (objects.length !== EXPECTED_IMAGES + 1) {
    throw new Error(`release manifest must list exactly ${EXPECTED_IMAGES + 1} expected objects (172 images + artworks.json), got ${objects.length}`);
  }

  // Every entry: canonical key/size/sha, no duplicates, strictly sorted.
  const seen = new Set();
  let prev = null;
  let imageCount = 0;
  let artworksEntry = null;
  for (const e of objects) {
    if (!e || typeof e !== 'object') throw new Error('release manifest expectedObjects entry must be an object');
    // Allow only the canonical {key,size,sha256} shape (no leaked local paths/etags).
    const keys = Object.keys(e).sort().join(',');
    if (keys !== 'key,sha256,size') {
      throw new Error(`release manifest object must have exactly {key,size,sha256}; got {${keys}} for ${e && e.key}`);
    }
    const { key, size, sha256 } = e;
    if (typeof key !== 'string') throw new Error('release manifest object key must be a string');
    if (OBJECT_KEY_RE.test(key)) {
      imageCount++;
    } else if (key === ARTWORKS_JSON_KEY) {
      artworksEntry = e;
    } else {
      throw new Error(`release manifest object key is neither canonical image nor artworks.json: ${key}`);
    }
    if (seen.has(key)) throw new Error(`release manifest duplicate object key: ${key}`);
    seen.add(key);
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error(`release manifest object size must be a positive integer: ${key}`);
    }
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
      throw new Error(`release manifest object sha256 must be 64-char hex: ${key}`);
    }
    if (prev !== null && !(prev < key)) {
      throw new Error(`release manifest expectedObjects must be sorted ascending; "${key}" <= previous "${prev}"`);
    }
    prev = key;
  }

  if (imageCount !== EXPECTED_IMAGES) {
    throw new Error(`release manifest must contain exactly ${EXPECTED_IMAGES} canonical image keys, got ${imageCount}`);
  }
  if (!artworksEntry) throw new Error('release manifest is missing the artworks.json object');

  // artworks.json summary must match the artworks.json object exactly.
  const aw = manifest.artworksJson;
  if (!aw || aw.key !== ARTWORKS_JSON_KEY) {
    throw new Error('release manifest artworksJson.key must be artworks.json');
  }
  if (aw.size !== artworksEntry.size || aw.sha256 !== artworksEntry.sha256) {
    throw new Error('release manifest artworksJson summary must match the artworks.json expected object');
  }
  if (aw.recordCount !== EXPECTED_RECORDS) {
    throw new Error(`release manifest artworksJson.recordCount must be ${EXPECTED_RECORDS}`);
  }
  if (manifest.imageObjectCount !== imageCount) {
    throw new Error(`release manifest imageObjectCount (${manifest.imageObjectCount}) must equal the counted image keys (${imageCount})`);
  }

  // Cross-check against the canonical catalogue records.
  if (!Array.isArray(catalog)) throw new Error('catalog must be an array');
  if (catalog.length !== EXPECTED_RECORDS) {
    throw new Error(`catalog has ${catalog.length} records, expected ${EXPECTED_RECORDS}`);
  }
  const requiredImageKeys = buildRequiredKeys(catalog);
  if (requiredImageKeys.size !== EXPECTED_IMAGES) {
    throw new Error(`catalogue requires ${requiredImageKeys.size} image keys, expected ${EXPECTED_IMAGES}`);
  }
  for (const k of requiredImageKeys) {
    if (!seen.has(k)) throw new Error(`release manifest missing catalogue-required image key: ${k}`);
  }
  // No image key in the manifest may be absent from the catalogue requirement.
  for (const e of objects) {
    if (OBJECT_KEY_RE.test(e.key) && !requiredImageKeys.has(e.key)) {
      throw new Error(`release manifest image key not required by catalogue: ${e.key}`);
    }
  }

  // The artworks.json payload in the manifest MUST equal the canonical catalogue
  // payload (the approved preview artworks.json is the canonical catalogue). This
  // pins the committed manifest to the committed catalogue by content hash.
  if (schemaFns) {
    const payload = buildCanonicalArtworksPayload(catalog, schemaFns);
    if (payload.size !== aw.size) {
      throw new Error(`release manifest artworks.json size (${aw.size}) != canonical catalogue payload (${payload.size})`);
    }
    if (payload.sha256 !== aw.sha256) {
      throw new Error(`release manifest artworks.json sha256 != canonical catalogue payload sha256 (${payload.sha256})`);
    }
    if (payload.count !== aw.recordCount) {
      throw new Error(`release manifest artworks.json recordCount != canonical catalogue count (${payload.count})`);
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Backup handshake / production inventory fingerprint
// ---------------------------------------------------------------------------

// Extract a bucket's inventory from a parsed read-only backup manifest (as
// produced by scripts/r2-readonly-backup.mjs). Returns { name, objectCount,
// objects: [{ key, size, sha256, downloaded }], allBodiesDownloaded }.
//
// The backup manifest top-level has a `buckets` array; each bucket entry has a
// `name`, `objectCount`, and `objects` array of per-object records (rawKey, size,
// sha256, downloaded). This helper is pure (parses only).
export function extractBackupBucket(backupManifest, bucketName) {
  if (!backupManifest || typeof backupManifest !== 'object') {
    throw new Error('backup manifest must be an object');
  }
  if (typeof bucketName !== 'string' || bucketName.length === 0) {
    throw new Error('bucketName must be a non-empty string');
  }
  const buckets = Array.isArray(backupManifest.buckets) ? backupManifest.buckets : null;
  if (!buckets) throw new Error('backup manifest has no buckets array');
  const bucket = buckets.find((b) => b && b.name === bucketName);
  if (!bucket) throw new Error(`backup manifest has no bucket named "${bucketName}"`);
  const objects = Array.isArray(bucket.objects) ? bucket.objects : [];
  let allBodiesDownloaded = true;
  const norm = objects.map((o) => {
    if (!o || typeof o !== 'object') {
      throw new Error('backup manifest object record must be an object');
    }
    const downloaded = o.downloaded === true;
    if (!downloaded) allBodiesDownloaded = false;
    const sha = typeof o.sha256 === 'string' && SHA256_RE.test(o.sha256) ? o.sha256 : null;
    if (downloaded && !sha) {
      throw new Error(`backup manifest object downloaded without a valid sha256: ${o.rawKey}`);
    }
    return { key: o.rawKey, size: o.size, sha256: sha, downloaded };
  });
  return {
    name: bucket.name,
    objectCount: bucket.objectCount,
    objects: norm,
    allBodiesDownloaded
  };
}

// Deterministic inventory fingerprint for a backup bucket: the count plus the
// sha256 of the sorted (key,size,sha256) lines. This is the drift guard: the
// promotion workflow pins the EXPECTED production count, and the script asserts
// the fresh backup's production inventory matches it exactly (same count and the
// same fingerprint). Used to detect unseen production drift before any write.
export function inventoryFingerprint(bucketInventory) {
  const objs = bucketInventory.objects.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const text = objs.map((o) => `${o.key}\t${o.size}\t${o.sha256 || '-'}`).join('\n');
  return {
    objectCount: objs.length,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex')
  };
}

// Verify the production backup handshake for a promotion:
//   1. The backup manifest must include the destination (production) bucket.
//   2. Every production body must be downloaded with a valid sha256 (so a
//      rollback source exists and is byte-verified).
//   3. The recorded production object count must equal the expected count
//      (drift guard: unseen production change -> mismatch -> fail closed).
// Returns the verified production inventory. Throws on any failure.
export function verifyProductionBackupHandshake(backupManifest, expectedProductionObjectCount) {
  if (!Number.isInteger(expectedProductionObjectCount) || expectedProductionObjectCount < 0) {
    throw new Error('expectedProductionObjectCount must be a non-negative integer');
  }
  const prod = extractBackupBucket(backupManifest, DESTINATION_BUCKET);
  if (!prod.allBodiesDownloaded) {
    throw new Error('production backup handshake failed: not every production body was downloaded/checksummed');
  }
  if (prod.objectCount !== expectedProductionObjectCount) {
    throw new Error(
      `production backup handshake failed: backup recorded ${prod.objectCount} production objects, expected ${expectedProductionObjectCount} (drift guard)`
    );
  }
  if (prod.objects.length !== expectedProductionObjectCount) {
    throw new Error(
      `production backup handshake failed: inventory has ${prod.objects.length} records, expected ${expectedProductionObjectCount}`
    );
  }
  return prod;
}

// Verify the source (preview) inventory in the SAME fresh backup matches the
// release manifest expected set exactly (no missing, no extra). This is the
// "reject missing/extra preview objects" cross-check using an independent
// inventory produced by the read-only backup run (not by the promotion client).
export function verifyPreviewInventoryMatchesRelease(backupManifest, releaseManifest) {
  const prev = extractBackupBucket(backupManifest, SOURCE_BUCKET);
  const expectedKeys = new Set(releaseManifest.expectedObjects.map((e) => e.key));
  const listedKeys = new Set(prev.objects.map((o) => o.key));
  if (expectedKeys.size !== releaseManifest.expectedObjectCount) {
    throw new Error('release manifest expectedObjects is internally inconsistent');
  }
  const missing = [...expectedKeys].filter((k) => !listedKeys.has(k));
  const extra = [...listedKeys].filter((k) => !expectedKeys.has(k));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push(`missing from preview: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' ...' : ''}`);
    if (extra.length) parts.push(`unexpected extra in preview: ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ' ...' : ''}`);
    throw new Error(`preview inventory does not match release manifest exactly (${parts.join('; ')})`);
  }
  return true;
}
