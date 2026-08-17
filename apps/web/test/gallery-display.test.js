import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIZE_FILTERS,
  MISC_KEY,
  ALL_KEY,
  FEATURED_KEY,
  FEATURED_COUNT,
  PAGE_SIZE,
  ALLOWED_FILTER_KEYS,
  FILTER_LABELS,
  filterLabel,
  cardSizeKey,
  isVisible,
  countBySize,
  countMatching,
  clampShown,
  selectCardVisibility,
  parseGalleryQuery,
  galleryQuery,
  resultSummary,
  loadMoreLabel,
  formatPriceDisplay,
  formatDimensionsDisplay,
  buildInquiryMailto
} from '../public/gallery-display.js';

// Canonical descriptor set mirroring the real 86-work catalogue counts.
function realCatalogueDescriptors() {
  const counts = {
    '20x20': 37,
    '20x25': 11,
    '25x25': 4,
    '30x23': 1,
    '30x30': 6,
    '35x28': 2,
    '40x30': 10,
    '47x57': 1,
    '50x25': 1,
    '55x30': 1,
    '58x73': 1,
    miscellaneous: 11
  };
  const cards = [];
  for (const [size, n] of Object.entries(counts)) {
    const category = size === 'miscellaneous' ? 'miscellaneous' : 'catalogue';
    for (let i = 0; i < n; i++) {
      cards.push({ category, sizeCategory: size });
    }
  }
  return cards;
}

test('SIZE_FILTERS has exactly the 11 canonical sizes in display order', () => {
  assert.deepEqual(SIZE_FILTERS, [
    '20x20', '20x25', '25x25', '30x23', '30x30', '35x28',
    '40x30', '47x57', '50x25', '55x30', '58x73'
  ]);
});

test('filter constants are stable sentinels', () => {
  assert.equal(MISC_KEY, 'miscellaneous');
  assert.equal(ALL_KEY, 'all');
  assert.equal(FEATURED_KEY, 'featured');
  assert.equal(FEATURED_COUNT, 10);
  assert.equal(PAGE_SIZE, 12);
});

test('ALLOWED_FILTER_KEYS allowlists featured + all + 11 sizes + misc only', () => {
  assert.ok(ALLOWED_FILTER_KEYS.has(FEATURED_KEY));
  assert.ok(ALLOWED_FILTER_KEYS.has(ALL_KEY));
  assert.ok(ALLOWED_FILTER_KEYS.has(MISC_KEY));
  for (const size of SIZE_FILTERS) assert.ok(ALLOWED_FILTER_KEYS.has(size));
  assert.equal(ALLOWED_FILTER_KEYS.size, SIZE_FILTERS.length + 3);
  assert.equal(ALLOWED_FILTER_KEYS.has('40x20'), false);
  assert.equal(ALLOWED_FILTER_KEYS.has('catalogue'), false);
});

test('filterLabel renders friendly labels for featured/all/misc and passthrough for sizes', () => {
  assert.equal(filterLabel(FEATURED_KEY), 'Featured');
  assert.equal(filterLabel(ALL_KEY), 'All');
  assert.equal(filterLabel(MISC_KEY), 'Miscellaneous');
  assert.equal(filterLabel('40x30'), '40x30');
  assert.equal(FILTER_LABELS[FEATURED_KEY], 'Featured');
  assert.equal(FILTER_LABELS[ALL_KEY], 'All');
  assert.equal(FILTER_LABELS[MISC_KEY], 'Miscellaneous');
});

test('cardSizeKey groups miscellaneous under the misc key regardless of sizeCategory', () => {
  assert.equal(cardSizeKey({ category: 'miscellaneous', sizeCategory: 'miscellaneous' }), MISC_KEY);
  assert.equal(cardSizeKey({ category: 'miscellaneous', sizeCategory: '40x30' }), MISC_KEY);
  assert.equal(cardSizeKey({ category: 'catalogue', sizeCategory: '40x30' }), '40x30');
  assert.equal(cardSizeKey({ category: 'catalogue', sizeCategory: 'unknown' }), ALL_KEY);
  assert.equal(cardSizeKey(null), ALL_KEY);
  assert.equal(cardSizeKey(undefined), ALL_KEY);
});

