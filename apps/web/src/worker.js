import {
  MAX_PUT_BODY_BYTES,
  dimensionsLabel,
  toPublicList,
  sortByOrder,
  validateArtworkList
} from './artwork-schema.js';

const ARTWORKS_KEY = 'artworks.json';
const SESSION_COOKIE = 'mj_art_admin';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

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

// Admin PUT: strict canonical-schema validation, full overwrite. Enforces JSON
// content type and a reasonable body-size cap. No legacy-schema acceptance.
async function saveArtworks(request, env) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return jsonResponse({ error: 'Request must be JSON.' }, 415);
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_PUT_BODY_BYTES) {
    return jsonResponse({ error: 'Request body is too large.' }, 413);
  }

  let artworks;
  try {
    const text = await request.text();
    if (text.length > MAX_PUT_BODY_BYTES) {
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

  await env.ARTWORK_IMAGES.put(ARTWORKS_KEY, JSON.stringify(validation.records, null, 2), {
    httpMetadata: { contentType: 'application/json' }
  });

  return jsonResponse({ ok: true, artworks: sortByOrder(validation.records) });
}

async function uploadArtworkImage(request, env) {
  const form = await request.formData();
  const file = form.get('image');

  if (!file || typeof file === 'string') {
    return jsonResponse({ error: 'Choose an image to upload.' }, 400);
  }

  if (!file.type.startsWith('image/')) {
    return jsonResponse({ error: 'Only image uploads are allowed.' }, 400);
  }

  const key = `artwork/${Date.now()}-${slugify(file.name)}`;
  await env.ARTWORK_IMAGES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type }
  });

  return jsonResponse({ image: `/artwork-uploaded/${key}` });
}

async function serveUploadedImage(url, env) {
  const key = url.pathname.replace('/artwork-uploaded/', '');
  const object = await env.ARTWORK_IMAGES.get(key);

  if (!object) {
    return new Response('Not found', { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
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

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '') || 'image';
}

function base64UrlEncode(value) {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecode(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return atob(base64);
}
