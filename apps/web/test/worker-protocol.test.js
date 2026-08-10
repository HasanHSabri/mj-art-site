import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import worker, { CONTENT_SECURITY_POLICY } from '../src/worker.js';

const PUBLIC = path.resolve(import.meta.dirname, '..', 'public');
const CANONICAL_IMAGE = '/artwork-uploaded/artwork/catalog/mj-001/thumb.jpg';

function request(pathname, options = {}, origin = 'http://localhost') {
  return new Request(new URL(pathname, origin), options);
}

function makeEnv({ allowedHosts = 'localhost', environment = 'local' } = {}) {
  const calls = { imageGet: 0, imageHead: 0 };
  const imageMetadata = {
    writeHttpMetadata(headers) {
      headers.set('content-type', 'image/jpeg');
      headers.set('content-length', '3');
    }
  };
  return {
    _calls: calls,
    BOOK_EOI_ALLOWED_HOSTNAMES: allowedHosts,
    BOOK_EOI_ENVIRONMENT: environment,
    TURNSTILE_SITE_KEY: 'test-site-key',
    ARTWORK_IMAGES: {
      async get(key) {
        if (key === 'artworks.json') {
          return { async json() { return []; } };
        }
        if (key === 'artwork/catalog/mj-001/thumb.jpg') {
          calls.imageGet += 1;
          return { ...imageMetadata, body: new Uint8Array([0xff, 0xd8, 0xff]) };
        }
        return null;
      },
      async head(key) {
        if (key === 'artwork/catalog/mj-001/thumb.jpg') {
          calls.imageHead += 1;
          return imageMetadata;
        }
        return null;
      }
    },
    ASSETS: {
      async fetch(input) {
        const req = input instanceof Request ? input : null;
        const url = input instanceof URL ? input : new URL(req ? req.url : input);
        if (req && !['GET', 'HEAD'].includes(req.method)) {
          return new Response('Method not allowed.', { status: 405 });
        }
        const file = url.pathname === '/' ? '/index.html' : url.pathname;
        if (['/index.html', '/books.html', '/admin.html', '/favicon.svg', '/styles.css'].includes(file)) {
          const body = readFileSync(path.join(PUBLIC, file.slice(1)));
          const type = file.endsWith('.html')
            ? 'text/html; charset=UTF-8'
            : file.endsWith('.svg')
              ? 'image/svg+xml'
              : 'text/css; charset=UTF-8';
          return new Response(req?.method === 'HEAD' ? null : body, {
            headers: { 'content-type': type, 'cache-control': 'public, max-age=60' }
          });
        }
        return new Response('Not found.', { status: 404, headers: { 'content-type': 'text/plain' } });
      }
    }
  };
}