test('isVisible is true for All and exact match otherwise', () => {
  assert.equal(isVisible(ALL_KEY, '40x30'), true);
  assert.equal(isVisible(ALL_KEY, MISC_KEY), true);
  assert.equal(isVisible('40x30', '40x30'), true);
  assert.equal(isVisible('40x30', '20x20'), false);
  assert.equal(isVisible(MISC_KEY, MISC_KEY), true);
  assert.equal(isVisible(MISC_KEY, '40x30'), false);
});

test('countBySize produces the real 86-work catalogue counts', () => {
  const counts = countBySize(realCatalogueDescriptors());
  assert.equal(counts[ALL_KEY], 86);
  assert.equal(counts['20x20'], 37);
  assert.equal(counts['20x25'], 11);
  assert.equal(counts['25x25'], 4);
  assert.equal(counts['30x23'], 1);
  assert.equal(counts['30x30'], 6);
  assert.equal(counts['35x28'], 2);
  assert.equal(counts['40x30'], 10);
  assert.equal(counts['47x57'], 1);
  assert.equal(counts['50x25'], 1);
  assert.equal(counts['55x30'], 1);
  assert.equal(counts['58x73'], 1);
  assert.equal(counts[MISC_KEY], 11);
  // The per-group counts sum to the All total.
  const sum = [...SIZE_FILTERS, MISC_KEY].reduce((s, k) => s + counts[k], 0);
  assert.equal(sum, 86);
});

test('countBySize initialises every group to zero for empty input', () => {
  const counts = countBySize([]);
  assert.equal(counts[ALL_KEY], 0);
  for (const k of [...SIZE_FILTERS, MISC_KEY]) assert.equal(counts[k], 0);
});

// --- Featured selection + batched reveal -----------------------------------

test('countMatching: featured is capped at the first 10, all/size count matches', () => {
  const cards = realCatalogueDescriptors();
  assert.equal(countMatching(cards, FEATURED_KEY), 10);
  assert.equal(countMatching(cards, ALL_KEY), 86);
  assert.equal(countMatching(cards, '20x20'), 37);
  assert.equal(countMatching(cards, MISC_KEY), 11);
  // Fewer cards than the featured window: featured is everything available.
  assert.equal(countMatching(cards.slice(0, 6), FEATURED_KEY), 6);
  assert.equal(countMatching([], FEATURED_KEY), 0);
  assert.equal(countMatching(null, ALL_KEY), 0);
});

test('selectCardVisibility: featured is exactly the first 10 in artist order', () => {
  const cards = realCatalogueDescriptors();
  const visibility = selectCardVisibility(cards, FEATURED_KEY, 10);
  assert.equal(visibility.length, 86);
  assert.equal(visibility.filter(Boolean).length, 10);
  // The first 10 DOM positions (the artist's sortOrder) and nothing else.
  for (let i = 0; i < 86; i++) assert.equal(visibility[i], i < 10);
});

test('selectCardVisibility: all/size show the first `shown` matching works', () => {
  const cards = realCatalogueDescriptors();
  const all12 = selectCardVisibility(cards, ALL_KEY, 12);
  assert.equal(all12.filter(Boolean).length, 12);
  for (let i = 0; i < 86; i++) assert.equal(all12[i], i < 12);

  const all24 = selectCardVisibility(cards, ALL_KEY, 24);
  assert.equal(all24.filter(Boolean).length, 24);

  // A size filter counts only matching cards, in order.
  const size12 = selectCardVisibility(cards, '20x20', 12);
  let seen = 0;
  for (let i = 0; i < cards.length; i++) {
    const matches = cards[i].sizeCategory === '20x20';
    if (matches) seen += 1;
    assert.equal(size12[i], matches && seen <= 12, `card ${i}`);
  }
  assert.equal(size12.filter(Boolean).length, 12);

  // Final batch: only the remaining matching works show.
  const size37 = selectCardVisibility(cards, '20x20', 37);
  assert.equal(size37.filter(Boolean).length, 37);
});

