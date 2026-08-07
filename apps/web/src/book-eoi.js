// Books Expression of Interest (EOI) backend core.
//
// Pure module: no runtime imports (no Neon driver, no fetch). All network and
// secret access is threaded in by the Worker via injected arguments so this
// module is fully unit-testable in isolation. It owns:
//   - strict payload allowlist/canonicalization/validation
//   - PII protection via Web Crypto (HMAC-SHA256 email hash for race-safe
//     dedup; AES-256-GCM encryption of the canonical {name,email} JSON, with a
//     random 12-byte IV and the row id as additional authenticated data)
//   - a repository/query seam expressed against a parameterized SQL executor
//     (the Neon `neon()` call-form `sql(text, params)`), with every statement
//     fully-qualified to the mj_eoi schema
//
// Security invariants enforced here and by the Worker:
//   * Normalized email is never stored in plaintext. Only its HMAC hash (hex,
//     64 chars) is persisted, and is used as the dedup key.
//   * {name,email} is stored only as AES-256-GCM ciphertext+IV. The plaintext
//     is decrypted solely for authenticated admin result rows.
//   * Public responses never include ciphertext, hash, raw PII, or row ids.

// ---------------------------------------------------------------------------
// Allowlists & limits
// ---------------------------------------------------------------------------

export const BOOK_CODES = new Set(['biography', 'childrens']);
export const FORMAT_CODES = new Set(['hardcover', 'paperback', 'ebook', 'unsure']);
export const BOOK_EOI_STATUSES = new Set(['new', 'contacted', 'withdrawn']);

export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 10;
export const MAX_NAME_LENGTH = 100;
export const MAX_EMAIL_LENGTH = 320;

// Small, strict cap for a public EOI submission. The canonical payload is a
// handful of short fields plus a Turnstile token; 16 KiB is generous headroom
// while bounding abuse.
export const MAX_BOOK_EOI_BODY_BYTES = 16 * 1024;

// Hard ceiling for admin "recent rows" pagination.
export const MAX_BOOK_EOI_ADMITTED_LIMIT = 100;
export const DEFAULT_BOOK_EOI_LIMIT = 50;

// Turnstile expectations (the public sitekey/secret are separate). The action
// and expected hostnames are non-secret and live in wrangler `vars`.
export const TURNSTILE_ACTION = 'books-eoi';

// Honeypot fields. Any present AND non-empty value means a bot filled a hidden
// input; the Worker accepts it silently (generic ok) without touching the DB.
export const HONEYPOT_FIELDS = ['website', 'companyUrl', 'company'];

// Exactly these keys are accepted on a public EOI submission (plus honeypots).
const PUBLIC_ALLOWED_FIELDS = new Set([
  'book',
  'format',
  'quantity',
  'name',
  'email',
  'turnstileToken'
]);

// ---------------------------------------------------------------------------
// Schema signature (schema-drift probe source of truth)
// ---------------------------------------------------------------------------

// The "signature" is a stable canonical string over the table's column-name
// set. It is intentionally simple, debuggable, and dependency-free so it can be
// (a) recomputed from information_schema at runtime by /api/books/health,
// (b) recomputed from database/mj-eoi-schema.sql by scripts/check-book-eoi-schema.mjs,
// and (c) embedded here as the expected value. Column-name drift (add/remove/
// rename) is detected; type/check/index drift is parsed and reported by the
// offline tool. When the schema changes, update database/mj-eoi-schema.sql and
// EXPECTED_COLUMNS together; the drift tool and tests enforce consistency.
export const SCHEMA_NAME = 'mj_eoi';
export const TABLE_NAME = 'book_eoi';
export const SCHEMA_TABLE = `${SCHEMA_NAME}.${TABLE_NAME}`;
export const EXPECTED_COLUMNS = [
  'id',
  'book_code',
  'email_hash',
  'pii_ciphertext',
  'pii_iv',
  'quantity',
  'format_code',
  'status',
  'created_at',
  'updated_at'
];
export const EXPECTED_SCHEMA_SIGNATURE = computeColumnSignature(SCHEMA_TABLE, EXPECTED_COLUMNS);