function headersObject(response) {
  return Object.fromEntries([...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function assertHeadMatchesGet(pathname, env, origin = 'http://localhost') {
  const get = await worker.fetch(request(pathname, {}, origin), env);
  const head = await worker.fetch(request(pathname, { method: 'HEAD' }, origin), env);
  assert.equal(head.status, get.status, `${pathname} status`);
  assert.deepEqual(headersObject(head), headersObject(get), `${pathname} headers`);
  assert.equal(await head.text(), '', `${pathname} HEAD body`);
  return { get, head };
}

test('security headers are exact and central on pages, APIs, assets, and errors', async () => {
  const env = makeEnv();
  for (const pathname of ['/', '/api/health', '/favicon.svg', '/missing']) {
    const response = await worker.fetch(request(pathname), env);
    assert.equal(response.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY, pathname);
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000', pathname);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', pathname);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', pathname);
    assert.equal(response.headers.get('referrer-policy'), 'strict-origin', pathname);
    assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()', pathname);
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin', pathname);
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin', pathname);
    assert.equal(response.headers.has('cross-origin-embedder-policy'), false, pathname);
  }
});

test('unexpected binding failures are sanitized and retain central security headers', async () => {
  const env = makeEnv();
  env.ASSETS.fetch = async () => { throw new Error('private binding detail'); };
  const response = await worker.fetch(request('/static-failure'), env);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'Internal server error.');
  assert.equal(response.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
});

test('CSP permits only self, Google Fonts, and Cloudflare Turnstile sources', () => {
  assert.equal(
    CONTENT_SECURITY_POLICY,
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self' mailto:; script-src 'self' https://challenges.cloudflare.com; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com"
  );
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-inline|unsafe-eval|https:\s|\*/);
});

test('HEAD matches GET status and headers with an empty body for pages, APIs, and static assets', async () => {
  const env = makeEnv();
  for (const pathname of ['/', '/index.html', '/books', '/api/health', '/api/artworks', '/admin.html', '/favicon.svg', '/styles.css']) {
    await assertHeadMatchesGet(pathname, env);
  }
});

test('root HEAD retains the GET no-store cache policy', async () => {
  const env = makeEnv();
  const { get, head } = await assertHeadMatchesGet('/', env);
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.equal(head.headers.get('cache-control'), 'no-store');
});

test('R2 image HEAD uses metadata-only head(), matches GET headers, and has no body', async () => {
  const env = makeEnv();
  const get = await worker.fetch(request(CANONICAL_IMAGE), env);
  assert.equal(get.status, 200);
  assert.equal(env._calls.imageGet, 1);
  const head = await worker.fetch(request(CANONICAL_IMAGE, { method: 'HEAD' }), env);
  assert.equal(head.status, 200);
  assert.deepEqual(headersObject(head), headersObject(get));
  assert.equal(await head.text(), '');
  assert.equal(env._calls.imageHead, 1);
  assert.equal(env._calls.imageGet, 1, 'HEAD must not download the R2 body when head() exists');
});

test('unauthorized admin HEAD remains 401 with an empty body', async () => {
  const response = await worker.fetch(request('/api/admin/artworks', { method: 'HEAD' }), makeEnv());
  assert.equal(response.status, 401);
  assert.equal(await response.text(), '');
});

test('known-route 405 responses carry exact Allow and OPTIONS has no CORS', async () => {
  const env = makeEnv();
  const cases = [
    ['/', 'POST', 'GET, HEAD'],
    ['/api/health', 'POST', 'GET, HEAD'],
    ['/api/artworks', 'DELETE', 'GET, HEAD'],
    ['/books', 'PATCH', 'GET, HEAD'],
    ['/api/admin/login', 'GET', 'POST'],
    ['/api/admin/logout', 'GET', 'POST'],
    ['/api/admin/artworks', 'POST', 'GET, HEAD, PUT'],
    ['/api/admin/upload', 'GET', 'POST'],
    [CANONICAL_IMAGE, 'POST', 'GET, HEAD'],
    ['/styles.css', 'POST', 'GET, HEAD'],
    ['/api/books/eoi', 'GET', 'POST'],
    ['/api/books/interest', 'DELETE', 'GET, HEAD'],
    ['/api/books/health', 'POST', 'GET, HEAD']
  ];
  for (const [pathname, method, allow] of cases) {
    const response = await worker.fetch(request(pathname, { method }), env);
    assert.equal(response.status, 405, `${method} ${pathname}`);
    assert.equal(response.headers.get('allow'), allow, `${method} ${pathname}`);
  }
  const options = await worker.fetch(request('/api/health', { method: 'OPTIONS' }), env);
  assert.equal(options.status, 405);
  assert.equal(options.headers.get('access-control-allow-origin'), null);
  assert.equal(options.headers.get('access-control-allow-methods'), null);
});

test('host allowlist accepts only explicit local, preview, and production hosts', async () => {
  for (const [origin, allowedHosts, environment] of [
    ['http://localhost', 'localhost,127.0.0.1', 'local'],
    ['https://mj-art-preview.drhasansabri.workers.dev', 'mj-art-preview.drhasansabri.workers.dev', 'preview'],
    ['https://mj-art.drhasansabri.workers.dev', 'mj-art.drhasansabri.workers.dev', 'production']
  ]) {
    const response = await worker.fetch(request('/api/health', {}, origin), makeEnv({ allowedHosts, environment }));
    assert.equal(response.status, 200, origin);
  }
});

test('missing, foreign, and mismatched Host values fail closed before health routing', async () => {
  const missing = await worker.fetch(request('/api/health'), makeEnv({ allowedHosts: '' }));
  assert.equal(missing.status, 421);
  assert.equal(await missing.text(), 'Misdirected request.');
  assert.equal(missing.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);

  const foreign = await worker.fetch(
    request('/api/health', {}, 'https://evil.example'),
    makeEnv({ allowedHosts: 'mj-art.drhasansabri.workers.dev' })
  );
  assert.equal(foreign.status, 421);

  const mismatched = await worker.fetch(
    request('/api/health', { headers: { host: 'evil.example' } }),
    makeEnv({ allowedHosts: 'localhost,evil.example' })
  );
  assert.equal(mismatched.status, 421, 'URL host and Host header must agree even if both are listed');
});

test('self-hosted SVG favicon is accessible and linked by public and admin pages', async () => {
  const svg = readFileSync(path.join(PUBLIC, 'favicon.svg'), 'utf8');
  assert.match(svg, /<title id="title">MJ Art<\/title>/);
  assert.match(svg, /aria-labelledby="title"/);
  for (const page of ['index.html', 'books.html', 'admin.html']) {
    const html = readFileSync(path.join(PUBLIC, page), 'utf8');
    assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/, page);
  }
  const response = await worker.fetch(request('/favicon.svg'), makeEnv());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('asset-generated 405 always carries an exact Allow: GET, HEAD, overwriting a divergent value', async () => {
  const env = makeEnv();
  // The fake asset binding returns a 405 with a WRONG Allow header; the Worker
  // must overwrite it with the exact GET, HEAD contract for served assets.
  env.ASSETS.fetch = async (input) => {
    const req = input instanceof Request ? input : null;
    const url = input instanceof URL ? input : new URL(req ? req.url : input);
    if (req && req.method === 'POST' && url.pathname === '/styles.css') {
      return new Response('Method not allowed.', {
        status: 405,
        headers: { allow: 'DELETE, TRACE' }
      });
    }
    return new Response('ok', { status: 200 });
  };
  const res = await worker.fetch(request('/styles.css', { method: 'POST' }), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET, HEAD', 'asset 405 Allow is overwritten to the exact contract');
});

test('R2 image HEAD never falls back to the body-returning get() when head() is unavailable', async () => {
  const env = makeEnv();
  delete env.ARTWORK_IMAGES.head; // head() unavailable -> must not download the body
  const realGet = env.ARTWORK_IMAGES.get.bind(env.ARTWORK_IMAGES);
  let getCalled = false;
  env.ARTWORK_IMAGES.get = async (key) => { getCalled = true; return realGet(key); };
  const head = await worker.fetch(request(CANONICAL_IMAGE, { method: 'HEAD' }), env);
  assert.equal(getCalled, false, 'HEAD must not call the body-returning get() when head() is unavailable');
  assert.equal(head.status, 501, 'HEAD declines with a stable response when head() is unavailable');
  assert.equal(await head.text(), '', 'HEAD body is empty');
});

test('Books alias/redirect HEAD matches the GET 301 status, Location, and has an empty body', async () => {
  const env = makeEnv();
  for (const alias of ['/books.html', '/books/', '/books//']) {
    const get = await worker.fetch(request(alias), env);
    const head = await worker.fetch(request(alias, { method: 'HEAD' }), env);
    assert.equal(get.status, 301, `${alias} GET redirects`);
    assert.equal(head.status, get.status, `${alias} HEAD status matches GET`);
    assert.equal(head.headers.get('location'), get.headers.get('location'), `${alias} HEAD Location matches GET`);
    assert.equal(await head.text(), '', `${alias} HEAD body is empty`);
    assert.equal(head.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY, `${alias} HEAD keeps central headers`);
  }
});

test('R2 HEAD on missing and rejected object keys returns 404 with an empty body, matching GET status', async () => {
  const env = makeEnv();
  // Canonical path with no stored object (head() resolves to null -> 404).
  const missing = '/artwork-uploaded/artwork/catalog/mj-999/thumb.jpg';
  // Rejected noncanonical paths (regex fail -> 404 before any R2 lookup).
  const rejected = [
    '/artwork-uploaded/artworks.json',
    '/artwork-uploaded/artwork/catalog/mj-001/evil.svg',
    '/artwork-uploaded/artwork/catalog/xyz-001/full.jpg'
  ];
  for (const pathname of [missing, ...rejected]) {
    const get = await worker.fetch(request(pathname), env);
    const head = await worker.fetch(request(pathname, { method: 'HEAD' }), env);
    assert.equal(get.status, 404, `${pathname} GET is 404`);
    assert.equal(head.status, 404, `${pathname} HEAD status matches GET`);
    assert.equal(await head.text(), '', `${pathname} HEAD body is empty`);
    assert.equal(head.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY, `${pathname} HEAD keeps central headers`);
  }
  // HEAD on a rejected path must never download a body via R2 get().
  assert.equal(env._calls.imageGet, 0, 'rejected/missing HEAD never calls R2 get()');
  assert.equal(env._calls.imageHead, 0, 'rejected noncanonical HEAD never calls R2 head()');
});

test('host-rejected HEAD returns 421 with an empty body and the central security policy', async () => {
  const foreign = await worker.fetch(
    request('/api/health', { method: 'HEAD' }, 'https://evil.example'),
    makeEnv({ allowedHosts: 'mj-art.drhasansabri.workers.dev', environment: 'production' })
  );
  assert.equal(foreign.status, 421);
  assert.equal(await foreign.text(), '', 'host-rejected HEAD body is empty');
  assert.equal(foreign.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);

  // Mismatched Host header on a HEAD also fails closed at the host gate.
  const mismatched = await worker.fetch(
    request('/api/health', { method: 'HEAD', headers: { host: 'evil.example' } }),
    makeEnv({ allowedHosts: 'localhost', environment: 'local' })
  );
  assert.equal(mismatched.status, 421);
  assert.equal(await mismatched.text(), '');
});

test('the Worker accepts exactly the local/preview/production hosts configured in wrangler.jsonc', async () => {
  // Parse the committed config (JSONC with full-line // comments + trailing commas).
  const raw = readFileSync(path.resolve(import.meta.dirname, '..', 'wrangler.jsonc'), 'utf8');
  const cfg = JSON.parse(
    raw
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
      .replace(/,(\s*[}\]])/g, '$1')
  );
  const environments = [
    ['local', cfg.vars],
    ['preview', cfg.env.preview.vars],
    ['production', cfg.env.production.vars]
  ];
  for (const [label, vars] of environments) {
    const allowed = vars.BOOK_EOI_ALLOWED_HOSTNAMES;
    const environment = vars.BOOK_EOI_ENVIRONMENT;
    const primaryHost = allowed.split(',')[0].trim().toLowerCase();
    const origin = `http://${primaryHost}`;
    const res = await worker.fetch(
      request('/api/health', {}, origin),
      makeEnv({ allowedHosts: allowed, environment })
    );
    assert.equal(res.status, 200, `configured ${label} host ${primaryHost} must be accepted`);
  }
});

test('environment/hostname policy binds each environment to its own host class', async () => {
  // Each wrangler environment's (environment, allowed hostnames) pair must be a
  // consistent pair under the fail-closed policy: local only allows loopback
  // hosts, preview/production only allow non-local (public) hosts.
  const raw = readFileSync(path.resolve(import.meta.dirname, '..', 'wrangler.jsonc'), 'utf8');
  const cfg = JSON.parse(
    raw
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
      .replace(/,(\s*[}\]])/g, '$1')
  );
  const pairs = [
    ['local', cfg.vars],
    ['preview', cfg.env.preview.vars],
    ['production', cfg.env.production.vars]
  ];
  for (const [label, vars] of pairs) {
    const res = await worker.fetch(
      request('/api/health', {}, `http://${vars.BOOK_EOI_ALLOWED_HOSTNAMES.split(',')[0].trim()}`),
      makeEnv({ allowedHosts: vars.BOOK_EOI_ALLOWED_HOSTNAMES, environment: vars.BOOK_EOI_ENVIRONMENT })
    );
    assert.equal(res.status, 200, `${label} environment/hostname pair must be consistent and accepted`);
  }
});

