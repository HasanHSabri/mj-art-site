import {
  MAX_PUT_BODY_BYTES,
  canonicalizeList,
  toPublicList,
  sortByOrder,
  validateArtworkList
} from './artwork-schema.js';
import { renderArtworkCards } from './gallery-ssr.js';
import {
  BOOK_CODES,
  BOOK_EOI_STATUSES,
  MAX_BOOK_EOI_BODY_BYTES,
  MAX_BOOK_EOI_ADMITTED_LIMIT,
  DEFAULT_BOOK_EOI_LIMIT,
  TURNSTILE_ACTION,
  createNeonSqlExecutor,
  bookEoiSecretsOk,
  secretByteLength,
  MIN_SECRET_BYTES,
  compareLiveCatalog,
  probeLiveCatalogShape,
  validateBookEoiPayload,
  validateStatusUpdate,
  hmacEmailHash,
  encryptPii,
  decryptPii,
  isUniqueViolation,
  findBookEoi,
  insertBookEoi,
  updateBookEoiOnResubmit,
  updateBookEoiStatus,
  countBookInterest,
  listRecentBookEoi,
  summarizeBookEoi
} from './book-eoi.js';

const ARTWORKS_KEY = 'artworks.json';
const SESSION_COOKIE = 'mj_art_admin';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

// The Worker owns every Books page URL. The canonical page is /books; the raw
// .html alias and any trailing-slash variant (single or repeated) all
// canonicalize to /books. Anything that is NOT one of these is left alone
// (e.g. /api/books/*, /bookstore). Pure + exported so the route contract is
// unit-tested directly.
export function isBooksPage(pathname) {
  return (
    pathname === '/books' ||
    pathname === '/books.html' ||
    /^\/books\/+$/.test(pathname)
  );
}

// Canonical upload pipeline constants. The admin produces two JPEG derivatives
// (full ~2000px, thumb ~640px); these caps bound the uploaded multipart parts.
const UPLOAD_CATALOG_RE = /^(MJ|MISC)-\d{3}$/i;
const MAX_FULL_BYTES = 4 * 1024 * 1024;
const MAX_THUMB_BYTES = 1 * 1024 * 1024;
const MAX_UPLOAD_COMBINED_BYTES = MAX_FULL_BYTES + MAX_THUMB_BYTES;
const JPEG = 'image/jpeg';

// Strict byte caps for small JSON bodies. Declared Content-Length is checked
// first, then the actual UTF-8 byte length is measured (multibyte-safe) after
// reading the body, so an oversized payload is rejected even with no header.
const MAX_ADMIN_LOGIN_BODY_BYTES = 4 * 1024;
const MAX_BOOK_EOI_PATCH_BODY_BYTES = 2 * 1024;

