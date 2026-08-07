import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/worker.js';
import * as bookEoi from '../src/book-eoi.js';
import {
  extractCreateTableBody,
  parseTableBody,
  extractIndexes,
  stripSqlComments,
  liveCatalogProbe
} from '../../../scripts/check-book-eoi-schema.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const {
  BOOK_CODES,
  MAX_BOOK_EOI_BODY_BYTES,
  MAX_BOOK_EOI_ADMITTED_LIMIT,
  EXPECTED_SCHEMA_SIGNATURE,
  SCHEMA_TABLE,
  computeColumnSignature,
  validateBookEoiPayload,
  validateStatusUpdate,
  normalizeEmail,
  canonicalizeName,
  hmacEmailHash,
  encryptPii,
  decryptPii
} = bookEoi;

const HMAC_KEY = 'test-hmac-secret';
const ENC_KEY = 'test-encryption-secret';
const SESSION_SECRET = 'test-secret-key';
const SESSION_COOKIE = 'mj_art_admin';
const SESSION_MAX_AGE_MS = 60 * 60 * 8 * 1000;

const SQL_PATH = path.resolve(import.meta.dirname, '..', '..', '..', 'database', 'mj-eoi-schema.sql');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function req(path, options = {}) {
  return new Request(new URL(path, 'http://localhost'), options);
}

// Same-origin JSON POST helper.
function jsonPost(path, payload, headers = {}) {
  const h = new Headers({ 'content-type': 'application/json', origin: 'http://localhost' });
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return req(path, { method: 'POST', headers: h, body: JSON.stringify(payload) });
}

// Fake Neon SQL executor: routes by substring of the statement text.
function makeSql(responder) {
  const calls = [];
  const sql = async function sql(text, params) {
    calls.push({ text, params });
    return responder(text, params);
  };
  sql.calls = calls;
  return sql;
}

