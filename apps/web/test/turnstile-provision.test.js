import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TURNSTILE_TARGETS,
  runTurnstileProvisioner,
  writeCredentialFiles
} from '../../../scripts/provision-turnstile.mjs';

const TOKEN = 'test-api-token';
const SITEKEY = 'test-site-key-never-log';
const SECRET = 'test-secret-never-log';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function success(result, resultInfo) {
  const pagination = resultInfo ?? (Array.isArray(result)
    ? { total_count: result.length, page: 1, per_page: 1000 }
    : undefined);
  return { success: true, result, ...(pagination ? { result_info: pagination } : {}) };
}

function capture() {
  let text = '';
  return {
    stream: { write(chunk) { text += String(chunk); } },
    value() { return text; }
  };
}

function secureTempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mj-turnstile-test-'));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('probe 200 performs only widget-list GET and reports permission yes without credentials', async () => {
  const calls = [];
  const output = capture();
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse(200, success([{ sitekey: SITEKEY, secret: SECRET }]));
  };

  const result = await runTurnstileProvisioner({
    argv: ['--mode', 'probe', '--environment', 'preview'],
    env: { CLOUDFLARE_API_TOKEN: TOKEN },
    fetchImpl,
    stdout: output.stream
  });

  assert.equal(result.permitted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.match(calls[0].url, /\/challenges\/widgets\?page=1&per_page=1000$/);
  assert.match(output.value(), /permission: yes \(preview\)/);
  assert.doesNotMatch(output.value(), new RegExp(`${SITEKEY}|${SECRET}`));
});

test('probe 403 reports permission no and fails without any mutation', async () => {
  const calls = [];
  const output = capture();
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse(403, { success: false, errors: [{ message: 'forbidden' }] });
  };

  await assert.rejects(
    runTurnstileProvisioner({
      argv: ['--mode', 'probe', '--environment', 'production'],
      env: { CLOUDFLARE_API_TOKEN: TOKEN },
      fetchImpl,
      stdout: output.stream
    }),
    /HTTP 403/
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.match(output.value(), /permission: no \(production, HTTP 403\)/);
});

test('provision creates the exact managed single-hostname widget and writes mode-0600 files', async (t) => {
  const target = TURNSTILE_TARGETS.preview;
  const outputDir = secureTempDir(t);
  const calls = [];
  const output = capture();
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init.method === 'GET') return jsonResponse(200, success([]));
    return jsonResponse(200, success({
      name: target.widgetName,
      mode: 'managed',
      domains: [target.hostname],
      sitekey: SITEKEY,
      secret: SECRET
    }));
  };

  const result = await runTurnstileProvisioner({
    argv: ['--mode', 'provision', '--environment', 'preview', '--output-dir', outputDir],
    env: { CLOUDFLARE_API_TOKEN: TOKEN },
    fetchImpl,
    stdout: output.stream
  });

  assert.equal(result.created, true);
  assert.deepEqual(calls.map((call) => call.init.method), ['GET', 'POST']);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    name: target.widgetName,
    domains: [target.hostname],
    mode: 'managed'
  });
  for (const [filename, value] of [['TURNSTILE_SITE_KEY', SITEKEY], ['TURNSTILE_SECRET_KEY', SECRET]]) {
    const file = path.join(outputDir, filename);
    assert.equal(readFileSync(file, 'utf8'), value);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
  }
  assert.doesNotMatch(output.value(), new RegExp(`${SITEKEY}|${SECRET}`));
});

test('provision reuses one exact valid widget and GETs its secret without creating', async (t) => {
  const target = TURNSTILE_TARGETS.production;
  const outputDir = secureTempDir(t);
  const calls = [];
  const listed = {
    name: target.widgetName,
    mode: 'managed',
    domains: [target.hostname],
    sitekey: SITEKEY
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return jsonResponse(200, success([listed]));
    return jsonResponse(200, success({ ...listed, secret: SECRET }));
  };

  const result = await runTurnstileProvisioner({
    argv: ['--mode', 'provision', '--environment', 'production', '--output-dir', outputDir],
    env: { CLOUDFLARE_API_TOKEN: TOKEN },
    fetchImpl,
    stdout: capture().stream
  });

  assert.equal(result.created, false);
  assert.deepEqual(calls.map((call) => call.init.method), ['GET', 'GET']);
  assert.match(calls[1].url, /\/challenges\/widgets\/test-site-key-never-log$/);
});

test('provision fails closed on existing widget mode or domain mismatch before secret GET', async (t) => {
  const target = TURNSTILE_TARGETS.preview;
  for (const mismatch of [
    { mode: 'invisible', domains: [target.hostname] },
    { mode: 'managed', domains: [target.hostname, 'other.example'] }
  ]) {
    const outputDir = secureTempDir(t);
    let calls = 0;
    await assert.rejects(
      runTurnstileProvisioner({
        argv: ['--mode', 'provision', '--environment', 'preview', '--output-dir', outputDir],
        env: { CLOUDFLARE_API_TOKEN: TOKEN },
        fetchImpl: async () => {
          calls++;
          return jsonResponse(200, success([{
            name: target.widgetName,
            sitekey: SITEKEY,
            ...mismatch
          }]));
        },
        stdout: capture().stream
      }),
      /mismatch/
    );
    assert.equal(calls, 1);
  }
});