// Canonical signature: "<schema.table>|<comma-joined,lowercased,sorted columns>".
export function computeColumnSignature(schemaTable, columnNames) {
  const sorted = [...columnNames]
    .map((c) => String(c).toLowerCase())
    .filter((c) => c.length > 0)
    .sort();
  return `${schemaTable}|${sorted.join(',')}`;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// Normalize and validate an email into a canonical lowercase form used both as
// HMAC input and (encrypted) storage. Returns null when invalid.
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) return null;
  // Pragmatic, conservative shape. Not RFC-exhaustive by design: we want a
  // stable, local-part@registered-domain token with no whitespace.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(trimmed)) return null;
  if (trimmed.includes('..')) return null;
  return trimmed;
}

// Canonicalize a name: trim, collapse internal whitespace, length-bound.
// Returns null when invalid/empty.
export function canonicalizeName(raw) {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  if (collapsed.length === 0 || collapsed.length > MAX_NAME_LENGTH) return null;
  return collapsed;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Validate a decoded public submission object against the strict allowlist.
// Returns one of:
//   { ok: true, fields: { book, format, quantity, name, email, turnstileToken } }
//   { ok: false, honeypot: true }                         // silent accept (bot)
//   { ok: false, status: <number>, error: <message> }     // real client error
export function validateBookEoiPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Request body must be a JSON object.' };
  }

  // Strict allowlist: reject any key that is neither a real field nor a known
  // honeypot. This blocks smuggling of extra properties.
  for (const key of Object.keys(body)) {
    if (!PUBLIC_ALLOWED_FIELDS.has(key) && !HONEYPOT_FIELDS.includes(key)) {
      return { ok: false, status: 400, error: 'Unexpected field in request.' };
    }
  }

  // Honeypot: any non-empty honeypot value => silent generic ok (no DB work).
  for (const field of HONEYPOT_FIELDS) {
    const value = body[field];
    if (value !== undefined && value !== null && value !== '') {
      return { ok: false, honeypot: true };
    }
  }

  const book = body.book;
  if (typeof book !== 'string' || !BOOK_CODES.has(book)) {
    return { ok: false, status: 400, error: 'Invalid book selection.' };
  }

  const format = body.format;
  if (typeof format !== 'string' || !FORMAT_CODES.has(format)) {
    return { ok: false, status: 400, error: 'Invalid format selection.' };
  }

  const quantity = body.quantity;
  if (!Number.isInteger(quantity) || quantity < MIN_QUANTITY || quantity > MAX_QUANTITY) {
    return { ok: false, status: 400, error: 'Invalid quantity.' };
  }

  const name = canonicalizeName(body.name);
  if (name === null) {
    return { ok: false, status: 400, error: 'A valid name is required.' };
  }

  const email = normalizeEmail(body.email);
  if (email === null) {
    return { ok: false, status: 400, error: 'A valid email is required.' };
  }

  const turnstileToken = body.turnstileToken;
  if (
    typeof turnstileToken !== 'string' ||
    turnstileToken.length === 0 ||
    turnstileToken.length > 8192
  ) {
    return { ok: false, status: 400, error: 'Verification token is missing.' };
  }

  return { ok: true, fields: { book, format, quantity, name, email, turnstileToken } };
}

// Validate an admin status-update body. Only { status } is accepted.
export function validateStatusUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Request body must be a JSON object.' };
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'status') {
    return { ok: false, status: 400, error: 'Only status may be updated.' };
  }
  const status = body.status;
  if (typeof status !== 'string' || !BOOK_EOI_STATUSES.has(status)) {
    return { ok: false, status: 400, error: 'Invalid status.' };
  }
  return { ok: true, status };
}

// ---------------------------------------------------------------------------
// Web Crypto: base64url (byte-safe) helpers
// ---------------------------------------------------------------------------

// btoa/atob operate on strings and choke on bytes > 255 when built from
// code points. These helpers convert through a binary string so every byte
// value 0..255 round-trips correctly (Workers + Node).
function bytesToBase64url(buffer) {
  const view = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64urlToBytes(str) {
  const base64 = str
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(str.length / 4) * 4, '=');
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bufferToHex(buffer) {
  const view = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0');
  return hex;
}

// ---------------------------------------------------------------------------
// Web Crypto: HMAC-SHA256 email hash (race-safe dedup key)
// ---------------------------------------------------------------------------

// Returns a 64-char lowercase hex HMAC-SHA256 of the normalized email under the
// supplied secret. This is the only persisted identity token and is the dedup
// key (unique(book_code, email_hash)). It is never returned to clients.
export async function hmacEmailHash(secret, normalizedEmail) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(normalizedEmail));
  return bufferToHex(signature);
}

// ---------------------------------------------------------------------------
// Web Crypto: AES-256-GCM PII encryption
// ---------------------------------------------------------------------------