// Strict allowlist for served uploaded-image keys. Only canonical catalog JPEG
// paths (full/thumb) ever match; everything else -- including artworks.json,
// arbitrary keys, SVG, or noncanonical paths -- is rejected with 404 before any
// R2 lookup. This mirrors the canonical regex semantics used for validation.
const SERVED_IMAGE_KEY_RE = /^artwork\/catalog\/(mj|misc)-\d{3}\/(full|thumb)\.jpg$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonResponse({ status: 'healthy' });
    }

    if (url.pathname === '/api/artworks' && request.method === 'GET') {
      return handlePublicArtworks(env);
    }

    if ((url.pathname === '/' || url.pathname === '/index.html') && request.method === 'GET') {
      return servePublicIndex(request, env);
    }

    // Books public page. The Worker owns every Books URL so the raw books.html
    // asset is never served with an unreplaced Turnstile site-key marker, and so
    // every alias canonicalizes to a single URL. GET /books serves the
    // SSR-injected page (site key from a pre-provisioned Worker secret; a
    // missing key fails closed 503, no static/fallback page is ever served).
    // GET /books.html, /books/, and repeated trailing slashes (/books//, ...)
    // are permanently redirected to /books. Any other method on a Books URL is
    // an explicit JSON 405 and NEVER falls through to static assets.
    if (isBooksPage(url.pathname)) {
      if (url.pathname !== '/books') {
        if (request.method === 'GET') {
          return Response.redirect(new URL('/books', request.url).toString(), 301);
        }
        return methodNotAllowed();
      }
      if (request.method !== 'GET') {
        return methodNotAllowed();
      }
      return serveBooksPage(request, env);
    }

    if (url.pathname === '/api/admin/login' && request.method === 'POST') {
      return login(request, env);
    }

    if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
      return logout();
    }

    if (url.pathname === '/api/admin/artworks' && request.method === 'GET') {
      const auth = await requireAdmin(request, env);
      if (auth) return auth;
      return handleAdminArtworks(env);
    }

    if (url.pathname === '/api/admin/artworks' && request.method === 'PUT') {
      const auth = await requireAdmin(request, env);
      if (auth) return auth;
      return saveArtworks(request, env);
    }

    if (url.pathname === '/api/admin/upload' && request.method === 'POST') {
      const auth = await requireAdmin(request, env);
      if (auth) return auth;
      return uploadArtworkImage(request, env);
    }

    if (url.pathname.startsWith('/artwork-uploaded/') && request.method === 'GET') {
      return serveUploadedImage(url, env);
    }

    // -------------------------------------------------------------------------
    // Books Expression of Interest (public). Unknown/unsupported /api/books/*
    // returns a JSON 404/405 and NEVER falls through to static assets.
    // -------------------------------------------------------------------------
    if (url.pathname.startsWith('/api/books/')) {
      if (url.pathname === '/api/books/eoi' && request.method === 'POST') {
        return handleCreateBookEoi(request, env);
      }
      if (url.pathname === '/api/books/interest' && request.method === 'GET') {
        return handleBookInterest(env);
      }
      if (url.pathname === '/api/books/health' && request.method === 'GET') {
        return handleBookHealth(env);
      }
      // Known path, unsupported method -> 405; unknown path -> 404.
      if (url.pathname === '/api/books/eoi' || url.pathname === '/api/books/interest' || url.pathname === '/api/books/health') {
        return jsonResponse({ error: 'Method not allowed.' }, 405);
      }
      return jsonResponse({ error: 'Not found.' }, 404);
    }

    // -------------------------------------------------------------------------
    // Books EOI (admin). Auth is enforced before any DB/crypto work. No DELETE.
    // -------------------------------------------------------------------------
    if (url.pathname === '/api/admin/books/eoi' && request.method === 'GET') {
      const auth = await requireAdmin(request, env);
      if (auth) return auth;
      return handleAdminListBookEoi(request, env);
    }
    if (url.pathname === '/api/admin/books/eoi/summary' && request.method === 'GET') {
      const auth = await requireAdmin(request, env);
      if (auth) return auth;
      return handleAdminSummaryBookEoi(env);
    }
    if (request.method === 'PATCH' && url.pathname.startsWith('/api/admin/books/eoi/')) {
      const auth = await requireAdmin(request, env);
      if (auth) return auth;
      // Safe decode: a malformed percent-encoded id must never throw (which
      // would surface as an opaque 500). It is not a valid resource -> JSON 404.
      const rawId = url.pathname.slice('/api/admin/books/eoi/'.length);
      let id;
      try {
        id = decodeURIComponent(rawId);
      } catch {
        return jsonResponse({ error: 'Not found.' }, 404);
      }
      return handleAdminPatchBookEoi(request, env, id);
    }
    if (url.pathname.startsWith('/api/admin/books/')) {
      const auth = await requireAdmin(request, env);
      if (auth) return auth;
      return jsonResponse({ error: 'Not found.' }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};

// Read the persisted catalogue from R2. Single runtime metadata source.
// Returns { state: 'present', records } | { state: 'missing' } | { state: 'invalid' }.
async function readStoredCatalog(env) {
  const stored = await env.ARTWORK_IMAGES.get(ARTWORKS_KEY);
  if (!stored) return { state: 'missing' };

  let parsed;
  try {
    parsed = await stored.json();
  } catch (error) {
    return { state: 'invalid' };
  }

  const result = validateArtworkList(parsed);
  if (!result.ok) return { state: 'invalid' };

  return { state: 'present', records: result.records };
}

// GET /api/artworks -> public projection, sorted by sortOrder ascending.
// Missing metadata returns an empty array (empty preview is valid). Invalid
// stored metadata returns a generic 500.
async function handlePublicArtworks(env) {
  const catalog = await readStoredCatalog(env);
  if (catalog.state === 'invalid') return jsonResponse({ error: 'Stored artwork data is invalid.' }, 500);
  if (catalog.state === 'missing') return jsonResponse([]);
  return jsonResponse(toPublicList(catalog.records));
}

// GET /api/admin/artworks -> full canonical records, sorted by sortOrder ascending.
// Missing metadata returns an empty array. Invalid stored metadata returns 500.
async function handleAdminArtworks(env) {
  const catalog = await readStoredCatalog(env);
  if (catalog.state === 'invalid') return jsonResponse({ error: 'Stored artwork data is invalid.' }, 500);
  if (catalog.state === 'missing') return jsonResponse([]);
  return jsonResponse(sortByOrder(catalog.records));
}

async function servePublicIndex(request, env) {
  const indexUrl = new URL('/index.html', request.url);
  const asset = await env.ASSETS.fetch(indexUrl);
  const html = await asset.text();

  const catalog = await readStoredCatalog(env);
  // SSR renders canonical public records exactly once. The client enhances
  // these cards in place (filters, dialog) and never fetches /api/artworks or
  // rebuilds the grid. Missing/invalid metadata yields an empty gallery
  // container (accessible empty state), never legacy cards.
  const galleryHtml = catalog.state === 'present'
    ? renderArtworkCards(toPublicList(catalog.records))
    : '';

  const status = catalog.state === 'invalid' ? 500 : 200;
  const rendered = html.replace(
    /<!-- artwork-gallery:start -->[\s\S]*<!-- artwork-gallery:end -->/,
    `<!-- artwork-gallery:start -->\n${galleryHtml}          <!-- artwork-gallery:end -->`
  );

  return new Response(rendered, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=UTF-8'
    }
  });
}