function okTurnstile({ action = 'books-eoi', hostname = 'localhost', success = true } = {}) {
  return async () =>
    new Response(JSON.stringify({ success, action, hostname, 'challenge_ts': new Date().toISOString() }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
}

function failClosedTurnstile() {
  return async () => {
    throw new Error('network down');
  };
}

function makeEnv({ sql, turnstile, rateLimiter, withConfig = true } = {}) {
  const env = {
    ARTWORK_IMAGES: { async get() { return null; }, async put() {} },
    ASSETS: { async fetch() { return new Response('not found', { status: 404 }); } },
    ADMIN_PASSWORD: 'secret',
    ADMIN_SESSION_SECRET: SESSION_SECRET,
    BOOK_EOI_TURNSTILE_ACTION: 'books-eoi',
    BOOK_EOI_ALLOWED_HOSTNAMES: 'localhost',
    BOOK_EOI_RATE_LIMITER: rateLimiter || { async limit() { return { success: true }; } },
    TURNSTILE_FETCH: turnstile || okTurnstile()
  };
  if (withConfig) {
    env.NEON_DATABASE_URL = 'postgres://u:p@host/db';
    env.BOOK_EOI_HMAC_KEY = HMAC_KEY;
    env.BOOK_EOI_ENCRYPTION_KEY = ENC_KEY;
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
  }
  if (sql) env.BOOK_EOI_SQL = sql;
  return env;
}

// Admin auth: mirror the worker's HMAC session token.
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
async function authedReq(path, options = {}) {
  const token = await mintToken(SESSION_SECRET);
  const headers = new Headers(options.headers);
  headers.set('cookie', `${SESSION_COOKIE}=${token}`);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return req(path, { ...options, headers });
}

async function body(res) {
  return JSON.parse(await res.text());
}

// Valid submission payload.
function validPayload(overrides = {}) {
  return {
    book: 'biography',
    format: 'hardcover',
    quantity: 2,
    name: 'Jane Doe',
    email: 'JANE.Example@Example.COM ',
    turnstileToken: 'fake-turnstile-token',
    ...overrides
  };
}

// SQL responder that simulates a fresh insert (no existing row).
function insertResponder() {
  return (text) => {
    if (/SELECT id, status/.test(text)) return [];
    if (/^INSERT INTO mj_eoi/.test(text)) return [];
    throw new Error('unexpected SQL: ' + text);
  };
}

// ===========================================================================
// 1. Web Crypto: HMAC + AES-256-GCM roundtrip / tamper
// ===========================================================================

test('hmacEmailHash is deterministic for the same normalized email', async () => {
  const a = await hmacEmailHash(HMAC_KEY, 'jane@example.com');
  const b = await hmacEmailHash(HMAC_KEY, 'jane@example.com');
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test('hmacEmailHash differs across emails and is keyed', async () => {
  const a = await hmacEmailHash(HMAC_KEY, 'jane@example.com');
  const b = await hmacEmailHash(HMAC_KEY, 'other@example.com');
  const c = await hmacEmailHash('different-key', 'jane@example.com');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('AES-GCM encrypt/decrypt roundtrip recovers canonical {name,email}', async () => {
  const id = crypto.randomUUID();
  const { ciphertext, iv } = await encryptPii(ENC_KEY, { name: 'Jane', email: 'jane@example.com' }, id);
  assert.equal(typeof ciphertext, 'string');
  assert.equal(typeof iv, 'string');
  assert.ok(ciphertext.length > 0);
  const recovered = await decryptPii(ENC_KEY, ciphertext, iv, id);
  assert.deepEqual(recovered, { name: 'Jane', email: 'jane@example.com' });
});

test('AES-GCM tamper detection: flipped ciphertext throws on decrypt', async () => {
  const id = crypto.randomUUID();
  const { ciphertext, iv } = await encryptPii(ENC_KEY, { name: 'Jane', email: 'jane@example.com' }, id);
  const flipped = ciphertext.slice(0, -2) + (ciphertext.slice(-2) === 'AA' ? 'BB' : 'AA');
  await assert.rejects(() => decryptPii(ENC_KEY, flipped, iv, id));
});

test('AES-GCM wrong key throws on decrypt', async () => {
  const id = crypto.randomUUID();
  const { ciphertext, iv } = await encryptPii(ENC_KEY, { name: 'Jane', email: 'jane@example.com' }, id);
  await assert.rejects(() => decryptPii('wrong-key', ciphertext, iv, id));
});

test('AES-GCM AAD binding: ciphertext does not decrypt under a different row id', async () => {
  const id = crypto.randomUUID();
  const { ciphertext, iv } = await encryptPii(ENC_KEY, { name: 'Jane', email: 'jane@example.com' }, id);
  await assert.rejects(() => decryptPii(ENC_KEY, ciphertext, iv, crypto.randomUUID()));
});

test('IV is random: two encryptions of the same plaintext differ', async () => {
  const id = crypto.randomUUID();
  const a = await encryptPii(ENC_KEY, { name: 'Jane', email: 'jane@example.com' }, id);
  const b = await encryptPii(ENC_KEY, { name: 'Jane', email: 'jane@example.com' }, id);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

// ===========================================================================
// 2. Normalization & dedup
// ===========================================================================

test('normalizeEmail lowercases, trims, and is stable for equivalent inputs', () => {
  assert.equal(normalizeEmail('  Jane.Example@Example.COM '), 'jane.example@example.com');
  assert.equal(normalizeEmail('\tJane.Example@Example.COM\n'), 'jane.example@example.com');
  assert.equal(normalizeEmail('Jane.Example@Example.COM'), 'jane.example@example.com');
});

test('normalizeEmail rejects malformed addresses', () => {
  for (const bad of ['', '   ', 'noat', 'no@domain', 'a@b', 'a @b.com', 'a..b@x.com', 'a@b..com', null, 42, { x: 1 }]) {
    assert.equal(normalizeEmail(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('canonicalizeName trims, collapses internal whitespace, bounds length', () => {
  assert.equal(canonicalizeName('  Jane   Doe  '), 'Jane Doe');
  assert.equal(canonicalizeName('Jane'), 'Jane');
  assert.equal(canonicalizeName('   '), null);
  assert.equal(canonicalizeName('x'.repeat(101)), null);
  assert.equal(canonicalizeName('x'.repeat(100)), 'x'.repeat(100));
});

test('dedup: equivalent emails produce the same HMAC hash after normalization', async () => {
  const a = await hmacEmailHash(HMAC_KEY, normalizeEmail(' Jane@example.com '));
  const b = await hmacEmailHash(HMAC_KEY, normalizeEmail('jane@example.com'));
  assert.equal(a, b);
});

// ===========================================================================
// 3. Strict validation / errors / body caps / origin
// ===========================================================================

test('validateBookEoiPayload accepts a well-formed payload', () => {
  const r = validateBookEoiPayload(validPayload());
  assert.equal(r.ok, true);
  assert.equal(r.fields.email, 'jane.example@example.com');
  assert.equal(r.fields.book, 'biography');
});

test('validateBookEoiPayload rejects unknown fields', () => {
  const r = validateBookEoiPayload({ ...validPayload(), extra: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('validateBookEoiPayload rejects out-of-range and non-integer quantity', () => {
  for (const q of [0, 11, 1.5, '2', null, -1]) {
    const r = validateBookEoiPayload({ ...validPayload(), quantity: q });
    assert.equal(r.ok, false, `quantity ${q} should fail`);
  }
  for (const q of [1, 5, 10]) {
    const r = validateBookEoiPayload({ ...validPayload(), quantity: q });
    assert.equal(r.ok, true, `quantity ${q} should pass`);
  }
});

test('validateBookEoiPayload enforces book/format allowlists', () => {
  assert.equal(validateBookEoiPayload({ ...validPayload(), book: 'novel' }).ok, false);
  assert.equal(validateBookEoiPayload({ ...validPayload(), book: 'childrens' }).ok, true);
  assert.equal(validateBookEoiPayload({ ...validPayload(), format: 'audiobook' }).ok, false);
  assert.equal(validateBookEoiPayload({ ...validPayload(), format: 'ebook' }).ok, true);
});

test('validateBookEoiPayload treats any non-empty honeypot as a honeypot hit', () => {
  for (const f of ['website', 'companyUrl', 'company']) {
    const r = validateBookEoiPayload({ ...validPayload(), [f]: 'bot-trap' });
    assert.equal(r.ok, false);
    assert.equal(r.honeypot, true);
  }
  // empty honeypot values are ignored.
  assert.equal(validateBookEoiPayload({ ...validPayload(), website: '' }).ok, true);
});

test('validateStatusUpdate only accepts { status } with allowed status', () => {
  assert.equal(validateStatusUpdate({ status: 'contacted' }).ok, true);
  assert.equal(validateStatusUpdate({ status: 'archived' }).ok, false);
  assert.equal(validateStatusUpdate({ status: 'new', note: 'x' }).ok, false);
  assert.equal(validateStatusUpdate({}).ok, false);
});

test('POST rejects non-JSON content-type with 415', async () => {
  const env = makeEnv({ sql: makeSql(insertResponder()) });
  const res = await worker.fetch(
    req('/api/books/eoi', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'http://localhost' },
      body: 'nope'
    }),
    env
  );
  assert.equal(res.status, 415);
});

test('POST rejects invalid JSON with 400', async () => {
  const env = makeEnv({ sql: makeSql(insertResponder()) });
  const res = await worker.fetch(
    req('/api/books/eoi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: '{bad'
    }),
    env
  );
  assert.equal(res.status, 400);
});

test('POST rejects oversized declared body with 413', async () => {
  const env = makeEnv({ sql: makeSql(insertResponder()) });
  const res = await worker.fetch(
    req('/api/books/eoi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost', 'content-length': String(MAX_BOOK_EOI_BODY_BYTES + 1) },
      body: 'x'
    }),
    env
  );
  assert.equal(res.status, 413);
});

test('POST uses UTF-8 byte length: oversized multibyte body is 413', async () => {
  const env = makeEnv({ sql: makeSql(insertResponder()) });
  const char = '☃';
  const count = Math.ceil((MAX_BOOK_EOI_BODY_BYTES + 1024) / 3) + 1;
  const buf = Buffer.from(char.repeat(count));
  assert.ok(buf.length > MAX_BOOK_EOI_BODY_BYTES);
  const res = await worker.fetch(
    req('/api/books/eoi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: buf
    }),
    env
  );
  assert.equal(res.status, 413);
});

test('POST rejects cross-origin submissions with 400', async () => {
  const env = makeEnv({ sql: makeSql(insertResponder()) });
  const res = await worker.fetch(
    req('/api/books/eoi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify(validPayload())
    }),
    env
  );
  assert.equal(res.status, 400);
  // DB never touched.
  assert.equal(env.BOOK_EOI_SQL.calls.length, 0);
});

test('POST rejects missing origin/referer with 400', async () => {
  const env = makeEnv({ sql: makeSql(insertResponder()) });
  const res = await worker.fetch(
    req('/api/books/eoi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validPayload())
    }),
    env
  );
  assert.equal(res.status, 400);
});

// ===========================================================================
// 4. Turnstile verification (mocked via TURNSTILE_FETCH)
// ===========================================================================

test('POST with valid Turnstile succeeds and inserts a row', async () => {
  const sql = makeSql(insertResponder());
  const env = makeEnv({ sql });
  const res = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { ok: true });
  // One SELECT (existing check) + one INSERT.
  const stmts = sql.calls.map((c) => c.text.split(' ')[0]);
  assert.equal(sql.calls.length, 2);
  assert.ok(stmts.includes('SELECT'));
  assert.ok(stmts.includes('INSERT'));
  // Inserted hash is the HMAC of the normalized email.
  const ins = sql.calls.find((c) => /^INSERT/.test(c.text));
  const expectedHash = await hmacEmailHash(HMAC_KEY, 'jane.example@example.com');
  assert.equal(ins.params[2], expectedHash);
});

test('POST with Turnstile success=false returns 400 and touches no DB', async () => {
  const sql = makeSql(insertResponder());
  const env = makeEnv({ sql, turnstile: okTurnstile({ success: false }) });
  const res = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), env);
  assert.equal(res.status, 400);
  assert.equal(sql.calls.length, 0);
});

test('POST with Turnstile action mismatch returns 400', async () => {
  const sql = makeSql(insertResponder());
  const env = makeEnv({ sql, turnstile: okTurnstile({ action: 'other-action' }) });
  const res = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), env);
  assert.equal(res.status, 400);
  assert.equal(sql.calls.length, 0);
});

test('POST with Turnstile hostname mismatch returns 400', async () => {
  const sql = makeSql(insertResponder());
  const env = makeEnv({ sql, turnstile: okTurnstile({ hostname: 'evil.example' }) });
  const res = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), env);
  assert.equal(res.status, 400);
});

test('POST when siteverify is unreachable fails closed (503)', async () => {
  const sql = makeSql(insertResponder());
  const env = makeEnv({ sql, turnstile: failClosedTurnstile() });
  const res = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), env);
  assert.equal(res.status, 503);
  assert.equal(sql.calls.length, 0);
});

test('Turnstile replay assumption: a presented token is validated server-side once (no local challenge_ts gate)', async () => {
  // We rely on Cloudflare single-use enforcement and intentionally do NOT add a
  // local challenge_ts recency gate (avoids clock-skew false negatives). This
  // test documents that a normal success response is accepted.
  const sql = makeSql(insertResponder());
  const env = makeEnv({ sql, turnstile: okTurnstile({ 'challenge_ts': new Date().toISOString() }) });
  const res = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), env);
  assert.equal(res.status, 200);
});

