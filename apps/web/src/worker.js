import {
  MAX_PUT_BODY_BYTES,
  canonicalizeList,
  dimensionsLabel,
  toPublicList,
  sortByOrder,
  validateArtworkList
} from './artwork-schema.js';

const ARTWORKS_KEY = 'artworks.json';
const SESSION_COOKIE = 'mj_art_admin';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

// Canonical upload pipeline constants. The admin produces two JPEG derivatives
// (full ~2000px, thumb ~640px); these caps bound the uploaded multipart parts.
const UPLOAD_CATALOG_RE = /^(MJ|MISC)-\d{3}$/i;
const MAX_FULL_BYTES = 4 * 1024 * 1024;
const MAX_THUMB_BYTES = 1 * 1024 * 1024;
const MAX_UPLOAD_COMBINED_BYTES = MAX_FULL_BYTES + MAX_THUMB_BYTES;
const JPEG = 'image/jpeg';

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
  let galleryHtml;
  if (catalog.state === 'present') {
    galleryHtml = renderArtworkCards(toPublicList(catalog.records));
  } else {
    // Missing or invalid metadata: render an empty gallery container. There is
    // no legacy/static data path; the client hydrates from /api/artworks.
    galleryHtml = '';
  }

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

// Renders the server-side gallery from already-projected public records (no
// catalogNumber, sortOrder, or provenance). Ordered by sortOrder ascending.
function renderArtworkCards(artworks) {
  const cards = artworks.map((artwork) => {
    const imageClass = artwork.containImage ? 'painting-image painting-image-contained' : 'painting-image';
    const imageSrc = artwork.thumbnail || artwork.image;
    const medium = artwork.medium || '';

    return `          <article class="painting-card" role="button" aria-haspopup="dialog" aria-label="View details for ${escapeAttribute(artwork.title)}" data-title="${escapeAttribute(artwork.title)}" data-medium="${escapeAttribute(medium)}" data-size="${escapeAttribute(dimensionsLabel(artwork))}" data-availability="${escapeAttribute(artwork.availability)}" data-description="${escapeAttribute(artwork.description)}" data-image="${escapeAttribute(imageSrc)}">
            <div class="${imageClass}"><img src="${escapeAttribute(imageSrc)}" alt="${escapeAttribute(artwork.title)}"></div>
            <div class="painting-card-body">
              <h3>${escapeHtml(artwork.title)}</h3>
              <p>${escapeHtml(artwork.cardNote)}</p>
              <span>${escapeHtml(artwork.availability)}</span>
            </div>
          </article>`;
  });

  cards.push(`          <article class="painting-card painting-card-placeholder" aria-label="More paintings will be added soon">
            <div class="painting-image painting-image-placeholder"></div>
            <div class="painting-card-body">
              <h3>More works soon</h3>
              <p>Additional paintings will be added as the collection grows.</p>
            </div>
          </article>`);

  return cards.join('\n\n');
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

  // No arbitrary user path: only canonical image keys are ever served here.
  if (key.includes('..') || key.includes('\0')) {
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

async function login(request, env) {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
    return jsonResponse({ error: 'Admin secrets are not configured.' }, 503);
  }

  const { password } = await request.json();
  if (password !== env.ADMIN_PASSWORD) {
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
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const expected = await sign(payload, env.ADMIN_SESSION_SECRET);
  if (signature !== expected) return false;

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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json'
    }
  });
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

function base64UrlEncode(value) {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecode(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return atob(base64);
}