// Unique, unambiguous marker in public/books.html that the Worker replaces with
// the pre-provisioned TURNSTILE_SITE_KEY. It is intentionally a sentinel that
// never appears in any other context, so a single replaceAll is total and safe.
const TURNSTILE_SITE_KEY_MARKER = '__BOOKS_TURNSTILE_SITE_KEY__';

// Escape a value for safe interpolation into an HTML double-quoted attribute.
// The Turnstile site key is opaque operator-controlled text; this defends in
// depth against any quoting/control characters breaking out of the attribute.
function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// GET /books -- serve public/books.html with the pre-provisioned Turnstile site
// key injected into the widget container's data-sitekey marker. Fails closed
// with 503 when TURNSTILE_SITE_KEY is absent/empty: the EOI form cannot render a
// verifiable widget without it, so no half-functional page is ever served.
async function serveBooksPage(request, env) {
  if (typeof env.TURNSTILE_SITE_KEY !== 'string' || env.TURNSTILE_SITE_KEY.length === 0) {
    return new Response('Service unavailable.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=UTF-8' }
    });
  }

  const booksUrl = new URL('/books.html', request.url);
  const asset = await env.ASSETS.fetch(booksUrl);
  if (!asset.ok) {
    return new Response('Not found', { status: 404 });
  }

  const html = await asset.text();
  const rendered = html.replaceAll(
    TURNSTILE_SITE_KEY_MARKER,
    escapeHtmlAttribute(env.TURNSTILE_SITE_KEY)
  );

  return new Response(rendered, {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=UTF-8'
    }
  });
}

// Admin PUT: strict canonical-schema validation, full overwrite. Enforces an
// exact JSON content type (with optional parameters) and a UTF-8 *byte-length*
// cap. Records are canonicalized (deep-cloned, exact field set) before they
// are persisted or returned. No legacy-schema acceptance.
async function saveArtworks(request, env) {
  const contentType = request.headers.get('content-type') || '';
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return jsonResponse({ error: 'Request must be JSON.' }, 415);
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_PUT_BODY_BYTES) {
    return jsonResponse({ error: 'Request body is too large.' }, 413);
  }

  let artworks;
  try {
    const text = await request.text();
    // Actual UTF-8 byte length, not JS char count, so multibyte payloads are
    // measured correctly even when no content-length header is present.
    if (new TextEncoder().encode(text).length > MAX_PUT_BODY_BYTES) {
      return jsonResponse({ error: 'Request body is too large.' }, 413);
    }
    artworks = JSON.parse(text);
  } catch (error) {
    return jsonResponse({ error: 'Request body is not valid JSON.' }, 400);
  }

  const validation = validateArtworkList(artworks);
  if (!validation.ok) {
    return jsonResponse({ error: validation.error }, 400);
  }

  const canonical = canonicalizeList(validation.records);
  await env.ARTWORK_IMAGES.put(ARTWORKS_KEY, JSON.stringify(canonical, null, 2), {
    httpMetadata: { contentType: 'application/json' }
  });

  return jsonResponse({ ok: true, artworks: sortByOrder(canonical) });
}

