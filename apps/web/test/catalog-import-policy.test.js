import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function readRel(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// Tiny extractor for the top-level `on:` trigger list (mirrors the guard).
function extractOnTriggers(text) {
  const lines = text.split(/\r?\n/);
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^on:\s*$/.test(lines[i]) || /^on:\s*workflow_dispatch/.test(lines[i])) { idx = i; break; }
  }
  if (idx === -1) return null;
  const triggers = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^[A-Za-z_]+:/.test(line)) break;
    const m = line.match(/^  ([A-Za-z_]+):\s*$/);
    if (m) triggers.push(m[1]);
  }
  return triggers;
}

const WF_PATH = '.github/workflows/catalog-import.yml';
const WF = existsSync(path.join(REPO_ROOT, WF_PATH)) ? readRel(WF_PATH) : '';

test('catalog-import.yml exists', () => {
  assert.ok(WF, `${WF_PATH} must exist`);
});

test('catalog-import.yml is workflow_dispatch only', () => {
  const triggers = extractOnTriggers(WF);
  assert.deepEqual(triggers, ['workflow_dispatch']);
});

test('catalog-import.yml declares workflow-level contents: read', () => {
  assert.match(WF, /permissions:\s*\n\s+contents:\s*read/);
});

test('catalog-import.yml uses a set -euo pipefail fail-closed gate', () => {
  assert.match(WF, /set -euo pipefail/);
});

test('catalog-import.yml requires the preview confirmation + asset inputs', () => {
  for (const name of ['confirm_preview_only', 'assets_archive_url', 'assets_archive_sha256', 'execute_upload']) {
    assert.match(WF, new RegExp('^\\s+' + name + ':', 'm'), `missing input ${name}`);
  }
});

test('catalog-import.yml references the preview bucket literal only', () => {
  assert.match(WF, /mj-art-images-preview/);
  // "mj-art-images" not immediately followed by "-preview" is a production leak.
  assert.doesNotMatch(WF, /mj-art-images(?!-preview)/);
});

test('catalog-import.yml never targets production environment', () => {
  assert.doesNotMatch(WF, /--env\s+production/);
  assert.doesNotMatch(WF, /environment:\s*production/);
});

test('catalog-import.yml gates upload on inputs.execute_upload, never secrets in if:', () => {
  assert.match(WF, /inputs\.execute_upload/);
  const lines = WF.split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*if:/.test(line)) {
      assert.doesNotMatch(line, /secrets\./i, `secret in if: not allowed: ${line.trim()}`);
    }
  }
});

test('catalog-import.yml uses deployment credentials only, not read/admin secrets', () => {
  assert.match(WF, /\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/);
  assert.match(WF, /\$\{\{\s*secrets\.CLOUDFLARE_ACCOUNT_ID\s*\}\}/);
  for (const forbidden of ['ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET', 'CLOUDFLARE_R2_READ_TOKEN']) {
    assert.ok(!WF.includes(forbidden), `must not reference ${forbidden}`);
  }
});

test('check-operations-rules.mjs enforces catalog-import policy', () => {
  const guard = readRel('scripts/check-operations-rules.mjs');
  assert.match(guard, /catalog-import\.yml/);
  assert.match(guard, /mj-art-images\(\?!-preview\)/);
  assert.match(guard, /generate-catalog-derivatives\.mjs/);
  assert.match(guard, /import-catalog-preview\.mjs/);
});

test('import-catalog-preview.mjs is preview-only and dry-run default', () => {
  const s = readRel('scripts/import-catalog-preview.mjs');
  assert.match(s, /assertPreviewBucket/);
  assert.doesNotMatch(s, /mj-art-images(?!-preview)/);
  assert.match(s, /DRY-RUN/);
  assert.match(s, /--execute/);
});
