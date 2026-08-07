import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/worker.js';
import { isBooksPage } from '../src/worker.js';
import * as bookEoi from '../src/book-eoi.js';
import {
  extractCreateTableBody,
  parseTableBody,
  parseChecks,
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
  EXPECTED_LIVE_CATALOG,
  MIN_SECRET_BYTES,
  SCHEMA_TABLE,
  computeColumnSignature,
  createNeonSqlExecutor,
  bookEoiSecretsOk,
  secretByteLength,
  compareLiveCatalog,
  probeLiveCatalogShape,
  validateBookEoiPayload,
  validateStatusUpdate,
  normalizeEmail,
  canonicalizeName,
  hmacEmailHash,
  encryptPii,
  decryptPii,
  isUniqueViolation,
  summarizeBookEoi
} = bookEoi;

// Secrets must meet the >=32-byte runtime gate, so the test keys are >=32 chars.
const HMAC_KEY = 'test-hmac-secret-' + '0123456789'.repeat(3);
const ENC_KEY = 'test-enc-secret--' + '0123456789'.repeat(3);
const SESSION_SECRET = 'test-admin-session-secret-0123456789';
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
    env.TURNSTILE_SITE_KEY = 'test-site-key';
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
    consent: true,
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

test('validateBookEoiPayload requires consent to be exactly the boolean true', () => {
  // Missing consent -> silent trap (generic ok, no stored fields), NOT a 400.
  const { book, format, quantity, name, email, turnstileToken } = validPayload();
  const missing = validateBookEoiPayload({ book, format, quantity, name, email, turnstileToken });
  assert.equal(missing.ok, false);
  assert.equal(missing.silent, true, 'missing consent is a silent trap');

  // Missing/false/null consent all collapse to the same silent trap.
  for (const bad of [false, null, undefined]) {
    const r = validateBookEoiPayload({ ...validPayload(), consent: bad });
    assert.equal(r.ok, false, `consent ${JSON.stringify(bad)} must not be accepted`);
    assert.equal(r.silent, true, `consent ${JSON.stringify(bad)} must be a silent trap`);
    assert.equal('status' in r, false, 'silent must not carry a 400 status');
  }
  // A truthy-but-non-boolean value is a malformed request -> 400 (not silent).
  for (const bad of ['true', 'yes', 1, 'on']) {
    const r = validateBookEoiPayload({ ...validPayload(), consent: bad });
    assert.equal(r.ok, false, `consent ${JSON.stringify(bad)} must be rejected`);
    assert.equal(r.status, 400, `consent ${JSON.stringify(bad)} must be a 400`);
  }
  // Exactly boolean true is accepted.
  assert.equal(validateBookEoiPayload(validPayload()).ok, true);
});

test('validateBookEoiPayload does not carry consent into the stored fields', () => {
  const r = validateBookEoiPayload(validPayload());
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.fields).sort(), ['book', 'email', 'format', 'name', 'quantity', 'turnstileToken']);
  assert.equal('consent' in r.fields, false);
});