// Canonical upload pipeline. The admin sends catalogNumber plus two JPEG
// derivatives (full + thumb). We validate auth (route level), catalog number
// format, presence and type of both files, JPEG magic bytes, and per-file and
// combined size caps. We then write exactly two canonical keys and return their
// canonical public URLs. There is no delete path and no user-controlled path.
async function uploadArtworkImage(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch (error) {
    return jsonResponse({ error: 'Upload must be a multipart form.' }, 400);
  }

  const catalogNumber = form.get('catalogNumber');
  if (typeof catalogNumber !== 'string' || !UPLOAD_CATALOG_RE.test(catalogNumber.trim())) {
    return jsonResponse({ error: 'A valid catalog number (MJ-xxx or MISC-xxx) is required first.' }, 400);
  }
  const catalog = catalogNumber.trim();
  const folder = catalog.toLowerCase();

  const image = form.get('image');
  const thumbnail = form.get('thumbnail');
  if (!image || typeof image === 'string' || !thumbnail || typeof thumbnail === 'string') {
    return jsonResponse({ error: 'Both image and thumbnail files are required.' }, 400);
  }

  if (image.type !== JPEG || thumbnail.type !== JPEG) {
    return jsonResponse({ error: 'Both files must be JPEG images.' }, 400);
  }

  const imageBuf = await image.arrayBuffer();
  const thumbBuf = await thumbnail.arrayBuffer();

  if (!isJpeg(imageBuf) || !isJpeg(thumbBuf)) {
    return jsonResponse({ error: 'Files are not valid JPEG images.' }, 400);
  }

  if (imageBuf.byteLength > MAX_FULL_BYTES) {
    return jsonResponse({ error: 'Full image exceeds the size limit.' }, 413);
  }
  if (thumbBuf.byteLength > MAX_THUMB_BYTES) {
    return jsonResponse({ error: 'Thumbnail exceeds the size limit.' }, 413);
  }
  if (imageBuf.byteLength + thumbBuf.byteLength > MAX_UPLOAD_COMBINED_BYTES) {
    return jsonResponse({ error: 'Combined upload exceeds the size limit.' }, 413);
  }

  const fullKey = `artwork/catalog/${folder}/full.jpg`;
  const thumbKey = `artwork/catalog/${folder}/thumb.jpg`;
  await env.ARTWORK_IMAGES.put(fullKey, imageBuf, { httpMetadata: { contentType: JPEG } });
  await env.ARTWORK_IMAGES.put(thumbKey, thumbBuf, { httpMetadata: { contentType: JPEG } });

  return jsonResponse({
    image: `/artwork-uploaded/${fullKey}`,
    thumbnail: `/artwork-uploaded/${thumbKey}`
  });
}

// JPEG SOI magic bytes (FF D8).
function isJpeg(buf) {
  const view = new Uint8Array(buf);
  return view.length >= 2 && view[0] === 0xff && view[1] === 0xd8;
}

