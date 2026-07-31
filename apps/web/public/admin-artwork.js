// Pure, dependency-free artwork form<->record mapping for the admin surface.
//
// Runs in the browser (loaded as an ES module by admin.js) and under node:test
// (no DOM, no network). All functions operate on plain objects so they can be
// unit-tested directly. The canonical record shape and validation live in
// src/artwork-schema.js; this module is concerned only with translating between
// form values and canonical records, and with list reordering.

export const CATEGORIES = ['catalogue', 'miscellaneous'];
export const AVAILABILITY_OPTIONS = ['Available', 'Sold'];
export const ORIENTATIONS = ['Horizontal', 'Vertical', 'Square', 'Unknown'];
export const CANONICAL_SIZES = [
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
];
export const MISC_SIZE_CATEGORY = 'miscellaneous';

const CATALOGUE_NUMBER_RE = /^MJ-\d{3}$/;
const MISC_NUMBER_RE = /^MISC-\d{3}$/;

// A form-values object mirrors the editable admin controls:
//   { catalogNumber, category, title, image, thumbnail, medium, widthCm,
//     heightCm, sizeCategory, availability, priceAmount, priceNote, cardNote,
//     description, containImage, sortOrder }
// widthCm/heightCm/priceAmount may be '' (empty) or numbers; everything else is
// a string; containImage is boolean.