// Minimum strength for PII secrets, enforced before any crypto (see
// bookEoiSecretsOk). 32 bytes matches the AES-256 key width so a configured
// secret always carries full-strength key material into HKDF.
export const MIN_SECRET_BYTES = 32;

export function secretByteLength(secret) {
  return new TextEncoder().encode(String(secret)).length;
}

// Fail-closed: both PII secrets must be present AND meet the minimum length
// before any submission is accepted or PII encrypted. A short/weak key never
// protects PII. (No compatibility/rotation fallback is needed because no rows
// exist yet -- this is a greenfield table.)
export function bookEoiSecretsOk(env) {
  return (
    typeof env.BOOK_EOI_HMAC_KEY === 'string' &&
    typeof env.BOOK_EOI_ENCRYPTION_KEY === 'string' &&
    secretByteLength(env.BOOK_EOI_HMAC_KEY) >= MIN_SECRET_BYTES &&
    secretByteLength(env.BOOK_EOI_ENCRYPTION_KEY) >= MIN_SECRET_BYTES
  );
}

// Versioned, fixed-salt HKDF-SHA256 derivation of the AES-256-GCM key. The salt
// and info strings embed the scheme version (v1) so a future scheme can be
// introduced by bumping the version and re-encrypting at the source; there is
// deliberately NO legacy fallback or rotation path (no rows exist yet). HKDF is
// used instead of an unsalted single SHA-256 so the key is properly extracted
// from the secret and domain-separated from every other use of the secret.
const KEY_DERIVATION_VERSION = 1;
const AES_HKDF_SALT = new TextEncoder().encode(
  `mj-art:book-eoi:pii-aes-gcm:v${KEY_DERIVATION_VERSION}:salt`
);
const AES_HKDF_INFO = new TextEncoder().encode(
  `mj-art:book-eoi:pii-aes-gcm:v${KEY_DERIVATION_VERSION}:aes-256-key`
);

// Derive a fixed 256-bit AES-GCM key from the secret via HKDF-SHA256.
async function deriveAesKey(secret) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveBits']
  );
  const keyBytes = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: AES_HKDF_SALT, info: AES_HKDF_INFO },
    keyMaterial,
    256
  );
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt'
  ]);
}

// Encrypt the canonical {name,email} object. Returns base64url ciphertext+iv.
// `aad` is the row id (UUID): binds ciphertext to its row and is required to
// decrypt, so a ciphertext transplanted to another row fails auth.
export async function encryptPii(secret, piiObject, aad) {
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(piiObject));
  const additionalData = new TextEncoder().encode(aad);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    key,
    plaintext
  );
  return { ciphertext: bytesToBase64url(ciphertext), iv: bytesToBase64url(iv) };
}

// Decrypt and parse. Throws on tamper, wrong key, or AAD mismatch (the Worker
// treats any throw as an unreadable row and surfaces null to admin views).
export async function decryptPii(secret, ciphertextB64url, ivB64url, aad) {
  const key = await deriveAesKey(secret);
  const iv = base64urlToBytes(ivB64url);
  const additionalData = new TextEncoder().encode(aad);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData },
    key,
    base64urlToBytes(ciphertextB64url)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ---------------------------------------------------------------------------
// Repository / query seam
// ---------------------------------------------------------------------------
//
// Every function takes a `sql` executor implementing the pure
// `async sql(text, params) -> rows[]` seam (array of plain row objects). The
// Worker builds the real executor by wrapping the installed Neon driver with
// createNeonSqlExecutor (neonClient.query(text, params)); tests pass a fake.
// All statements fully-qualify mj_eoi.book_eoi and use parameter placeholders.
// The runtime role contract is SELECT/INSERT/UPDATE only (see the schema file):
// no DELETE, no DDL, no other tables are referenced.

