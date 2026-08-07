import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  BOOK_LABELS,
  FORMAT_LABELS,
  STATUS_LABELS,
  BOOK_ORDER,
  STATUS_ORDER,
  formatBookLabel,
  formatFormatLabel,
  formatStatusLabel,
  formatCreatedDate,
  safeMailtoHref,
  buildSummaryTiles,
  filterRows,
  toCsv
} from '../public/admin-books.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminJs = readFileSync(join(__dirname, '..', 'public', 'admin.js'), 'utf8');
const adminCss = readFileSync(join(__dirname, '..', 'public', 'admin.css'), 'utf8');
const adminHtml = readFileSync(join(__dirname, '..', 'public', 'admin.html'), 'utf8');

// ---------------------------------------------------------------------------
// Allowlist / label helpers
// ---------------------------------------------------------------------------

test('label maps cover every book/format/status code from the backend allowlist', () => {
  assert.deepEqual(Object.keys(BOOK_LABELS).sort(), ['biography', 'childrens']);
  assert.deepEqual(Object.keys(FORMAT_LABELS).sort(), ['ebook', 'hardcover', 'paperback', 'unsure']);
  assert.deepEqual(Object.keys(STATUS_LABELS).sort(), ['contacted', 'new', 'withdrawn']);
});

test('formatBookLabel / formatFormatLabel / formatStatusLabel map known codes and fall back gracefully', () => {
  assert.equal(formatBookLabel('biography'), 'Biography');
  assert.equal(formatBookLabel('childrens'), "Children's Book");
  assert.equal(formatFormatLabel('ebook'), 'E-book');
  assert.equal(formatStatusLabel('new'), 'New');
  assert.equal(formatStatusLabel('contacted'), 'Contacted');
  assert.equal(formatStatusLabel('withdrawn'), 'Withdrawn');
  // Unknown / empty -> em dash, never blank.
  assert.equal(formatBookLabel('mystery'), 'mystery');
  assert.equal(formatBookLabel(''), '—');
  assert.equal(formatBookLabel(null), '—');
});

test('BOOK_ORDER and STATUS_ORDER are the canonical display orders', () => {
  assert.deepEqual(BOOK_ORDER, ['biography', 'childrens']);
  assert.deepEqual(STATUS_ORDER, ['new', 'contacted', 'withdrawn']);
});

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

test('formatCreatedDate formats a UTC timestamp and handles invalid input', () => {
  const out = formatCreatedDate('2026-08-07T13:45:30.000Z');
  assert.equal(out, '2026-08-07 13:45 UTC');
  assert.equal(formatCreatedDate(''), '—');
  assert.equal(formatCreatedDate(null), '—');
  assert.equal(formatCreatedDate(undefined), '—');
  assert.equal(formatCreatedDate('not-a-date'), '—');
  assert.equal(formatCreatedDate(new Date('2026-08-07T09:00:00.000Z')), '2026-08-07 09:00 UTC');
});

// ---------------------------------------------------------------------------
// Safe mailto construction (XSS / injection resistance)
// ---------------------------------------------------------------------------

test('safeMailtoHref builds a percent-encoded mailto for a valid email', () => {
  assert.equal(safeMailtoHref('jane@example.com'), 'mailto:jane%40example.com');
});

test('safeMailtoHref returns empty string for missing/over-long/non-email input', () => {
  assert.equal(safeMailtoHref(''), '');
  assert.equal(safeMailtoHref(null), '');
  assert.equal(safeMailtoHref(undefined), '');
  assert.equal(safeMailtoHref(42), '');
  assert.equal(safeMailtoHref('noat'), '');
  assert.equal(safeMailtoHref('a@b'), '');
  assert.equal(safeMailtoHref('a'.repeat(320) + '@example.com'), '');
});

test('safeMailtoHref rejects injection / attribute-breakout payloads', () => {
  // These must never yield a usable mailto: an attacker cannot smuggle quotes,
  // angle brackets, whitespace, or a different scheme through the email field.
  for (const evil of [
    '" onload="alert(1)',
    'a@b.c" onmouseover="evil',
    'javascript:alert(1)',
    'a@b.c\r\nBcc: victim@x',
    '<script>alert(1)</script>@x.com',
    'a b@example.com'
  ]) {
    assert.equal(safeMailtoHref(evil), '', `rejected: ${evil}`);
  }
});