export function normalizeCatalogNumber(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

export function isValidCatalogNumber(value, category) {
  const cn = normalizeCatalogNumber(value);
  if (category === 'miscellaneous') return MISC_NUMBER_RE.test(cn);
  return CATALOGUE_NUMBER_RE.test(cn);
}

// Orientation is explicit metadata text (Horizontal/Vertical/Square), never an
// image rotation. Derived from the real physical dimensions when both are known.
export function deriveOrientation(widthCm, heightCm) {
  if (widthCm == null || heightCm == null) return 'Unknown';
  if (widthCm === heightCm) return 'Square';
  if (widthCm > heightCm) return 'Horizontal';
  return 'Vertical';
}

export function deriveDimensionsLabel(widthCm, heightCm) {
  if (widthCm == null || heightCm == null) return '';
  return `${widthCm}x${heightCm} cm`;
}

function parseDimension(value) {
  if (value === '' || value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return NaN;
  return num;
}

function parsePositiveAmount(value) {
  if (value === '' || value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return NaN;
  return num;
}

// Translate form values into a canonical record (without provenance; the caller
// attaches provenance separately). Returns { ok: true, record } or
// { ok: false, errors: [...] }.
export function formToRecord(values) {
  const errors = [];
  const v = values || {};

  const category = v.category === 'miscellaneous' ? 'miscellaneous' : 'catalogue';
  const catalogNumber = normalizeCatalogNumber(v.catalogNumber);
  const title = String(v.title == null ? '' : v.title).trim();

  if (!isValidCatalogNumber(catalogNumber, category)) {
    errors.push(category === 'miscellaneous'
      ? 'Catalog number must be MISC-xxx.'
      : 'Catalog number must be MJ-xxx.');
  }
  if (!title) {
    errors.push('Title is required.');
  }

  const widthCm = parseDimension(v.widthCm);
  const heightCm = parseDimension(v.heightCm);
  if (category === 'catalogue') {
    if (widthCm === null || Number.isNaN(widthCm)) errors.push('A positive width (cm) is required for catalogue works.');
    if (heightCm === null || Number.isNaN(heightCm)) errors.push('A positive height (cm) is required for catalogue works.');
  } else {
    if (v.widthCm !== '' && v.widthCm != null && Number.isNaN(widthCm)) errors.push('Width (cm) must be a positive number or empty.');
    if (v.heightCm !== '' && v.heightCm != null && Number.isNaN(heightCm)) errors.push('Height (cm) must be a positive number or empty.');
  }

  let sizeCategory;
  if (category === 'miscellaneous') {
    sizeCategory = MISC_SIZE_CATEGORY;
  } else {
    sizeCategory = String(v.sizeCategory == null ? '' : v.sizeCategory).trim();
    if (!CANONICAL_SIZES.includes(sizeCategory)) errors.push('Select a canonical size category.');
  }

  const availability = AVAILABILITY_OPTIONS.includes(v.availability) ? v.availability : '';
  if (!availability) errors.push('Availability must be Available or Sold.');

  const amount = parsePositiveAmount(v.priceAmount);
  if (amount === null) {
    // empty price is fine
  } else if (Number.isNaN(amount)) {
    errors.push('Price amount must be a positive number or empty.');
  }

  const rawSort = v.sortOrder;
  let sortOrder;
  if (Number.isInteger(rawSort)) {
    sortOrder = rawSort;
  } else if (typeof rawSort === 'string' && rawSort.trim() !== '') {
    sortOrder = Number(rawSort);
  } else {
    sortOrder = NaN;
  }
  if (!Number.isInteger(sortOrder) || sortOrder <= 0) {
    errors.push('Sort order must be a positive integer.');
  }

  if (errors.length) return { ok: false, errors };

  const effectiveWidth = category === 'miscellaneous' && (v.widthCm === '' || v.widthCm == null) ? null : widthCm;
  const effectiveHeight = category === 'miscellaneous' && (v.heightCm === '' || v.heightCm == null) ? null : heightCm;

  const price = amount === null ? null : {
    amount,
    currency: 'AUD',
    note: String(v.priceNote == null ? '' : v.priceNote).trim() || null
  };

  const record = {
    id: catalogNumber.toLowerCase(),
    catalogNumber,
    category,
    title,
    image: String(v.image == null ? '' : v.image).trim(),
    thumbnail: String(v.thumbnail == null ? '' : v.thumbnail).trim(),
    medium: String(v.medium == null ? '' : v.medium).trim() || null,
    dimensions: {
      widthCm: effectiveWidth,
      heightCm: effectiveHeight,
      label: deriveDimensionsLabel(effectiveWidth, effectiveHeight),
      orientation: deriveOrientation(effectiveWidth, effectiveHeight)
    },
    sizeCategory,
    availability,
    price,
    cardNote: String(v.cardNote == null ? '' : v.cardNote).trim(),
    description: String(v.description == null ? '' : v.description).trim(),
    containImage: Boolean(v.containImage),
    sortOrder
  };

  return { ok: true, record };
}

// Translate a canonical record back into form values for the editor.
export function recordToForm(record) {
  const r = record || {};
  const dims = r.dimensions || {};
  const price = r.price || {};
  return {
    catalogNumber: r.catalogNumber || '',
    category: r.category || 'catalogue',
    title: r.title || '',
    image: r.image || '',
    thumbnail: r.thumbnail || '',
    medium: r.medium || '',
    widthCm: dims.widthCm == null ? '' : dims.widthCm,
    heightCm: dims.heightCm == null ? '' : dims.heightCm,
    sizeCategory: r.sizeCategory || '',
    availability: r.availability || 'Available',
    priceAmount: price.amount == null ? '' : price.amount,
    priceNote: price.note == null ? '' : price.note,
    cardNote: r.cardNote || '',
    description: r.description || '',
    containImage: Boolean(r.containImage),
    sortOrder: r.sortOrder == null ? '' : r.sortOrder
  };
}

// Next available sort order (max + 1, or 1 for an empty list).
export function nextSortOrder(records) {
  let max = 0;
  for (const r of records) {
    if (Number.isInteger(r.sortOrder) && r.sortOrder > max) max = r.sortOrder;
  }
  return max + 1;
}

// Move the item at `index` one step in `direction` ('up' | 'down'). Returns a
// new array (no mutation). At list boundaries returns the *same* array reference
// so callers can detect a no-op and skip saving.
export function reorder(records, index, direction) {
  if (index < 0 || index >= records.length) return records;
  const swap = direction === 'up' ? index - 1 : index + 1;
  if (swap < 0 || swap >= records.length) return records;
  const list = [...records];
  [list[index], list[swap]] = [list[swap], list[index]];
  return list;
}

// Renumber a list to contiguous sortOrder 1..N, preserving order. Returns a new
// array of shallow-cloned records so callers do not mutate the source.
export function renumber(records) {
  return records.map((record, index) => ({ ...record, sortOrder: index + 1 }));
}

// Compact, read-only provenance summary for the admin. Never exposes hashes or
// raw internal values; only a human label for the source.
export function provenanceSummary(provenance) {
  const source = provenance && provenance.source;
  if (!source) return 'None';
  if (source === 'admin') return 'Admin';
  if (source === 'google-drive') return 'Google Drive import';
  if (source === 'r2-backup-or-live-fetch') return 'R2 backup / live fetch';
  return source;
}
