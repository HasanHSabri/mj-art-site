// Pure, dependency-free client helpers for the public gallery.
//
// No DOM, no network. Imported by script.js (an ES module) and imported by
// node:test directly. Concerns: filter definitions (Featured + All + sizes +
// miscellaneous), deterministic featured selection, batched reveal ("load
// more"), query-string parse/serialize with validation and clamping, card
// size-key derivation, visibility selection, results status text, public
// display formatting, and enquiry mailto. The client enhances SSR cards in
// place; it never fetches /api/artworks or rebuilds the grid.

// Exact canonical catalogue size groups, in display order. Miscellaneous is a
// single additional group. "all" is the no-filter state and "featured" is the
// curated default: the first 10 public records in the artist's existing
// sortOrder (the SSR card order) -- deterministic, no invented metadata.
export const SIZE_FILTERS = [
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
export const MISC_KEY = 'miscellaneous';
export const ALL_KEY = 'all';
export const FEATURED_KEY = 'featured';

// Featured shows exactly the first FEATURED_COUNT cards in artist order; the
// Featured filter has no "load more". All/size filters reveal PAGE_SIZE cards
// at a time (first PAGE_SIZE matching works initially, then +PAGE_SIZE per
// Load more activation; no infinite scroll).
export const FEATURED_COUNT = 10;
export const PAGE_SIZE = 12;

// Allowlist of every accepted ?size=<value>: featured + all + 11 sizes + misc.
export const ALLOWED_FILTER_KEYS = new Set([
  FEATURED_KEY,
  ALL_KEY,
  ...SIZE_FILTERS,
  MISC_KEY
]);

// Human-readable labels for the filter bar. Sizes render as-is; misc and all
// use friendly labels.
export const FILTER_LABELS = {
  [FEATURED_KEY]: 'Featured',
  [ALL_KEY]: 'All',
  [MISC_KEY]: 'Miscellaneous'
};

export function filterLabel(key) {
  return FILTER_LABELS[key] || key;
}

// Derive the filter key for a card from its category/sizeCategory data attrs.
// Miscellaneous works always group under the misc key regardless of any
// incidental sizeCategory value.
export function cardSizeKey(card) {
  if (!card) return ALL_KEY;
  if (card.category === 'miscellaneous') return MISC_KEY;
  return SIZE_FILTERS.includes(card.sizeCategory) ? card.sizeCategory : ALL_KEY;
}

// True when a card with filter key `sizeKey` matches filter `key` (Featured is
// handled positionally by selectCardVisibility, not by key).
export function isVisible(key, sizeKey) {
  if (key === ALL_KEY) return true;
  return key === sizeKey;
}

// Build a counts map { all, <each size>, miscellaneous } from a list of card
// descriptors ({ category, sizeCategory }). Used to render filter bar counts.
export function countBySize(cards) {
  const counts = { [ALL_KEY]: cards.length };
  for (const key of [...SIZE_FILTERS, MISC_KEY]) counts[key] = 0;
  for (const card of cards) {
    const key = cardSizeKey(card);
    if (key in counts) counts[key] += 1;
  }
  return counts;
}

// Number of cards the given filter can ever show: Featured is capped at
// FEATURED_COUNT; All is everything; a size key counts its matching cards.
export function countMatching(cards, key) {
  if (!Array.isArray(cards)) return 0;
  if (key === FEATURED_KEY) return Math.min(cards.length, FEATURED_COUNT);
  return cards.filter((card) => key === ALL_KEY || cardSizeKey(card) === key).length;
}

// Validate a raw count input: numbers pass through (finite or not), numeric
// strings parse, anything else is NaN. Shared by clampShown and
// parseGalleryQuery so validation lives in exactly one place.
function toFiniteCount(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return NaN;
}

// Clamp a `shown` value to a valid batch state: positive integers only, floored
// to a PAGE_SIZE multiple (12/24/36...), never below PAGE_SIZE, and never above
// `total` when a total is supplied. Invalid input (NaN, strings that are not
// integers, <= 0) resolves to PAGE_SIZE. A value that reaches or exceeds
// `total` returns exactly `total` even when it is not a PAGE_SIZE multiple, so
// the final partial batch (e.g. 86 of 86, 37 of 37) is never floored back to
// 84/36 by re-normalization.
export function clampShown(value, total = Number.POSITIVE_INFINITY) {
  let n = toFiniteCount(value);
  if (!Number.isFinite(n)) n = PAGE_SIZE;
  if (Number.isFinite(total) && n >= total) return Math.max(total, 0);
  n = Math.floor(n / PAGE_SIZE) * PAGE_SIZE;
  if (n < PAGE_SIZE) n = PAGE_SIZE;
  if (Number.isFinite(total)) n = Math.min(n, Math.max(total, 0));
  return n;
}

// Pure visibility selection over SSR card descriptors (in artist/DOM order).
// Returns a boolean per card:
//   - Featured: the first FEATURED_COUNT cards in order, nothing else.
//   - All/size: the first `shown` MATCHING cards in order (Featured excluded).
export function selectCardVisibility(cards, key, shown) {
  const out = [];
  if (!Array.isArray(cards)) return out;
  let matchIndex = 0;
  for (let i = 0; i < cards.length; i++) {
    let visible = false;
    if (key === FEATURED_KEY) {
      visible = i < FEATURED_COUNT;
    } else {
      const sizeKey = cardSizeKey(cards[i]);
      if (key === ALL_KEY || sizeKey === key) {
        visible = matchIndex < shown;
        matchIndex += 1;
      }
    }
    out.push(visible);
  }
  return out;
}

// Parse a gallery URL search string ('' | '?size=...&shown=...') into the
// canonical filter state. Absent size -> Featured (the default). 'featured',
// 'all', a size key, or 'miscellaneous' are accepted case-insensitively; any
// other value is invalid and falls back to Featured. Legacy '?size=<size>'
// links keep working unchanged. `shown` only applies to All/size states: it is
// validated here (numeric string or the PAGE_SIZE fallback) but NOT floored to
// the batch grid, so an exact-total deep link (e.g. shown=86 of 86) survives;
// batch flooring and total clamping are the caller's job via clampShown with
// the real matching count.
export function parseGalleryQuery(search) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const rawSize = params.get('size');
  let key = FEATURED_KEY;
  if (typeof rawSize === 'string' && rawSize.length > 0) {
    const normalized = rawSize.trim().toLowerCase();
    if (ALLOWED_FILTER_KEYS.has(normalized)) key = normalized;
  }
  if (key === FEATURED_KEY) return { filter: FEATURED_KEY, shown: FEATURED_COUNT };
  const parsed = toFiniteCount(params.get('shown'));
  return { filter: key, shown: Number.isFinite(parsed) ? parsed : PAGE_SIZE };
}