test('widget listing fails closed on malformed or inconsistent pagination metadata', async () => {
  const malformed = [
    undefined,
    { page: 1, per_page: 1000 },
    { total_count: 0, per_page: 1000 },
    { total_count: 0, page: 1 },
    { total_count: '0', page: 1, per_page: 1000 },
    { total_count: 0, page: '1', per_page: 1000 },
    { total_count: 0, page: 1, per_page: '1000' },
    { total_count: 0.5, page: 1, per_page: 1000 },
    { total_count: 0, page: 1.5, per_page: 1000 },
    { total_count: 0, page: 1, per_page: 1000.5 },
    { total_count: -1, page: 1, per_page: 1000 },
    { total_count: 0, page: -1, per_page: 1000 },
    { total_count: 0, page: 1, per_page: -1 },
    { total_count: 0, page: 2, per_page: 1000 },
    { total_count: 0, page: 1, per_page: 50 },
    { total_count: 1, page: 1, per_page: 1000 }
  ];

  for (const resultInfo of malformed) {
    let calls = 0;
    await assert.rejects(
      runTurnstileProvisioner({
        argv: ['--mode', 'provision', '--environment', 'preview', '--output-dir', '/unused'],
        env: { CLOUDFLARE_API_TOKEN: TOKEN },
        fetchImpl: async () => {
          calls++;
          return jsonResponse(200, {
            success: true,
            result: [],
            ...(resultInfo === undefined ? {} : { result_info: resultInfo })
          });
        },
        stdout: capture().stream
      }),
      /pagination/
    );
    assert.equal(calls, 1);
  }
});

test('widget listing follows a full page and requires consistent metadata on the next page', async () => {
  const target = TURNSTILE_TARGETS.preview;
  const firstPage = Array.from({ length: 1000 }, (_, index) => ({
    name: `other-widget-${index}`,
    sitekey: `other-sitekey-${index}`
  }));
  const listed = {
    name: target.widgetName,
    mode: 'managed',
    domains: [target.hostname],
    sitekey: SITEKEY
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return jsonResponse(200, success(firstPage, { total_count: 1001, page: 1, per_page: 1000 }));
    }
    if (calls.length === 2) {
      return jsonResponse(200, success([listed], { total_count: 1001, page: 2, per_page: 1000 }));
    }
    return jsonResponse(200, success({ ...listed, secret: SECRET }));
  };
  const outputDir = mkdtempSync(path.join(os.tmpdir(), 'mj-turnstile-test-'));
  chmodSync(outputDir, 0o700);

  try {
    const result = await runTurnstileProvisioner({
      argv: ['--mode', 'provision', '--environment', 'preview', '--output-dir', outputDir],
      env: { CLOUDFLARE_API_TOKEN: TOKEN },
      fetchImpl,
      stdout: capture().stream
    });
    assert.equal(result.created, false);
    assert.match(calls[0].url, /page=1&per_page=1000$/);
    assert.match(calls[1].url, /page=2&per_page=1000$/);
    assert.equal(calls[2].init.method, 'GET');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('secure output rejects relative, permissive, symlinked, and existing-file targets', (t) => {
  assert.throws(() => writeCredentialFiles('relative/path', SITEKEY, SECRET), /absolute path/);

  const permissive = secureTempDir(t);
  chmodSync(permissive, 0o755);
  assert.throws(() => writeCredentialFiles(permissive, SITEKEY, SECRET), /group or other/);

  const root = secureTempDir(t);
  const real = path.join(root, 'real');
  const link = path.join(root, 'link');
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, link, 'dir');
  assert.throws(() => writeCredentialFiles(link, SITEKEY, SECRET), /symlinks/);

  writeFileSync(path.join(real, 'TURNSTILE_SITE_KEY'), 'existing', { mode: 0o600 });
  assert.throws(() => writeCredentialFiles(real, SITEKEY, SECRET), /Refusing to overwrite/);
  assert.throws(() => writeCredentialFiles(real, 'unsafe\nsitekey', SECRET), /unsafe shape/);
});

test('exclusive-create failure cleans up only files created by this invocation', (t) => {
  const outputDir = secureTempDir(t);
  const sitekeyPath = path.join(outputDir, 'TURNSTILE_SITE_KEY');
  const secretPath = path.join(outputDir, 'TURNSTILE_SECRET_KEY');
  let opens = 0;
  const racingOpen = (outputPath, flags, mode) => {
    opens++;
    if (opens === 2) writeFileSync(outputPath, 'race-created', { flag: 'wx', mode: 0o600 });
    return openSync(outputPath, flags, mode);
  };

  assert.throws(
    () => writeCredentialFiles(outputDir, SITEKEY, SECRET, { openFile: racingOpen }),
    /EEXIST/
  );
  assert.equal(existsSync(sitekeyPath), false);
  assert.equal(readFileSync(secretPath, 'utf8'), 'race-created');
});

test('invalid environment and arbitrary arguments fail before networking', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('unexpected'); };
  await assert.rejects(
    runTurnstileProvisioner({
      argv: ['--mode', 'probe', '--environment', 'staging'],
      env: { CLOUDFLARE_API_TOKEN: TOKEN },
      fetchImpl
    }),
    /exactly preview or production/
  );
  await assert.rejects(
    runTurnstileProvisioner({
      argv: ['--mode', 'probe', '--environment', 'preview', '--account-id', 'other'],
      env: { CLOUDFLARE_API_TOKEN: TOKEN },
      fetchImpl
    }),
    /Unsupported argument/
  );
  assert.equal(called, false);
});