// ===========================================================================
// 5. Rate limiter denial
// ===========================================================================

test('POST returns 429 when the rate limiter denies', async () => {
  const sql = makeSql(insertResponder());
  const env = makeEnv({ sql, rateLimiter: { async limit() { return { success: false }; } } });
  const res = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), env);
  assert.equal(res.status, 429);
  // Turnstile/DB never reached after denial.
  assert.equal(sql.calls.length, 0);
});

test('rate limiter is keyed per client IP', async () => {
  let seenKey;
  const env = makeEnv({
    sql: makeSql(insertResponder()),
    rateLimiter: { async limit({ key }) { seenKey = key; return { success: true }; } }
  });
  const res = await worker.fetch(
    req('/api/books/eoi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost', 'cf-connecting-ip': '203.0.113.7' },
      body: JSON.stringify(validPayload())
    }),
    env
  );
  assert.equal(res.status, 200);
  assert.equal(seenKey, 'books-eoi:203.0.113.7');
});

// ===========================================================================
// 6. Honeypot + generic-ok anti-enumeration
// ===========================================================================

test('honeypot submission returns generic ok without DB/Turnstile/limit work', async () => {
  let limited = false;
  const sql = makeSql(insertResponder());
  const env = makeEnv({
    sql,
    rateLimiter: { async limit() { limited = true; return { success: true }; } }
  });
  const res = await worker.fetch(jsonPost('/api/books/eoi', { ...validPayload(), website: 'spam' }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { ok: true });
  assert.equal(limited, false);
  assert.equal(sql.calls.length, 0);
});

test('duplicate (existing email+book) and new both return identical generic ok', async () => {
  const id = crypto.randomUUID();
  // First responder: existing row found -> UPDATE path.
  const dupSql = makeSql((text) => {
    if (/SELECT id, status/.test(text)) return [{ id, status: 'withdrawn' }];
    if (/^UPDATE mj_eoi/.test(text)) return [];
    throw new Error('unexpected: ' + text);
  });
  const newSql = makeSql(insertResponder());
  const dupRes = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), makeEnv({ sql: dupSql }));
  const newRes = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), makeEnv({ sql: newSql }));
  assert.equal(dupRes.status, 200);
  assert.equal(newRes.status, 200);
  assert.deepEqual(await body(dupRes), await body(newRes));
  // Dup path used UPDATE and reactivated withdrawn -> 'new'.
  const upd = dupSql.calls.find((c) => /^UPDATE/.test(c.text));
  assert.ok(upd);
  assert.ok(upd.params.includes('withdrawn'));
  assert.ok(upd.params.includes('new'));
});