// ---------------------------------------------------------------------------
// buildSummaryTiles
// ---------------------------------------------------------------------------

test('buildSummaryTiles returns the canonical ordered tile set from a full summary', () => {
  const tiles = buildSummaryTiles({
    books: {
      biography: { interestCount: 3, requestedCopies: 7 },
      childrens: { interestCount: 1, requestedCopies: 2 }
    },
    today: { submissions: 2, copies: 4 },
    last7Days: { submissions: 5, copies: 9 },
    byStatus: { new: 4, contacted: 2, withdrawn: 1 },
    total: 7
  });
  assert.equal(tiles.length, 7);
  assert.deepEqual(tiles.map((t) => t.key), ['biography', 'childrens', 'today', 'last7Days', 'new', 'contacted', 'withdrawn']);
  const bio = tiles[0];
  assert.equal(bio.kind, 'book');
  assert.equal(bio.label, 'Biography');
  assert.equal(bio.interest, 3);
  assert.equal(bio.copies, 7);
  const today = tiles[2];
  assert.equal(today.kind, 'window');
  assert.equal(today.submissions, 2);
  assert.equal(today.copies, 4);
  const withdrawn = tiles[6];
  assert.equal(withdrawn.kind, 'status');
  assert.equal(withdrawn.value, 1);
});

test('buildSummaryTiles is tolerant of null/partial input (zeros, never throws)', () => {
  const tiles = buildSummaryTiles(null);
  assert.equal(tiles.length, 7);
  for (const t of tiles) {
    if (t.kind === 'status') assert.equal(t.value, 0);
    else if (t.kind === 'book') { assert.equal(t.interest, 0); assert.equal(t.copies, 0); }
    else { assert.equal(t.submissions, 0); assert.equal(t.copies, 0); }
  }
  const partial = buildSummaryTiles({ books: { biography: { interestCount: 5 } } });
  assert.equal(partial[0].interest, 5);
  assert.equal(partial[0].copies, 0);
  assert.equal(partial[1].interest, 0); // childrens missing
});

// ---------------------------------------------------------------------------
// filterRows
// ---------------------------------------------------------------------------

const SAMPLE_ROWS = [
  { id: '1', name: 'Jane Doe', email: 'jane@example.com', book: 'biography', format: 'hardcover', quantity: 2, status: 'new', createdAt: '2026-08-07T09:00:00Z' },
  { id: '2', name: 'Ali Rao', email: 'ali@example.com', book: 'childrens', format: 'ebook', quantity: 1, status: 'contacted', createdAt: '2026-08-06T09:00:00Z' },
  { id: '3', name: 'Bo', email: 'bo@x.com', book: 'biography', format: 'paperback', quantity: 3, status: 'withdrawn', createdAt: '2026-08-05T09:00:00Z' }
];

test('filterRows with no filters returns all rows in order', () => {
  assert.equal(filterRows(SAMPLE_ROWS).length, 3);
  assert.deepEqual(filterRows(SAMPLE_ROWS).map((r) => r.id), ['1', '2', '3']);
});

test('filterRows term matches name or email, case-insensitive', () => {
  assert.deepEqual(filterRows(SAMPLE_ROWS, { term: 'jane' }).map((r) => r.id), ['1']);
  assert.deepEqual(filterRows(SAMPLE_ROWS, { term: 'EXAMPLE.COM' }).map((r) => r.id), ['1', '2']);
  assert.equal(filterRows(SAMPLE_ROWS, { term: 'nobody' }).length, 0);
});

