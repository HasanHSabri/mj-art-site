// Canonical artwork metadata schema, validation, and projection.
//
// Single source of truth for the persisted record shape stored in R2 under the
// key `artworks.json`. Dependency-free, runtime-safe (no DOM, no network).
//
// The persisted record (canonical) carries admin/internal-only fields
// (`catalogNumber`, `sortOrder`, `provenance`) that are stripped from every
// public surface by `projectPublic`.

export const CANONICAL_FIELDS = [
  'id',
  'catalogNumber',
  'category',
  'title',
  'image',
  'thumbnail',
  'medium',
  'dimensions',
  'sizeCategory',
  'availability',
  'price',
  'cardNote',
  'description',
  'containImage',
  'sortOrder',
  'provenance'
];

// Public-facing projection allowlist. Anything not listed here is never exposed
// to the public API or SSR. `catalogNumber`, `sortOrder`, and `provenance` are
// deliberately omitted.
export const PUBLIC_FIELDS = [
  'id',
  'category',
  'title',
  'image',
  'thumbnail',
  'medium',
  'dimensions',
  'sizeCategory',
  'availability',
  'price',
  'cardNote',
  'description',
  'containImage'
];

const ALLOWED_CATEGORIES = new Set(['catalogue', 'miscellaneous']);
const ALLOWED_AVAILABILITY = new Set(['Available', 'Sold']);
const ALLOWED_CURRENCY = new Set(['AUD']);
const ALLOWED_ORIENTATIONS = new Set(['Horizontal', 'Vertical', 'Square', 'Unknown']);

// Exact canonical size set for catalogue works. Must match the client-side
// CANONICAL_SIZES list in public/admin-artwork.js. Miscellaneous works use the
// single sentinel MISC_SIZE_CATEGORY. The server-side validateArtworkRecord
// enforces this as the authoritative allowlist.
export const ALLOWED_CATALOGUE_SIZES = new Set([
  '20x20',
  '20x25',
  '25x25',
  '30x23',
  '30x30',
  '35x28',
  '40x30',
  '47x57',
  '50x25',
  '55x30',
  '58x73'
]);
export const MISC_SIZE_CATEGORY = 'miscellaneous';

const ID_RE = /^[a-z]+-\d{3}$/;
const R2_IMAGE_PATH_RE = /^\/artwork-uploaded\/artwork\/catalog\/[a-z]+-\d{3}\/(full|thumb)\.jpg$/;

// Strict provenance contract. Only these internal-only keys may ever appear on
// a persisted record. Every key present in catalog/catalog.json is covered.
export const PROVENANCE_FIELDS = [
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
];

// source enum. `admin` is the only source created by the admin surface and is
// the one source that does not require (and must not carry) a content hash.
export const ALLOWED_SOURCES = new Set(['google-drive', 'r2-backup-or-live-fetch', 'admin']);

const SHA256_RE = /^[a-f0-9]{64}$/;
const PROV_LEAK_RE = /\/tmp\/|\/workspace\/|\/home\/|\/Users\/|[A-Za-z]:[\\/]/i;
const PROV_SECRET_RE = /(secret|token|password|api[_-]?key|authorization|bearer|credential)/i;

// Reasonable ceiling for an admin PUT body. The canonical 86-record catalogue is
// well under 1 MB; this leaves generous headroom for growth without allowing
// unbounded payloads.
export const MAX_PUT_BODY_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Validate a full list of records. Returns { ok: true, records } on success
// (records is the validated input as-is) or { ok: false, error } with a single
// descriptive message. Strict: unknown keys, duplicate ids/catalog numbers/sort
// orders, malformed nested objects, and out-of-range values all fail.
export function validateArtworkList(records) {
  if (!Array.isArray(records)) {
    return { ok: false, error: 'Artwork data must be a list.' };
  }

  const seenIds = new Set();
  const seenCatalogNumbers = new Set();
  const seenSortOrders = new Set();

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const ctx = (r && typeof r.id === 'string' && r.id) || (r && typeof r.catalogNumber === 'string' && r.catalogNumber) || `index ${i}`;

    const recordError = validateArtworkRecord(r, ctx);
    if (recordError) return { ok: false, error: recordError };

    if (seenIds.has(r.id)) return { ok: false, error: `[${ctx}] duplicate id: ${r.id}` };
    seenIds.add(r.id);
    if (seenCatalogNumbers.has(r.catalogNumber)) return { ok: false, error: `[${ctx}] duplicate catalogNumber: ${r.catalogNumber}` };
    seenCatalogNumbers.add(r.catalogNumber);
    if (seenSortOrders.has(r.sortOrder)) return { ok: false, error: `[${ctx}] duplicate sortOrder: ${r.sortOrder}` };
    seenSortOrders.add(r.sortOrder);
  }

  return { ok: true, records };
}

