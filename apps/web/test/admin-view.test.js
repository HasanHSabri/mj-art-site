import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_VIEWS,
  DEFAULT_ADMIN_VIEW,
  CATALOGUE_PAGE_SIZE,
  AVAILABILITY_FILTERS,
  SIZE_FILTER_KEYS,
  parseAdminView,
  defaultViewState,
  adminViewQuery,
  sameViewState
} from '../public/admin-view.js';

// ---------------------------------------------------------------------------
// parseAdminView: view + legacy hash mapping
// ---------------------------------------------------------------------------

test('parseAdminView defaults to the compact catalogue view', () => {
  assert.deepEqual(parseAdminView(''), defaultViewState());
  assert.equal(DEFAULT_ADMIN_VIEW, 'catalogue');
});

test('parseAdminView accepts each allowlisted view', () => {
  for (const view of ADMIN_VIEWS) {
    assert.equal(parseAdminView(`?view=${view}`).view, view);
  }
  assert.equal(ADMIN_VIEWS.length, 3);
});

test('parseAdminView is case-insensitive and trims the view value', () => {
  assert.equal(parseAdminView('?view=Books').view, 'books');
  assert.equal(parseAdminView('?view=%20artwork%20').view, 'artwork');
});

test('parseAdminView falls back to catalogue for an unknown view value', () => {
  assert.equal(parseAdminView('?view=admin').view, 'catalogue');
  assert.equal(parseAdminView('?view=').view, 'catalogue');
});

test('parseAdminView maps the legacy in-page anchors onto focused views', () => {
  assert.equal(parseAdminView('', '#books-dashboard').view, 'books');
  assert.equal(parseAdminView('', '#artwork-section').view, 'catalogue');
});

// ---------------------------------------------------------------------------
// parseAdminView: editor id + catalogue list state
// ---------------------------------------------------------------------------

test('parseAdminView reads the editor id, lowercased and length-bounded', () => {
  assert.equal(parseAdminView('?view=artwork&id=MJ-003').id, 'mj-003');
  assert.equal(parseAdminView('?view=artwork').id, '');
  const long = 'x'.repeat(300);
  assert.equal(parseAdminView('?view=artwork&id=' + long).id.length, 100);
});

test('parseAdminView reads catalogue search, availability, size, and page', () => {
  const state = parseAdminView('?q=still+waters&availability=Sold&size=20x20&page=3');
  assert.equal(state.view, 'catalogue');
  assert.equal(state.q, 'still waters');
  assert.equal(state.availability, 'Sold');
  assert.equal(state.size, '20x20');
  assert.equal(state.page, 3);
});

test('parseAdminView rejects non-allowlisted availability/size values', () => {
  const state = parseAdminView('?availability=Free&size=huge&page=-2&q=');
  assert.equal(state.availability, 'all');
  assert.equal(state.size, 'all');
  assert.equal(state.page, 1);
});

test('parseAdminView clamps absurd pages and truncates absurd terms', () => {
  assert.equal(parseAdminView('?page=99999').page, 500);
  assert.equal(parseAdminView('?page=0').page, 1);
  assert.equal(parseAdminView('?page=abc').page, 1);
  assert.equal(parseAdminView('?q=' + 'y'.repeat(300)).q.length, 100);
});

test('the availability and size filter allowlists cover the real catalogue groups', () => {
  assert.deepEqual(AVAILABILITY_FILTERS, ['all', 'Available', 'Sold']);
  assert.ok(SIZE_FILTER_KEYS.includes('all'));
  assert.ok(SIZE_FILTER_KEYS.includes('miscellaneous'));
  for (const size of ['20x20', '30x30', '58x73']) {
    assert.ok(SIZE_FILTER_KEYS.includes(size), size);
  }
});

// ---------------------------------------------------------------------------
// adminViewQuery / sameViewState round-trips
// ---------------------------------------------------------------------------

test('adminViewQuery keeps the default catalogue URL clean and omits defaults', () => {
  assert.equal(adminViewQuery(defaultViewState()), '');
  assert.equal(adminViewQuery({ q: '', availability: 'all', size: 'all', page: 1 }), '');
  assert.equal(adminViewQuery({ q: 'sea', availability: 'all', size: 'all', page: 1 }), '?q=sea');
  assert.equal(adminViewQuery({ page: 2 }), '?page=2');
});

test('adminViewQuery serializes the editor and books views addressably', () => {
  assert.equal(adminViewQuery({ view: 'artwork' }), '?view=artwork');
  assert.equal(adminViewQuery({ view: 'artwork', id: 'mj-004' }), '?view=artwork&id=mj-004');
  assert.equal(adminViewQuery({ view: 'books' }), '?view=books');
});

test('adminViewQuery serializes full catalogue list state', () => {
  assert.equal(
    adminViewQuery({ q: 'mj-00', availability: 'Sold', size: 'miscellaneous', page: 4 }),
    '?q=mj-00&availability=Sold&size=miscellaneous&page=4'
  );
});

test('parseAdminView and adminViewQuery round-trip every view state', () => {
  for (const state of [
    defaultViewState(),
    { view: 'artwork' },
    { view: 'artwork', id: 'misc-011' },
    { view: 'books' },
    { q: 'river', availability: 'Available', size: '25x25', page: 7 }
  ]) {
    const query = adminViewQuery(state);
    assert.deepEqual(parseAdminView(query), defaultViewState(state), query || '(clean url)');
  }
});

test('sameViewState compares canonical state and ignores omitted defaults', () => {
  assert.equal(sameViewState({ view: 'catalogue' }, defaultViewState()), true);
  assert.equal(sameViewState({ view: 'catalogue', page: 1 }, { view: 'catalogue' }), true);
  assert.equal(sameViewState({ view: 'artwork', id: 'mj-001' }, { view: 'artwork', id: 'mj-002' }), false);
  assert.equal(sameViewState({ page: 2 }, { page: 1 }), false);
});

test('the catalogue page size is 12', () => {
  assert.equal(CATALOGUE_PAGE_SIZE, 12);
});