test('validateBookEoiPayload rejects consent sent as a non-boolean with 400', async () => {
  const env = makeEnv({ sql: makeSql(insertResponder()) });
  const res = await worker.fetch(
    jsonPost('/api/books/eoi', { ...validPayload(), consent: 'yes' }),
    env
  );
  assert.equal(res.status, 400);
  assert.equal(env.BOOK_EOI_SQL.calls.length, 0);
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

test('missing/false consent returns the same generic ok before limiter/Turnstile/DB', async () => {
  // A real submitter must actively check consent (the client enforces it too),
  // so a missing/false consent is a probe/bot -> identical generic ok, with no
  // rate-limit/Turnstile/DB work and no way to tell it apart from a real save.
  for (const consent of [undefined, false, null]) {
    let limited = false;
    let verified = false;
    const sql = makeSql(insertResponder());
    const env = makeEnv({
      sql,
      rateLimiter: { async limit() { limited = true; return { success: true }; } },
      turnstile: async () => { verified = true; return okTurnstile()(); }
    });
    const { book, format, quantity, name, email, turnstileToken } = validPayload();
    const res = await worker.fetch(
      jsonPost('/api/books/eoi', { book, format, quantity, name, email, turnstileToken, consent }),
      env
    );
    assert.equal(res.status, 200, `consent ${consent} -> 200`);
    assert.deepEqual(await body(res), { ok: true }, `consent ${consent} -> generic ok`);
    assert.equal(limited, false, 'rate limiter must not run');
    assert.equal(verified, false, 'Turnstile must not run');
    assert.equal(sql.calls.length, 0, 'DB must not be touched');
  }
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
// 8. Public GET /api/books/health (live-catalog shape comparison; outcome only)
// ===========================================================================
//
// Health now compares the LIVE catalog (columns/types/nullability/defaults +
// CHECK value sets + UNIQUE + exact indexes) to EXPECTED_LIVE_CATALOG and
// reveals only healthy | mismatch | unavailable -- never the differences.

function liveColumnsFixture() {
  return EXPECTED_LIVE_CATALOG.columns.map((c) => ({
    column_name: c.name,
    data_type: c.dataType,
    is_nullable: c.nullable ? 'YES' : 'NO',
    column_default: c.default,
    character_maximum_length: c.charLength == null ? null : c.charLength
  }));
}
function liveChecksFixture() {
  return [
    { name: 'book_eoi_book_code_check', definition: "CHECK ((book_code = ANY (ARRAY['biography'::text, 'childrens'::text])))" },
    { name: 'book_eoi_format_code_check', definition: "CHECK ((format_code = ANY (ARRAY['hardcover'::text, 'paperback'::text, 'ebook'::text, 'unsure'::text])))" },
    { name: 'book_eoi_status_check', definition: "CHECK ((status = ANY (ARRAY['new'::text, 'contacted'::text, 'withdrawn'::text])))" },
    { name: 'book_eoi_quantity_check', definition: 'CHECK ((quantity >= 1) AND (quantity <= 10))' }
  ];
}
function liveUniqueFixture() {
  return [{ name: 'book_eoi_book_email_unique', definition: 'UNIQUE (book_code, email_hash)' }];
}
function liveIndexesFixture() {
  return [
    { name: 'book_eoi_book_status_idx', definition: 'CREATE INDEX book_eoi_book_status_idx ON mj_eoi.book_eoi USING btree (book_code, status)' },
    { name: 'book_eoi_book_created_idx', definition: 'CREATE INDEX book_eoi_book_created_idx ON mj_eoi.book_eoi USING btree (book_code, created_at DESC)' }
  ];
}
function liveCatalogFixture() {
  return { columns: liveColumnsFixture(), checks: liveChecksFixture(), unique: liveUniqueFixture(), indexes: liveIndexesFixture() };
}
function liveCatalogSql(catalog) {
  return makeSql((text) => {
    if (/information_schema\.columns/.test(text)) return catalog.columns;
    if (/con\.contype = 'c'/.test(text)) return catalog.checks;
    if (/con\.contype = 'u'/.test(text)) return catalog.unique;
    if (/pg_indexes/.test(text)) return catalog.indexes;
    throw new Error('unexpected probe SQL: ' + text);
  });
}

test('health reports healthy when the live catalog matches the canonical shape', async () => {
  const env = makeEnv({ sql: liveCatalogSql(liveCatalogFixture()) });
  const res = await worker.fetch(req('/api/books/health'), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { status: 'healthy' });
});

test('health reports mismatch (503) when a column type drifts', async () => {
  const drifted = liveCatalogFixture();
  drifted.columns[2] = { ...drifted.columns[2], data_type: 'text' }; // email_hash char -> text
  const env = makeEnv({ sql: liveCatalogSql(drifted) });
  const res = await worker.fetch(req('/api/books/health'), env);
  assert.equal(res.status, 503);
  assert.deepEqual(await body(res), { status: 'mismatch' });
});

test('health reports mismatch when a CHECK value set drifts', async () => {
  const drifted = liveCatalogFixture();
  drifted.checks[0] = { name: 'book_eoi_book_code_check', definition: "CHECK ((book_code = ANY (ARRAY['biography'::text])))" };
  const env = makeEnv({ sql: liveCatalogSql(drifted) });
  const res = await worker.fetch(req('/api/books/health'), env);
  assert.equal(res.status, 503);
  assert.deepEqual(await body(res), { status: 'mismatch' });
});

test('health reports unavailable when the DB throws', async () => {
  const env = makeEnv({ sql: makeSql(() => { throw new Error('db down'); }) });
  const res = await worker.fetch(req('/api/books/health'), env);
  assert.equal(res.status, 503);
  assert.deepEqual(await body(res), { status: 'unavailable' });
});

test('health response reveals only the outcome (no columns/types/details/credentials)', async () => {
  const env = makeEnv({ sql: liveCatalogSql(liveCatalogFixture()) });
  const res = await worker.fetch(req('/api/books/health'), env);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { status: 'healthy' });
  for (const needle of ['column', 'mismatch', 'count', 'signature', 'data_type', 'pii_', 'email_hash', env.NEON_DATABASE_URL, 'postgres://', 'password']) {
    assert.equal(text.toLowerCase().includes(needle.toLowerCase()), false, `leaked ${needle}`);
  }
});

test('health returns unavailable when NEON_DATABASE_URL is missing', async () => {
  const env = makeEnv({ withConfig: false });
  const res = await worker.fetch(req('/api/books/health'), env);
  assert.equal(res.status, 503);
  assert.deepEqual(await body(res), { status: 'unavailable' });
});

test('health returns unavailable when TURNSTILE_SITE_KEY is missing', async () => {
  const env = makeEnv({ sql: liveCatalogSql(liveCatalogFixture()) });
  delete env.TURNSTILE_SITE_KEY;
  const res = await worker.fetch(req('/api/books/health'), env);
  assert.equal(res.status, 503);
  assert.deepEqual(await body(res), { status: 'unavailable' });
});

test('health returns unavailable when TURNSTILE_SECRET_KEY is missing', async () => {
  const env = makeEnv({ sql: liveCatalogSql(liveCatalogFixture()) });
  delete env.TURNSTILE_SECRET_KEY;
  const res = await worker.fetch(req('/api/books/health'), env);
  assert.equal(res.status, 503);
  assert.deepEqual(await body(res), { status: 'unavailable' });
});

test('health returns unavailable when the allowed hostname allowlist is empty', async () => {
  const env = makeEnv({ sql: liveCatalogSql(liveCatalogFixture()) });
  env.BOOK_EOI_ALLOWED_HOSTNAMES = '';
  const res = await worker.fetch(req('/api/books/health'), env);
  assert.equal(res.status, 503);
  assert.deepEqual(await body(res), { status: 'unavailable' });
});

test('health returns unavailable when a PII crypto key is short', async () => {
  const env = makeEnv({ sql: liveCatalogSql(liveCatalogFixture()) });
  env.BOOK_EOI_HMAC_KEY = 'short';
  const res = await worker.fetch(req('/api/books/health'), env);
  assert.equal(res.status, 503);
  assert.deepEqual(await body(res), { status: 'unavailable' });
});

test('trailing slash on /api/books/health is intentionally NOT normalized -> JSON 404', async () => {
  const env = makeEnv({ sql: liveCatalogSql(liveCatalogFixture()) });
  const res = await worker.fetch(req('/api/books/health/'), env);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/json');
});

// --- Pure live-catalog comparison tests (compareLiveCatalog) ---

test('compareLiveCatalog: exact-match fixture is a match with no mismatches', () => {
  const r = compareLiveCatalog(liveCatalogFixture());
  assert.equal(r.match, true);
  assert.deepEqual(r.mismatches, []);
});

test('compareLiveCatalog: column count, order, type, nullable, and default drift are all detected', () => {
  const tooFew = liveCatalogFixture();
  tooFew.columns = tooFew.columns.slice(0, 9);
  assert.equal(compareLiveCatalog(tooFew).match, false);

  const reordered = liveCatalogFixture();
  const cols = [...reordered.columns];
  [cols[0], cols[1]] = [cols[1], cols[0]];
  reordered.columns = cols;
  assert.equal(compareLiveCatalog(reordered).match, false);

  const nullableDrift = liveCatalogFixture();
  nullableDrift.columns[1] = { ...nullableDrift.columns[1], is_nullable: 'YES' };
  assert.equal(compareLiveCatalog(nullableDrift).match, false);

  const defaultDrift = liveCatalogFixture();
  defaultDrift.columns[7] = { ...defaultDrift.columns[7], column_default: "'archived'::text" };
  assert.equal(compareLiveCatalog(defaultDrift).match, false);

  const charLenDrift = liveCatalogFixture();
  charLenDrift.columns[2] = { ...charLenDrift.columns[2], character_maximum_length: 128 };
  assert.equal(compareLiveCatalog(charLenDrift).match, false);
});

test('compareLiveCatalog: CHECK value-set/bounds drift, missing UNIQUE, and wrong index columns are detected', () => {
  const checkDrift = liveCatalogFixture();
  checkDrift.checks[3] = { name: 'book_eoi_quantity_check', definition: 'CHECK ((quantity >= 1) AND (quantity <= 99))' };
  assert.equal(compareLiveCatalog(checkDrift).match, false);

  const missingCheck = liveCatalogFixture();
  missingCheck.checks = missingCheck.checks.slice(0, 3);
  assert.equal(compareLiveCatalog(missingCheck).match, false);

  const missingUnique = liveCatalogFixture();
  missingUnique.unique = [];
  assert.equal(compareLiveCatalog(missingUnique).match, false);

  const wrongIndex = liveCatalogFixture();
  wrongIndex.indexes[0] = { name: 'book_eoi_book_status_idx', definition: 'CREATE INDEX book_eoi_book_status_idx ON mj_eoi.book_eoi USING btree (status)' };
  assert.equal(compareLiveCatalog(wrongIndex).match, false);
});

test('probeLiveCatalogShape issues four catalog reads and assembles the live shape', async () => {
  const sql = makeSql((text) => {
    if (/information_schema\.columns/.test(text)) return liveColumnsFixture();
    if (/contype = 'c'/.test(text)) return liveChecksFixture();
    if (/contype = 'u'/.test(text)) return liveUniqueFixture();
    if (/pg_indexes/.test(text)) return liveIndexesFixture();
    throw new Error('unexpected: ' + text);
  });
  const shape = await probeLiveCatalogShape(sql);
  assert.equal(sql.calls.length, 4);
  assert.equal(shape.columns.length, 10);
  assert.equal(compareLiveCatalog(shape).match, true);
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
    if (/AS bio_interest/.test(text)) {
      return [{
        bio_interest: 0, bio_copies: 0, child_interest: 0, child_copies: 0,
        today_submissions: 0, today_copies: 0, last7_submissions: 0, last7_copies: 0,
        status_new: 0, status_contacted: 0, status_withdrawn: 0, total: 0
      }];
    }
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

test('admin summary returns per-book active counts, today + 7-day windows, statuses, total; no PII', async () => {
  const summaryRow = {
    bio_interest: 3, bio_copies: 7,
    child_interest: 1, child_copies: 2,
    today_submissions: 2, today_copies: 4,
    last7_submissions: 5, last7_copies: 9,
    status_new: 4, status_contacted: 2, status_withdrawn: 1,
    total: 7
  };
  const env = makeEnv({ sql: makeSql(() => [summaryRow]) });
  const res = await worker.fetch(await authedReq('/api/admin/books/eoi/summary'), env);
  assert.equal(res.status, 200);
  const data = await body(res);
  assert.deepEqual(data.books.biography, { interestCount: 3, requestedCopies: 7 });
  assert.deepEqual(data.books.childrens, { interestCount: 1, requestedCopies: 2 });
  assert.deepEqual(data.today, { submissions: 2, copies: 4 });
  assert.deepEqual(data.last7Days, { submissions: 5, copies: 9 });
  assert.deepEqual(data.byStatus, { new: 4, contacted: 2, withdrawn: 1 });
  assert.equal(data.total, 7);
  assert.equal(JSON.stringify(data).includes('@'), false);
});

test('admin summary fails closed 503 when the DB throws', async () => {
  const env = makeEnv({ sql: makeSql(() => { throw new Error('db down'); }) });
  const res = await worker.fetch(await authedReq('/api/admin/books/eoi/summary'), env);
  assert.equal(res.status, 503);
});

test('admin summary: empty DB yields all-zero windows, statuses, and books', async () => {
  const env = makeEnv({ sql: makeSql(() => [{}]) });
  const res = await worker.fetch(await authedReq('/api/admin/books/eoi/summary'), env);
  const data = await body(res);
  assert.deepEqual(data.books.biography, { interestCount: 0, requestedCopies: 0 });
  assert.deepEqual(data.books.childrens, { interestCount: 0, requestedCopies: 0 });
  assert.deepEqual(data.today, { submissions: 0, copies: 0 });
  assert.deepEqual(data.last7Days, { submissions: 0, copies: 0 });
  assert.deepEqual(data.byStatus, { new: 0, contacted: 0, withdrawn: 0 });
  assert.equal(data.total, 0);
});

// --- summarizeBookEoi: parameterized date windows + counts (single scan) ---

test('summarizeBookEoi computes UTC start-of-today and trailing-7-day boundaries and passes them parameterized', async () => {
  const now = new Date(Date.UTC(2026, 7, 7, 13, 30, 45)); // 2026-08-07 13:30:45 UTC
  const captured = [];
  const sql = async (text, params) => { captured.push({ text, params }); return [{}]; };
  await summarizeBookEoi(sql, { now });
  assert.equal(captured.length, 1, 'a single table scan');
  const { text, params } = captured[0];
  // Allowlist constants are parameterized ($1..$7), never interpolated.
  assert.equal(params[0], 'biography');
  assert.equal(params[1], 'withdrawn');
  assert.equal(params[2], 'childrens');
  assert.equal(params[5], 'new');
  assert.equal(params[6], 'contacted');
  // Date windows are ISO strings derived from the injected clock.
  const todayStart = new Date(Date.UTC(2026, 7, 7, 0, 0, 0)).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(params[3], todayStart, 'today boundary is UTC midnight of the injected clock');
  assert.equal(params[4], sevenDaysAgo, '7-day boundary is now minus 7 days');
  // Per-book active counts exclude withdrawn via status <> $2.
  assert.match(text, /book_code = \$1 AND status <> \$2/);
  assert.match(text, /book_code = \$3 AND status <> \$2/);
  // Only created_at/quantity/status/book_code are referenced; no PII columns.
  assert.equal(/pii_|email_hash/i.test(text), false);
});

test('summarizeBookEoi maps a single aggregated row into the canonical shape and coerces to numbers', async () => {
  const sql = async () => [{
    bio_interest: '3', bio_copies: '7', child_interest: '1', child_copies: '2',
    today_submissions: '2', today_copies: '4', last7_submissions: '5', last7_copies: '9',
    status_new: '4', status_contacted: '2', status_withdrawn: '1', total: '7'
  }];
  const out = await summarizeBookEoi(sql, { now: new Date('2026-08-07T10:00:00Z') });
  assert.equal(typeof out.books.biography.interestCount, 'number');
  assert.equal(out.books.biography.interestCount, 3);
  assert.equal(out.books.biography.requestedCopies, 7);
  assert.equal(out.today.submissions, 2);
  assert.equal(out.today.copies, 4);
  assert.equal(out.last7Days.submissions, 5);
  assert.equal(out.byStatus.withdrawn, 1);
  assert.equal(out.total, 7);
});

test('summarizeBookEoi throws on an invalid clock value (fails closed, never silently wrong)', async () => {
  const sql = async () => [{}];
  await assert.rejects(() => summarizeBookEoi(sql, { now: new Date('not-a-date') }));
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

test('parseTableBody captures exact ordered types, nullability, and defaults', () => {
  const sql = readFileSync(SQL_PATH, 'utf8');
  const { columns } = parseTableBody(extractCreateTableBody(sql).body);
  const want = [
    { name: 'id', type: 'uuid', nullable: false, default: null },
    { name: 'book_code', type: 'text', nullable: false, default: null },
    { name: 'email_hash', type: 'char(64)', nullable: false, default: null },
    { name: 'pii_ciphertext', type: 'text', nullable: false, default: null },
    { name: 'pii_iv', type: 'text', nullable: false, default: null },
    { name: 'quantity', type: 'integer', nullable: false, default: null },
    { name: 'format_code', type: 'text', nullable: false, default: null },
    { name: 'status', type: 'text', nullable: false, default: "'new'" },
    { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()' },
    { name: 'updated_at', type: 'timestamptz', nullable: false, default: 'now()' }
  ];
  assert.equal(columns.length, want.length);
  for (let i = 0; i < want.length; i++) {
    assert.equal(columns[i].name, want[i].name, `col #${i} name`);
    assert.equal(columns[i].type, want[i].type, `col ${want[i].name} type`);
    assert.equal(columns[i].nullable, want[i].nullable, `col ${want[i].name} nullable`);
    assert.equal(columns[i].default, want[i].default, `col ${want[i].name} default`);
  }
});

test('parseChecks extracts CHECK value sets and quantity bounds', () => {
  const sql = readFileSync(SQL_PATH, 'utf8');
  const { tableConstraints } = parseTableBody(extractCreateTableBody(sql).body);
  const byName = Object.fromEntries(parseChecks(tableConstraints).map((c) => [c.name, c]));
  assert.deepEqual(byName.book_eoi_book_code_check.values, ['biography', 'childrens']);
  assert.deepEqual(byName.book_eoi_format_code_check.values.sort(), ['ebook', 'hardcover', 'paperback', 'unsure']);
  assert.deepEqual(byName.book_eoi_status_check.values, ['contacted', 'new', 'withdrawn']);
  assert.deepEqual(byName.book_eoi_quantity_check.bounds, [1, 10]);
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

// ===========================================================================
// 13. Hardening regressions (Neon adapter, HKDF/secrets, robustness, login)
// ===========================================================================

// --- Neon 1.1 adapter contract (installed-driver boundary) ---

test('installed @neondatabase/serverless neon() client exposes .query(text, params)', async () => {
  const { neon } = await import('@neondatabase/serverless');
  const client = neon('postgres://u:p@host/db');
  assert.equal(typeof client.query, 'function');
});

test('createNeonSqlExecutor delegates to neonClient.query, never the tagged-template call form', async () => {
  const { neon } = await import('@neondatabase/serverless');
  const client = neon('postgres://u:p@host/db');
  const calls = [];
  client.query = (text, params) => { calls.push({ text, params }); return [{ x: 1 }]; };
  const sql = createNeonSqlExecutor(client);
  // Must NOT return the raw client (the broken conventional function form).
  assert.notEqual(sql, client);
  // The executor is a plain function; it does not itself expose .query.
  assert.equal(typeof sql.query, 'undefined');
  const rows = await sql('SELECT $1::int', [42]);
  assert.deepEqual(rows, [{ x: 1 }]);
  assert.deepEqual(calls, [{ text: 'SELECT $1::int', params: [42] }]);
});

test('createNeonSqlExecutor throws when neonClient.query is absent', () => {
  assert.throws(() => createNeonSqlExecutor({}), /query/);
  assert.throws(() => createNeonSqlExecutor(null), /query/);
});

test('production executor wraps neon() via createNeonSqlExecutor (no raw function-form return)', () => {
  const src = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'worker.js'), 'utf8');
  assert.match(src, /return createNeonSqlExecutor\(neon\(env\.NEON_DATABASE_URL\)\)/);
  // The broken form -- returning the neon() client directly -- must be absent.
  assert.equal(/return neon\(env\.NEON_DATABASE_URL\)/.test(src), false);
});

// --- HKDF / secret-length gate ---

test('bookEoiSecretsOk requires >=32-byte HMAC and encryption secrets', () => {
  assert.equal(bookEoiSecretsOk({ BOOK_EOI_HMAC_KEY: 'x'.repeat(32), BOOK_EOI_ENCRYPTION_KEY: 'x'.repeat(32) }), true);
  assert.equal(bookEoiSecretsOk({ BOOK_EOI_HMAC_KEY: 'short', BOOK_EOI_ENCRYPTION_KEY: 'x'.repeat(32) }), false);
  assert.equal(bookEoiSecretsOk({ BOOK_EOI_HMAC_KEY: 'x'.repeat(32), BOOK_EOI_ENCRYPTION_KEY: 'x'.repeat(31) }), false);
  assert.equal(bookEoiSecretsOk({ BOOK_EOI_HMAC_KEY: 'x'.repeat(31), BOOK_EOI_ENCRYPTION_KEY: 'x'.repeat(31) }), false);
});

test('secretByteLength counts UTF-8 bytes, not code points', () => {
  assert.equal(secretByteLength('x'.repeat(32)), 32);
  assert.equal(secretByteLength('☃'), 3); // 1 code point, 3 UTF-8 bytes
  assert.equal(MIN_SECRET_BYTES, 32);
});

test('AES-GCM works with a multibyte secret of sufficient byte length (HKDF input is UTF-8 bytes)', async () => {
  const id = crypto.randomUUID();
  const secret = '☃'.repeat(12); // 36 bytes
  assert.ok(secretByteLength(secret) >= 32);
  const { ciphertext, iv } = await encryptPii(secret, { name: 'Jane', email: 'jane@example.com' }, id);
  const recovered = await decryptPii(secret, ciphertext, iv, id);
  assert.deepEqual(recovered, { name: 'Jane', email: 'jane@example.com' });
});

test('POST returns 503 when a PII secret is shorter than 32 bytes', async () => {
  const env = makeEnv({ sql: makeSql(insertResponder()) });
  env.BOOK_EOI_HMAC_KEY = 'short';
  env.BOOK_EOI_ENCRYPTION_KEY = 'x'.repeat(32);
  const res = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), env);
  assert.equal(res.status, 503);
});

// --- unique-violation + insert race ---

test('isUniqueViolation matches only PG SQLSTATE 23505', () => {
  assert.equal(isUniqueViolation({ code: '23505' }), true);
  assert.equal(isUniqueViolation({ code: '23505', message: 'duplicate' }), true);
  assert.equal(isUniqueViolation({ code: '23503' }), false); // FK violation
  assert.equal(isUniqueViolation({ message: 'unique constraint failed: foo' }), false);
  assert.equal(isUniqueViolation(null), false);
  assert.equal(isUniqueViolation(undefined), false);
});

test('concurrent insert race (unique violation) is treated as idempotent success', async () => {
  let insertAttempted = false;
  const sql = makeSql((text) => {
    if (/SELECT id, status/.test(text)) return [];
    if (/^INSERT INTO mj_eoi/.test(text)) {
      insertAttempted = true;
      const err = new Error('duplicate key value violates unique constraint');
      err.code = '23505';
      throw err;
    }
    throw new Error('unexpected: ' + text);
  });
  const env = makeEnv({ sql });
  const res = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { ok: true });
  assert.equal(insertAttempted, true);
});

test('a non-23505 SQL error during insert is NOT swallowed (fails closed 503)', async () => {
  const sql = makeSql((text) => {
    if (/SELECT id, status/.test(text)) return [];
    if (/^INSERT INTO mj_eoi/.test(text)) {
      const err = new Error('unique constraint failed: something'); // message says "unique"
      err.code = '23503'; // ...but it is actually a foreign-key violation
      throw err;
    }
    throw new Error('unexpected: ' + text);
  });
  const env = makeEnv({ sql });
  const res = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), env);
  assert.equal(res.status, 503);
});

// --- XFF removal + stable unknown bucket ---

test('rate-limit key uses cf-connecting-ip and ignores spoofable X-Forwarded-For', async () => {
  let seenKey;
  const env = makeEnv({
    sql: makeSql(insertResponder()),
    rateLimiter: { async limit({ key }) { seenKey = key; return { success: true }; } }
  });
  await worker.fetch(req('/api/books/eoi', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', 'cf-connecting-ip': '198.51.100.2', 'x-forwarded-for': '10.0.0.99' },
    body: JSON.stringify(validPayload())
  }), env);
  assert.equal(seenKey, 'books-eoi:198.51.100.2');
});

test('rate-limit key falls back to a single stable unknown bucket (no XFF fan-out)', async () => {
  let seenKey;
  const env = makeEnv({
    sql: makeSql(insertResponder()),
    rateLimiter: { async limit({ key }) { seenKey = key; return { success: true }; } }
  });
  await worker.fetch(req('/api/books/eoi', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', 'x-forwarded-for': '10.0.0.99' },
    body: JSON.stringify(validPayload())
  }), env);
  assert.equal(seenKey, 'books-eoi:unknown');
});

// --- Turnstile idempotency_key + hostname-config fail-closed ---

test('Turnstile verification includes an idempotency_key UUID', async () => {
  let captured = null;
  const env = makeEnv({
    sql: makeSql(insertResponder()),
    turnstile: async (_url, init) => {
      const form = new URLSearchParams(init.body);
      captured = { idempotency_key: form.get('idempotency_key') };
      return okTurnstile()();
    }
  });
  const res = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), env);
  assert.equal(res.status, 200);
  assert.ok(captured, 'siteverify was called');
  assert.match(
    captured.idempotency_key,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  );
});