test('filterRows book and status are exact allowlist filters; all/empty = no filter', () => {
  assert.deepEqual(filterRows(SAMPLE_ROWS, { book: 'biography' }).map((r) => r.id), ['1', '3']);
  assert.deepEqual(filterRows(SAMPLE_ROWS, { status: 'contacted' }).map((r) => r.id), ['2']);
  assert.deepEqual(filterRows(SAMPLE_ROWS, { book: 'all' }).length, 3);
  assert.deepEqual(filterRows(SAMPLE_ROWS, { status: '' }).length, 3);
  assert.deepEqual(
    filterRows(SAMPLE_ROWS, { term: 'a', book: 'biography', status: 'new' }).map((r) => r.id),
    ['1']
  );
});

test('filterRows is defensive against non-array / malformed rows', () => {
  assert.deepEqual(filterRows(null), []);
  assert.deepEqual(filterRows([null, { id: 'x', name: 'A', email: 'a@b.com', book: 'biography', status: 'new' }]).length, 1);
});

// ---------------------------------------------------------------------------
// toCsv (pure helper; no UI export wired in this phase)
// ---------------------------------------------------------------------------

test('toCsv emits a header row plus one quoted-safe line per row', () => {
  const csv = toCsv(SAMPLE_ROWS);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'createdAt,name,email,book,format,quantity,status');
  assert.equal(lines.length, 4);
  const first = lines[1];
  assert.ok(first.startsWith('2026-08-07 09:00 UTC,'));
  assert.ok(first.includes(',Jane Doe,'));
  // Raw codes are NOT used; human labels appear.
  assert.ok(first.includes(',Biography,'));
  assert.ok(first.includes(',Hardcover,'));
  assert.ok(first.endsWith(',New'));
});

test('toCsv quotes values containing comma/quote/newline and doubles embedded quotes', () => {
  const rows = [{ createdAt: '2026-01-01T00:00:00.000Z', name: 'Doe, Jane', email: 'a@b.com', book: 'biography', format: 'hardcover', quantity: 1, status: 'new' }];
  const csv = toCsv(rows);
  assert.ok(csv.includes('"Doe, Jane"'));
  const quoteRows = [{ createdAt: null, name: 'she said "hi"', email: 'a@b.com', book: 'biography', format: 'hardcover', quantity: 1, status: 'new' }];
  const q = toCsv(quoteRows);
  assert.ok(q.includes('"she said ""hi"""'), 'embedded quotes are doubled and the cell quoted');
});

test('toCsv header only for empty input and tolerates null', () => {
  assert.equal(toCsv([]), 'createdAt,name,email,book,format,quantity,status');
  assert.equal(toCsv(null), 'createdAt,name,email,book,format,quantity,status');
});

// ===========================================================================
// Source-level contracts for the admin.js dashboard wiring
// ===========================================================================
//
// These assert the security/UX invariants the task requires, at the source
// level (the test env has no DOM). The Books dashboard section is delimited by
// a marker comment so the assertions can target exactly that code.

const BOOKS_SECTION_MARKER = 'Books EOI dashboard';
const booksSectionStart = adminJs.indexOf(BOOKS_SECTION_MARKER);
const booksSection = booksSectionStart >= 0 ? adminJs.slice(booksSectionStart) : '';

// Strip JS comments so source-contract assertions judge the CODE, not the
// wording of a documenting comment (e.g. a comment that says "no innerHTML").
function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}
const booksCode = stripJsComments(booksSection);

test('admin.js defines a Books dashboard section', () => {
  assert.ok(booksSectionStart >= 0, 'the Books EOI dashboard section marker must exist in admin.js');
});

test('Books dashboard rendering never uses innerHTML / insertAdjacentHTML (safe PII rendering)', () => {
  assert.equal(/\.innerHTML\s*=/.test(booksCode), false, 'no innerHTML assignment in the books code');
  assert.equal(/insertAdjacentHTML/.test(booksCode), false, 'no insertAdjacentHTML in the books code');
});

test('Books dashboard uses textContent for cell text and property assignment for the mailto href', () => {
  assert.ok(/\.textContent\s*=/.test(booksCode), 'cells are rendered via textContent');
  assert.ok(/anchor\.href\s*=\s*href/.test(booksCode), 'the mailto href is assigned via a property, not interpolated HTML');
});