// ---------------------------------------------------------------------------
// Neon driver adapter (the single installed-driver boundary)
// ---------------------------------------------------------------------------
//
// @neondatabase/serverless 1.x `neon()` returns an HTTP query function whose
// *tagged-template* call form is `sql\`...\`` -- i.e. `sql(strings, ...params)`
// where `strings` must be a TemplateStringsArray. When invoked as a plain
// function `sql(text, params)` with a string query, the driver's dispatch guard
// (`Array.isArray(strings) && Array.isArray(strings.raw)`) fails and the
// parameterized statement is not executed correctly. The driver's correct
// parameterized entry point is `neonClient.query(text, params)`, which returns
// the rows array directly (fullResults defaults to false).
//
// This adapter wraps a neon client so the repository seam stays the pure,
// driver-agnostic `sql(text, params) -> rows[]` used by every function below.
// It is the ONLY place that talks to the installed driver: there is no
// per-query (8-call) workaround -- each repository function still calls
// `sql(text, params)` exactly once and is unchanged.
export function createNeonSqlExecutor(neonClient) {
  if (!neonClient || typeof neonClient.query !== 'function') {
    throw new Error('createNeonSqlExecutor: a neon client with a .query(text, params) method is required');
  }
  return async function sql(text, params) {
    const rows = await neonClient.query(text, params || []);
    return rows;
  };
}