test('missing Turnstile hostname allowlist fails closed (503)', async () => {
  const env = makeEnv({ sql: makeSql(insertResponder()) });
  delete env.BOOK_EOI_ALLOWED_HOSTNAMES;
  const res = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), env);
  assert.equal(res.status, 503);
});

// --- Rate-limiter fail-closed (public EOI) ---

test('POST fails closed 503 when the rate-limiter binding is undefined', async () => {
  const env = makeEnv({ sql: makeSql(insertResponder()) });
  env.BOOK_EOI_RATE_LIMITER = undefined;
  const res = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), env);
  assert.equal(res.status, 503);
});

test('POST fails closed 503 when rate-limiter.limit() throws', async () => {
  const env = makeEnv({
    sql: makeSql(insertResponder()),
    rateLimiter: { async limit() { throw new Error('limiter down'); } }
  });
  const res = await worker.fetch(jsonPost('/api/books/eoi', validPayload()), env);
  assert.equal(res.status, 503);
});

// --- Admin login: rate-limit before password compare + body cap ---

test('admin login is rate-limited before the password compare', async () => {
  const env = makeEnv({});
  env.BOOK_EOI_RATE_LIMITER = { async limit() { return { success: false }; } };
  const res = await worker.fetch(req('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' })
  }), env);
  assert.equal(res.status, 429); // not 401: the limiter precedes the password check
});

