import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

import {
  BOOK_LABELS,
  FORMAT_LABELS,
  STATUS_LABELS,
  BOOK_ORDER,
  STATUS_ORDER,
  BOOKS_PAGE_SIZE,
  formatBookLabel,
  formatFormatLabel,
  formatStatusLabel,
  formatCreatedDate,
  safeMailtoHref,
  buildSummaryTiles,
  filterRows,
  filterRowsByName,
  booksRangeLabel,
  toCsv
} from '../public/admin-books.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminJs = readFileSync(join(__dirname, '..', 'public', 'admin.js'), 'utf8');
const adminCss = readFileSync(join(__dirname, '..', 'public', 'admin.css'), 'utf8');
const adminHtml = readFileSync(join(__dirname, '..', 'public', 'admin.html'), 'utf8');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.listeners = {};
    this.attributes = new Map();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.className = '';
    this._textContent = '';
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join('');
  }

  appendChild(child) {
    if (child.tagName === '#FRAGMENT') {
      child.children.slice().forEach((item) => this.appendChild(item));
      child.children = [];
      return child;
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  closest(selector) {
    for (let node = this; node; node = node.parentNode) {
      if (selector === 'tr' && node.tagName === 'TR') return node;
    }
    return null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const tagName = selector.toUpperCase();
    for (const child of this.children) {
      if (child.tagName === tagName) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
const failedJson = (status = 500) => ({ ok: false, status, json: async () => ({}) });
const piiRow = {
  id: 'pii-1',
  name: 'Jane Doe',
  email: 'jane@example.com',
  book: 'biography',
  format: 'hardcover',
  quantity: 1,
  status: 'new',
  createdAt: '2026-08-07T09:00:00Z'
};

function createBooksVm(responses) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    createElement: (tagName) => new FakeElement(tagName),
    createDocumentFragment: () => new FakeElement('#fragment')
  };
  const fetch = async () => responses.shift();
  const context = {
    document,
    fetch,
    URLSearchParams,
    window: { confirm: () => true },
    adminContent: new FakeElement(),
    loginPanel: new FakeElement(),
    loginStatus: new FakeElement(),
    loadArtworks() {},
    STATUS_ORDER,
    formatBookLabel,
    formatFormatLabel,
    formatStatusLabel,
    formatCreatedDate,
    safeMailtoHref,
    buildSummaryTiles,
    filterRows,
    filterRowsByName,
    booksRangeLabel,
    BOOKS_PAGE_SIZE,
    console
  };
  runInNewContext(
    adminJs.slice(adminJs.lastIndexOf('\n', booksSectionStart) + 1) + '\nglobalThis.booksTestApi = { loadBooksDashboard, resetBooksSurface };',
    context
  );
  return { context, document, elements };
}

function assertBooksFailureSurface(elements) {
  const tbody = elements.get('books-tbody');
  assert.equal(tbody.children.length, 1, 'the PII row is replaced by the empty state');
  assert.equal(tbody.children[0].className, '', 'the rendered PII row is gone');
  assert.equal(tbody.textContent.includes('jane@example.com'), false, 'email text is cleared');
  assert.equal(tbody.querySelectorAll('a').length, 0, 'mailto links are cleared');
  assert.equal(elements.get('books-status').textContent, '', 'stale update metadata is cleared');
  assert.equal(elements.get('books-error').hidden, false, 'the persistent panel error is visible');
  assert.match(elements.get('books-error').textContent, /Could not load book interest/);
  const tileValues = elements.get('books-tiles').children.map((tile) => tile.children[1].textContent);
  assert.deepEqual(tileValues, ['0 interested', '0 interested', '0 submissions', '0 submissions', '0', '0', '0', '0', '0']);
}

// ---------------------------------------------------------------------------
// Allowlist / label helpers
// ---------------------------------------------------------------------------

test('label maps cover every book/format/status code from the backend allowlist', () => {
  assert.deepEqual(Object.keys(BOOK_LABELS).sort(), ['biography', 'childrens']);
  assert.deepEqual(Object.keys(FORMAT_LABELS).sort(), ['ebook', 'hardcover', 'paperback', 'unsure']);
  assert.deepEqual(Object.keys(STATUS_LABELS).sort(), ['contacted', 'new', 'withdrawn']);
});

test('formatBookLabel / formatFormatLabel / formatStatusLabel map known codes and fall back gracefully', () => {
  assert.equal(formatBookLabel('biography'), 'Frayed Not Broken');
  assert.equal(formatBookLabel('childrens'), 'MJ and Her Wobbly Days');
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

test('admin book labels stay aligned with the public book titles (admin/public no-drift)', () => {
  // The stable persisted/API codes never change; only the admin-visible
  // display titles do, and they must match the public Books page <h3> titles.
  const booksHtml = readFileSync(join(__dirname, '..', 'public', 'books.html'), 'utf8');
  const titles = [...booksHtml.matchAll(/<h3>([\s\S]*?)<\/h3>/g)].map((m) => m[1].trim());
  assert.deepEqual(titles, ['Frayed Not Broken', 'MJ and Her Wobbly Days']);
  for (const code of BOOK_ORDER) {
    assert.equal(formatBookLabel(code), titles[BOOK_ORDER.indexOf(code)], `admin label for ${code} matches its public title`);
    assert.ok(
      new RegExp(`<option value="${code}">${BOOK_LABELS[code]}</option>`).test(adminHtml),
      `admin.html filter option for ${code} shows the public title`
    );
  }
  // The old generic admin labels are gone from the admin surface.
  assert.doesNotMatch(adminHtml, /<option value="biography">Biography<\/option>/);
  assert.doesNotMatch(adminHtml, /Children&rsquo;s Book/);
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

test('buildSummaryTiles returns the exact canonical tile set when the reported total matches normalized statuses', () => {
  const tiles = buildSummaryTiles({
    books: {
      biography: { interestCount: 3, requestedCopies: 7 },
      childrens: { interestCount: 1, requestedCopies: 2 }
    },
    today: { submissions: 2, copies: 4 },
    last7Days: { submissions: 5, copies: 9 },
    byStatus: { new: 4, contacted: 2, withdrawn: 1 },
    total: 7,
    overallContacts: 6
  });
  assert.deepEqual(tiles, [
    { kind: 'book', key: 'biography', label: 'Frayed Not Broken', value: 3, secondary: 7 },
    { kind: 'book', key: 'childrens', label: 'MJ and Her Wobbly Days', value: 1, secondary: 2 },
    { kind: 'window', key: 'today', label: 'Submissions received — Today', value: 2, secondary: 4 },
    { kind: 'window', key: 'last7Days', label: 'Submissions received — Last 7 days', value: 5, secondary: 9 },
    { kind: 'status', key: 'new', label: 'New', value: 4 },
    { kind: 'status', key: 'contacted', label: 'Contacted', value: 2 },
    { kind: 'status', key: 'withdrawn', label: 'Withdrawn', value: 1 },
    { kind: 'total', key: 'total', label: 'Interest records', value: 7 },
    { kind: 'distinct', key: 'overallContacts', label: 'Distinct contacts', value: 6 }
  ]);
});

test('buildSummaryTiles returns the exact all-zero tile set for null or absent summaries', () => {
  for (const summary of [null, undefined]) {
    const tiles = buildSummaryTiles(summary);
    assert.equal(tiles.length, 9);
    assert.deepEqual(tiles.map((t) => t.key), ['biography', 'childrens', 'today', 'last7Days', 'new', 'contacted', 'withdrawn', 'total', 'overallContacts']);
    assert.deepEqual(tiles.map((t) => t.value), Array(9).fill(0));
    assert.deepEqual(tiles.filter((t) => 'secondary' in t).map((t) => t.secondary), [0, 0, 0, 0]);
  }
});

test('buildSummaryTiles rejects a finite reported total that differs from normalized statuses', () => {
  assert.throws(
    () => buildSummaryTiles({ byStatus: { new: '3', contacted: 2, withdrawn: 1 }, total: 7 }),
    /summary total does not match status counts/
  );
});

test('buildSummaryTiles normalizes partial and malformed numeric fields', () => {
  const tiles = buildSummaryTiles({
    books: { biography: { interestCount: '5', requestedCopies: 'not-a-number' } },
    today: { submissions: Infinity, copies: -2 },
    byStatus: { new: '3' },
    total: Infinity,
    overallContacts: 'not-a-number'
  });
  assert.deepEqual(tiles.map((t) => t.value), [5, 0, 0, 0, 3, 0, 0, 3, 0]);
  assert.deepEqual(tiles.filter((t) => 'secondary' in t).map((t) => t.secondary), [0, 0, 0, 0]);
});

test('the total/distinct tile pair keeps row-level and contact-level counting honestly labelled', () => {
  const tiles = buildSummaryTiles({
    byStatus: { new: 2, contacted: 0, withdrawn: 0 },
    total: 2,
    overallContacts: 1
  });
  const total = tiles.find((t) => t.kind === 'total');
  const distinct = tiles.find((t) => t.kind === 'distinct');
  assert.equal(total.label, 'Interest records', 'row-level count is labelled as records, not people');
  assert.equal(total.value, 2, 'one two-book submission creates two interest rows');
  assert.equal(distinct.label, 'Distinct contacts', 'contact-level count is separately labelled');
  assert.equal(distinct.value, 1, 'the same person counts once across both books');
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
// filterRowsByName (loaded-page name filter) + booksRangeLabel + page size
// ---------------------------------------------------------------------------

test('filterRowsByName matches ONLY the name, never the email (truthful scope)', () => {
  const rows = [
    { id: '1', name: 'Jane Doe', email: 'jane@example.com' },
    { id: '2', name: 'Ali Rao', email: 'ali@example.com' },
    { id: '3', name: null, email: 'bo@example.com' }
  ];
  assert.deepEqual(filterRowsByName(rows, 'jane').map((r) => r.id), ['1']);
  // An email-shaped term must NOT match via the email column.
  assert.deepEqual(filterRowsByName(rows, 'example.com').map((r) => r.id), []);
  assert.deepEqual(filterRowsByName(rows, '').map((r) => r.id), ['1', '2', '3']);
  assert.deepEqual(filterRowsByName(rows).length, 3);
  assert.deepEqual(filterRowsByName(null, 'x'), []);
});

test('booksRangeLabel renders honest 1-based ranges and empty states', () => {
  assert.equal(booksRangeLabel(0, 50, 137), '1\u201350 of 137 records');
  assert.equal(booksRangeLabel(100, 37, 137), '101\u2013137 of 137 records');
  assert.equal(booksRangeLabel(0, 0, 0), 'No records yet.');
  assert.equal(booksRangeLabel(50, 0, 137), 'No matching records.');
});

test('the client page size stays at 50 and within the server-admitted limit', () => {
  assert.equal(BOOKS_PAGE_SIZE, 50);
  assert.ok(BOOKS_PAGE_SIZE >= 1 && BOOKS_PAGE_SIZE <= 100);
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
  assert.ok(first.includes(',Frayed Not Broken,'));
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

test('Books summary renderer exhaustively handles all five tile kinds without legacy undefined fields', () => {
  const renderer = booksCode.match(/function renderBooksTiles\(summary\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(renderer, 'renderBooksTiles must exist');
  for (const kind of ['book', 'window', 'status', 'total', 'distinct']) {
    assert.match(renderer[1], new RegExp(`case ['"]${kind}['"]:`), `${kind} has an explicit renderer case`);
  }
  assert.match(renderer[1], /default:\s*throw new Error/, 'unknown kinds fail loudly');
  assert.doesNotMatch(renderer[1], /tile\.(interest|copies|submissions)/, 'renderer uses the normalized value/secondary model only');
  assert.match(renderer[1], /' interested'/);
  assert.match(renderer[1], /' submissions'/);
  assert.match(renderer[1], /'records'/);
  assert.match(renderer[1], /'one row per book interest'/);
  assert.match(renderer[1], /'people, counted once across both books'/);
});

test('Books summary explains raw submission windows and active interest semantics', () => {
  assert.match(adminHtml, /Submission windows count raw records by received time, including records later withdrawn\./);
  assert.match(adminHtml, /Last 7 days is the trailing 168 hours in UTC\./);
  assert.match(readFileSync(join(__dirname, '..', 'public', 'admin-books.js'), 'utf8'), /Book values are\s*\/\/ active interest \(withdrawn excluded\)/);
});

test('Books status updates use PATCH only; there is no DELETE path or button', () => {
  assert.ok(/method:\s*'PATCH'/.test(booksCode), 'status updates issue a PATCH');
  assert.equal(/method:\s*'DELETE'/.test(booksCode), false, 'no DELETE method in the books code');
  // No delete action literal used as a status action (only new/contacted/withdrawn).
  assert.equal(/['"]delete['"]\s*[,)\]]/.test(booksCode), false, 'no delete action literal in the books code');
});

test('exact-email search sends the address in a POST body, never in a URL', () => {
  const searchMatch = booksCode.match(/fetch\('\/api\/admin\/books\/eoi\/search',\s*\{[\s\S]*?\}\)/);
  assert.ok(searchMatch, 'the search endpoint is called by URL /api/admin/books/eoi/search');
  assert.match(searchMatch[0], /method:\s*'POST'/, 'search is a POST');
  assert.match(searchMatch[0], /JSON\.stringify\(\{ email: booksListState\.email/);
  // The GET list URL is built from limit/offset/book/status only -- the email
  // never appears as a query parameter anywhere in the books code.
  assert.doesNotMatch(booksCode, /[?&]email=/);
  assert.doesNotMatch(booksCode, /params\.set\('email'/);
});

test('server-side pagination requests use limit+offset and render DOM-built controls', () => {
  assert.match(booksCode, /const offset = \(booksListState\.page - 1\) \* BOOKS_PAGE_SIZE;/, 'offset derives from the page state');
  assert.match(
    booksCode,
    /new URLSearchParams\(\{ limit: String\(BOOKS_PAGE_SIZE\), offset: String\(offset\) \}\)/,
    'the GET list carries limit and offset'
  );
  const pagination = booksCode.match(/function renderBooksPagination\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(pagination, 'renderBooksPagination must exist');
  assert.match(pagination[1], /document\.createElement\('button'\)/, 'pagination buttons are DOM-built');
  assert.match(pagination[1], /'Previous'/);
  assert.match(pagination[1], /'Next'/);
  assert.match(pagination[1], /'Page ' \+ booksListState\.page \+ ' of ' \+ pageCount/, 'truthful page label');
});

test('the search controls name their exact scope in the UI copy', () => {
  assert.match(adminHtml, /Find by exact email/);
  assert.match(adminHtml, /Name \(loaded page only\)/);
  // The empty search result for an email names the exact-email semantics.
  assert.match(booksCode, /No records match that exact email address\./);
  // The name-filter scope note is rendered and honest.
  assert.match(booksCode, /loaded records match/);
});

test('Books dashboard loads lazily inside the authenticated admin content (never eagerly)', () => {
  // The loadArtworks success path reveals admin content; the Books view is
  // then loaded lazily by renderView -> ensureBooksLoaded the first time the
  // books view becomes visible. The guarded first-load call must appear after
  // the reveal, and no loadBooksDashboard call may be a top-level statement.
  const revealIdx = adminJs.indexOf('adminContent.hidden = false');
  const callIdx = adminJs.indexOf('loadBooksDashboard(false)');
  assert.ok(revealIdx >= 0, 'admin content reveal must exist');
  assert.ok(callIdx >= 0, 'a guarded lazy loadBooksDashboard(false) call must exist');
  assert.ok(callIdx > revealIdx, 'the books load happens only after admin content is revealed');
  // No top-level (module-scope) invocation of the loader.
  assert.doesNotMatch(adminJs, /^loadBooksDashboard\(/m);
  // The lazy trigger is wired to the books view.
  assert.match(adminJs, /function ensureBooksLoaded\(\)\s*\{\s*if \(!booksLoadedOnce\) loadBooksDashboard\(false\);\s*\}/);
});

test('logout resets the Books surface (clears PII from the DOM)', () => {
  const logoutIdx = adminJs.indexOf("'/api/admin/logout'");
  assert.ok(logoutIdx >= 0);
  const after = adminJs.slice(logoutIdx, logoutIdx + 400);
  assert.ok(after.includes('resetBooksSurface()'), 'logout must call resetBooksSurface()');
});

test('initial load summary invariant failure clears rows, PII, status, and tiles through the centralized handler', async () => {
  const responses = [
    okJson({ byStatus: { new: 1, contacted: 0, withdrawn: 0 }, total: 2 }),
    okJson({ rows: [piiRow] })
  ];
  const { context, document, elements } = createBooksVm(responses);
  const staleRow = document.createElement('tr');
  const staleEmail = document.createElement('a');
  staleEmail.href = 'mailto:jane%40example.com';
  staleEmail.textContent = piiRow.email;
  staleRow.appendChild(staleEmail);
  elements.get('books-tbody').appendChild(staleRow);
  elements.get('books-status').textContent = 'Last updated stale metadata.';

  await context.booksTestApi.loadBooksDashboard(false);

  assert.equal(responses.length, 0, 'the summary and list requests both completed');
  assertBooksFailureSurface(elements);
  assert.equal(elements.get('books-refresh').disabled, false, 'the refresh control is re-enabled');
});

test('manual Refresh summary invariant failure clears rows, PII, status, and tiles through the centralized handler', async () => {
  const responses = [
    okJson({ byStatus: { new: 1, contacted: 0, withdrawn: 0 }, total: 1 }),
    okJson({ rows: [piiRow] }),
    okJson({ byStatus: { new: 0, contacted: 1, withdrawn: 0 }, total: 2 }),
    okJson({ rows: [{ ...piiRow, status: 'contacted' }] })
  ];
  const { context, elements } = createBooksVm(responses);

  await context.booksTestApi.loadBooksDashboard(false);
  assert.equal(elements.get('books-tbody').textContent.includes(piiRow.email), true, 'precondition: PII is rendered');
  assert.match(elements.get('books-status').textContent, /Last updated/);

  await elements.get('books-refresh').listeners.click();

  assert.equal(responses.length, 0, 'the manual refresh summary and list requests both completed');
  assertBooksFailureSurface(elements);
  assert.equal(elements.get('books-refresh').disabled, false, 'the refresh control is re-enabled');
});

test('manual Refresh fetch failure clears rows, PII, status, and tiles through the centralized handler', async () => {
  const responses = [
    okJson({ byStatus: { new: 1, contacted: 0, withdrawn: 0 }, total: 1 }),
    okJson({ rows: [piiRow] }),
    failedJson(),
    okJson({ rows: [piiRow] })
  ];
  const { context, elements } = createBooksVm(responses);

  await context.booksTestApi.loadBooksDashboard(false);
  assert.equal(elements.get('books-tbody').textContent.includes(piiRow.email), true, 'precondition: PII is rendered');
  assert.match(elements.get('books-status').textContent, /Last updated/);

  await elements.get('books-refresh').listeners.click();

  assert.equal(responses.length, 0, 'the manual refresh summary and list requests both completed');
  assertBooksFailureSurface(elements);
  assert.equal(elements.get('books-refresh').disabled, false, 'the refresh control is re-enabled');
});

// ===========================================================================
// Request invalidation: stale loads / logout can never repopulate PII
// ===========================================================================

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a superseded Books load is dropped: its late response renders nothing', async () => {
  const responses = [];
  const { context, elements } = createBooksVm(responses);

  // First (slow) load whose responses resolve only later.
  let resolveSlowSummary;
  let resolveSlowList;
  responses.push(
    new Promise((resolve) => { resolveSlowSummary = resolve; }),
    new Promise((resolve) => { resolveSlowList = resolve; })
  );
  const slowLoad = context.booksTestApi.loadBooksDashboard(false);

  // A newer load completes first and renders.
  responses.push(
    okJson({ byStatus: { new: 1, contacted: 0, withdrawn: 0 }, total: 1 }),
    okJson({ rows: [piiRow], total: 1 })
  );
  await context.booksTestApi.loadBooksDashboard(true);
  const tbody = elements.get('books-tbody');
  assert.equal(tbody.textContent.includes(piiRow.email), true, 'the newest load rendered');

  // The superseded load resolves LAST: it must not render, overwrite status,
  // or re-enable/disable controls.
  resolveSlowSummary(okJson({ byStatus: { new: 5, contacted: 0, withdrawn: 0 }, total: 5 }));
  resolveSlowList(okJson({ rows: [{ ...piiRow, id: 'stale-1', name: 'Stale Person', email: 'stale@example.com' }], total: 5 }));
  await slowLoad;
  await tick();

  assert.equal(tbody.textContent.includes('stale@example.com'), false, 'stale rows are never rendered');
  assert.equal(tbody.textContent.includes(piiRow.email), true, 'the newest rows remain');
  assert.match(elements.get('books-status').textContent, /Last updated/);
  assert.equal(elements.get('books-refresh').disabled, false, 'stale finally-handlers do not touch controls');
  assert.equal(elements.get('books-error').hidden, true, 'an aborted/stale request is not an error');
});

test('logout invalidates in-flight loads: nothing repopulates afterwards', async () => {
  const responses = [];
  const { context, elements } = createBooksVm(responses);

  let resolveSummary;
  let resolveList;
  responses.push(
    new Promise((resolve) => { resolveSummary = resolve; }),
    new Promise((resolve) => { resolveList = resolve; })
  );
  const pending = context.booksTestApi.loadBooksDashboard(false);
  assert.equal(elements.get('books-refresh').disabled, true, 'precondition: load in flight');

  // Mid-flight logout (or session expiry): everything is invalidated now.
  context.booksTestApi.resetBooksSurface();

  resolveSummary(okJson({ byStatus: { new: 3, contacted: 0, withdrawn: 0 }, total: 3 }));
  resolveList(okJson({ rows: [piiRow], total: 3 }));
  await pending;
  await tick();

  const tbody = elements.get('books-tbody');
  assert.equal(tbody.children.length, 0, 'no rows repopulate after logout');
  assert.equal(tbody.textContent.includes(piiRow.email), false, 'PII never reappears');
  assert.equal(elements.get('books-status').textContent, '', 'status text stays cleared');
  assert.equal(elements.get('books-error').hidden, true, 'the dropped request is not an error');
  assert.equal(elements.get('books-dashboard').hidden, true, 'the panel stays hidden');
  assert.equal(elements.get('books-refresh').disabled, true, 'a stale finally-handler does not re-enable controls');
});

test('a PATCH completing after logout renders nothing', async () => {
  const responses = [
    okJson({ byStatus: { new: 1, contacted: 0, withdrawn: 0 }, total: 1 }),
    okJson({ rows: [piiRow], total: 1 })
  ];
  const { context, elements } = createBooksVm(responses);
  await context.booksTestApi.loadBooksDashboard(false);
  const tbody = elements.get('books-tbody');
  const row = tbody.children[0];
  const contactedButton = row.querySelectorAll('button').find((button) => button.dataset.action === 'contacted');
  assert.ok(contactedButton, 'precondition: a status action exists');

  // PATCH starts, then the session dies before the response lands.
  let resolvePatch;
  responses.push(new Promise((resolve) => { resolvePatch = resolve; }));
  const patch = contactedButton.listeners.click();
  context.booksTestApi.resetBooksSurface();
  resolvePatch(okJson({ ok: true }));
  await patch;
  await tick();

  assert.equal(tbody.children.length, 0, 'no rows repopulate from the stale PATCH');
  assert.equal(tbody.textContent.includes(piiRow.email), false);
  assert.notEqual(elements.get('books-status').textContent, 'Status updated.', 'no success message after logout');
  assert.equal(elements.get('books-error').hidden, true);
});

test('Books requests are generation-guarded, aborted, and epoch-invalidated (source contract)', () => {
  assert.match(booksCode, /let booksLoadGeneration = 0;/);
  assert.match(booksCode, /let booksSessionEpoch = 0;/);
  assert.match(booksCode, /function isStaleBooksRequest\(generation, epoch\)/);
  // Every await point in the load path re-checks staleness before rendering.
  const load = booksCode.match(/function loadBooksDashboard\(isRefresh\)\s*\{([\s\S]*?)\n\}\n/);
  assert.ok(load);
  assert.match(load[1], /if \(isStaleBooksRequest\(generation, epoch\)\)\s*return;/);
  assert.match(load[1], /\.finally\(\(\) => \{[\s\S]*?isStaleBooksRequest[\s\S]*?booksRefresh\.disabled = false;/);
  // Real browsers also cancel the network work (and any decrypt it causes).
  assert.match(booksCode, /typeof AbortController === 'function'/);
  assert.match(booksCode, /booksAbortController\.abort\(\)/);
  assert.match(booksCode, /fetchBooksRows\(signal\)/);
  // The logout/session-expiry reset invalidates loads, summaries, the abort
  // controller, and any pending name-filter debounce.
  const reset = booksCode.match(/function resetBooksSurface\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(reset);
  assert.match(reset[1], /booksSessionEpoch \+= 1;/);
  assert.match(reset[1], /booksLoadGeneration \+= 1;/);
  assert.match(reset[1], /booksSummaryGeneration \+= 1;/);
  assert.match(reset[1], /\.abort\(\)/);
  // The name filter is debounced.
  assert.match(booksCode, /booksDebounce\.set\(\(\) => \{/);
  // The debounce helpers must be receiver-safe wrappers, not the detached
  // native setTimeout/clearTimeout: browsers throw "Illegal invocation" for
  // those when called off the plain object, silently breaking the filter.
  assert.doesNotMatch(booksCode, /set:\s*setTimeout\b/);
  assert.doesNotMatch(booksCode, /clear:\s*clearTimeout\b/);
  assert.match(booksCode, /set:\s*\(fn, delay\) => setTimeout\(fn, delay\)/);
  assert.match(booksCode, /clear:\s*\(timer\) => clearTimeout\(timer\)/);
});

test('successful PATCH followed by a mismatched summary clears PII, shows an error, and resets tiles', async () => {
  const responses = [
    okJson({ byStatus: { new: 1, contacted: 0, withdrawn: 0 }, total: 1 }),
    okJson({ rows: [piiRow] }),
    okJson({ row: { id: 'pii-1', status: 'contacted' } }),
    okJson({ byStatus: { new: 0, contacted: 1, withdrawn: 0 }, total: 2 })
  ];
  const { context, elements } = createBooksVm(responses);

  await context.booksTestApi.loadBooksDashboard(false);
  const tbody = elements.get('books-tbody');
  const row = tbody.children[0];
  const mailto = row.children[2].children[0];
  assert.equal(mailto.href, 'mailto:jane%40example.com', 'precondition: decrypted email is rendered as a mailto link');

  const contactedButton = row.querySelectorAll('button').find((button) => button.dataset.action === 'contacted');
  await contactedButton.listeners.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(responses.length, 0, 'PATCH and follow-up summary were both requested');
  assertBooksFailureSurface(elements);
});

test('admin.html exposes a persistent topbar with URL-addressable focused views', () => {
  // The compact nav links to the focused, URL-addressable views and carries a
  // data-view attribute so admin.js can intercept and set the active state.
  // Tabs are icon + label: the icon span is decorative (aria-hidden) and the
  // label span carries the accessible name.
  for (const [view, label] of [['catalogue', 'Artworks'], ['books', 'Book enquiries']]) {
    const anchor = adminHtml.match(new RegExp(`<a class="section-anchor"[^>]*data-view="${view}">([\\s\\S]*?)</a>`));
    assert.ok(anchor, `${view} anchor exists`);
    assert.match(
      anchor[1],
      /<span class="section-anchor-icon" aria-hidden="true">/,
      `${view} tab carries a decorative icon span`
    );
    assert.match(
      anchor[1],
      new RegExp(`<span class="section-anchor-label">${label}</span>`),
      `${view} tab keeps its readable text label`
    );
  }
  // Every view panel exists and is governed by data-view-panel, with the
  // books dashboard inside the authenticated admin content container.
  for (const panel of ['catalogue', 'artwork', 'books']) {
    assert.ok(adminHtml.includes(`data-view-panel="${panel}"`), `${panel} panel exists`);
  }
  const contentIdx = adminHtml.indexOf('id="admin-content"');
  const booksIdx = adminHtml.indexOf('id="books-dashboard"');
  assert.ok(booksIdx > contentIdx, 'the books dashboard must be inside #admin-content');
  // View website link and sign out live in the persistent topbar.
  assert.match(adminHtml, /class="button ghost-button topbar-link" href="\.\/index\.html">View website</);
  assert.match(adminHtml, /id="logout"[^>]*hidden>Sign out</);
  // The section nav is hidden until authentication succeeds.
  assert.match(adminHtml, /id="admin-section-nav"[^>]*aria-label="Admin sections" hidden/);
});

// ===========================================================================
// Responsive CSS contract (admin stays Inter; phone cards at <=767px)
// ===========================================================================

// Extract one max-width media block (up to the next @media) for assertions.
function adminMediaBlock(width) {
  const start = adminCss.indexOf(`@media (max-width: ${width}px)`);
  assert.ok(start >= 0, `a ${width}px media block must exist`);
  return adminCss.slice(start, adminCss.indexOf('@media', start + 10));
}

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

test('admin keyboard focus rings cover controls, section anchors, and Books email links', () => {
  for (const selector of ['.section-anchor:focus-visible', 'button:focus-visible', '.button:focus-visible', 'input:focus-visible', 'textarea:focus-visible', 'select:focus-visible', '.books-table a:focus-visible']) {
    assert.ok(adminCss.includes(selector), `${selector} has an explicit focus-visible style`);
  }
  const focusRule = adminCss.match(/\.section-anchor:focus-visible,[\s\S]*?\.books-table a:focus-visible\s*\{([^}]*)\}/);
  assert.ok(focusRule, 'shared focus-visible rule must exist');
  assert.match(focusRule[1], /outline:\s*3px\s+solid/);
  assert.match(focusRule[1], /outline-offset:\s*3px/);
  assert.match(focusRule[1], /box-shadow:/, 'focus ring retains contrast against varied surfaces');
});

test('Books actions, filters, search, and section navigation meet the 44px target floor', () => {
  const sectionAnchor = adminCss.match(/\.section-anchor\s*\{([^}]*)\}/);
  const filters = adminCss.match(/\.books-filter-controls input,[\s\S]*?\.books-filter-controls select\s*\{([^}]*)\}/);
  const actions = adminCss.match(/\.books-actions \.book-action\s*\{([^}]*)\}/);
  assert.match(sectionAnchor[1], /min-height:\s*44px/);
  assert.match(filters[1], /min-height:\s*44px/);
  assert.match(actions[1], /min-height:\s*44px/);
  // Catalogue search/filters are primary controls: they take the 48px size.
  assert.match(adminCss.match(/\.search-label input\s*\{([^}]*)\}/)[1], /min-height:\s*48px/, 'artwork search meets the 48px primary control size');
  assert.match(adminCss.match(/\.filter-label select\s*\{([^}]*)\}/)[1], /min-height:\s*48px/, 'artwork filter selects meet the 48px primary control size');
});

test('the recent list table reflows to phone cards at <=767px (below the tablet band; covers 320/393, landscape phones, and 200% zoom)', () => {
  const mq = adminMediaBlock(767);
  assert.match(mq, /\.books-table\s+thead\s*\{[^}]*display:\s*none/, 'thead hidden on phones');
  assert.match(mq, /content:\s*attr\(data-label\)/, 'cells expose labels via data-label ::before');
});

test('books enquiry cards lead with name + status, group the detail metadata, and end with grouped actions', () => {
  const mq = adminMediaBlock(767);
  assert.match(mq, /\.books-table tbody tr\s*\{[^}]*grid-template-areas:/, 'each enquiry row becomes a structured card grid');
  assert.match(mq, /"name status"/, 'the card header pairs the customer name with the status badge');
  assert.match(mq, /"actions actions"/, 'status actions close the card in their own footer area');
  assert.doesNotMatch(mq, /42%/, 'the fixed two-column percentage split is gone');
  assert.match(mq, /\.books-table tbody td\s*\{[^}]*overflow-wrap:\s*anywhere/, 'long emails and names wrap instead of overflowing the card');
  assert.match(mq, /\.books-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/, 'status actions are two equal 48px targets per row');
  assert.match(mq, /\.books-table tbody td\.books-empty\s*\{[^}]*grid-column:\s*1 \/ -1/, 'the colspan empty state spans the whole card');
});

test('the phone header is one account row and the section nav is the fixed bottom bar (<=767px)', () => {
  const block = adminMediaBlock(767);
  assert.match(block, /grid-template-columns:\s*minmax\(0, 1fr\) auto/, 'the single header row pairs the brand with the account actions');
  // The nav left the header entirely: no second header row remains.
  assert.doesNotMatch(block, /\.admin-section-nav\s*\{[^}]*grid-row:\s*2/, 'no empty second header row is left behind');
  // ...and became the fixed bottom bar reusing #admin-section-nav.
  const bar = block.match(/\.admin-section-nav\s*\{([^}]*)\}/)[1];
  assert.match(bar, /position:\s*fixed/, 'the section nav is fixed');
  assert.match(bar, /bottom:\s*0/, 'anchored to the viewport bottom');
  // The bar lives inside the header element, so the header must not form a
  // containing block for fixed descendants at phone widths (backdrop-filter
  // would re-anchor the bar to the header instead of the viewport).
  const phoneHeader = block.match(/\.admin-topbar\s*\{([^}]*)\}/)[1];
  assert.match(phoneHeader, /backdrop-filter:\s*none/, 'the phone header drops backdrop-filter so the bar fixes to the viewport');
  assert.match(bar, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/, 'the two views are equal-width tabs');
  assert.match(bar, /env\(safe-area-inset-bottom/, 'the bar clears the gesture safe area');
  assert.match(block, /\.section-anchor\s*\{[^}]*min-height:\s*56px/, 'section anchors are 48px+ targets');
  assert.match(block, /\.section-anchor\s*\{[^}]*flex-direction:\s*column/, 'tabs stack icon above label');
  assert.match(block, /\.section-anchor-icon\s*\{[^}]*display:\s*inline-flex/, 'icons show in the phone bar');
  // Active state beyond colour: the 3px top rail + heavier label.
  assert.match(
    block,
    /\.section-anchor\[aria-current="page"\]::before\s*\{[^}]*height:\s*3px/,
    'the active tab carries a 3px indicator rail'
  );
  assert.match(
    block,
    /\.section-anchor\[aria-current="page"\] \.section-anchor-label\s*\{[^}]*font-weight:\s*700/,
    'the active label gains weight'
  );
  assert.match(block, /\.topbar-actions \.topbar-link\s*\{[^}]*min-height:\s*44px/, 'account actions stay in the header at the 44px floor');
  assert.match(block, /env\(safe-area-inset-left\)/, 'notch/home-indicator insets are respected');
  // Content clears the bar (and safe area) so nothing sits under it.
  assert.match(
    block,
    /\.admin-shell\s*\{[^}]*padding:[^}]*env\(safe-area-inset-bottom/,
    'main content padding clears the fixed bar + safe area'
  );
  assert.match(block, /scroll-padding-block-end:/, 'focused controls scroll clear of the bar');
  const short = adminCss.slice(adminCss.indexOf('@media (max-width: 767px) and (max-height: 480px)'));
  assert.ok(short.length > 0, 'a short-landscape rule exists');
  assert.match(short.slice(0, short.indexOf('}') + 1), /position:\s*static/, 'short landscape viewports unstick the header so content wins the space');
});

test('the fixed phone nav stays hidden for logged-out admins and icons stay off the desktop tabs', () => {
  // The nav element itself is reused, so authentication visibility must keep
  // winning over the author display rules (origin beats the UA [hidden]
  // default): the explicit guard makes that contract enforceable.
  assert.match(
    adminCss,
    /\.admin-section-nav\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    'an explicit [hidden] guard must defeat the bar\'s display rules'
  );
  assert.match(adminHtml, /id="admin-section-nav"[^>]*aria-label="Admin sections" hidden/, 'the nav starts hidden until authentication succeeds');
  // Desktop (>=768px) keeps the text-tab composition: the decorative icons
  // are display:none outside the phone band.
  const iconBase = adminCss.match(/\.section-anchor-icon\s*\{([^}]*)\}/)[1];
  assert.match(iconBase, /display:\s*none/, 'icons are hidden on desktop tabs');
});

test('renderView maps the artwork editor onto the Artworks tab so exactly one tab is always current', () => {
  // The editor view has no dedicated tab; Artworks owns it, so the fixed bar
  // (and the desktop tabs) always show one current section. Click handling,
  // history, and the dirty-editor guard are unchanged.
  assert.match(
    adminJs,
    /const navView = state\.view === 'artwork' \? 'catalogue' : state\.view;/,
    'renderView maps artwork -> catalogue for the nav aria-current'
  );
  assert.match(
    adminJs,
    /link\.dataset\.view === navView/,
    'aria-current follows the mapped view'
  );
});