// Validate a single canonical record. Returns an error string or null.
export function validateArtworkRecord(r, ctx = '(unknown)') {
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    return `[${ctx}] record must be an object.`;
  }

  // Strict allowlist: no unknown keys.
  for (const key of Object.keys(r)) {
    if (!CANONICAL_FIELDS.includes(key)) {
      return `[${ctx}] unknown field: ${key}`;
    }
  }

  // Required top-level presence.
  for (const field of CANONICAL_FIELDS) {
    if (!(field in r)) {
      return `[${ctx}] missing field: ${field}`;
    }
  }

  // id
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) {
    return `[${ctx}] id must be a slug like mj-001 or misc-001, got: ${safeStr(r.id)}`;
  }

  // category
  if (!ALLOWED_CATEGORIES.has(r.category)) {
    return `[${ctx}] invalid category: ${safeStr(r.category)}`;
  }

  // catalogNumber format (depends on category) and id consistency.
  if (r.category === 'catalogue') {
    if (!/^MJ-\d{3}$/.test(r.catalogNumber)) {
      return `[${ctx}] catalogue catalogNumber must be MJ-xxx, got: ${safeStr(r.catalogNumber)}`;
    }
  } else {
    if (!/^MISC-\d{3}$/.test(r.catalogNumber)) {
      return `[${ctx}] miscellaneous catalogNumber must be MISC-xxx, got: ${safeStr(r.catalogNumber)}`;
    }
  }
  if (typeof r.catalogNumber !== 'string' || r.id !== r.catalogNumber.toLowerCase()) {
    return `[${ctx}] id must equal catalogNumber.toLowerCase(): id=${safeStr(r.id)} catalogNumber=${safeStr(r.catalogNumber)}`;
  }

  // title
  if (typeof r.title !== 'string' || r.title.length === 0) {
    return `[${ctx}] title must be a non-empty string.`;
  }

  // image / thumbnail
  if (typeof r.image !== 'string' || !R2_IMAGE_PATH_RE.test(r.image)) {
    return `[${ctx}] image path malformed: ${safeStr(r.image)}`;
  }
  if (typeof r.thumbnail !== 'string' || !R2_IMAGE_PATH_RE.test(r.thumbnail)) {
    return `[${ctx}] thumbnail path malformed: ${safeStr(r.thumbnail)}`;
  }

  // medium: string or null
  if (r.medium !== null && typeof r.medium !== 'string') {
    return `[${ctx}] medium must be a string or null.`;
  }

  // sizeCategory - strict allowlist per category. Catalogue works must use one
  // of the exact canonical sizes; miscellaneous works must use the sentinel.
  if (typeof r.sizeCategory !== 'string' || r.sizeCategory.length === 0) {
    return `[${ctx}] sizeCategory must be a non-empty string.`;
  }
  if (r.category === 'catalogue') {
    if (!ALLOWED_CATALOGUE_SIZES.has(r.sizeCategory)) {
      return `[${ctx}] sizeCategory must be one of the canonical catalogue sizes, got: ${safeStr(r.sizeCategory)}`;
    }
  } else {
    if (r.sizeCategory !== MISC_SIZE_CATEGORY) {
      return `[${ctx}] sizeCategory for miscellaneous works must be '${MISC_SIZE_CATEGORY}', got: ${safeStr(r.sizeCategory)}`;
    }
  }

  // availability
  if (!ALLOWED_AVAILABILITY.has(r.availability)) {
    return `[${ctx}] invalid availability: ${safeStr(r.availability)}`;
  }

  // price
  const priceError = validatePrice(r.price, ctx);
  if (priceError) return priceError;

  // cardNote / description: strings (may be empty)
  if (typeof r.cardNote !== 'string') return `[${ctx}] cardNote must be a string.`;
  if (typeof r.description !== 'string') return `[${ctx}] description must be a string.`;

  // containImage
  if (typeof r.containImage !== 'boolean') return `[${ctx}] containImage must be a boolean.`;

  // sortOrder
  if (!Number.isInteger(r.sortOrder)) return `[${ctx}] sortOrder must be an integer.`;
  if (r.sortOrder <= 0) return `[${ctx}] sortOrder must be a positive integer.`;

  // dimensions
  const dimsError = validateDimensions(r.dimensions, ctx);
  if (dimsError) return dimsError;

  // provenance
  const provError = validateProvenance(r.provenance, ctx);
  if (provError) return provError;

  return null;
}

