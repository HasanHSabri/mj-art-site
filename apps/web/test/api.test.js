import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const ARTWORKS_KEY = 'artworks.json';
const SESSION_COOKIE = 'mj_art_admin';
const SESSION_MAX_AGE_MS = 60 * 60 * 8 * 1000;

function validRecord(overrides = {}) {
  return {
    id: 'mj-001',
    catalogNumber: 'MJ-001',
    category: 'catalogue',
    title: 'Still Waters, Moving Souls',
    image: '/artwork-uploaded/artwork/catalog/mj-001/full.jpg',
    thumbnail: '/artwork-uploaded/artwork/catalog/mj-001/thumb.jpg',
    medium: 'Acrylic pouring paint',
    dimensions: { widthCm: 20, heightCm: 20, label: '20x20 cm', orientation: 'Square' },
    sizeCategory: '20x20',
    availability: 'Available',
    price: { amount: 40, currency: 'AUD', note: 'postage extra' },
    cardNote: '$40 (postage extra)',
    description: 'A painting.',
    containImage: true,
    sortOrder: 1,
    provenance: { source: 'google-drive', driveFileId: 'abc', sha256: 'a'.repeat(64) },
    ...overrides
  };
}

function twoValidRecords() {
  return [
    validRecord({ sortOrder: 2, id: 'mj-002', catalogNumber: 'MJ-002' }),
    validRecord({ sortOrder: 1, id: 'mj-001', catalogNumber: 'MJ-001' })
  ];
}

// Minimal R2 object stub: parses stored text on demand.
function r2Object(text) {
  return {
    async json() { return JSON.parse(text); },
    async text() { return text; }
  };
}

// Build a fake env. storedText: undefined => key absent (missing); string => present.
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
      async fetch() {
        return new Response(
          '<html><body><div id="gallery-grid"><!-- artwork-gallery:start -->x<!-- artwork-gallery:end --></div></body></html>',
          { headers: { 'content-type': 'text/html; charset=UTF-8' } }
        );
      }
    },
    ADMIN_PASSWORD: 'secret',
    ADMIN_SESSION_SECRET: 'test-secret-key'
  };
}

function req(path, options = {}) {
  return new Request(new URL(path, 'http://localhost'), options);
}

// Mint a valid session token mirroring the worker's createSessionToken/sign.
function base64UrlEncode(value) {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
}
async function mintToken(secret) {
  const payload = base64UrlEncode(JSON.stringify({ exp: Date.now() + SESSION_MAX_AGE_MS }));
  const signature = await sign(payload, secret);
  return `${payload}.${signature}`;
}
async function authedReq(path, secret, options = {}) {
  const token = await mintToken(secret);
  const headers = new Headers(options.headers);
  headers.set('cookie', `${SESSION_COOKIE}=${token}`);
  return req(path, { ...options, headers });
}

async function body(response) {
  return JSON.parse(await response.text());
}

// ---------------------------------------------------------------------------
// GET /api/artworks (public)
// ---------------------------------------------------------------------------

test('public GET returns [] when R2 metadata is missing', async () => {
  const env = makeEnv(undefined);
  const res = await worker.fetch(req('/api/artworks'), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), []);
});

test('public GET returns 500 when stored JSON is unparseable', async () => {
  const env = makeEnv('{not valid json');
  const res = await worker.fetch(req('/api/artworks'), env);
  assert.equal(res.status, 500);
});

test('public GET returns 500 when stored schema is invalid', async () => {
  const env = makeEnv(JSON.stringify([{ id: 'mj-001', size: 'legacy' }]));
  const res = await worker.fetch(req('/api/artworks'), env);
  assert.equal(res.status, 500);
});

test('public GET returns projected, ordered records with no internal fields', async () => {
  const env = makeEnv(JSON.stringify(twoValidRecords()));
  const res = await worker.fetch(req('/api/artworks'), env);
  assert.equal(res.status, 200);
  const list = await body(res);
  assert.equal(list.length, 2);
  // Ordered ascending by sortOrder: mj-001 (sortOrder 1) first.
  assert.deepEqual(list.map((r) => r.id), ['mj-001', 'mj-002']);
  const sample = list[0];
  assert.equal('catalogNumber' in sample, false);
  assert.equal('sortOrder' in sample, false);
  assert.equal('provenance' in sample, false);
  assert.equal(sample.category, 'catalogue');
  assert.equal(sample.sizeCategory, '20x20');
  assert.deepEqual(sample.dimensions, { widthCm: 20, heightCm: 20, label: '20x20 cm', orientation: 'Square' });
  assert.deepEqual(sample.price, { amount: 40, currency: 'AUD', note: 'postage extra' });
  assert.equal(sample.thumbnail, '/artwork-uploaded/artwork/catalog/mj-001/thumb.jpg');
  assert.equal(sample.medium, 'Acrylic pouring paint');
});