// ===========================================================================
// 7. Public GET /api/books/interest (no leaks, both books, counts)
// ===========================================================================

test('interest returns both books with correct counts, excluding withdrawn', async () => {
  const sql = makeSql((text) => {
    if (/GROUP BY book_code/.test(text)) {
      return [
        { book_code: 'biography', interest_count: 3, requested_copies: 7 },
        { book_code: 'childrens', interest_count: 1, requested_copies: 2 }
      ];
    }
    throw new Error('unexpected: ' + text);
  });
  const env = makeEnv({ sql });
  const res = await worker.fetch(req('/api/books/interest'), env);
  assert.equal(res.status, 200);
  const data = await body(res);
  assert.equal(data.books.length, 2);
  const byBook = Object.fromEntries(data.books.map((b) => [b.book, b]));
  assert.equal(byBook.biography.interestCount, 3);
  assert.equal(byBook.biography.requestedCopies, 7);
  assert.equal(byBook.childrens.interestCount, 1);
  // The query excludes withdrawn (WHERE status <> 'withdrawn').
  const sel = sql.calls.find((c) => /GROUP BY book_code/.test(c.text));
  assert.match(sel.text, /status <> \$1/);
  assert.equal(sel.params[0], 'withdrawn');
});

test('interest always returns both books even when DB returns none', async () => {
  const sql = makeSql(() => []);
  const env = makeEnv({ sql });
  const res = await worker.fetch(req('/api/books/interest'), env);
  const data = await body(res);
  assert.deepEqual(
    data.books.map((b) => b.book).sort(),
    [...BOOK_CODES].sort()
  );
  for (const b of data.books) {
    assert.equal(b.interestCount, 0);
    assert.equal(b.requestedCopies, 0);
  }
});