test('admin login fails closed 503 when the rate-limiter binding is missing', async () => {
  const env = makeEnv({});
  delete env.BOOK_EOI_RATE_LIMITER;
  const res = await worker.fetch(req('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'secret' })
  }), env);
  assert.equal(res.status, 503);
});

test('admin login rejects an oversized declared body with 413', async () => {
  const env = makeEnv({});
  const res = await worker.fetch(req('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024) },
    body: JSON.stringify({ password: 'secret' })
  }), env);
  assert.equal(res.status, 413);
});

test('admin login still succeeds when the rate limiter allows', async () => {
  const env = makeEnv({});
  const res = await worker.fetch(req('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'secret' })
  }), env);
  assert.equal(res.status, 200);
});

// --- Books admin PATCH: body cap + safe id decode ---

test('admin PATCH rejects an oversized declared body with 413', async () => {
  const id = crypto.randomUUID();
  const env = makeEnv({ sql: makeSql(() => []) });
  const res = await worker.fetch(await authedReq('/api/admin/books/eoi/' + id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'content-length': String(4 * 1024) },
    body: JSON.stringify({ status: 'new' })
  }), env);
  assert.equal(res.status, 413);
});

test('admin PATCH safe-decodes a malformed percent-encoded id to JSON 404 (never throws)', async () => {
  const env = makeEnv({ sql: makeSql(() => { throw new Error('must not query'); }) });
  // '%E0%A4' is a truncated/invalid UTF-8 percent sequence that makes
  // decodeURIComponent throw if it is not guarded.
  const res = await worker.fetch(await authedReq('/api/admin/books/eoi/%E0%A4', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'new' })
  }), env);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/json');
});