async function serveUploadedImage(url, env) {
  const key = url.pathname.replace('/artwork-uploaded/', '');

  // Strict canonical-path allowlist: only artwork/catalog/(mj|misc)-NNN/(full|thumb).jpg
  // is ever served. artworks.json, arbitrary keys, SVG, and noncanonical paths
  // all fall through to 404 here -- before any R2 lookup -- so raw metadata can
  // never be fetched through this route.
  if (!SERVED_IMAGE_KEY_RE.test(key)) {
    return new Response('Not found', { status: 404 });
  }

  const object = await env.ARTWORK_IMAGES.get(key);

  if (!object) {
    return new Response('Not found', { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(object.body, { headers });
}

// Fail-closed admin session-secret gate, mirroring the Books PII secret gate.
// The session-signing secret must be present AND carry at least MIN_SECRET_BYTES
// of UTF-8 key material before login (and therefore session creation) proceeds.
// A short/weak secret never signs a session and the password is never compared:
// the route fails closed with 503. There is deliberately no compatibility
// fallback (no live sessions/data are in scope for this greenfield route).
function adminSessionSecretOk(env) {
  return (
    typeof env.ADMIN_SESSION_SECRET === 'string' &&
    secretByteLength(env.ADMIN_SESSION_SECRET) >= MIN_SECRET_BYTES
  );
}

async function login(request, env) {
  if (!env.ADMIN_PASSWORD || !adminSessionSecretOk(env)) {
    return jsonResponse({ error: 'Admin secrets are not configured.' }, 503);
  }

  // Rate limit BEFORE the password compare, using the existing rate-limiter
  // binding. A missing/undefined binding fails closed (no fallback, no separate
  // binding). This caps brute-force attempts against the admin password.
  const rl = await rateLimit(env, 'admin-login:' + (clientIp(request) || 'unknown'));
  if (!rl.allowed) {
    return jsonResponse({ error: rl.serviceError ? 'Service unavailable.' : 'Too many requests.' }, rl.serviceError ? 503 : 429);
  }

  // Declared + actual (multibyte-safe) byte cap on the login body.
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_ADMIN_LOGIN_BODY_BYTES) {
    return jsonResponse({ error: 'Request body is too large.' }, 413);
  }

  let body;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_ADMIN_LOGIN_BODY_BYTES) {
      return jsonResponse({ error: 'Request body is too large.' }, 413);
    }
    body = JSON.parse(text);
  } catch (error) {
    return jsonResponse({ error: 'Request body must be valid JSON.' }, 400);
  }

  const password = body && typeof body === 'object' ? body.password : undefined;
  if (typeof password !== 'string' || !timingSafeEqual(password, env.ADMIN_PASSWORD)) {
    return jsonResponse({ error: 'Incorrect password.' }, 401);
  }

  const token = await createSessionToken(env);
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`);
  return new Response(JSON.stringify({ ok: true }), { headers });
}

function logout() {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
  return new Response(JSON.stringify({ ok: true }), { headers });
}

async function requireAdmin(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !(await verifySessionToken(token, env))) {
    return jsonResponse({ error: 'Sign in required.' }, 401);
  }

  return null;
}

async function createSessionToken(env) {
  const payload = base64UrlEncode(JSON.stringify({ exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 }));
  const signature = await sign(payload, env.ADMIN_SESSION_SECRET);
  return `${payload}.${signature}`;
}

async function verifySessionToken(token, env) {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;

  const expected = await sign(payload, env.ADMIN_SESSION_SECRET);
  if (!timingSafeEqual(signature, expected)) return false;

  try {
    const data = JSON.parse(base64UrlDecode(payload));
    return Number(data.exp) > Date.now();
  } catch (error) {
    return false;
  }
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

function getCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  return cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

// Constant-time string comparison (dependency-free). Compares the UTF-8 byte
// sequences of two strings, always scanning the full length of the shorter.
// Returns false immediately on length mismatch (length itself is not secret
// here: passwords and HMAC signatures have known lengths).
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json'
    }
  });
}

// Consistent JSON 405 for any supported path hit with an unsupported method.
// Used by the Books page routes so unsupported methods never fall through to
// static assets. Mirrors the /api/books/* 405 shape.
function methodNotAllowed() {
  return jsonResponse({ error: 'Method not allowed.' }, 405);
}

function base64UrlEncode(value) {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecode(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return atob(base64);
}

// ===========================================================================
// Books Expression of Interest
// ===========================================================================
//
// PII handling: the normalized email is HMAC-hashed (dedup key) and {name,email}
// is AES-256-GCM encrypted before any storage. Plaintext PII, hashes, and
// ciphertext are NEVER returned to public callers and are NEVER logged. Only
// authenticated admin result rows are decrypted. All statements are
// parameterized and fully-qualified to mj_eoi.book_eoi.

// Build the Neon SQL executor for this request. The driver is imported lazily so
// it is only loaded when a Books/DB route is actually hit (keeping the module
// importable in environments where the package is absent, e.g. unit tests). The
// raw neon() HTTP client is wrapped by createNeonSqlExecutor so the repository
// seam stays the pure sql(text, params) form -- the neon client's plain
// call-form is NOT used (see createNeonSqlExecutor for the 1.x compatibility
// note). The BOOK_EOI_SQL env hook lets tests inject a fake executor.
async function getBookEoiSql(env) {
  if (env.BOOK_EOI_SQL) return env.BOOK_EOI_SQL;
  const { neon } = await import('@neondatabase/serverless');
  return createNeonSqlExecutor(neon(env.NEON_DATABASE_URL));
}

// Fail-closed config gate: every Books EOI secret/binding must be present AND
// the PII secrets must meet the minimum key length before any submission is
// accepted. A missing binding or short key means the route is unavailable.
function bookEoiConfigOk(env) {
  return Boolean(
    env.NEON_DATABASE_URL &&
      env.TURNSTILE_SECRET_KEY &&
      env.BOOK_EOI_RATE_LIMITER &&
      bookEoiSecretsOk(env)
  );
}

function bookEoiReadConfigOk(env) {
  return Boolean(env.NEON_DATABASE_URL);
}

// Full deployment-config gate for the post-deploy /api/books/health probe. It
// verifies that EVERY pre-provisioned Worker secret/binding is present so a
// deploy fails closed when the Turnstile keys, DB URL, or crypto keys are
// missing or misconfigured, and that the non-secret allowed Turnstile action
// and hostname allowlist are set. Intentionally stricter than the per-route
// read/write gates: its job is to catch an incompletely provisioned deployment
// before it is trusted. It performs NO DB access.
function bookEoiHealthConfigOk(env) {
  return Boolean(
    env &&
      env.NEON_DATABASE_URL &&
      typeof env.TURNSTILE_SECRET_KEY === 'string' && env.TURNSTILE_SECRET_KEY.length > 0 &&
      typeof env.TURNSTILE_SITE_KEY === 'string' && env.TURNSTILE_SITE_KEY.length > 0 &&
      typeof env.BOOK_EOI_TURNSTILE_ACTION === 'string' && env.BOOK_EOI_TURNSTILE_ACTION.length > 0 &&
      parseAllowedHostnames(env.BOOK_EOI_ALLOWED_HOSTNAMES).length > 0 &&
      bookEoiSecretsOk(env)
  );
}

// Same-origin enforcement: the request's Origin (or Referer) host must match the
// host the Worker is serving. Blocks cross-site submissions without needing env.
function sameOrigin(request) {
  const host = new URL(request.url).host;
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).host === host;
    } catch {
      return false;
    }
  }
  return false;
}

function clientIp(request) {
  // Cloudflare-provided client IP only. The spoofable X-Forwarded-For header is
  // intentionally NOT consulted: outside Cloudflare there is no trustworthy
  // per-client IP, and a spoofed value would let an attacker shift buckets.
  const cf = request.headers.get('cf-connecting-ip');
  return cf ? cf.trim() : null;
}

function bookEoiRateLimitKey(request) {
  const ip = clientIp(request);
  // A single stable bucket for requests with no CF IP (no per-spoofed-value
  // fan-out).
  return ip ? `books-eoi:${ip}` : 'books-eoi:unknown';
}

// Fail-closed rate-limit wrapper around the existing BOOK_EOI_RATE_LIMITER
// binding. Returns { allowed, serviceError }. serviceError is true (-> 503) when
// the binding is missing/undefined OR limit() throws: both are service faults,
// not a legitimate rate-limit denial. A real denial ({ success: false }) sets
// allowed=false with serviceError=false (-> 429). There is no fallback binding.
async function rateLimit(env, key) {
  const rl = env.BOOK_EOI_RATE_LIMITER;
  if (!rl || typeof rl.limit !== 'function') return { allowed: false, serviceError: true };
  let decision;
  try {
    decision = await rl.limit({ key });
  } catch {
    return { allowed: false, serviceError: true };
  }
  return { allowed: Boolean(decision && decision.success !== false), serviceError: false };
}

function parseAllowedHostnames(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

// Verify a Turnstile token via Siteverify. Validates success, expected action,
// and expected hostname. The hostname allowlist is MANDATORY: a missing/empty
// BOOK_EOI_ALLOWED_HOSTNAMES config fails closed. A per-call idempotency_key
// (UUID) is sent so a retried verification is safe. On network failure (cannot
// reach / non-2xx / unparseable body) it fails closed. Returns { ok, failClosed }.
async function verifyTurnstile(env, token, remoteip) {
  const fetcher = env.TURNSTILE_FETCH || fetch;
  const allowedHosts = parseAllowedHostnames(env.BOOK_EOI_ALLOWED_HOSTNAMES);
  if (allowedHosts.length === 0) return { ok: false, failClosed: true };

  const form = new URLSearchParams();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  if (remoteip) form.append('remoteip', remoteip);
  form.append('idempotency_key', crypto.randomUUID());

  let res;
  try {
    res = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form
    });
  } catch {
    return { ok: false, failClosed: true };
  }
  if (!res || !res.ok) return { ok: false, failClosed: true };

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, failClosed: true };
  }

  const action = env.BOOK_EOI_TURNSTILE_ACTION || TURNSTILE_ACTION;
  const actionOk = data.action === action;
  const hostOk = allowedHosts.includes(String(data.hostname || '').toLowerCase());
  return { ok: Boolean(data.success && actionOk && hostOk), failClosed: false };
}

// POST /api/books/eoi -- strict validation, honeypot, rate limit, mandatory
// Turnstile, then parameterized upsert on (book, email_hash). New, duplicate,
// and honeypot submissions all return the same generic { ok: true } so the
// response cannot be used to enumerate interest.
async function handleCreateBookEoi(request, env) {
  if (!bookEoiConfigOk(env)) return jsonResponse({ ok: false, error: 'Service unavailable.' }, 503);
  if (!sameOrigin(request)) return jsonResponse({ error: 'Bad request.' }, 400);

  const contentType = request.headers.get('content-type') || '';
  if (contentType.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return jsonResponse({ error: 'Request must be JSON.' }, 415);
  }

  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_BOOK_EOI_BODY_BYTES) {
    return jsonResponse({ error: 'Request body is too large.' }, 413);
  }

  let body;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BOOK_EOI_BODY_BYTES) {
      return jsonResponse({ error: 'Request body is too large.' }, 413);
    }
    body = JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'Request body is not valid JSON.' }, 400);
  }

  const validation = validateBookEoiPayload(body);
  if (!validation.ok) {
    // Honeypot OR missing/false consent: accept silently with the same generic
    // response as success, before any rate-limit/Turnstile/DB work (anti-
    // enumeration + no wasted downstream work).
    if (validation.honeypot || validation.silent) return jsonResponse({ ok: true });
    return jsonResponse({ error: validation.error }, validation.status || 400);
  }
  const { book, format, quantity, name, email, turnstileToken } = validation.fields;

  const decision = await rateLimit(env, bookEoiRateLimitKey(request));
  if (!decision.allowed) {
    return jsonResponse({ error: decision.serviceError ? 'Service unavailable.' : 'Too many requests.' }, decision.serviceError ? 503 : 429);
  }

  const turnstile = await verifyTurnstile(env, turnstileToken, clientIp(request));
  if (turnstile.failClosed) return jsonResponse({ error: 'Service unavailable.' }, 503);
  if (!turnstile.ok) return jsonResponse({ error: 'Verification failed.' }, 400);

  try {
    const emailHash = await hmacEmailHash(env.BOOK_EOI_HMAC_KEY, email);
    let sql;
    try {
      sql = await getBookEoiSql(env);
    } catch {
      return jsonResponse({ error: 'Service unavailable.' }, 503);
    }

    const existing = await findBookEoi(sql, book, emailHash);
    const id = existing ? existing.id : crypto.randomUUID();
    const { ciphertext, iv } = await encryptPii(env.BOOK_EOI_ENCRYPTION_KEY, { name, email }, id);

    if (existing) {
      await updateBookEoiOnResubmit(sql, id, {
        piiCiphertext: ciphertext,
        piiIv: iv,
        quantity,
        formatCode: format
      });
    } else {
      try {
        await insertBookEoi(sql, {
          id,
          bookCode: book,
          emailHash,
          piiCiphertext: ciphertext,
          piiIv: iv,
          quantity,
          formatCode: format
        });
      } catch (insertError) {
        // Concurrent insert raced past the SELECT: the unique(book,email_hash)
        // constraint makes this idempotent. Treat as a duplicate success.
        if (!isUniqueViolation(insertError)) throw insertError;
      }
    }

    return jsonResponse({ ok: true });
  } catch {
    // Any unexpected failure fails closed with a generic message; no PII leaks.
    return jsonResponse({ ok: false, error: 'Service unavailable.' }, 503);
  }
}

// GET /api/books/interest -- public per-book active counts + requested-copy sum.
// Always returns both books. Short public cache: non-sensitive aggregate, and
// caching reduces DB load on a hot public endpoint.
async function handleBookInterest(env) {
  if (!bookEoiReadConfigOk(env)) return jsonResponse({ error: 'Service unavailable.' }, 503);
  let sql;
  try {
    sql = await getBookEoiSql(env);
  } catch {
    return jsonResponse({ error: 'Service unavailable.' }, 503);
  }
  try {
    const rows = await countBookInterest(sql);
    const byCode = new Map(rows.map((r) => [r.book_code, r]));
    const books = [...BOOK_CODES].map((code) => {
      const r = byCode.get(code);
      return {
        book: code,
        interestCount: r ? Number(r.interest_count) : 0,
        requestedCopies: r ? Number(r.requested_copies) : 0
      };
    });
    return new Response(JSON.stringify({ books }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=60'
      }
    });
  } catch {
    return jsonResponse({ error: 'Service unavailable.' }, 503);
  }
}

// GET /api/books/health -- runtime schema-drift probe for post-deploy
// validation. Compares the LIVE catalog shape (columns/types/nullability/
// defaults + CHECK value sets + UNIQUE constraint + exact indexes) to the
// canonical model. No PII, no credentials. The PUBLIC response reveals only the
// outcome (healthy | mismatch | unavailable) and never the differences, column
// data, or any internal detail.
async function handleBookHealth(env) {
  // Post-deploy smoke gate: the FULL pre-provisioned config (DB + both
  // Turnstile keys + crypto keys + allowed action/host) must be present, then
  // the live schema is compared. The PUBLIC response reveals only the outcome
  // (healthy | mismatch | unavailable), never the differences or any detail.
  if (!bookEoiHealthConfigOk(env)) {
    return jsonResponse({ status: 'unavailable' }, 503);
  }
  let sql;
  try {
    sql = await getBookEoiSql(env);
  } catch {
    return jsonResponse({ status: 'unavailable' }, 503);
  }
  try {
    const live = await probeLiveCatalogShape(sql);
    const result = compareLiveCatalog(live);
    if (result.match) return jsonResponse({ status: 'healthy' }, 200);
    return jsonResponse({ status: 'mismatch' }, 503);
  } catch {
    return jsonResponse({ status: 'unavailable' }, 503);
  }
}

// GET /api/admin/books/eoi?limit= -- recent rows with PII decrypted. limit<=100.
async function handleAdminListBookEoi(request, env) {
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get('limit'));
  let limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_BOOK_EOI_LIMIT;
  if (limit > MAX_BOOK_EOI_ADMITTED_LIMIT) limit = MAX_BOOK_EOI_ADMITTED_LIMIT;

  let sql;
  try {
    sql = await getBookEoiSql(env);
  } catch {
    return jsonResponse({ error: 'Service unavailable.' }, 503);
  }
  try {
    const rows = await listRecentBookEoi(sql, limit);
    const out = [];
    for (const row of rows) {
      let pii = null;
      try {
        pii = await decryptPii(env.BOOK_EOI_ENCRYPTION_KEY, row.pii_ciphertext, row.pii_iv, row.id);
      } catch {
        pii = null; // unreadable (tamper/key/ADD mismatch): do not expose raw.
      }
      out.push({
        id: row.id,
        book: row.book_code,
        name: pii ? pii.name : null,
        email: pii ? pii.email : null,
        quantity: row.quantity,
        format: row.format_code,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    }
    return jsonResponse({ rows: out });
  } catch {
    return jsonResponse({ error: 'Service unavailable.' }, 503);
  }
}

// GET /api/admin/books/eoi/summary -- per-book active counts/copies, today +
// trailing-7-day submission/copy windows, counts by status, and a grand total.
// Single parameterized conditional-aggregation scan over created_at/quantity/
// status/book_code only. No PII is read or returned.
async function handleAdminSummaryBookEoi(env) {
  let sql;
  try {
    sql = await getBookEoiSql(env);
  } catch {
    return jsonResponse({ error: 'Service unavailable.' }, 503);
  }
  try {
    const summary = await summarizeBookEoi(sql, { now: new Date() });
    return jsonResponse(summary);
  } catch {
    return jsonResponse({ error: 'Service unavailable.' }, 503);
  }
}

// PATCH /api/admin/books/eoi/:id -- strict {status}-only update. No DELETE.
async function handleAdminPatchBookEoi(request, env, id) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!id || !UUID_RE.test(id)) return jsonResponse({ error: 'Not found.' }, 404);

  const contentType = request.headers.get('content-type') || '';
  if (contentType.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return jsonResponse({ error: 'Request must be JSON.' }, 415);
  }

  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_BOOK_EOI_PATCH_BODY_BYTES) {
    return jsonResponse({ error: 'Request body is too large.' }, 413);
  }

  let body;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BOOK_EOI_PATCH_BODY_BYTES) {
      return jsonResponse({ error: 'Request body is too large.' }, 413);
    }
    body = JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'Request body is not valid JSON.' }, 400);
  }

  const validation = validateStatusUpdate(body);
  if (!validation.ok) return jsonResponse({ error: validation.error }, validation.status);

  let sql;
  try {
    sql = await getBookEoiSql(env);
  } catch {
    return jsonResponse({ error: 'Service unavailable.' }, 503);
  }
  try {
    const updated = await updateBookEoiStatus(sql, id, validation.status);
    if (!updated) return jsonResponse({ error: 'Not found.' }, 404);
    return jsonResponse({ ok: true });
  } catch {
    return jsonResponse({ error: 'Service unavailable.' }, 503);
  }
}
