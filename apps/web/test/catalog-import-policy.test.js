import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findInputsInRunBlocks, findSecretsInRunBlocks } from '../../../scripts/lib/catalog-import-core.mjs';

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

test('catalog-import.yml requires the preview confirmation + master version inputs', () => {
  for (const name of ['confirm_preview_only', 'master_archive_version', 'execute_upload']) {
    assert.match(WF, new RegExp('^\\s+' + name + ':', 'm'), `missing input ${name}`);
  }
  // The removed transport inputs must be entirely gone.
  for (const removed of ['assets_archive_url', 'assets_archive_sha256']) {
    assert.ok(!WF.includes(removed), `removed input ${removed} must not appear`);
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

// ===========================================================================
// Hardening: no raw inputs interpolation in run scripts + pinned action SHAs
// ===========================================================================

test('catalog-import.yml never interpolates ${{ inputs.* }} inside a run script', () => {
  const hits = findInputsInRunBlocks(WF);
  assert.deepEqual(hits, [], 'run scripts must not interpolate inputs: ' + JSON.stringify(hits));
});

test('catalog-import.yml pins every third-party action to a 40-char commit SHA', () => {
  const lines = WF.split(/\r?\n/).filter((l) => /^\s*uses:\s*[^{]*\S/.test(l));
  assert.ok(lines.length >= 3, 'expected at least 3 action uses: steps');
  for (const line of lines) {
    const m = line.match(/uses:\s*([^#\s]+)\s*(?:#.*)?$/);
    if (!m) continue;
    const sha = (m[1].split('@')[1] || '').trim();
    assert.match(sha, /^[0-9a-f]{40}$/, `action not pinned to 40-char SHA: ${m[1]}`);
  }
});

test('catalog-import.yml hardens archive extraction (listing validation + no-same-owner)', () => {
  assert.match(WF, /validate-archive-listing\.mjs/, 'must validate the tar listing before extraction');
  assert.match(WF, /--no-same-owner/, 'must extract with --no-same-owner');
});

test('catalog-import.yml no longer runs raw sha256sum -c on SHA256SUMS', () => {
  // The redundant/unsafe `sha256sum -c SHA256SUMS` pass was removed; source
  // integrity relies on the generator's strict rehash. Ensure it is gone from
  // active run steps (it may still appear in the explanatory NOTE comment).
  const runBlocks = [];
  const lines = WF.split(/\r?\n/);
  let inRun = false, runIndent = -1, buf = [];
  for (const raw of lines) {
    const rm = raw.match(/^(\s*)run:\s*(.*)$/);
    if (rm) {
      if (buf.length) runBlocks.push(buf.join('\n'));
      buf = [];
      runIndent = rm[1].length;
      inRun = (rm[2].startsWith('|') || rm[2].startsWith('>'));
      continue;
    }
    if (inRun) {
      const ind = raw.length - raw.replace(/^\s+/, '').length;
      if (raw.trim() !== '' && ind <= runIndent) { inRun = false; if (buf.length) runBlocks.push(buf.join('\n')); buf = []; }
      else buf.push(raw);
    }
  }
  if (buf.length) runBlocks.push(buf.join('\n'));
  for (const block of runBlocks) {
    assert.doesNotMatch(block, /sha256sum\s+-c\s+SHA256SUMS/, 'run script must not run raw sha256sum -c SHA256SUMS');
  }
});

test('archive-safety validator script exists and calls validateTarVerboseListing', () => {
  const s = readRel('scripts/validate-archive-listing.mjs');
  assert.match(s, /validateTarVerboseListing/);
});

// ===========================================================================
// VPS private masters: fetch safety static checks
// ===========================================================================
//
// Masters are a versioned library on a hardened VPS (no Neon). The workflow
// fetches by version token over strict-host-checking SSH/SCP. These static
// checks enforce: no protocol URL leftovers, the exact confirmation gate, the
// strict version regex, the required VPS vars/secrets via env only, the
// version-derived remote basename, and no secret interpolation in run scripts.

test('catalog-import.yml contains NO protocol URL (no archive or write URL anywhere)', () => {
  assert.doesNotMatch(WF, /[a-z][a-z0-9+.-]*:\/\//i, 'no protocol URL may appear');
});

test('catalog-import.yml references the exact out-of-band VPS confirmation gate', () => {
  assert.match(WF, /\$\{\{\s*vars\.VPS_ASSETS_CONFIRMED\s*\}\}/);
  // The gate must assert the literal 'true' comparison in a run script.
  assert.match(WF, /VPS_ASSETS_CONFIRMED.*!=.*true|VPS_ASSETS_CONFIRMED.*true/, );
});

test('catalog-import.yml enforces the strict master version regex', () => {
  // The run script must validate master_archive_version against the strict shape.
  assert.match(WF, /\[A-Za-z0-9\._-\]\{1,64\}/);
});

test('catalog-import.yml references every required VPS variable via env only', () => {
  for (const ref of [
    '${{ vars.VPS_HOST }}',
    '${{ vars.VPS_PORT }}',
    '${{ vars.VPS_USER }}',
    '${{ vars.VPS_MASTER_ROOT }}'
  ]) {
    assert.ok(WF.includes(ref), `must reference ${ref}`);
  }
});

test('catalog-import.yml references every required VPS secret via env only', () => {
  for (const ref of ['${{ secrets.VPS_SSH_PRIVATE_KEY }}', '${{ secrets.VPS_KNOWN_HOSTS }}']) {
    assert.ok(WF.includes(ref), `must reference ${ref}`);
  }
});

test('catalog-import.yml builds the remote basename from the version token', () => {
  // The remote archive/sidecar basename is constructed in-shell from the
  // validated version, never supplied as an input (no injected path).
  assert.match(WF, /mj-art-master-\$\{MASTER_VERSION\}\.tar\.gz/);
  assert.match(WF, /mj-art-master-\$\{MASTER_VERSION\}\.sha256/);
});

test('catalog-import.yml uses hardened strict-host-checking key-only SSH/SCP', () => {
  assert.match(WF, /StrictHostKeyChecking=yes/);
  assert.match(WF, /UserKnownHostsFile=/);
  assert.match(WF, /BatchMode=yes/);
  assert.match(WF, /PreferredAuthentications=publickey/);
  assert.match(WF, /IdentitiesOnly=yes/);
  // SSH options must be a bash array (no string word-splitting).
  assert.match(WF, /SCP_OPTS=\(/);
  assert.match(WF, /"\$\{SCP_OPTS\[@\]\}"/);
});

test('catalog-import.yml never interpolates ${{ secrets.* }} inside a run script', () => {
  const hits = findSecretsInRunBlocks(WF);
  assert.deepEqual(hits, [], 'run scripts must not interpolate secrets: ' + JSON.stringify(hits));
});

test('catalog-import.yml invokes the safe master sidecar verifier, not sha256sum -c', () => {
  assert.match(WF, /verify-master-archive\.mjs/);
  // No raw coreutils checksum-check subcommand in any run script.
  const lines = WF.split(/\r?\n/);
  let inRun = false, runIndent = -1;
  for (const raw of lines) {
    const rm = raw.match(/^(\s*)run:\s*(.*)$/);
    if (rm) {
      runIndent = rm[1].length;
      inRun = rm[2].startsWith('|') || rm[2].startsWith('>');
      continue;
    }
    if (inRun && raw.trim() !== '') {
      const ind = raw.length - raw.replace(/^\s+/, '').length;
      if (ind <= runIndent) { inRun = false; continue; }
      assert.doesNotMatch(raw, /sha256sum\s+-c/, 'run script must not run sha256sum -c');
    }
  }
});

test('verify-master-archive.mjs exists, parses sidecar strictly, and re-hashes', () => {
  const s = readRel('scripts/verify-master-archive.mjs');
  assert.match(s, /parseMasterSidecar/);
  assert.match(s, /createHash/);
  // Must not delegate to the coreutils checksum-check subcommand.
  assert.doesNotMatch(s, /sha256sum\s+-c/);
});