function validatePrice(price, ctx) {
  if (price === null) return null;
  if (!price || typeof price !== 'object' || Array.isArray(price)) {
    return `[${ctx}] price must be null or an object.`;
  }
  for (const key of Object.keys(price)) {
    if (!['amount', 'currency', 'note'].includes(key)) {
      return `[${ctx}] unknown price field: ${key}`;
    }
  }
  if (typeof price.amount !== 'number' || !(price.amount > 0) || !Number.isFinite(price.amount)) {
    return `[${ctx}] price.amount must be a positive finite number.`;
  }
  if (!ALLOWED_CURRENCY.has(price.currency)) {
    return `[${ctx}] price.currency must be AUD, got: ${safeStr(price.currency)}`;
  }
  if (price.note !== null && typeof price.note !== 'string') {
    return `[${ctx}] price.note must be a string or null.`;
  }
  return null;
}

function validateDimensions(dims, ctx) {
  if (!dims || typeof dims !== 'object' || Array.isArray(dims)) {
    return `[${ctx}] dimensions must be an object.`;
  }
  for (const key of Object.keys(dims)) {
    if (!['widthCm', 'heightCm', 'label', 'orientation'].includes(key)) {
      return `[${ctx}] unknown dimensions field: ${key}`;
    }
  }
  if (dims.widthCm !== null) {
    if (typeof dims.widthCm !== 'number' || !Number.isFinite(dims.widthCm) || dims.widthCm <= 0) {
      return `[${ctx}] dimensions.widthCm must be a positive number or null.`;
    }
  }
  if (dims.heightCm !== null) {
    if (typeof dims.heightCm !== 'number' || !Number.isFinite(dims.heightCm) || dims.heightCm <= 0) {
      return `[${ctx}] dimensions.heightCm must be a positive number or null.`;
    }
  }
  if (typeof dims.label !== 'string') {
    return `[${ctx}] dimensions.label must be a string.`;
  }
  if (!ALLOWED_ORIENTATIONS.has(dims.orientation)) {
    return `[${ctx}] invalid orientation: ${safeStr(dims.orientation)}`;
  }
  if (dims.widthCm !== null && dims.heightCm !== null) {
    if (dims.widthCm === dims.heightCm && dims.orientation !== 'Square') {
      return `[${ctx}] equal dimensions but orientation is ${dims.orientation}, expected Square.`;
    }
    if (dims.widthCm > dims.heightCm && dims.orientation !== 'Horizontal') {
      return `[${ctx}] width>height but orientation is ${dims.orientation}, expected Horizontal.`;
    }
    if (dims.widthCm < dims.heightCm && dims.orientation !== 'Vertical') {
      return `[${ctx}] width<height but orientation is ${dims.orientation}, expected Vertical.`;
    }
  }
  return null;
}