test('interest response never leaks PII, hashes, or ciphertext', async () => {
  const sql = makeSql(() => [
    { book_code: 'biography', interest_count: 1, requested_copies: 1 }
  ]);
  const env = makeEnv({ sql });
  const res = await worker.fetch(req('/api/books/interest'), env);
  const text = await res.text();
  for (const needle of ['@', 'email', 'name', 'ciphertext', 'pii_', 'hash']) {
    assert.equal(text.toLowerCase().includes(needle), false, `leaked ${needle}`);
  }
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
});

test('interest fails closed 503 when DB throws', async () => {
  const sql = makeSql(() => { throw new Error('db down'); });
  const env = makeEnv({ sql });
  const res = await worker.fetch(req('/api/books/interest'), env);
  assert.equal(res.status, 503);
});

// ===========================================================================
// 8. Public GET /api/books/health (schema signature, no PII/credentials)
// ===========================================================================

test('health reports healthy when live column signature matches', async () => {
  const cols = 'book_code,created_at,email_hash,format_code,id,pii_ciphertext,pii_iv,quantity,status,updated_at'.split(',');
  const sql = makeSql(() => cols.map((c) => ({ column_name: c })));
  const env = makeEnv({ sql });
  const res = await worker.fetch(req('/api/books/health'), env);
  assert.equal(res.status, 200);
  const data = await body(res);
  assert.equal(data.status, 'healthy');
  assert.equal(data.schemaSignature, 'match');
});

