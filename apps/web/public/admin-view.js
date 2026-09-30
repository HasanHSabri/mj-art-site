// Pure, dependency-free URL view-state helpers for the admin surface.
//
// Runs in the browser (imported as an ES module by admin.js) and under
// node:test. The admin page is ONE document with focused, URL-addressable
// views (./admin.html?view=...), so the browser address bar, back/forward
// history, and shared links all describe the exact admin view:
//
//   ?view=catalogue  (default)  compact artwork catalogue
//   ?view=artwork[&id=mj-003]   focused add/edit artwork editor
//   ?view=books                  book enquiries dashboard
//
// Catalogue list state (search/availability/size/page) is carried in the same
// URL so returning from the editor -- via the in-app Back control OR the
// browser Back button -- restores exactly what the admin was looking at. Only
// non-PII artwork admin state lives here; the Books dashboard carries its
// server filters client-side and never places PII in a URL.
//
// Legacy in-page anchors from the previous single-page layout (#artwork-section,
// #books-dashboard) map onto the matching view so old bookmarks still land
// somewhere sensible.

import { CANONICAL_SIZES, MISC_SIZE_CATEGORY } from './admin-artwork.js';

export const ADMIN_VIEWS = ['catalogue', 'artwork', 'books'];
export const DEFAULT_ADMIN_VIEW = 'catalogue';

export const CATALOGUE_PAGE_SIZE = 12;

export const AVAILABILITY_FILTERS = ['all', 'Available', 'Sold'];
export const SIZE_FILTER_KEYS = ['all', ...CANONICAL_SIZES, MISC_SIZE_CATEGORY];

// Maximum length accepted for the catalogue search term; longer values are
// truncated so a pasted novel cannot produce absurd URLs.
const MAX_TERM_LENGTH = 100;
// Hard page ceiling; real catalogues are far smaller.
const MAX_PAGE = 500;

// Parse an admin URL (search + hash) into the canonical view state. Absent or
// invalid values always fall back to safe defaults rather than erroring, so
// any URL the browser can produce renders something sensible.
export function parseAdminView(search, hash = '') {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');

  let view = DEFAULT_ADMIN_VIEW;
  const rawView = (params.get('view') || '').trim().toLowerCase();
  if (ADMIN_VIEWS.includes(rawView)) {
    view = rawView;
  } else {
    const rawHash = typeof hash === 'string' ? hash.trim().toLowerCase() : '';
    if (rawHash === '#books-dashboard') view = 'books';
    else if (rawHash === '#artwork-section') view = 'catalogue';
  }

  const id = String(params.get('id') || '').trim().toLowerCase().slice(0, 100);

  const q = String(params.get('q') || '').trim().slice(0, MAX_TERM_LENGTH);

  const rawAvailability = (params.get('availability') || '').trim();
  const availability = AVAILABILITY_FILTERS.includes(rawAvailability) ? rawAvailability : 'all';

  const rawSize = (params.get('size') || '').trim();
  const size = SIZE_FILTER_KEYS.includes(rawSize) ? rawSize : 'all';

  const rawPage = Number(params.get('page'));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, MAX_PAGE) : 1;

  return { view, id, q, availability, size, page };
}

// Canonical defaults for a view state (used to compare and to omit defaults
// from serialized URLs).
export function defaultViewState(overrides = {}) {
  return {
    view: DEFAULT_ADMIN_VIEW,
    id: '',
    q: '',
    availability: 'all',
    size: 'all',
    page: 1,
    ...overrides
  };
}

// Serialize a view state to the canonical query string ('' for the default
// catalogue view). Defaults are omitted so URLs stay minimal; catalogue list
// state is kept only on the catalogue view (the editor carries just its id).
export function adminViewQuery(state) {
  const s = defaultViewState(state || {});
  const params = new URLSearchParams();

  if (s.view !== DEFAULT_ADMIN_VIEW) params.set('view', s.view);
  if (s.view === 'artwork') {
    if (s.id) params.set('id', s.id);
    return params.toString() ? '?' + params.toString() : '?view=artwork';
  }
  if (s.view === 'books') {
    return params.toString() ? '?' + params.toString() : '?view=books';
  }

  if (s.q) params.set('q', s.q);
  if (s.availability !== 'all') params.set('availability', s.availability);
  if (s.size !== 'all') params.set('size', s.size);
  if (s.page > 1) params.set('page', String(s.page));
  const query = params.toString();
  return query ? '?' + query : '';
}

// True when two view states describe the same rendered admin view (used to
// skip no-op re-renders and to detect an actual editor-content change).
export function sameViewState(a, b) {
  const x = defaultViewState(a || {});
  const y = defaultViewState(b || {});
  return (
    x.view === y.view &&
    x.id === y.id &&
    x.q === y.q &&
    x.availability === y.availability &&
    x.size === y.size &&
    x.page === y.page
  );
}
