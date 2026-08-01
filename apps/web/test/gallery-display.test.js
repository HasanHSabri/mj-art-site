import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIZE_FILTERS,
  MISC_KEY,
  ALL_KEY,
  ALLOWED_SIZE_QUERY_VALUES,
  FILTER_LABELS,
  filterLabel,
  cardSizeKey,
  isVisible,
  countBySize,
  parseSizeQuery,
  sizeQuery,
  resultSummary,
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
});

test('ALLOWED_SIZE_QUERY_VALUES allowlists all + 11 sizes + misc only', () => {
  assert.ok(ALLOWED_SIZE_QUERY_VALUES.has(ALL_KEY));
  assert.ok(ALLOWED_SIZE_QUERY_VALUES.has(MISC_KEY));
  for (const size of SIZE_FILTERS) assert.ok(ALLOWED_SIZE_QUERY_VALUES.has(size));
  assert.equal(ALLOWED_SIZE_QUERY_VALUES.size, SIZE_FILTERS.length + 2);
  assert.equal(ALLOWED_SIZE_QUERY_VALUES.has('40x20'), false);
  assert.equal(ALLOWED_SIZE_QUERY_VALUES.has('catalogue'), false);
});

test('filterLabel renders friendly labels for all/misc and passthrough for sizes', () => {
  assert.equal(filterLabel(ALL_KEY), 'All');
  assert.equal(filterLabel(MISC_KEY), 'Miscellaneous');
  assert.equal(filterLabel('40x30'), '40x30');
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

test('parseSizeQuery accepts allowlisted values and falls back to All', () => {
  assert.equal(parseSizeQuery('all'), ALL_KEY);
  assert.equal(parseSizeQuery('miscellaneous'), MISC_KEY);
  assert.equal(parseSizeQuery('40x30'), '40x30');
  assert.equal(parseSizeQuery('  40x30  '), '40x30');
  assert.equal(parseSizeQuery('40X30'), '40x30');
  assert.equal(parseSizeQuery('bogus'), ALL_KEY);
  assert.equal(parseSizeQuery(''), ALL_KEY);
  assert.equal(parseSizeQuery(null), ALL_KEY);
  assert.equal(parseSizeQuery(undefined), ALL_KEY);
  assert.equal(parseSizeQuery(42), ALL_KEY);
});

test('sizeQuery yields clean All URL and ?size= for groups', () => {
  assert.equal(sizeQuery(ALL_KEY), '');
  assert.equal(sizeQuery('40x30'), '?size=40x30');
  assert.equal(sizeQuery(MISC_KEY), '?size=miscellaneous');
  assert.equal(sizeQuery('bogus'), '');
});

test('resultSummary uses singular/plural noun forms', () => {
  assert.equal(resultSummary(0), '0 paintings shown');
  assert.equal(resultSummary(1), '1 painting shown');
  assert.equal(resultSummary(37), '37 paintings shown');
});

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

test('buildInquiryMailto encodes subject and body and targets the contact email', () => {
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
  assert.ok(url.includes(encodeURIComponent('Painting inquiry: Spirit beneath the Ashes')));
  assert.ok(url.includes(encodeURIComponent('I love this piece!')));
});

test('buildInquiryMailto tolerates missing fields without throwing', () => {
  const url = buildInquiryMailto({});
  assert.ok(url.startsWith('mailto:?subject='));
});