test('health reports degraded on column drift', async () => {
  const sql = makeSql(() => [{ column_name: 'id' }, { column_name: 'book_code' }]);
  const env = makeEnv({ sql });
  const res = await worker.fetch(req('/api/books/health'), env);
  assert.equal(res.status, 503);
  const data = await body(res);
  assert.equal(data.schemaSignature, 'mismatch');
});

test('health response contains no credentials or PII', async () => {
  const cols = 'book_code,created_at,email_hash,format_code,id,pii_ciphertext,pii_iv,quantity,status,updated_at'.split(',');
  const sql = makeSql(() => cols.map((c) => ({ column_name: c })));
  const env = makeEnv({ sql });
  const res = await worker.fetch(req('/api/books/health'), env);
  const text = await res.text();
  for (const needle of [env.NEON_DATABASE_URL, 'postgres://', 'password', '@example']) {
    assert.equal(text.includes(needle), false);
  }
});

// ===========================================================================
// 9. Fail-closed config gate
// ===========================================================================

test('POST returns 503 when required config/secrets are missing', async () => {
  const env = makeEnv({ withConfig: false });
  const res = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), env);
  assert.equal(res.status, 503);
});

test('interest returns 503 when NEON_DATABASE_URL is missing', async () => {
  const env = makeEnv({ withConfig: false });
  const res = await worker.fetch(req('/api/books/interest'), env);
  assert.equal(res.status, 503);
});

// ===========================================================================
// 10. Books API terminal 404 / 405 (never static-asset fallback)
// ===========================================================================

test('unknown /api/books/* returns JSON 404, not asset fallback', async () => {
  const env = makeEnv({ sql: makeSql(insertResponder()) });
  const res = await worker.fetch(req('/api/books/nope'), env);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/json');
});

test('GET on POST-only /api/books/eoi returns 405', async () => {
  const env = makeEnv({ sql: makeSql(insertResponder()) });
  const res = await worker.fetch(req('/api/books/eoi'), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('content-type'), 'application/json');
});

test('DELETE on /api/books/interest returns 405', async () => {
  const env = makeEnv({ sql: makeSql(insertResponder()) });
  const res = await worker.fetch(req('/api/books/interest', { method: 'DELETE' }), env);
  assert.equal(res.status, 405);
});

// ===========================================================================
// 11. Admin routes: auth, decrypt, summary, status update, no DELETE
// ===========================================================================

async function seedRowSql(rows) {
  return makeSql((text) => {
    if (/ORDER BY created_at DESC/.test(text)) return rows;
    if (/GROUP BY status/.test(text)) return rows;
    if (/UPDATE mj_eoi.book_eoi SET status/.test(text)) return [{ id: 'updated' }];
    throw new Error('unexpected: ' + text);
  });
}

test('admin list without auth returns 401 before any DB/crypto work', async () => {
  const sql = makeSql(() => { throw new Error('should not query'); });
  const env = makeEnv({ sql });
  const res = await worker.fetch(req('/api/admin/books/eoi'), env);
  assert.equal(res.status, 401);
  assert.equal(sql.calls.length, 0);
});

test('admin list decrypts recent rows and exposes plaintext PII only here', async () => {
  const id = crypto.randomUUID();
  const { ciphertext, iv } = await encryptPii(ENC_KEY, { name: 'Jane Doe', email: 'jane@example.com' }, id);
  const rows = [
    {
      id, book_code: 'biography', email_hash: 'h'.repeat(64),
      pii_ciphertext: ciphertext, pii_iv: iv, quantity: 3, format_code: 'hardcover',
      status: 'new', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z'
    }
  ];
  const env = makeEnv({ sql: await seedRowSql(rows) });
  const res = await worker.fetch(await authedReq('/api/admin/books/eoi'), env);
  assert.equal(res.status, 200);
  const data = await body(res);
  assert.equal(data.rows.length, 1);
  const r = data.rows[0];
  assert.equal(r.id, id);
  assert.equal(r.book, 'biography');
  assert.equal(r.name, 'Jane Doe');
  assert.equal(r.email, 'jane@example.com');
  assert.equal(r.quantity, 3);
  assert.equal(r.format, 'hardcover');
  assert.equal(r.status, 'new');
  // Raw crypto material must never be exposed.
  const text = JSON.stringify(data);
  for (const needle of ['ciphertext', 'pii_', 'email_hash', iv]) {
    assert.equal(text.includes(needle), false, `leaked ${needle}`);
  }
});