test('selectCardVisibility guards non-array input', () => {
  assert.deepEqual(selectCardVisibility(undefined, FEATURED_KEY, 10), []);
  assert.deepEqual(selectCardVisibility(null, ALL_KEY, 12), []);
});

// --- URL state: parse + serialize + clamp ----------------------------------

test('clampShown floors to batch multiples, never below the initial batch, caps at total', () => {
  assert.equal(clampShown(12), 12);
  assert.equal(clampShown(24), 24);
  assert.equal(clampShown(36), 36);
  assert.equal(clampShown(50), 48, 'non-multiples floor to the batch grid');
  assert.equal(clampShown(5), 12, 'below the initial batch clamps up to 12');
  assert.equal(clampShown(0), 12);
  assert.equal(clampShown(-3), 12);
  assert.equal(clampShown(NaN), 12);
  assert.equal(clampShown('24'), 24, 'numeric strings parse');
  assert.equal(clampShown('  24  '), 24);
  assert.equal(clampShown('bogus'), 12);
  assert.equal(clampShown(null), 12);
  assert.equal(clampShown(undefined), 12);
  // Total clamping (small groups, final batches).
  assert.equal(clampShown(24, 16), 16, 'caps at the matching total');
  assert.equal(clampShown(12, 1), 1, 'a single-match group shows one');
  assert.equal(clampShown(12, 0), 0, 'an empty group shows none');
  assert.equal(clampShown(200, 86), 86);
});

test('clampShown preserves the exact total for final partial batches (84->86, 36->37)', () => {
  // The Load more handler math: shown + PAGE_SIZE reaching the total.
  assert.equal(clampShown(84 + PAGE_SIZE, 86), 86, '84 -> 86 completes the 86-work All view');
  assert.equal(clampShown(36 + PAGE_SIZE, 37), 37, '36 -> 37 completes the 37-work 20x20 view');
  // applyState re-normalization must not floor a reached total back to the grid.
  assert.equal(clampShown(86, 86), 86, 'a reached total stays exact, not floored to 84');
  assert.equal(clampShown(37, 37), 37, 'a reached total stays exact, not floored to 36');
  assert.equal(clampShown('86', 86), 86, 'numeric strings restore the exact total too');
  // Below-total non-multiples keep the floor behaviour (no skipping forward).
  assert.equal(clampShown(85, 86), 84);
  assert.equal(clampShown(50, 86), 48);
  assert.equal(clampShown(36, 37), 36);
});

test('clampShown stays safe for malformed and excess input alongside a total', () => {
  assert.equal(clampShown('bogus', 86), 12, 'malformed resolves to the initial batch');
  assert.equal(clampShown(null, 86), 12);
  assert.equal(clampShown(undefined, 86), 12);
  assert.equal(clampShown(-5, 86), 12, 'negative input clamps up to the initial batch');
  assert.equal(clampShown(200, 86), 86, 'excess input clamps down to the total');
  assert.equal(clampShown(200, 37), 37);
  assert.equal(clampShown('999', 37), 37);
});

