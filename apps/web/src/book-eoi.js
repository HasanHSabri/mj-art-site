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
// `consent` is validated server-side (must be the boolean true) but is NOT
// part of the stored fields: it proves the submitter explicitly agreed to be
// contacted, and is dropped after validation rather than persisted in the
// encrypted PII blob.
const PUBLIC_ALLOWED_FIELDS = new Set([
  'book',
  'format',
  'quantity',
  'name',
  'email',
  'consent',
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
//   { ok: false, silent: true }                           // silent accept (missing/false consent)
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

  // Explicit, required consent. It must be exactly the boolean true (not a
  // truthy string/number): a checkbox the submitter actively checked. Consent
  // is validated here and intentionally NOT carried into the persisted fields.
  //
  // A MISSING or FALSE consent is treated as a silent trap (the same generic ok
  // as a honeypot, before any limiter/Turnstile/DB work): a real submitter must
  // actively check the box (the client enforces this too), and returning a
  // generic ok avoids revealing the reason and avoids wasting downstream work.
  // A truthy-but-non-boolean value is a malformed request -> 400.
  if (body.consent === undefined || body.consent === null || body.consent === false) {
    return { ok: false, silent: true };
  }
  if (body.consent !== true) {
    return { ok: false, status: 400, error: 'Consent is required to continue.' };
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

// Admin summary in a single table scan using conditional (FILTER)
// aggregation. Reads ONLY created_at, quantity, status, and book_code -- no
// PII columns are touched and no schema change is required.
//
// "Today" is the start of the current UTC day (deterministic in a Worker, which
// has no meaningful local timezone); "last 7 days" is a trailing 168-hour
// window ending now. `windows.now` lets tests inject a deterministic clock.
//
// Returns the exact dashboard shape (no PII):
//   {
//     books: { biography:{interestCount,requestedCopies}, childrens:{...} },
//     today: { submissions, copies },
//     last7Days: { submissions, copies },
//     byStatus: { new, contacted, withdrawn },
//     total
//   }
// Per-book "active" counts EXCLUDE withdrawn rows (status <> 'withdrawn'), so a
// withdrawn interest no longer counts toward a book's active interest/copies.
export async function summarizeBookEoi(sql, windows) {
  const now = windows && windows.now ? new Date(windows.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Invalid clock value for summary.');
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const rows = await sql(
    'SELECT ' +
      'COUNT(*) FILTER (WHERE book_code = $1 AND status <> $2) AS bio_interest, ' +
      'COALESCE(SUM(quantity) FILTER (WHERE book_code = $1 AND status <> $2), 0)::int AS bio_copies, ' +
      'COUNT(*) FILTER (WHERE book_code = $3 AND status <> $2) AS child_interest, ' +
      'COALESCE(SUM(quantity) FILTER (WHERE book_code = $3 AND status <> $2), 0)::int AS child_copies, ' +
      'COUNT(*) FILTER (WHERE created_at >= $4) AS today_submissions, ' +
      'COALESCE(SUM(quantity) FILTER (WHERE created_at >= $4), 0)::int AS today_copies, ' +
      'COUNT(*) FILTER (WHERE created_at >= $5) AS last7_submissions, ' +
      'COALESCE(SUM(quantity) FILTER (WHERE created_at >= $5), 0)::int AS last7_copies, ' +
      'COUNT(*) FILTER (WHERE status = $6) AS status_new, ' +
      'COUNT(*) FILTER (WHERE status = $7) AS status_contacted, ' +
      'COUNT(*) FILTER (WHERE status = $2) AS status_withdrawn, ' +
      'COUNT(*) AS total ' +
      'FROM mj_eoi.book_eoi',
    ['biography', 'withdrawn', 'childrens', todayStart.toISOString(), sevenDaysAgo.toISOString(), 'new', 'contacted']
  );
  const r = Array.isArray(rows) && rows[0] ? rows[0] : {};
  const num = (v) => Number(v) || 0;
  return {
    books: {
      biography: { interestCount: num(r.bio_interest), requestedCopies: num(r.bio_copies) },
      childrens: { interestCount: num(r.child_interest), requestedCopies: num(r.child_copies) }
    },
    today: { submissions: num(r.today_submissions), copies: num(r.today_copies) },
    last7Days: { submissions: num(r.last7_submissions), copies: num(r.last7_copies) },
    byStatus: {
      new: num(r.status_new),
      contacted: num(r.status_contacted),
      withdrawn: num(r.status_withdrawn)
    },
    total: num(r.total)
  };
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
// pg_catalog) to EXPECTED_LIVE_CATALOG. The comparison is exact: ordered column
// definitions plus the complete normalized PK/UNIQUE/CHECK/FK and index sets.
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
  constraints: [
    {
      name: 'book_eoi_book_code_check',
      type: 'c',
      definition: "CHECK ((book_code = ANY (ARRAY['biography'::text, 'childrens'::text])))"
    },
    {
      name: 'book_eoi_book_email_unique',
      type: 'u',
      definition: 'UNIQUE (book_code, email_hash)'
    },
    {
      name: 'book_eoi_format_code_check',
      type: 'c',
      definition: "CHECK ((format_code = ANY (ARRAY['hardcover'::text, 'paperback'::text, 'ebook'::text, 'unsure'::text])))"
    },
    { name: 'book_eoi_pkey', type: 'p', definition: 'PRIMARY KEY (id)' },
    {
      name: 'book_eoi_quantity_check',
      type: 'c',
      definition: 'CHECK (((quantity >= 1) AND (quantity <= 10)))'
    },
    {
      name: 'book_eoi_status_check',
      type: 'c',
      definition: "CHECK ((status = ANY (ARRAY['new'::text, 'contacted'::text, 'withdrawn'::text])))"
    }
  ],
  indexes: [
    {
      name: 'book_eoi_book_created_idx',
      definition: 'CREATE INDEX book_eoi_book_created_idx ON mj_eoi.book_eoi USING btree (book_code, created_at DESC)',
      unique: false,
      primary: false
    },
    {
      name: 'book_eoi_book_email_unique',
      definition: 'CREATE UNIQUE INDEX book_eoi_book_email_unique ON mj_eoi.book_eoi USING btree (book_code, email_hash)',
      unique: true,
      primary: false
    },
    {
      name: 'book_eoi_book_status_idx',
      definition: 'CREATE INDEX book_eoi_book_status_idx ON mj_eoi.book_eoi USING btree (book_code, status)',
      unique: false,
      primary: false
    },
    {
      name: 'book_eoi_pkey',
      definition: 'CREATE UNIQUE INDEX book_eoi_pkey ON mj_eoi.book_eoi USING btree (id)',
      unique: true,
      primary: true
    }
  ]
};

export const EXPECTED_RUNTIME_PRIVILEGES = {
  role: {
    superuser: false,
    inherit: true,
    createRole: false,
    createDb: false,
    canLogin: true,
    replication: false,
    bypassRls: false
  },
  database: { connect: true, connectGrant: false, create: false, temporary: false },
  schemas: [
    { name: 'mj_eoi', usage: true, usageGrant: false, create: false, createGrant: false },
    { name: 'public', usage: false, usageGrant: false, create: false, createGrant: false }
  ],
  tables: [
    {
      schema: 'mj_eoi',
      name: 'book_eoi',
      select: true, selectGrant: false,
      insert: true, insertGrant: false,
      update: true, updateGrant: false,
      delete: false,
      truncate: false,
      references: false,
      trigger: false
    }
  ],
  defaultFunctionAcls: [
    { owner: 'neondb_owner', isGlobal: true, objectType: 'f', publicExecute: false }
  ],
  settings: [
    { database: 'CURRENT', setting: 'search_path=pg_catalog, mj_eoi' },
    { database: 'CURRENT', setting: 'statement_timeout=5000' }
  ]
};

function normText(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
}

// Normalize catalog definitions without changing quoted identifiers or string
// literals. This makes insignificant keyword/whitespace differences stable but
// preserves expression structure, literal order/case, predicates, methods,
// operator classes, sort/null semantics, INCLUDE columns, and index options.
export function normalizePgDefinition(value) {
  const source = String(value == null ? '' : value).trim().replace(/;$/, '');
  let out = '';
  let quote = null;
  let pendingSpace = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (source[i + 1] === quote) out += source[++i];
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (pendingSpace && out && !out.endsWith('(') && !out.endsWith(',')) out += ' ';
      pendingSpace = false;
      quote = ch;
      out += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      pendingSpace = true;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',') {
      out = out.replace(/ $/, '');
      out += ch;
      pendingSpace = false;
      continue;
    }
    if (pendingSpace && out && !out.endsWith('(') && !out.endsWith(',')) out += ' ';
    pendingSpace = false;
    out += ch.toLowerCase();
  }
  return out.trim();
}

function exactNamedDefinitions(kind, liveRows, expectedRows, mismatches) {
  const live = [...liveRows]
    .map((row) => ({
      name: normText(row.name),
      type: row.type == null ? undefined : normText(row.type),
      definition: normalizePgDefinition(row.definition),
      unique: row.unique == null ? undefined : bool(row.unique),
      primary: row.primary == null ? undefined : bool(row.primary),
      valid: row.valid == null ? undefined : bool(row.valid),
      ready: row.ready == null ? undefined : bool(row.ready),
      nullsNotDistinct: row.nulls_not_distinct == null ? undefined : bool(row.nulls_not_distinct),
      options: row.options == null ? null : normText(row.options)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const expected = [...expectedRows]
    .map((row) => ({
      name: normText(row.name),
      type: row.type == null ? undefined : normText(row.type),
      definition: normalizePgDefinition(row.definition),
      unique: row.unique,
      primary: row.primary,
      valid: row.valid,
      ready: row.ready,
      nullsNotDistinct: row.nullsNotDistinct,
      options: row.options == null ? null : normText(row.options)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (live.length !== expected.length) {
    mismatches.push(`${kind} count: expected ${expected.length}, got ${live.length}`);
  }
  for (let i = 0; i < Math.max(live.length, expected.length); i++) {
    const got = live[i];
    const want = expected[i];
    if (!want) {
      mismatches.push(`unexpected ${kind}: ${got.name}`);
      continue;
    }
    if (!got) {
      mismatches.push(`missing ${kind}: ${want.name}`);
      continue;
    }
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      mismatches.push(`${kind} ${want.name} definition mismatch`);
    }
  }
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

  exactNamedDefinitions(
    'constraint',
    live && Array.isArray(live.constraints) ? live.constraints : [],
    expected.constraints,
    mismatches
  );
  exactNamedDefinitions(
    'index',
    live && Array.isArray(live.indexes) ? live.indexes : [],
    expected.indexes.map((index) => ({
      ...index,
      valid: true,
      ready: true,
      nullsNotDistinct: false,
      options: null
    })),
    mismatches
  );

  return { match: mismatches.length === 0, mismatches };
}

// Probe the LIVE database catalog (columns, all constraints, all indexes) for the
// runtime schema-drift health check. No PII, no credentials. Three cheap catalog
// reads against information_schema/pg_catalog, run in parallel (each is an
// independent HTTP query via the executor).
export async function probeLiveCatalogShape(sql) {
  const [columns, constraints, indexes] = await Promise.all([
    sql(
      'SELECT column_name, data_type, is_nullable, column_default, character_maximum_length ' +
        'FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
      [SCHEMA_NAME, TABLE_NAME]
    ),
    sql(
      'SELECT con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid) AS definition ' +
        'FROM pg_constraint con ' +
        'JOIN pg_class rel ON rel.oid = con.conrelid ' +
        'JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace ' +
        'WHERE nsp.nspname = $1 AND rel.relname = $2 ORDER BY con.conname',
      [SCHEMA_NAME, TABLE_NAME]
    ),
    sql(
      'SELECT idx.relname AS name, pg_get_indexdef(idx.oid) AS definition, ind.indisunique AS unique, ' +
        'ind.indisprimary AS primary, ind.indisvalid AS valid, ind.indisready AS ready, ' +
        'ind.indnullsnotdistinct AS nulls_not_distinct, idx.reloptions::text AS options ' +
        'FROM pg_index ind JOIN pg_class idx ON idx.oid = ind.indexrelid ' +
        'JOIN pg_class rel ON rel.oid = ind.indrelid JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace ' +
        'WHERE nsp.nspname = $1 AND rel.relname = $2 ORDER BY idx.relname',
      [SCHEMA_NAME, TABLE_NAME]
    )
  ]);
  return {
    columns: Array.isArray(columns) ? columns : [],
    constraints: Array.isArray(constraints) ? constraints : [],
    indexes: Array.isArray(indexes) ? indexes : []
  };
}

function bool(value) {
  return value === true || value === 't' || value === 'true';
}

function exactRows(kind, liveRows, expectedRows, fields, mismatches) {
  const normalize = (row) => Object.fromEntries(fields.map((field) => [field, row[field]]));
  const live = liveRows.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const expected = expectedRows.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (JSON.stringify(live) !== JSON.stringify(expected)) mismatches.push(`${kind} matrix mismatch`);
}

export function compareRuntimePrivileges(live, expected = EXPECTED_RUNTIME_PRIVILEGES) {
  const mismatches = [];
  const summary = live && live.summary ? live.summary : {};
  const role = expected.role;
  const database = expected.database;
  for (const [field, want] of Object.entries({
    superuser: role.superuser,
    inherit: role.inherit,
    create_role: role.createRole,
    create_db: role.createDb,
    can_login: role.canLogin,
    replication: role.replication,
    bypass_rls: role.bypassRls,
    has_connect: database.connect,
    has_connect_grant: database.connectGrant,
    has_create: database.create,
    has_temporary: database.temporary
  })) {
    if (bool(summary[field]) !== want) mismatches.push(`role/database ${field}: expected ${want}`);
  }

  const schemas = (live?.schemas || []).map((row) => ({
    name: normText(row.name), usage: bool(row.usage), usageGrant: bool(row.usage_grant),
    create: bool(row.create), createGrant: bool(row.create_grant)
  }));
  exactRows(
    'schema privilege', schemas, expected.schemas,
    ['name', 'usage', 'usageGrant', 'create', 'createGrant'], mismatches
  );

  const tables = (live?.tables || []).map((row) => ({
    schema: normText(row.schema), name: normText(row.name), select: bool(row.select),
    selectGrant: bool(row.select_grant), insert: bool(row.insert), insertGrant: bool(row.insert_grant),
    update: bool(row.update), updateGrant: bool(row.update_grant), delete: bool(row.delete),
    truncate: bool(row.truncate), references: bool(row.references), trigger: bool(row.trigger)
  }));
  exactRows(
    'table privilege', tables, expected.tables,
    ['schema', 'name', 'select', 'selectGrant', 'insert', 'insertGrant', 'update', 'updateGrant', 'delete', 'truncate', 'references', 'trigger'],
    mismatches
  );

  const defaultFunctionAcls = (live?.defaultFunctionAcls || []).map((row) => ({
    owner: normText(row.owner), isGlobal: bool(row.is_global),
    objectType: normText(row.object_type), publicExecute: bool(row.public_execute)
  }));
  exactRows(
    'default function ACL', defaultFunctionAcls, expected.defaultFunctionAcls,
    ['owner', 'isGlobal', 'objectType', 'publicExecute'], mismatches
  );

  const currentDatabase = normText(summary.database_name);
  const settings = (live?.settings || []).map((row) => ({
    database: normText(row.database) === currentDatabase ? 'CURRENT' : normText(row.database),
    setting: String(row.setting)
  }));
  exactRows('role setting', settings, expected.settings, ['database', 'setting'], mismatches);
  if ((live?.executablePublicRoutines || []).length) mismatches.push('executable public routines found');
  if ((live?.columnAcls || []).length) mismatches.push('column ACLs found');
  if ((live?.ownedObjects || []).length) mismatches.push('owned database objects found');
  if ((live?.memberships || []).length) mismatches.push('role memberships found');
  return { match: mismatches.length === 0, mismatches };
}

export async function probeRuntimePrivileges(sql) {
  const [summaryRows, schemas, tables, defaultFunctionAcls, executablePublicRoutines, columnAcls, ownedObjects, settings, memberships] = await Promise.all([
    sql(
      'SELECT current_database() AS database_name, r.rolsuper AS superuser, r.rolinherit AS inherit, ' +
        'r.rolcreaterole AS create_role, r.rolcreatedb AS create_db, r.rolcanlogin AS can_login, ' +
        'r.rolreplication AS replication, r.rolbypassrls AS bypass_rls, ' +
        "has_database_privilege(current_user, current_database(), 'CONNECT') AS has_connect, " +
        "has_database_privilege(current_user, current_database(), 'CONNECT WITH GRANT OPTION') AS has_connect_grant, " +
        "has_database_privilege(current_user, current_database(), 'CREATE') AS has_create, " +
        "has_database_privilege(current_user, current_database(), 'TEMPORARY') AS has_temporary " +
        'FROM pg_roles r WHERE r.rolname = current_user'
    ),
    sql(
      "SELECT n.nspname AS name, has_schema_privilege(current_user, n.oid, 'USAGE') AS usage, " +
        "has_schema_privilege(current_user, n.oid, 'USAGE WITH GRANT OPTION') AS usage_grant, " +
        "has_schema_privilege(current_user, n.oid, 'CREATE') AS create, " +
        "has_schema_privilege(current_user, n.oid, 'CREATE WITH GRANT OPTION') AS create_grant FROM pg_namespace n " +
        "WHERE n.nspname IN ('mj_eoi', 'public') OR (n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND " +
        "(has_schema_privilege(current_user, n.oid, 'USAGE') OR has_schema_privilege(current_user, n.oid, 'CREATE'))) " +
        'ORDER BY n.nspname'
    ),
    sql(
      "SELECT n.nspname AS schema, c.relname AS name, (has_table_privilege(current_user, c.oid, 'SELECT') OR has_any_column_privilege(current_user, c.oid, 'SELECT')) AS select, " +
        "has_table_privilege(current_user, c.oid, 'SELECT WITH GRANT OPTION') AS select_grant, " +
        "(has_table_privilege(current_user, c.oid, 'INSERT') OR has_any_column_privilege(current_user, c.oid, 'INSERT')) AS insert, " +
        "has_table_privilege(current_user, c.oid, 'INSERT WITH GRANT OPTION') AS insert_grant, " +
        "(has_table_privilege(current_user, c.oid, 'UPDATE') OR has_any_column_privilege(current_user, c.oid, 'UPDATE')) AS update, " +
        "has_table_privilege(current_user, c.oid, 'UPDATE WITH GRANT OPTION') AS update_grant, " +
        "has_table_privilege(current_user, c.oid, 'DELETE') AS delete, has_table_privilege(current_user, c.oid, 'TRUNCATE') AS truncate, " +
        "(has_table_privilege(current_user, c.oid, 'REFERENCES') OR has_any_column_privilege(current_user, c.oid, 'REFERENCES')) AS references, " +
        "has_table_privilege(current_user, c.oid, 'TRIGGER') AS trigger " +
        'FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
        "WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND " +
        "((n.nspname = 'mj_eoi' AND c.relname = 'book_eoi') OR has_table_privilege(current_user, c.oid, 'SELECT') OR has_any_column_privilege(current_user, c.oid, 'SELECT') " +
        "OR has_table_privilege(current_user, c.oid, 'INSERT') OR has_any_column_privilege(current_user, c.oid, 'INSERT') " +
        "OR has_table_privilege(current_user, c.oid, 'UPDATE') OR has_any_column_privilege(current_user, c.oid, 'UPDATE') " +
        "OR has_table_privilege(current_user, c.oid, 'DELETE') OR has_table_privilege(current_user, c.oid, 'TRUNCATE') " +
        "OR has_table_privilege(current_user, c.oid, 'REFERENCES') OR has_any_column_privilege(current_user, c.oid, 'REFERENCES') " +
        "OR has_table_privilege(current_user, c.oid, 'TRIGGER')) " +
        'ORDER BY n.nspname, c.relname'
    ),
    sql(
      "SELECT r.rolname AS owner, (d.defaclnamespace = 0) AS is_global, d.defaclobjtype AS object_type, " +
        "EXISTS (SELECT 1 FROM aclexplode(COALESCE(d.defaclacl, acldefault('f', r.oid))) acl " +
        "WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_execute " +
        'FROM pg_roles r LEFT JOIN pg_default_acl d ON d.defaclrole = r.oid ' +
        "AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f' WHERE r.rolname = 'neondb_owner'"
    ),
    sql(
      "SELECT p.oid::regprocedure::text AS routine FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
        "WHERE n.nspname = 'public' AND has_function_privilege(current_user, p.oid, 'EXECUTE') ORDER BY 1"
    ),
    sql(
      "SELECT n.nspname AS schema, c.relname AS table, a.attname AS column, acl.privilege_type, acl.is_grantable " +
        "FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl " +
        "JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE a.attnum > 0 AND NOT a.attisdropped AND acl.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname = current_user)) AND n.nspname !~ '^pg_' " +
        "AND n.nspname <> 'information_schema' ORDER BY n.nspname, c.relname, a.attname"
    ),
    sql(
      "SELECT dep.classid::regclass::text AS kind, pg_describe_object(dep.classid, dep.objid, dep.objsubid) AS name " +
        "FROM pg_shdepend dep WHERE dep.refclassid = 'pg_authid'::regclass " +
        "AND dep.refobjid = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND dep.deptype = 'o' ORDER BY kind, name"
    ),
    sql(
      "SELECT COALESCE(d.datname, '*') AS database, setting FROM pg_db_role_setting s " +
        'LEFT JOIN pg_database d ON d.oid = s.setdatabase CROSS JOIN LATERAL unnest(s.setconfig) AS setting ' +
        'WHERE s.setrole = (SELECT oid FROM pg_roles WHERE rolname = current_user) ORDER BY database, setting'
    ),
    sql(
      'SELECT r.rolname AS role FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid ' +
        'WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user) ORDER BY r.rolname'
    )
  ]);
  return {
    summary: Array.isArray(summaryRows) ? summaryRows[0] || {} : {},
    schemas: Array.isArray(schemas) ? schemas : [],
    tables: Array.isArray(tables) ? tables : [],
    defaultFunctionAcls: Array.isArray(defaultFunctionAcls) ? defaultFunctionAcls : [],
    executablePublicRoutines: Array.isArray(executablePublicRoutines) ? executablePublicRoutines : [],
    columnAcls: Array.isArray(columnAcls) ? columnAcls : [],
    ownedObjects: Array.isArray(ownedObjects) ? ownedObjects : [],
    settings: Array.isArray(settings) ? settings : [],
    memberships: Array.isArray(memberships) ? memberships : []
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
