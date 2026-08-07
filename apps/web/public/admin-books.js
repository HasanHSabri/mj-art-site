// Pure, dependency-free helpers for the Books EOI admin dashboard.
//
// Runs in the browser (imported as an ES module by admin.js) and under
// node:test (no DOM, no network). Every function operates on plain values so
// they can be unit-tested directly. This module holds ONLY presentation/
// derivation helpers: it never fetches, never touches the DOM, and never reads
// or builds HTML. All PII rendering in admin.js uses textContent/DOM APIs built
// from these label/string helpers, never innerHTML.

// Allowlist mirrors src/book-eoi.js (BOOK_CODES / FORMAT_CODES /
// BOOK_EOI_STATUSES). Kept as plain objects for O(1) label lookup.
export const BOOK_LABELS = { biography: 'Biography', childrens: "Children's Book" };
export const FORMAT_LABELS = { hardcover: 'Hardcover', paperback: 'Paperback', ebook: 'E-book', unsure: 'Unsure' };
export const STATUS_LABELS = { new: 'New', contacted: 'Contacted', withdrawn: 'Withdrawn' };

// Stable display order for filters and tile grouping.
export const BOOK_ORDER = ['biography', 'childrens'];
export const STATUS_ORDER = ['new', 'contacted', 'withdrawn'];

// Human labels for stored codes; fall back to the raw value (or an em dash) so
// an unexpected code is still visible rather than silently blank.
export function formatBookLabel(code) {
  return BOOK_LABELS[code] || (code == null || code === '' ? '—' : String(code));
}

export function formatFormatLabel(code) {
  return FORMAT_LABELS[code] || (code == null || code === '' ? '—' : String(code));
}

export function formatStatusLabel(code) {
  return STATUS_LABELS[code] || (code == null || code === '' ? '—' : String(code));
}

// Locale-independent, UTC timestamp formatting for admin display. Returns an em
// dash for a missing/invalid value so a cell never renders "Invalid Date".
export function formatCreatedDate(value) {
  if (value === '' || value == null) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const iso = d.toISOString();
  return iso.slice(0, 10) + ' ' + iso.slice(11, 16) + ' UTC';
}

// Build a safe mailto: URL from a decrypted admin email. Returns '' for any
// missing/over-long/invalid value so the caller renders fallback text instead.
// The result is assigned to an <a>.href property (never innerHTML), and the
// address is percent-encoded so it cannot break out of the mailto scheme or
// inject attributes. Rejects addresses containing characters that are dangerous
// in URL/header contexts (< > " \s) or that fail a conservative email shape.
export function safeMailtoHref(email) {
  if (typeof email !== 'string') return '';
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return '';
  if (!/^[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+$/.test(trimmed)) return '';
  return 'mailto:' + encodeURIComponent(trimmed);
}

// Normalize the summary API response into the ordered tile model the UI renders.
// Tolerant of a missing/partial response (e.g. a load failure passes null) so
// the grid always renders a stable set of tiles with zeros. Book values are
// active interest (withdrawn excluded); window values are raw submissions by
// created_at and still include records later withdrawn. Last 7 days is the
// trailing 168 hours in UTC.
export function buildSummaryTiles(summary) {
  const s = summary || {};
  const books = s.books || {};
  const byStatus = s.byStatus || {};
  const numeric = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  };
  const bookTile = (code) => ({
    kind: 'book',
    key: code,
    label: BOOK_LABELS[code] || code,
    value: numeric(books[code] && books[code].interestCount),
    secondary: numeric(books[code] && books[code].requestedCopies)
  });
  const windowTile = (key, label) => ({
    kind: 'window',
    key,
    label,
    value: numeric(s[key] && s[key].submissions),
    secondary: numeric(s[key] && s[key].copies)
  });
  const statusTile = (code) => ({
    kind: 'status',
    key: code,
    label: STATUS_LABELS[code] || code,
    value: numeric(byStatus[code])
  });
  return [
    bookTile('biography'),
    bookTile('childrens'),
    windowTile('today', 'Submissions received — Today'),
    windowTile('last7Days', 'Submissions received — Last 7 days'),
    statusTile('new'),
    statusTile('contacted'),
    statusTile('withdrawn'),
    {
      kind: 'total',
      key: 'total',
      label: 'Total',
      value: numeric(s.total)
    }
  ];
}

// Client-side filter for the recent list. `term` matches name OR email
// (case-insensitive). `book`/`status` are exact allowlist filters; 'all' or ''
// means "no filter on this dimension". Order is preserved (the API already
// returns newest-first); this does not sort.
export function filterRows(rows, { term = '', book = 'all', status = 'all' } = {}) {
  const t = String(term == null ? '' : term).trim().toLowerCase();
  const wantBook = book && book !== 'all' ? book : null;
  const wantStatus = status && status !== 'all' ? status : null;
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((r) => {
    if (!r || typeof r !== 'object') return false;
    if (wantBook && r.book !== wantBook) return false;
    if (wantStatus && r.status !== wantStatus) return false;
    if (t) {
      const name = String(r.name == null ? '' : r.name).toLowerCase();
      const email = String(r.email == null ? '' : r.email).toLowerCase();
      if (!name.includes(t) && !email.includes(t)) return false;
    }
    return true;
  });
}

// Pure RFC 4180-ish CSV serializer for the recent rows. No UI export is wired
// in this phase; the helper is exported and tested so a future "download CSV"
// control can use it without re-deriving quoting rules. Values are quoted when
// they contain a comma, double-quote, or newline; embedded quotes are doubled.
// Labels use the human book/format/status labels (not the raw codes).
export function toCsv(rows) {
  const cols = ['createdAt', 'name', 'email', 'book', 'format', 'quantity', 'status'];
  const header = cols.join(',');
  const labelFor = { book: formatBookLabel, format: formatFormatLabel, status: formatStatusLabel };
  const cell = (r, c) => {
    let v;
    if (c === 'createdAt') v = r[c] == null ? '' : formatCreatedDate(r[c]);
    else if (labelFor[c]) v = r[c] == null ? '' : labelFor[c](r[c]);
    else v = r[c] == null ? '' : String(r[c]);
    v = String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = (Array.isArray(rows) ? rows : []).map((r) => cols.map((c) => cell(r, c)).join(','));
  return [header, ...lines].join('\n');
}
