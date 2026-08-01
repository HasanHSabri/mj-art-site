// Pure, dependency-free client helpers for the public gallery.
//
// No DOM, no network. Imported by script.js (an ES module) and imported by
// node:test directly. Concerns: size filter definitions, query-string parsing,
// card size-key derivation, visibility predicate, results status text, public
// display formatting, and inquiry mailto. The client enhances SSR cards in
// place; it never fetches /api/artworks or rebuilds the grid.

// Exact canonical catalogue size groups, in display order. Miscellaneous is a
// single additional group. "all" is the no-filter state.
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

// Allowlist of every accepted ?size=<value>. Anything else resolves to "all".
export const ALLOWED_SIZE_QUERY_VALUES = new Set([ALL_KEY, ...SIZE_FILTERS, MISC_KEY]);

// Human-readable labels for the filter bar. Sizes render as-is; misc and all
// use friendly labels.
export const FILTER_LABELS = {
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

// True when a card with filter key `sizeKey` is visible under filter `key`.
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

// Parse and validate a ?size= query value. Non-strings and unknown values
// resolve to ALL_KEY (invalid -> All). Case-insensitive.
export function parseSizeQuery(value) {
  if (typeof value !== 'string') return ALL_KEY;
  const key = value.trim().toLowerCase();
  return ALLOWED_SIZE_QUERY_VALUES.has(key) ? key : ALL_KEY;
}

// The query string (with leading "?") that represents `key`, or '' for All so
// the URL stays clean. Callers use history.replaceState without navigation.
export function sizeQuery(key) {
  if (key === ALL_KEY || !ALLOWED_SIZE_QUERY_VALUES.has(key)) return '';
  return `?size=${key}`;
}

// Results status text for the aria-live region, e.g. "37 paintings shown".
export function resultSummary(visibleCount) {
  const noun = visibleCount === 1 ? 'painting' : 'paintings';
  return `${visibleCount} ${noun} shown`;
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

// Build a mailto: URL for an artwork inquiry. All user fields are URL-encoded.
export function buildInquiryMailto({ email, name, customerEmail, painting, message }) {
  const safeEmail = String(email || '').trim();
  const subject = encodeURIComponent(`Painting inquiry: ${painting}`);
  const body = encodeURIComponent(
    `Hello,\n\nMy name is ${name}.\nMy email is ${customerEmail}.\n\nI would like to ask about: ${painting}\n\n${message}`
  );
  return `mailto:${safeEmail}?subject=${subject}&body=${body}`;
}
