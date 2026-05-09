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
      return jsonResponse(await getArtworks(request, env));
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
      return jsonResponse(await getArtworks(request, env));
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

async function getArtworks(request, env) {
  const stored = await env.ARTWORK_IMAGES.get(ARTWORKS_KEY);
  if (stored) {
    return stored.json();
  }

  const fallbackUrl = new URL('/artworks.json', request.url);
  const fallback = await env.ASSETS.fetch(new Request(fallbackUrl, request));
  return fallback.json();
}

async function saveArtworks(request, env) {
  const artworks = await request.json();
  const validation = validateArtworks(artworks);

  if (validation) {
    return jsonResponse({ error: validation }, 400);
  }

  await env.ARTWORK_IMAGES.put(ARTWORKS_KEY, JSON.stringify(artworks, null, 2), {
    httpMetadata: { contentType: 'application/json' }
  });
  return jsonResponse({ ok: true, artworks });
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

function validateArtworks(artworks) {
  if (!Array.isArray(artworks)) {
    return 'Artwork data must be a list.';
  }

  for (const artwork of artworks) {
    for (const key of ['id', 'title', 'image', 'medium', 'size', 'availability', 'cardNote', 'description']) {
      if (!artwork[key] || typeof artwork[key] !== 'string') {
        return `Missing ${key} on one artwork entry.`;
      }
    }

    if (typeof artwork.containImage !== 'boolean') {
      return 'containImage must be true or false.';
    }
  }

  return null;
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