function validateProvenance(prov, ctx) {
  if (!prov || typeof prov !== 'object' || Array.isArray(prov)) {
    return `[${ctx}] provenance must be an object.`;
  }

  // Strict key allowlist: no unknown keys (this also blocks secret smuggling).
  for (const key of Object.keys(prov)) {
    if (!PROVENANCE_FIELDS.includes(key)) {
      return `[${ctx}] unknown provenance field: ${key}`;
    }
  }

  if (typeof prov.source !== 'string' || prov.source.length === 0) {
    return `[${ctx}] provenance.source must be a non-empty string.`;
  }
  if (!ALLOWED_SOURCES.has(prov.source)) {
    return `[${ctx}] invalid provenance.source: ${safeStr(prov.source)}`;
  }

  if (prov.sha256 !== undefined) {
    if (typeof prov.sha256 !== 'string' || !SHA256_RE.test(prov.sha256)) {
      return `[${ctx}] provenance.sha256 must be 64-char lowercase hex.`;
    }
  }

  if (prov.sourceBytes !== undefined) {
    if (!Number.isInteger(prov.sourceBytes) || prov.sourceBytes < 0) {
      return `[${ctx}] provenance.sourceBytes must be a non-negative integer.`;
    }
  }

  const stringFields = [
    'driveFileId',
    'driveFolder',
    'sourceFilename',
    'photoTimestamp',
    'mappedFromMiscLabel',
    'mappedFromLiveId',
    'originalMiscLabel',
    'liveId',
    'originalImageUrl',
    'r2BackupRun'
  ];
  for (const field of stringFields) {
    if (prov[field] !== undefined && typeof prov[field] !== 'string') {
      return `[${ctx}] provenance.${field} must be a string.`;
    }
  }

  // Reject secret-like or local-path values anywhere in provenance. Values are
  // internal-only references; none should ever resemble a secret or a path.
  for (const value of Object.values(prov)) {
    if (typeof value === 'string') {
      if (PROV_SECRET_RE.test(value)) {
        return `[${ctx}] secret-like value in provenance.`;
      }
      if (PROV_LEAK_RE.test(value)) {
        return `[${ctx}] local-path value in provenance.`;
      }
    }
  }

  return null;
}

function safeStr(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// Ordering & projection
// ---------------------------------------------------------------------------

// Deep clone a plain JSON value (records are JSON-serializable). Used so that
// persisted/public objects never share mutable references with caller input or
// with each other.
export function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

// Return a canonical, deep-cloned copy of a record containing exactly the
// CANONICAL_FIELDS (in canonical order). Used before persistence so the stored
// shape is stable and free of stray/foreign references.
export function canonicalizeRecord(record) {
  const out = {};
  for (const field of CANONICAL_FIELDS) {
    out[field] = clone(record[field]);
  }
  return out;
}

// Canonicalize every record in a list (deep clone, exact field set/order).
export function canonicalizeList(records) {
  return records.map(canonicalizeRecord);
}

// Return a shallow-copied list sorted by sortOrder ascending (stable).
export function sortByOrder(records) {
  return [...records].sort((a, b) => {
    if (a.sortOrder === b.sortOrder) return 0;
    return a.sortOrder < b.sortOrder ? -1 : 1;
  });
}

// Project a single canonical record to its public shape, omitting
// catalogNumber, sortOrder, and provenance. Returns a new object containing
// only PUBLIC_FIELDS. Nested dimensions/price are deep-cloned so mutating a
// public record can never corrupt the canonical source.
export function projectPublic(record) {
  const out = {};
  for (const field of PUBLIC_FIELDS) {
    out[field] = record[field];
  }
  if (out.dimensions) out.dimensions = clone(out.dimensions);
  if (out.price) out.price = clone(out.price);
  return out;
}

// Sort by sortOrder ascending, then project each record to the public shape.
// This is the canonical transformation for GET /api/artworks and SSR.
export function toPublicList(records) {
  return sortByOrder(records).map(projectPublic);
}

// ---------------------------------------------------------------------------
// Display helpers (shared by SSR and client rendering)
// ---------------------------------------------------------------------------

// Human-readable dimensions label, e.g. "20x20 cm", or "" when absent.
export function dimensionsLabel(record) {
  const label = record && record.dimensions && record.dimensions.label;
  return typeof label === 'string' ? label : '';
}

// Human-readable price for a public record. Returns "" when there is no price
// (caller renders "Price on enquiry"). Otherwise "$<amount>" optionally with a
// note, e.g. "$40 (postage extra)". Currency is always AUD.
export function priceDisplay(record) {
  const price = record && record.price;
  if (!price) return '';
  const amount = `$${price.amount}`;
  if (price.note) return `${amount} (${price.note})`;
  return amount;
}