test('admin list caps limit at 100', async () => {
  const sql = await seedRowSql([]);
  const env = makeEnv({ sql });
  await worker.fetch(await authedReq('/api/admin/books/eoi?limit=9999'), env);
  const listCall = sql.calls.find((c) => /ORDER BY created_at DESC/.test(c.text));
  assert.ok(listCall);
  assert.equal(listCall.params[0], MAX_BOOK_EOI_ADMITTED_LIMIT);
});

test('admin list: tampered ciphertext yields null PII without leaking raw', async () => {
  const id = crypto.randomUUID();
  const rows = [
    {
      id, book_code: 'biography', email_hash: 'h'.repeat(64),
      pii_ciphertext: 'AAAA', pii_iv: 'AAAAAAAAAAAAAAAA', quantity: 1, format_code: 'ebook',
      status: 'new', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
    }
  ];
  const env = makeEnv({ sql: await seedRowSql(rows) });
  const res = await worker.fetch(await authedReq('/api/admin/books/eoi'), env);
  const data = await body(res);
  assert.equal(data.rows[0].name, null);
  assert.equal(data.rows[0].email, null);
});

test('admin summary returns counts by status + total, no PII', async () => {
  const env = makeEnv({
    sql: makeSql(() => [
      { status: 'new', count: 4 },
      { status: 'contacted', count: 2 },
      { status: 'withdrawn', count: 1 }
    ])
  });
  const res = await worker.fetch(await authedReq('/api/admin/books/eoi/summary'), env);
  assert.equal(res.status, 200);
  const data = await body(res);
  assert.equal(data.byStatus.new, 4);
  assert.equal(data.total, 7);
  const text = JSON.stringify(data);
  assert.equal(text.includes('@'), false);
});

test('admin PATCH updates status with {status} only', async () => {
  const id = crypto.randomUUID();
  const sql = makeSql((text) => {
    if (/UPDATE mj_eoi.book_eoi SET status/.test(text)) {
      assert.equal(text.includes('RETURNING id'), true);
      return [{ id }];
    }
    throw new Error('unexpected: ' + text);
  });
  const env = makeEnv({ sql });
  const res = await worker.fetch(
    await authedReq('/api/admin/books/eoi/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'contacted' }) }),
    env
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { ok: true });
});

test('admin PATCH without auth returns 401', async () => {
  const env = makeEnv({ sql: makeSql(() => { throw new Error('no'); }) });
  const res = await worker.fetch(
    req('/api/admin/books/eoi/' + crypto.randomUUID(), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'new' }) }),
    env
  );
  assert.equal(res.status, 401);
});