test('parseGalleryQuery: absent/invalid size resolves to the Featured default', () => {
  assert.deepEqual(parseGalleryQuery(''), { filter: FEATURED_KEY, shown: FEATURED_COUNT });
  assert.deepEqual(parseGalleryQuery('?'), { filter: FEATURED_KEY, shown: FEATURED_COUNT });
  assert.deepEqual(parseGalleryQuery('?size=featured'), { filter: FEATURED_KEY, shown: FEATURED_COUNT });
  assert.deepEqual(parseGalleryQuery('?size=bogus'), { filter: FEATURED_KEY, shown: FEATURED_COUNT });
  assert.deepEqual(parseGalleryQuery('?size='), { filter: FEATURED_KEY, shown: FEATURED_COUNT });
  assert.deepEqual(parseGalleryQuery(null), { filter: FEATURED_KEY, shown: FEATURED_COUNT });
  // shown never applies to Featured.
  assert.deepEqual(parseGalleryQuery('?size=featured&shown=36'), { filter: FEATURED_KEY, shown: FEATURED_COUNT });
});

test('parseGalleryQuery: all/sizes/misc parse case-insensitively and keep legacy links working', () => {
  assert.deepEqual(parseGalleryQuery('?size=all'), { filter: ALL_KEY, shown: 12 });
  assert.deepEqual(parseGalleryQuery('?size=40x30'), { filter: '40x30', shown: 12 });
  assert.deepEqual(parseGalleryQuery('?size=40X30'), { filter: '40x30', shown: 12 });
  assert.deepEqual(parseGalleryQuery('?size=miscellaneous'), { filter: MISC_KEY, shown: 12 });
  // Legacy deep link with a batch. parseGalleryQuery validates but defers
  // batch flooring to the caller's total-aware clampShown, so exact-total
  // values (86, 37) survive while sub-grid values (50, 99) stay raw here and
  // floor/clamp once the matching total is known.
  assert.deepEqual(parseGalleryQuery('?size=all&shown=24'), { filter: ALL_KEY, shown: 24 });
  assert.deepEqual(parseGalleryQuery('?size=all&shown=50'), { filter: ALL_KEY, shown: 50 });
  assert.deepEqual(parseGalleryQuery('?size=all&shown=bogus'), { filter: ALL_KEY, shown: 12 });
  assert.deepEqual(parseGalleryQuery('?size=20x20&shown=99'), { filter: '20x20', shown: 99 });
});

test('galleryQuery serializes canonical URLs: clean Featured, size+shown otherwise', () => {
  assert.equal(galleryQuery(FEATURED_KEY, 10), '');
  assert.equal(galleryQuery('bogus', 12), '');
  assert.equal(galleryQuery(ALL_KEY, 12), '?size=all');
  assert.equal(galleryQuery(ALL_KEY, 24), '?size=all&shown=24');
  assert.equal(galleryQuery('40x30', 12), '?size=40x30');
  assert.equal(galleryQuery('40x30', 24), '?size=40x30&shown=24');
  assert.equal(galleryQuery(MISC_KEY, 24), '?size=miscellaneous&shown=24');
});

test('parseGalleryQuery preserves an exact-total shown for direct deep links', () => {
  // Direct ?size=all&shown=86 must restore all 86 (not floor to 84) once the
  // caller applies the total-aware clamp.
  assert.deepEqual(parseGalleryQuery('?size=all&shown=86'), { filter: ALL_KEY, shown: 86 });
  assert.deepEqual(parseGalleryQuery('?size=20x20&shown=37'), { filter: '20x20', shown: 37 });
  // Malformed/absent values stay safe at the initial batch.
  assert.deepEqual(parseGalleryQuery('?size=all&shown=bogus'), { filter: ALL_KEY, shown: 12 });
  assert.deepEqual(parseGalleryQuery('?size=all&shown='), { filter: ALL_KEY, shown: 12 });
  assert.deepEqual(parseGalleryQuery('?size=all'), { filter: ALL_KEY, shown: 12 });
  // End to end: parse then total-aware clamp restores the exact total.
  const all86 = parseGalleryQuery('?size=all&shown=86');
  assert.equal(clampShown(all86.shown, 86), 86);
  const size37 = parseGalleryQuery('?size=20x20&shown=37');
  assert.equal(clampShown(size37.shown, 37), 37);
});