// Serialize filter state to a canonical query string (with leading '?' or ''
// for the clean default). Featured is the clean URL; All/size carry
// ?size=<key>, and `shown` is included only once it exceeds the initial batch
// so URLs stay minimal. Pass the matching `total` so a final partial batch
// (e.g. 86 of 86) serializes exactly instead of flooring to 84. Callers append
// window.location.hash themselves.
export function galleryQuery(key, shown, total = Number.POSITIVE_INFINITY) {
  if (key === FEATURED_KEY || !ALLOWED_FILTER_KEYS.has(key)) return '';
  const params = new URLSearchParams();
  params.set('size', key);
  const batchShown = clampShown(shown, total);
  if (batchShown > PAGE_SIZE) params.set('shown', String(batchShown));
  const query = params.toString();
  return query ? `?${query}` : '';
}

// Results status text for the aria-live region: "Showing X of Y paintings".
export function resultSummary(shown, total) {
  const noun = Number(total) === 1 ? 'painting' : 'paintings';
  return `Showing ${shown} of ${total} ${noun}`;
}

// Accessible Load more label carrying next/remaining semantics, e.g.
// "Show 12 more (62 remaining)". Returns null when nothing remains.
export function loadMoreLabel(shown, total, batchSize = PAGE_SIZE) {
  const remaining = Number(total) - Number(shown);
  if (remaining <= 0) return null;
  const next = Math.min(batchSize, remaining);
  return `Show ${next} more (${remaining} remaining)`;
}

// Format a public price object. AUD is prefixed A$. null -> "Price on enquiry".
// Mirrors src/gallery-ssr.js#formatPriceDisplay exactly (parity is unit-tested).
export function formatPriceDisplay(price) {
  if (!price) return 'Price on enquiry';
  const amount = `A$${price.amount}`;
  return price.note ? `${amount} (${price.note})` : amount;
}

// Format public dimensions as "W x H cm · Orientation". Unknown/absent ->
// "Dimensions to be confirmed". Mirrors src/gallery-ssr.js exactly (parity
// is unit-tested).
export function formatDimensionsDisplay(dimensions) {
  if (!dimensions) return 'Dimensions to be confirmed';
  const { widthCm, heightCm, orientation } = dimensions;
  if (widthCm == null || heightCm == null) return 'Dimensions to be confirmed';
  return `${widthCm} x ${heightCm} cm · ${orientation}`;
}

// Build a mailto: URL for an artwork enquiry. All user fields are URL-encoded.
export function buildInquiryMailto({ email, name, customerEmail, painting, message }) {
  const safeEmail = String(email || '').trim();
  const subject = encodeURIComponent(`Painting enquiry: ${painting}`);
  const body = encodeURIComponent(
    `Hello,\n\nMy name is ${name}.\nMy email is ${customerEmail}.\n\nI would like to ask about: ${painting}\n\n${message}`
  );
  return `mailto:${safeEmail}?subject=${subject}&body=${body}`;
}