test('admin PATCH rejects extra fields / unknown status', async () => {
  const env = makeEnv({ sql: makeSql(() => []) });
  const id = crypto.randomUUID();
  const r1 = await worker.fetch(
    await authedReq('/api/admin/books/eoi/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'new', foo: 1 }) }),
    env
  );
  assert.equal(r1.status, 400);
  const r2 = await worker.fetch(
    await authedReq('/api/admin/books/eoi/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'deleted' }) }),
    env
  );
  assert.equal(r2.status, 400);
});

test('admin PATCH returns 404 for unknown id', async () => {
  const env = makeEnv({ sql: makeSql(() => []) });
  const id = crypto.randomUUID();
  const res = await worker.fetch(
    await authedReq('/api/admin/books/eoi/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'new' }) }),
    env
  );
  assert.equal(res.status, 404);
});

test('admin PATCH rejects malformed id with 404', async () => {
  const env = makeEnv({ sql: makeSql(() => []) });
  const res = await worker.fetch(
    await authedReq('/api/admin/books/eoi/not-a-uuid', { method: 'PATCH', body: JSON.stringify({ status: 'new' }) }),
    env
  );
  assert.equal(res.status, 404);
});

test('unknown admin books path returns 404 (no asset fallback)', async () => {
  const env = makeEnv({ sql: makeSql(() => []) });
  const res = await worker.fetch(await authedReq('/api/admin/books/eoi/other'), env);
  assert.equal(res.status, 404);
});

test('there is no DELETE route: DELETE on admin eoi returns 404 (no deletion path)', async () => {
  const env = makeEnv({ sql: makeSql(() => { throw new Error('must not query'); }) });
  const res = await worker.fetch(
    await authedReq('/api/admin/books/eoi/' + crypto.randomUUID(), { method: 'DELETE' }),
    env
  );
  assert.equal(res.status, 404);
});

// ===========================================================================
// 12. Schema SQL + signature + drift parser
// ===========================================================================

test('the committed SQL signature equals the app EXPECTED_SCHEMA_SIGNATURE', () => {
  const sql = readFileSync(SQL_PATH, 'utf8');
  const table = extractCreateTableBody(sql);
  const { columns } = parseTableBody(table.body);
  const sig = computeColumnSignature(SCHEMA_TABLE, columns.map((c) => c.name));
  assert.equal(sig, EXPECTED_SCHEMA_SIGNATURE);
});

test('EXPECTED_SCHEMA_SIGNATURE is the canonical column string', () => {
  assert.equal(
    EXPECTED_SCHEMA_SIGNATURE,
    'mj_eoi.book_eoi|book_code,created_at,email_hash,format_code,id,pii_ciphertext,pii_iv,quantity,status,updated_at'
  );
});

test('computeColumnSignature is order-independent and case-insensitive', () => {
  const a = computeColumnSignature('mj_eoi.book_eoi', ['id', 'Book_Code', 'status']);
  const b = computeColumnSignature('mj_eoi.book_eoi', ['status', 'book_code', 'ID']);
  assert.equal(a, b);
});

test('drift detection: added column changes the signature', () => {
  const base = ['id', 'book_code'];
  const drifted = ['id', 'book_code', 'extra_col'];
  assert.notEqual(
    computeColumnSignature(SCHEMA_TABLE, base),
    computeColumnSignature(SCHEMA_TABLE, drifted)
  );
});

test('parseTableBody extracts all 10 columns with types', () => {
  const sql = readFileSync(SQL_PATH, 'utf8');
  const table = extractCreateTableBody(sql);
  const { columns } = parseTableBody(table.body);
  assert.equal(columns.length, 10);
  const names = columns.map((c) => c.name).sort();
  assert.deepEqual(names, EXPECTED_SCHEMA_SIGNATURE.split('|')[1].split(',').sort());
  const idCol = columns.find((c) => c.name === 'id');
  assert.match(idCol.type, /uuid/i);
  const qtyCol = columns.find((c) => c.name === 'quantity');
  assert.match(qtyCol.type, /integer/i);
});

test('extractIndexes finds both required indexes', () => {
  const sql = readFileSync(SQL_PATH, 'utf8');
  const indexes = extractIndexes(sql);
  const names = indexes.map((i) => i.name);
  assert.ok(names.includes('book_eoi_book_status_idx'));
  assert.ok(names.includes('book_eoi_book_created_idx'));
});

test('stripSqlComments removes line and block comments', () => {
  const out = stripSqlComments('SELECT 1; -- a comment\n/* block */ SELECT 2;');
  assert.equal(out.includes('a comment'), false);
  assert.equal(out.includes('block'), false);
  assert.ok(out.includes('SELECT 1'));
});

test('liveCatalogProbe emits information_schema + pg_catalog queries', () => {
  const probe = liveCatalogProbe();
  assert.ok(probe.includes('information_schema.columns'));
  assert.ok(probe.includes('pg_constraint'));
  assert.ok(probe.includes('pg_indexes'));
  assert.ok(probe.includes('role_table_grants'));
});

test('the SQL declares the UNIQUE(book_code, email_hash) constraint', () => {
  const sql = readFileSync(SQL_PATH, 'utf8');
  const table = extractCreateTableBody(sql);
  const { tableConstraints } = parseTableBody(table.body);
  assert.ok(/UNIQUE\s*\(\s*book_code\s*,\s*email_hash\s*\)/i.test(tableConstraints.join(' ')));
});

test('the SQL documents the SELECT/INSERT/UPDATE-only role contract', () => {
  const sql = readFileSync(SQL_PATH, 'utf8');
  assert.ok(/GRANT SELECT, INSERT, UPDATE/.test(sql));
  assert.ok(/REVOKE DELETE/.test(sql));
  // And forbids DELETE/TRUNCATE in executable SQL.
  const stripped = stripSqlComments(sql);
  assert.equal(/\bDELETE\s+FROM\b/i.test(stripped), false);
  assert.equal(/\bTRUNCATE\b/i.test(stripped), false);
});