test('cross-environment hostname/config pairs fail closed at the host gate (421)', async () => {
  // A production/preview hostname paired with a local environment, and a
  // localhost paired with a production/preview environment, must both be
  // rejected before any routing (the environment and hostname set are not a
  // consistent pair). Driven by the public wrangler config values.
  const raw = readFileSync(path.resolve(import.meta.dirname, '..', 'wrangler.jsonc'), 'utf8');
  const cfg = JSON.parse(
    raw
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
      .replace(/,(\s*[}\]])/g, '$1')
  );
  const prodHost = cfg.env.production.vars.BOOK_EOI_ALLOWED_HOSTNAMES;
  const previewHost = cfg.env.preview.vars.BOOK_EOI_ALLOWED_HOSTNAMES;

  // Public host paired with a local environment -> rejected.
  for (const host of [prodHost, previewHost]) {
    const res = await worker.fetch(
      request('/api/health', {}, `https://${host.split(',')[0]}`),
      makeEnv({ allowedHosts: host, environment: 'local' })
    );
    assert.equal(res.status, 421, `local env with public host ${host} must fail closed`);
  }
  // Localhost paired with a production/preview environment -> rejected.
  for (const environment of ['production', 'preview']) {
    const res = await worker.fetch(
      request('/api/health', {}, 'http://localhost'),
      makeEnv({ allowedHosts: 'localhost,127.0.0.1', environment })
    );
    assert.equal(res.status, 421, `${environment} env with localhost must fail closed`);
  }
  // An unknown environment is rejected even with an otherwise valid host set.
  const unknown = await worker.fetch(
    request('/api/health'),
    makeEnv({ allowedHosts: 'localhost', environment: 'staging' })
  );
  assert.equal(unknown.status, 421, 'an unknown environment must fail closed');
});