export async function findBookEoi(sql, bookCode, emailHash) {
  const rows = await sql(
    'SELECT id, status FROM mj_eoi.book_eoi WHERE book_code = $1 AND email_hash = $2',
    [bookCode, emailHash]
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

export async function insertBookEoi(sql, row) {
  await sql(
    'INSERT INTO mj_eoi.book_eoi ' +
      '(id, book_code, email_hash, pii_ciphertext, pii_iv, quantity, format_code, status, created_at, updated_at) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())',
    [
      row.id,
      row.bookCode,
      row.emailHash,
      row.piiCiphertext,
      row.piiIv,
      row.quantity,
      row.formatCode,
      'new'
    ]
  );
}

// Re-submission of an existing (book,email): refresh encrypted PII, quantity,
// format, and reactivate a withdrawn interest back to 'new'. The row id is
// preserved so existing ciphertext AAD stays valid before re-encryption.
export async function updateBookEoiOnResubmit(sql, id, row) {
  await sql(
    'UPDATE mj_eoi.book_eoi SET ' +
      'pii_ciphertext = $1, pii_iv = $2, quantity = $3, format_code = $4, ' +
      'status = CASE WHEN status = $5 THEN $6 ELSE status END, updated_at = now() ' +
      'WHERE id = $7',
    [row.piiCiphertext, row.piiIv, row.quantity, row.formatCode, 'withdrawn', 'new', id]
  );
}

// Strict status-only update (admin). Returns true if a row was updated.
export async function updateBookEoiStatus(sql, id, status) {
  const rows = await sql(
    'UPDATE mj_eoi.book_eoi SET status = $1, updated_at = now() WHERE id = $2 RETURNING id',
    [status, id]
  );
  return Array.isArray(rows) && rows.length > 0;
}

// Public interest counts per book: active rows (status != withdrawn) with the
// sum of requested copies. Grouped by book_code.
export async function countBookInterest(sql) {
  const rows = await sql(
    'SELECT book_code, COUNT(*)::int AS interest_count, COALESCE(SUM(quantity), 0)::int AS requested_copies ' +
      'FROM mj_eoi.book_eoi WHERE status <> $1 GROUP BY book_code',
    ['withdrawn']
  );
  return Array.isArray(rows) ? rows : [];
}

// Recent rows for admin decryption. Returns raw columns including ciphertext.
export async function listRecentBookEoi(sql, limit) {
  const rows = await sql(
    'SELECT id, book_code, email_hash, pii_ciphertext, pii_iv, quantity, format_code, status, created_at, updated_at ' +
      'FROM mj_eoi.book_eoi ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return Array.isArray(rows) ? rows : [];
}

// Summary counts grouped by status (admin).
export async function summarizeBookEoi(sql) {
  const rows = await sql(
    'SELECT status, COUNT(*)::int AS count FROM mj_eoi.book_eoi GROUP BY status',
    []
  );
  return Array.isArray(rows) ? rows : [];
}

// Live column-name probe for the schema-signature health/drift check. No PII.
export async function probeBookEoiSchemaColumns(sql) {
  const rows = await sql(
    'SELECT column_name FROM information_schema.columns ' +
      'WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name',
    [SCHEMA_NAME, TABLE_NAME]
  );
  return (Array.isArray(rows) ? rows : []).map((r) => r.column_name);
}

// ---------------------------------------------------------------------------
// Live catalog shape (runtime schema-drift comparison for /api/books/health)
// ---------------------------------------------------------------------------
//
// /api/books/health compares the LIVE database catalog (information_schema +
// pg_catalog) to EXPECTED_LIVE_CATALOG. The comparison is MEANINGFUL: ordered
// column names, data types, nullability, defaults, CHECK value sets / numeric
// bounds, the UNIQUE(book_code, email_hash) constraint, and the exact indexes.
// It is deliberately NOT a column-name-only check. The PUBLIC health response
// reveals only an outcome (healthy | mismatch | unavailable) -- never the
// differences, never column data, never credentials/PII.

// Expected information_schema/pg_catalog shape. data_type values are the exact
// strings Postgres reports; column_default values match information_schema
// output verbatim. Column order matches database/mj-eoi-schema.sql.
export const EXPECTED_LIVE_CATALOG = {
  columns: [
    { name: 'id', dataType: 'uuid', nullable: false, default: null },
    { name: 'book_code', dataType: 'text', nullable: false, default: null },
    { name: 'email_hash', dataType: 'character', nullable: false, default: null, charLength: 64 },
    { name: 'pii_ciphertext', dataType: 'text', nullable: false, default: null },
    { name: 'pii_iv', dataType: 'text', nullable: false, default: null },
    { name: 'quantity', dataType: 'integer', nullable: false, default: null },
    { name: 'format_code', dataType: 'text', nullable: false, default: null },
    { name: 'status', dataType: 'text', nullable: false, default: "'new'::text" },
    { name: 'created_at', dataType: 'timestamp with time zone', nullable: false, default: 'now()' },
    { name: 'updated_at', dataType: 'timestamp with time zone', nullable: false, default: 'now()' }
  ],
  checks: [
    { name: 'book_eoi_book_code_check', values: ['biography', 'childrens'] },
    { name: 'book_eoi_format_code_check', values: ['hardcover', 'paperback', 'ebook', 'unsure'] },
    { name: 'book_eoi_status_check', values: ['new', 'contacted', 'withdrawn'] },
    { name: 'book_eoi_quantity_check', bounds: [1, 10] }
  ],
  unique: { name: 'book_eoi_book_email_unique', columns: ['book_code', 'email_hash'] },
  indexes: [
    { name: 'book_eoi_book_status_idx', columns: 'book_code, status' },
    { name: 'book_eoi_book_created_idx', columns: 'book_code, created_at desc' }
  ]
};

function normText(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
}

// For comma-separated column lists (index/unique definitions), whitespace and
// casing are insignificant: collapse to a canonical lowercase, spaceless form.
function normCols(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, '');
}

// Quoted string literals from a CHECK definition -> sorted array.
function extractStringLiterals(def) {
  return (String(def).match(/'([^']*)'/g) || [])
    .map((s) => s.slice(1, -1))
    .filter((s) => s.length > 0)
    .sort();
}

// Integer literals from a CHECK definition -> sorted ascending array.
function extractIntBounds(def) {
  return (String(def).match(/-?\d+/g) || []).map(Number).sort((a, b) => a - b);
}

// First parenthesized column list from a definition (lowercased, spaceless).
function extractParenColumns(def) {
  const m = String(def).match(/\(([^()]*)\)/);
  return m ? normCols(m[1]) : '';
}

// PURE comparison of a live catalog shape to the canonical model. Returns
// { match: boolean, mismatches: string[] }. mismatches are for tests/operators
// only -- the public health endpoint never exposes them.
export function compareLiveCatalog(live, expected = EXPECTED_LIVE_CATALOG) {
  const mismatches = [];
  const liveCols = live && Array.isArray(live.columns) ? live.columns : [];

  if (liveCols.length !== expected.columns.length) {
    mismatches.push(`column count: expected ${expected.columns.length}, got ${liveCols.length}`);
  }
  for (let i = 0; i < expected.columns.length; i++) {
    const want = expected.columns[i];
    const got = liveCols[i];
    if (!got) {
      mismatches.push(`column #${i + 1} missing: expected ${want.name}`);
      continue;
    }
    if (normText(got.column_name) !== want.name) {
      mismatches.push(`column #${i + 1} name: expected ${want.name}, got ${got.column_name}`);
    }
    if (normText(got.data_type) !== want.dataType) {
      mismatches.push(`column ${want.name} type: expected ${want.dataType}, got ${got.data_type}`);
    }
    const nullable = String(got.is_nullable).toUpperCase() !== 'NO';
    if (nullable !== want.nullable) {
      mismatches.push(`column ${want.name} nullable: expected ${want.nullable}, got ${nullable}`);
    }
    if (want.charLength !== undefined && Number(got.character_maximum_length) !== want.charLength) {
      mismatches.push(`column ${want.name} charLength: expected ${want.charLength}, got ${got.character_maximum_length}`);
    }
    const gotDefault = got.column_default == null ? null : normText(got.column_default);
    const wantDefault = want.default == null ? null : normText(want.default);
    if (gotDefault !== wantDefault) {
      mismatches.push(`column ${want.name} default: expected ${want.default}, got ${got.column_default}`);
    }
  }

  const liveChecks = live && Array.isArray(live.checks) ? live.checks : [];
  const checkByName = new Map(liveChecks.map((c) => [normText(c.name), c.definition || '']));
  for (const want of expected.checks) {
    const def = checkByName.get(normText(want.name));
    if (def === undefined) {
      mismatches.push(`missing CHECK constraint: ${want.name}`);
      continue;
    }
    if (want.values) {
      const gotVals = extractStringLiterals(def);
      if (gotVals.join(',') !== [...want.values].sort().join(',')) {
        mismatches.push(`CHECK ${want.name} values: expected ${want.values.join(',')}, got ${gotVals.join(',')}`);
      }
    }
    if (want.bounds) {
      const gotBounds = extractIntBounds(def);
      if (gotBounds.length !== 2 || gotBounds[0] !== want.bounds[0] || gotBounds[1] !== want.bounds[1]) {
        mismatches.push(`CHECK ${want.name} bounds: expected ${want.bounds.join(',')}, got ${gotBounds.join(',')}`);
      }
    }
  }

  const liveUnique = live && Array.isArray(live.unique) ? live.unique : [];
  const wantUniqueCols = normCols(expected.unique.columns.join(','));
  const uniqueOk = liveUnique.some(
    (u) => normText(u.name) === normText(expected.unique.name) && extractParenColumns(u.definition) === wantUniqueCols
  );
  if (!uniqueOk) {
    mismatches.push(`UNIQUE constraint ${expected.unique.name}(${expected.unique.columns.join(', ')}) not found`);
  }

  const liveIndexes = live && Array.isArray(live.indexes) ? live.indexes : [];
  for (const wantIdx of expected.indexes) {
    const found = liveIndexes.some(
      (idx) => normText(idx.name) === normText(wantIdx.name) && extractParenColumns(idx.definition) === normCols(wantIdx.columns)
    );
    if (!found) mismatches.push(`index ${wantIdx.name}(${wantIdx.columns}) not found`);
  }

  return { match: mismatches.length === 0, mismatches };
}

// Probe the LIVE database catalog (columns, CHECKs, UNIQUE, indexes) for the
// runtime schema-drift health check. No PII, no credentials. Four cheap catalog
// reads against information_schema/pg_catalog, run in parallel (each is an
// independent HTTP query via the executor).
export async function probeLiveCatalogShape(sql) {
  const [columns, checks, unique, indexes] = await Promise.all([
    sql(
      'SELECT column_name, data_type, is_nullable, column_default, character_maximum_length ' +
        'FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
      [SCHEMA_NAME, TABLE_NAME]
    ),
    sql(
      'SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition ' +
        'FROM pg_constraint con ' +
        'JOIN pg_class rel ON rel.oid = con.conrelid ' +
        'JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace ' +
        "WHERE nsp.nspname = $1 AND rel.relname = $2 AND con.contype = 'c'",
      [SCHEMA_NAME, TABLE_NAME]
    ),
    sql(
      'SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition ' +
        'FROM pg_constraint con ' +
        'JOIN pg_class rel ON rel.oid = con.conrelid ' +
        'JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace ' +
        "WHERE nsp.nspname = $1 AND rel.relname = $2 AND con.contype = 'u'",
      [SCHEMA_NAME, TABLE_NAME]
    ),
    sql(
      'SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = $1 AND tablename = $2',
      [SCHEMA_NAME, TABLE_NAME]
    )
  ]);
  return {
    columns: Array.isArray(columns) ? columns : [],
    checks: Array.isArray(checks) ? checks : [],
    unique: Array.isArray(unique) ? unique : [],
    indexes: Array.isArray(indexes) ? indexes : []
  };
}

// True only for a PostgreSQL unique-constraint violation (SQLSTATE 23505), used
// to treat a concurrent-insert race as an idempotent success. The check is
// strict to the driver error code: a message-substring match would be both too
// broad (could match unrelated errors) and too narrow (neon HTTP errors surface
// the code, not a stable message shape).
export function isUniqueViolation(error) {
  return Boolean(error && error.code === '23505');
}