test('Books status updates use PATCH only; there is no DELETE path or button', () => {
  assert.ok(/method:\s*'PATCH'/.test(booksCode), 'status updates issue a PATCH');
  assert.equal(/method:\s*'DELETE'/.test(booksCode), false, 'no DELETE method in the books code');
  // No delete action literal used as a status action (only new/contacted/withdrawn).
  assert.equal(/['"]delete['"]\s*[,)\]]/.test(booksCode), false, 'no delete action literal in the books code');
});

test('Books dashboard loads only inside the authenticated admin content (after adminContent.hidden = false)', () => {
  // The loadArtworks success path must reveal admin content and THEN trigger the
  // books load. The call must not appear before that reveal in module order.
  const revealIdx = adminJs.indexOf('adminContent.hidden = false');
  const callIdx = adminJs.indexOf('loadBooksDashboard(false)');
  assert.ok(revealIdx >= 0, 'admin content reveal must exist');
  assert.ok(callIdx >= 0, 'a guarded loadBooksDashboard(false) call must exist');
  assert.ok(callIdx > revealIdx, 'loadBooksDashboard is called only after admin content is revealed');
  // No top-level / eager load on module evaluation: the only direct call is the
  // guarded one inside loadArtworks.
  assert.equal(adminJs.indexOf('loadBooksDashboard(true)'), adminJs.lastIndexOf('loadBooksDashboard(true)'));
});

test('logout resets the Books surface (clears PII from the DOM)', () => {
  const logoutIdx = adminJs.indexOf("'/api/admin/logout'");
  assert.ok(logoutIdx >= 0);
  const after = adminJs.slice(logoutIdx, logoutIdx + 400);
  assert.ok(after.includes('resetBooksSurface()'), 'logout must call resetBooksSurface()');
});

test('admin.html exposes nav anchors for Artwork Catalogue and Book Interest Dashboard', () => {
  assert.match(adminHtml, /href="#artwork-section"[^>]*>Artwork Catalogue/);
  assert.match(adminHtml, /href="#books-dashboard"[^>]*>Book Interest Dashboard/);
  assert.ok(adminHtml.includes('id="artwork-section"'));
  assert.ok(adminHtml.includes('id="books-dashboard"'));
  // The dashboard lives inside the authenticated admin content container.
  const contentIdx = adminHtml.indexOf('id="admin-content"');
  const panelIdx = adminHtml.indexOf('id="books-dashboard"');
  assert.ok(panelIdx > contentIdx, 'the books dashboard must be inside #admin-content');
});

// ===========================================================================
// Responsive CSS contract (admin stays Inter; table reflows at 320/393/200%)
// ===========================================================================

test('admin body typography stays Inter (Hanken Grotesk isolation guard)', () => {
  const body = adminCss.match(/body\s*\{([^}]*)\}/);
  assert.ok(body);
  assert.match(body[1], /font-family:\s*"Inter"/);
  assert.doesNotMatch(body[1], /Hanken Grotesk/);
});

test('summary tiles use auto-fit with minmax so columns never leave gaps', () => {
  const tiles = adminCss.match(/\.books-tiles\s*\{([^}]*)\}/);
  assert.ok(tiles, '.books-tiles rule must exist');
  assert.match(tiles[1], /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(\s*\d+px,\s*1fr\s*\)\)/);
  const min = Number(tiles[1].match(/minmax\(\s*(\d+)px/)[1]);
  assert.ok(min >= 140 && min <= 200, `auto-fit minmax between 140-200px (got ${min})`);
});

test('the recent list table reflows to stacked cards at <=640px (covers 320/393 and 200% zoom)', () => {
  const mq = adminCss.match(/@media\s*\(\s*max-width:\s*640px\s*\)\s*\{([\s\S]*?)\}\s*(?=@media|\z)/);
  assert.ok(mq, 'a 640px media block must exist');
  assert.match(mq[1], /\.books-table\s+thead\s*\{[^}]*display:\s*none/, 'thead hidden at 640px');
  assert.match(mq[1], /content:\s*attr\(data-label\)/, 'cells expose labels via data-label ::before');
});
