import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { CONTENT_SECURITY_POLICY, isGalleryPage } from '../src/worker.js';

const ARTWORKS_KEY = 'artworks.json';

function validRecord(overrides = {}) {
  return {
    id: 'mj-001',
    catalogNumber: 'MJ-001',
    category: 'catalogue',
    title: 'Still Waters',
    image: '/artwork-uploaded/artwork/catalog/mj-001/full.jpg',
    thumbnail: '/artwork-uploaded/artwork/catalog/mj-001/thumb.jpg',
    medium: 'Acrylic pouring paint',
    dimensions: { widthCm: 40, heightCm: 30, label: '40x30 cm', orientation: 'Horizontal' },
    sizeCategory: '40x30',
    availability: 'Available',
    price: { amount: 90, currency: 'AUD', note: 'framed' },
    cardNote: '$90 (framed)',
    description: 'A painting.',
    containImage: false,
    sortOrder: 1,
    provenance: { source: 'google-drive', driveFileId: 'abc', sha256: 'a'.repeat(64) },
    ...overrides
  };
}

// Eight records with distinct sortOrder and titles, so Home (first 6) and
// Gallery (all 8) are distinguishable.
function eightRecords() {
  return Array.from({ length: 8 }, (_, i) => validRecord({
    sortOrder: i + 1,
    id: `mj-${String(i + 1).padStart(3, '0')}`,
    catalogNumber: `MJ-${String(i + 1).padStart(3, '0')}`,
    title: `Piece ${i + 1}`
  }));
}

function r2Object(text) {
  return { async json() { return JSON.parse(text); }, async text() { return text; } };
}

// Fake ASSETS returns a page carrying the SSR gallery marker. The same body is
// used for /index.html and /gallery.html so the SSR replacement is testable.
function makeEnv(storedText) {
  let store = storedText;
  return {
    ARTWORK_IMAGES: {
      async get(key) {
        if (key !== ARTWORKS_KEY) return null;
        return store === undefined ? null : r2Object(store);
      },
      async put(key, value) { store = String(value); }
    },
    ASSETS: {
      async fetch(input) {
        const req = input instanceof Request ? input : null;
        if (req && !['GET', 'HEAD'].includes(req.method)) {
          return new Response('Method not allowed.', { status: 405 });
        }
        const url = input instanceof URL ? input : new URL(req ? req.url : input);
        if (['/index.html', '/gallery.html', '/books.html'].includes(url.pathname)) {
          const body = req?.method === 'HEAD' ? null :
            '<html><body><div id="gallery-grid"><!-- artwork-gallery:start --><!-- artwork-gallery:end --></div></body></html>';
          return new Response(body, { headers: { 'content-type': 'text/html; charset=UTF-8' } });
        }
        return new Response('Not found.', { status: 404 });
      }
    },
    BOOK_EOI_ALLOWED_HOSTNAMES: 'localhost',
    BOOK_EOI_ENVIRONMENT: 'local'
  };
}

function req(path, options = {}, origin = 'http://localhost') {
  return new Request(new URL(path, origin), options);
}

function countBetween(html, needle) {
  const slice = html.match(/artwork-gallery:start -->([\s\S]*)<!-- artwork-gallery:end/)[1];
  return (slice.match(new RegExp(needle, 'g')) || []).length;
}