test('admin PATCH: oversized actual UTF-8 body is rejected with 413', async () => {
  const id = crypto.randomUUID();
  const env = makeEnv({ sql: makeSql(() => []) });
  // No Content-Length header; the worker must measure the actual UTF-8 bytes.
  const payload = { status: 'new', pad: '☃'.repeat(2000) };
  const res = await worker.fetch(await authedReq('/api/admin/books/eoi/' + id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }), env);
  assert.equal(res.status, 413);
});

// ===========================================================================
// 14. GET /books page route: site-key marker injection, fail-closed, redirect
// ===========================================================================

const BOOKS_HTML_WITH_MARKER =
  '<!doctype html><html><body>' +
  '<div id="books-turnstile" data-sitekey="__BOOKS_TURNSTILE_SITE_KEY__" data-action="books-eoi"></div>' +
  '</body></html>';

function booksHtmlEnv(html, { withSiteKey = true } = {}) {
  const env = makeEnv({});
  env.ASSETS = {
    // The Worker passes a URL object to ASSETS.fetch (mirroring servePublicIndex);
    // accept a URL, string, or Request here.
    async fetch(input) {
      const u = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (u.pathname === '/books.html') {
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=UTF-8' }
        });
      }
      return new Response('not found', { status: 404 });
    }
  };
  if (!withSiteKey) delete env.TURNSTILE_SITE_KEY;
  return env;
}