test('public GET does not leak Drive ids, hashes, or local paths', async () => {
  const env = makeEnv(JSON.stringify([validRecord()]));
  const res = await worker.fetch(req('/api/artworks'), env);
  const text = await res.text();
  assert.equal(text.includes('driveFileId'), false);
  assert.equal(text.includes('sha256'), false);
  assert.equal(text.includes('google-drive'), false);
  assert.equal(text.includes('/tmp/'), false);
  assert.equal(text.includes('/workspace/'), false);
});

// ---------------------------------------------------------------------------
// SSR / (public index)
// ---------------------------------------------------------------------------

test('SSR / with valid data renders 200 and no catalog number', async () => {
  const env = makeEnv(JSON.stringify([validRecord()]));
  const res = await worker.fetch(req('/'), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.equal(html.includes('catalogNumber'), false);
  assert.equal(html.includes('provenance'), false);
  assert.equal(html.includes('sortOrder'), false);
  assert.equal(html.includes('Still Waters'), true);
});

test('SSR / with missing data renders empty gallery (200)', async () => {
  const env = makeEnv(undefined);
  const res = await worker.fetch(req('/'), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.equal(html.includes('artwork-gallery:start'), true);
});

test('SSR / with invalid stored data returns 500', async () => {
  const env = makeEnv('{bad');
  const res = await worker.fetch(req('/'), env);
  assert.equal(res.status, 500);
});

// ---------------------------------------------------------------------------
// GET /api/admin/artworks (admin)
// ---------------------------------------------------------------------------

test('admin GET without auth returns 401', async () => {
  const env = makeEnv(JSON.stringify(twoValidRecords()));
  const res = await worker.fetch(req('/api/admin/artworks'), env);
  assert.equal(res.status, 401);
});

test('admin GET with auth returns full records (incl. internal fields), ordered', async () => {
  const env = makeEnv(JSON.stringify(twoValidRecords()));
  const request = await authedReq('/api/admin/artworks', env.ADMIN_SESSION_SECRET);
  const res = await worker.fetch(request, env);
  assert.equal(res.status, 200);
  const list = await body(res);
  assert.deepEqual(list.map((r) => r.id), ['mj-001', 'mj-002']);
  const sample = list[0];
  assert.equal('catalogNumber' in sample, true);
  assert.equal('sortOrder' in sample, true);
  assert.equal('provenance' in sample, true);
  assert.equal(sample.catalogNumber, 'MJ-001');
});

test('admin GET with missing metadata returns []', async () => {
  const env = makeEnv(undefined);
  const request = await authedReq('/api/admin/artworks', env.ADMIN_SESSION_SECRET);
  const res = await worker.fetch(request, env);
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), []);
});

// ---------------------------------------------------------------------------
// PUT /api/admin/artworks (admin)
// ---------------------------------------------------------------------------

test('admin PUT without auth returns 401', async () => {
  const env = makeEnv(undefined);
  const res = await worker.fetch(req('/api/admin/artworks', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([])
  }), env);
  assert.equal(res.status, 401);
});

test('admin PUT with wrong content-type returns 415', async () => {
  const env = makeEnv(undefined);
  const request = await authedReq('/api/admin/artworks', env.ADMIN_SESSION_SECRET, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: 'nope'
  });
  const res = await worker.fetch(request, env);
  assert.equal(res.status, 415);
});

test('admin PUT with invalid schema returns 400 and does not store', async () => {
  const env = makeEnv(undefined);
  const request = await authedReq('/api/admin/artworks', env.ADMIN_SESSION_SECRET, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ id: 'mj-001', size: 'legacy' }])
  });
  const res = await worker.fetch(request, env);
  assert.equal(res.status, 400);
  // Nothing stored.
  const publicRes = await worker.fetch(req('/api/artworks'), env);
  assert.deepEqual(await body(publicRes), []);
});

test('admin PUT with valid canonical list stores and returns sorted full records', async () => {
  const env = makeEnv(undefined);
  const records = twoValidRecords();
  const request = await authedReq('/api/admin/artworks', env.ADMIN_SESSION_SECRET, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(records)
  });
  const res = await worker.fetch(request, env);
  assert.equal(res.status, 200);
  const result = await body(res);
  assert.equal(result.ok, true);
  assert.deepEqual(result.artworks.map((r) => r.id), ['mj-001', 'mj-002']);
  assert.equal('provenance' in result.artworks[0], true);

  // Confirm it was persisted to R2 and is now readable via the public API.
  const publicRes = await worker.fetch(req('/api/artworks'), env);
  const list = await body(publicRes);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((r) => r.id), ['mj-001', 'mj-002']);
});

test('admin PUT rejects invalid JSON body with 400', async () => {
  const env = makeEnv(undefined);
  const request = await authedReq('/api/admin/artworks', env.ADMIN_SESSION_SECRET, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{not json'
  });
  const res = await worker.fetch(request, env);
  assert.equal(res.status, 400);
});