test('galleryQuery serializes final partial batches exactly when the total is known', () => {
  assert.equal(galleryQuery(ALL_KEY, 86, 86), '?size=all&shown=86', 'the 86-of-86 URL keeps shown=86');
  assert.equal(galleryQuery('20x20', 37, 37), '?size=20x20&shown=37', 'the 37-of-37 URL keeps shown=37');
  assert.equal(galleryQuery(ALL_KEY, 84, 86), '?size=all&shown=84');
  assert.equal(galleryQuery(ALL_KEY, 12, 86), '?size=all');
  assert.equal(galleryQuery('20x20', 24, 37), '?size=20x20&shown=24');
});

// --- Status + load more labels ---------------------------------------------

test('resultSummary reads "Showing X of Y paintings" with singular/plural noun', () => {
  assert.equal(resultSummary(0, 0), 'Showing 0 of 0 paintings');
  assert.equal(resultSummary(1, 1), 'Showing 1 of 1 painting');
  assert.equal(resultSummary(12, 86), 'Showing 12 of 86 paintings');
  assert.equal(resultSummary(10, 10), 'Showing 10 of 10 paintings');
});

test('loadMoreLabel carries next/remaining semantics and null when complete', () => {
  assert.equal(loadMoreLabel(12, 86), 'Show 12 more (74 remaining)');
  assert.equal(loadMoreLabel(74, 86), 'Show 12 more (12 remaining)');
  assert.equal(loadMoreLabel(80, 86), 'Show 6 more (6 remaining)');
  assert.equal(loadMoreLabel(86, 86), null);
  assert.equal(loadMoreLabel(90, 86), null);
  assert.equal(loadMoreLabel(37, 37), null);
});

// --- Public display formatting (unchanged parity with SSR) ------------------

test('formatPriceDisplay formats AUD as A$ and enquiry fallback', () => {
  assert.equal(formatPriceDisplay(null), 'Price on enquiry');
  assert.equal(formatPriceDisplay({ amount: 40, currency: 'AUD', note: null }), 'A$40');
  assert.equal(formatPriceDisplay({ amount: 40, currency: 'AUD', note: 'postage extra' }), 'A$40 (postage extra)');
  assert.equal(formatPriceDisplay({ amount: 150, currency: 'AUD', note: 'framed' }), 'A$150 (framed)');
});

test('formatDimensionsDisplay shows dimensions and orientation, never rotation', () => {
  assert.equal(formatDimensionsDisplay(null), 'Dimensions to be confirmed');
  assert.equal(formatDimensionsDisplay({ widthCm: null, heightCm: null, orientation: 'Unknown' }), 'Dimensions to be confirmed');
  assert.equal(
    formatDimensionsDisplay({ widthCm: 40, heightCm: 30, orientation: 'Horizontal' }),
    '40 x 30 cm · Horizontal'
  );
  assert.equal(
    formatDimensionsDisplay({ widthCm: 20, heightCm: 20, orientation: 'Square' }),
    '20 x 20 cm · Square'
  );
});

test('buildInquiryMailto encodes the enquiry subject and body and targets the contact email', () => {
  const url = buildInquiryMailto({
    email: 'mjdonnellan73@gmail.com',
    name: 'Jane Smith',
    customerEmail: 'jane@example.com',
    painting: 'Spirit beneath the Ashes',
    message: 'I love this piece!'
  });
  assert.ok(url.startsWith('mailto:mjdonnellan73@gmail.com?subject='));
  assert.ok(url.includes('&body='));
  // User-supplied free text must be percent-encoded (no raw spaces in query).
  assert.equal(url.includes('Jane Smith'), false);
  assert.ok(url.includes(encodeURIComponent('Painting enquiry: Spirit beneath the Ashes')));
  assert.ok(url.includes(encodeURIComponent('I love this piece!')));
});

test('buildInquiryMailto tolerates missing fields without throwing', () => {
  const url = buildInquiryMailto({});
  assert.ok(url.startsWith('mailto:?subject='));
});