function headersObject(response) {
  return Object.fromEntries([...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// --- Route classification --------------------------------------------------

test('isGalleryPage classifies the canonical route and its aliases', () => {
  for (const p of ['/gallery', '/gallery.html', '/gallery/', '/gallery//']) {
    assert.equal(isGalleryPage(p), true, `${p} is a gallery page`);
  }
  for (const p of ['/', '/index.html', '/books', '/api/artworks', '/gallery-foo']) {
    assert.equal(isGalleryPage(p), false, `${p} is NOT a gallery page`);
  }
});

// --- GET /gallery SSR -----------------------------------------------------

test('GET /gallery renders 200, no-store, and the complete projected catalogue', async () => {
  const env = makeEnv(JSON.stringify(eightRecords()));
  const res = await worker.fetch(req('/gallery'), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('content-type'), 'text/html; charset=UTF-8');
  const html = await res.text();
  // Full gallery renders every record as an interactive dialog <article> card.
  assert.equal(countBetween(html, '<article class="painting-card"'), 8);
  // No Home-style preview anchor cards on the full gallery page.
  assert.equal(countBetween(html, 'painting-preview-card'), 0);
  // No internal-only fields leak into the SSR.
  for (const needle of ['catalogNumber', 'sortOrder', 'provenance', 'sha256', 'driveFileId']) {
    assert.equal(html.includes(needle), false, `gallery SSR must not leak ${needle}`);
  }
});

test('GET /gallery with missing catalogue renders 200 with an empty marker (no legacy cards)', async () => {
  const env = makeEnv(undefined);
  const res = await worker.fetch(req('/gallery'), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.equal(countBetween(html, '<article class="painting-card"'), 0);
  assert.equal(countBetween(html, 'painting-preview-card'), 0);
});

test('GET /gallery with invalid stored catalogue returns 500', async () => {
  const env = makeEnv('{not valid json');
  const res = await worker.fetch(req('/gallery'), env);
  assert.equal(res.status, 500);
});

// --- HEAD parity ----------------------------------------------------------

test('HEAD /gallery matches GET status, headers, and has an empty body', async () => {
  const env = makeEnv(JSON.stringify(eightRecords()));
  const get = await worker.fetch(req('/gallery'), env);
  const head = await worker.fetch(req('/gallery', { method: 'HEAD' }), env);
  assert.equal(head.status, get.status);
  assert.deepEqual(headersObject(head), headersObject(get));
  assert.equal(await head.text(), '');
});

// --- Redirects from aliases ----------------------------------------------

test('GET /gallery.html, /gallery/, and /gallery// permanently redirect to /gallery', async () => {
  const env = makeEnv(JSON.stringify(eightRecords()));
  for (const alias of ['/gallery.html', '/gallery/', '/gallery//']) {
    const res = await worker.fetch(req(alias), env);
    assert.equal(res.status, 301, `${alias} -> 301`);
    assert.equal(res.headers.get('location'), 'http://localhost/gallery', `${alias} Location`);
  }
});

test('alias HEAD matches the GET 301 status and Location with an empty body and central headers', async () => {
  const env = makeEnv(JSON.stringify(eightRecords()));
  for (const alias of ['/gallery.html', '/gallery/', '/gallery//']) {
    const get = await worker.fetch(req(alias), env);
    const head = await worker.fetch(req(alias, { method: 'HEAD' }), env);
    assert.equal(head.status, 301, `${alias} HEAD status`);
    assert.equal(head.headers.get('location'), get.headers.get('location'), `${alias} HEAD Location`);
    assert.equal(await head.text(), '', `${alias} HEAD body empty`);
    assert.equal(head.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY, `${alias} HEAD CSP`);
  }
});

// --- Method-not-allowed ---------------------------------------------------

test('non-GET/HEAD methods on /gallery return 405 with exact Allow: GET, HEAD', async () => {
  const env = makeEnv(JSON.stringify(eightRecords()));
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await worker.fetch(req('/gallery', { method }), env);
    assert.equal(res.status, 405, `${method} /gallery -> 405`);
    assert.equal(res.headers.get('allow'), 'GET, HEAD', `${method} /gallery Allow`);
  }
});

test('a non-GET/HEAD method on a gallery alias is a JSON 405, never a redirect or static asset', async () => {
  const env = makeEnv(JSON.stringify(eightRecords()));
  const res = await worker.fetch(req('/gallery.html', { method: 'POST' }), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET, HEAD');
  assert.equal(res.headers.get('location'), null, 'non-GET alias must not redirect');
});

// --- Host gate + central security ----------------------------------------

test('foreign Host on /gallery fails closed at the host gate (421) with central headers', async () => {
  const env = makeEnv(JSON.stringify(eightRecords()));
  const res = await worker.fetch(req('/gallery', {}, 'https://evil.example'), env);
  assert.equal(res.status, 421);
  assert.equal(res.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
});

test('/gallery carries the central security headers', async () => {
  const env = makeEnv(JSON.stringify(eightRecords()));
  const res = await worker.fetch(req('/gallery'), env);
  assert.equal(res.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

// --- Home renders exactly the first 6 in sortOrder ------------------------

test('GET / renders exactly the first 6 public records in the artist sortOrder as preview anchors', async () => {
  const env = makeEnv(JSON.stringify(eightRecords()));
  const res = await worker.fetch(req('/'), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  // Home is a PREVIEW: exactly 6 anchor cards, never interactive <article> cards.
  assert.equal(countBetween(html, 'painting-preview-card'), 6);
  assert.equal(countBetween(html, '<article class="painting-card"'), 0);
  // The six are the first six by sortOrder ascending (Piece 1..Piece 6), and
  // Piece 7 / Piece 8 are NOT present on Home.
  for (const n of [1, 2, 3, 4, 5, 6]) {
    assert.ok(html.includes(`Piece ${n}`), `Home includes the sortOrder-${n} preview`);
  }
  assert.equal(html.includes('Piece 7'), false, 'Home never shows the 7th record');
  assert.equal(html.includes('Piece 8'), false, 'Home never shows the 8th record');
});

test('GET / with fewer than 6 records renders only what exists (no padding, no placeholders)', async () => {
  const env = makeEnv(JSON.stringify([validRecord({ sortOrder: 1, title: 'Only One' })]));
  const res = await worker.fetch(req('/'), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.equal(countBetween(html, 'painting-preview-card'), 1);
  assert.ok(html.includes('Only One'));
});

test('GET / preview never leaks internal-only fields', async () => {
  const env = makeEnv(JSON.stringify(eightRecords()));
  const res = await worker.fetch(req('/'), env);
  const html = await res.text();
  for (const needle of ['catalogNumber', 'sortOrder', 'provenance', 'sha256', 'driveFileId']) {
    assert.equal(html.includes(needle), false, `Home preview must not leak ${needle}`);
  }
});