test('GET /books injects the Turnstile site key in place of the marker', async () => {
  const env = booksHtmlEnv(BOOKS_HTML_WITH_MARKER);
  const res = await worker.fetch(req('/books'), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=UTF-8');
  const html = await res.text();
  assert.equal(html.includes('__BOOKS_TURNSTILE_SITE_KEY__'), false, 'marker must be replaced');
  assert.ok(html.includes('data-sitekey="test-site-key"'), 'site key is injected into the attribute');
  assert.ok(html.includes('data-action="books-eoi"'), 'action is preserved');
});

test('GET /books HTML-escapes the site key for the attribute context', async () => {
  const env = booksHtmlEnv(BOOKS_HTML_WITH_MARKER);
  env.TURNSTILE_SITE_KEY = '1x00"onmouseover="evil';
  const res = await worker.fetch(req('/books'), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  // The double-quote that would break out of the attribute is escaped.
  assert.equal(html.includes('"onmouseover'), false);
  assert.ok(html.includes('&quot;'));
});

test('GET /books fails closed 503 when TURNSTILE_SITE_KEY is absent', async () => {
  const env = booksHtmlEnv(BOOKS_HTML_WITH_MARKER, { withSiteKey: false });
  const res = await worker.fetch(req('/books'), env);
  assert.equal(res.status, 503);
  // No HTML page (and no marker) is ever served.
  const text = await res.text();
  assert.equal(text.includes('books-turnstile'), false);
});

test('GET /books/ is permanently redirected to the canonical /books', async () => {
  const env = booksHtmlEnv(BOOKS_HTML_WITH_MARKER);
  const res = await worker.fetch(req('/books/'), env);
  assert.equal(res.status, 301);
  assert.equal(new URL(res.headers.get('location')).pathname, '/books');
});

test('GET /books returns 404 when the books.html asset is missing', async () => {
  const env = booksHtmlEnv(BOOKS_HTML_WITH_MARKER);
  env.ASSETS = {
    async fetch() {
      return new Response('not found', { status: 404 });
    }
  };
  const res = await worker.fetch(req('/books'), env);
  assert.equal(res.status, 404);
});

test('/books routes are registered in run_worker_first so they are handled by the Worker', () => {
  // Parse the run_worker_first array text directly: the .jsonc file contains
  // https:// URLs, so a naive // comment-strip would corrupt those strings.
  const wrangler = readFileSync(path.resolve(import.meta.dirname, '..', 'wrangler.jsonc'), 'utf8');
  const rwf = wrangler.match(/"run_worker_first"\s*:\s*\[([^\]]*)\]/);
  assert.ok(rwf, 'an assets.run_worker_first array must exist');
  assert.match(rwf[1], /"\/books"/, 'run_worker_first must include "/books"');
  assert.match(rwf[1], /"\/books\/"/, 'run_worker_first must include "/books/"');
  // The raw .html asset must be Worker-first so it is redirected (never served
  // with an unreplaced Turnstile site-key marker).
  assert.match(rwf[1], /"\/books\.html"/, 'run_worker_first must include "/books.html"');
});

// --- isBooksPage route contract ---

test('isBooksPage matches the canonical page and every alias', () => {
  assert.equal(isBooksPage('/books'), true);
  assert.equal(isBooksPage('/books.html'), true);
  assert.equal(isBooksPage('/books/'), true);
  assert.equal(isBooksPage('/books//'), true, 'repeated trailing slashes are the books page');
  assert.equal(isBooksPage('/books///'), true, 'repeated trailing slashes are the books page');
});

test('isBooksPage does not match unrelated paths', () => {
  for (const p of ['/', '/book', '/bookstore', '/books-x', '/books.htmlx', '/api/books/eoi', '/api/books/health', '/index.html']) {
    assert.equal(isBooksPage(p), false, `${p} must not be the books page`);
  }
});

// --- Canonical redirect of /books.html and trailing-slash variants ---

test('GET /books.html is permanently redirected to the canonical /books', async () => {
  const env = booksHtmlEnv(BOOKS_HTML_WITH_MARKER);
  const res = await worker.fetch(req('/books.html'), env);
  assert.equal(res.status, 301);
  assert.equal(new URL(res.headers.get('location')).pathname, '/books');
});

test('GET /books// (repeated trailing slashes) is permanently redirected to /books', async () => {
  const env = booksHtmlEnv(BOOKS_HTML_WITH_MARKER);
  for (const path of ['/books//', '/books///']) {
    const res = await worker.fetch(req(path), env);
    assert.equal(res.status, 301, `${path} -> 301`);
    assert.equal(new URL(res.headers.get('location')).pathname, '/books', `${path} -> /books`);
  }
});

test('GET /books.html never serves the raw asset / unreplaced marker', async () => {
  // Even if ASSETS could serve books.html, the Worker intercepts it first and
  // redirects, so the marker never reaches a client.
  const env = booksHtmlEnv(BOOKS_HTML_WITH_MARKER);
  const res = await worker.fetch(req('/books.html'), env);
  assert.equal(res.status, 301);
  const text = await res.text();
  assert.equal(text.includes('__BOOKS_TURNSTILE_SITE_KEY__'), false, 'marker must not leak');
});

// --- Explicit 405 for unsupported methods on Books URLs (never assets) ---

test('unsupported methods on /books return a JSON 405, never an asset', async () => {
  const env = booksHtmlEnv(BOOKS_HTML_WITH_MARKER);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await worker.fetch(req('/books', { method }), env);
    assert.equal(res.status, 405, `${method} /books -> 405`);
    assert.equal(res.headers.get('content-type'), 'application/json', `${method} /books -> JSON`);
    assert.deepEqual(await body(res), { error: 'Method not allowed.' });
  }
});

test('unsupported methods on /books.html and /books/ return a JSON 405', async () => {
  const env = booksHtmlEnv(BOOKS_HTML_WITH_MARKER);
  for (const path of ['/books.html', '/books/', '/books//']) {
    const res = await worker.fetch(req(path, { method: 'POST' }), env);
    assert.equal(res.status, 405, `POST ${path} -> 405`);
    assert.equal(res.headers.get('content-type'), 'application/json', `POST ${path} -> JSON`);
  }
});


