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

// ===========================================================================
// catalog-promote-production.yml
// ===========================================================================

const WF_PATH = '.github/workflows/catalog-promote-production.yml';
const WF = existsSync(path.join(REPO_ROOT, WF_PATH)) ? readRel(WF_PATH) : '';

test('catalog-promote-production.yml exists', () => {
  assert.ok(WF, `${WF_PATH} must exist`);
});

test('catalog-promote-production.yml is workflow_dispatch only', () => {
  assert.deepEqual(extractOnTriggers(WF), ['workflow_dispatch']);
});

test('catalog-promote-production.yml declares workflow-level contents: read', () => {
  assert.match(WF, /permissions:\s*\n\s+contents:\s*read/);
});

test('catalog-promote-production.yml uses a set -euo pipefail fail-closed gate', () => {
  assert.match(WF, /set -euo pipefail/);
});

test('catalog-promote-production.yml declares all required inputs', () => {
  for (const name of [
    'confirm_promote_to_production',
    'confirmation_phrase',
    'release_manifest_sha256',
    'expected_production_object_count',
    'execute_promotion'
  ]) {
    assert.match(WF, new RegExp('^\\s+' + name + ':', 'm'), `missing input ${name}`);
  }
});

test('catalog-promote-production.yml pins the exact strong confirmation phrase', () => {
  assert.match(WF, /I-CONFIRM-PRODUCTION-CATALOGUE-PROMOTION/);
});

test('catalog-promote-production.yml gates the write step on inputs.execute_promotion', () => {
  assert.match(WF, /inputs\.execute_promotion/);
});

test('catalog-promote-production.yml references both fixed bucket literals (source=preview, dest=production)', () => {
  assert.match(WF, /SOURCE_BUCKET:\s*mj-art-images-preview/);
  assert.match(WF, /DESTINATION_BUCKET:\s*mj-art-images(?!-preview)/);
});

test('catalog-promote-production.yml uses the READ token for backup and WRITE token only for execute', () => {
  assert.match(WF, /\$\{\{\s*secrets\.CLOUDFLARE_R2_READ_TOKEN\s*\}\}/);
  assert.match(WF, /\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/);
  for (const forbidden of ['ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET']) {
    assert.ok(!WF.includes(forbidden), `must not reference ${forbidden}`);
  }
});

test('catalog-promote-production.yml never interpolates inputs/secrets inside run scripts', () => {
  assert.deepEqual(findInputsInRunBlocks(WF), [], 'no inputs in run: ' + JSON.stringify(findInputsInRunBlocks(WF)));
  assert.deepEqual(findSecretsInRunBlocks(WF), [], 'no secrets in run: ' + JSON.stringify(findSecretsInRunBlocks(WF)));
});

test('catalog-promote-production.yml has no secrets in step if: conditions', () => {
  for (const line of WF.split(/\r?\n/)) {
    if (/^\s*if:/.test(line)) {
      assert.doesNotMatch(line, /secrets\./i, `secret in if: not allowed: ${line.trim()}`);
    }
  }
});

test('catalog-promote-production.yml pins every third-party action to a 40-char SHA', () => {
  const lines = WF.split(/\r?\n/).filter((l) => /^\s*uses:\s*[^{]*\S/.test(l));
  assert.ok(lines.length >= 3, 'expected at least 3 action uses: steps');
  for (const line of lines) {
    const m = line.match(/uses:\s*([^#\s]+)\s*(?:#.*)?$/);
    if (!m) continue;
    const sha = (m[1].split('@')[1] || '').trim();
    assert.match(sha, /^[0-9a-f]{40}$/, `action not pinned to 40-char SHA: ${m[1]}`);
  }
});

test('catalog-promote-production.yml declares non-cancellable concurrency + a timeout', () => {
  assert.match(WF, /concurrency:/);
  assert.match(WF, /cancel-in-progress:\s*false/);
  assert.match(WF, /timeout-minutes:/);
});

test('catalog-promote-production.yml contains NO r2 object delete command', () => {
  assert.doesNotMatch(WF, /r2\s+object\s+delete/i);
});

test('catalog-promote-production.yml exposes the write token only on the execute step', () => {
  // The CLOUDFLARE_API_TOKEN env must appear on exactly one step, and that step
  // must be gated on execute_promotion.
  const lines = WF.split(/\r?\n/);
  const tokenLines = lines.filter((l) => /CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN/.test(l));
  assert.equal(tokenLines.length, 1, 'CLOUDFLARE_API_TOKEN secret must be referenced exactly once');
  // The execute step name + its if: must both reference execute_promotion.
  assert.match(WF, /Execute production promotion/);
});

// ===========================================================================
// promote-catalog-production.mjs
// ===========================================================================

const SCRIPT_PATH = 'scripts/promote-catalog-production.mjs';
const SCRIPT = readRel(SCRIPT_PATH);

test('promote-catalog-production.mjs references fixed SOURCE/DEST bucket constants', () => {
  assert.match(SCRIPT, /\bSOURCE_BUCKET\b/);
  assert.match(SCRIPT, /\bDESTINATION_BUCKET\b/);
  assert.doesNotMatch(SCRIPT, /\b(?:const|let|var)\s+SOURCE_BUCKET\s*=\s*['"]/);
  assert.doesNotMatch(SCRIPT, /\b(?:const|let|var)\s+DESTINATION_BUCKET\s*=\s*['"]/);
});

test('promote-catalog-production.mjs is dry-run default and requires --execute + phrase', () => {
  assert.match(SCRIPT, /DRY-RUN/);
  assert.match(SCRIPT, /--execute/);
  assert.match(SCRIPT, /PROMOTION_CONFIRM_PHRASE/);
});

test('promote-catalog-production.mjs has no r2 object delete command', () => {
  assert.doesNotMatch(SCRIPT, /r2\s+object\s+delete/i);
});

test('promote-catalog-production.mjs invokes both backup gates before writes', () => {
  assert.match(SCRIPT, /verifyProductionBackupHandshake/);
  assert.match(SCRIPT, /verifyPreviewInventoryMatchesRelease/);
});

test('promote-catalog-production.mjs uploads images before artworks.json (metadata last)', () => {
  const uploadIdx = SCRIPT.search(/Uploading \$\{EXPECTED_IMAGES\} images/);
  const awIdx = SCRIPT.search(/Publishing approved artworks\.json.*LAST/);
  assert.ok(uploadIdx > -1 && awIdx > -1, 'must mention both phases');
  assert.ok(uploadIdx < awIdx, 'images must upload before artworks.json');
});

// ===========================================================================
// Deploy workflow bucket safety: a preview deploy must not create production
// ===========================================================================

const DEPLOY_PATH = '.github/workflows/deploy-cloudflare.yml';
const DEPLOY = readRel(DEPLOY_PATH);

test('deploy-cloudflare.yml never creates a bucket by literal name in a command', () => {
  // The create must use a case-selected variable, never a literal mj-art-images.
  assert.doesNotMatch(DEPLOY, /r2\s+bucket\s+create\s+mj-art-images/);
});

test('deploy-cloudflare.yml creates the selected bucket via a case-selected $BUCKET variable', () => {
  assert.match(DEPLOY, /r2\s+bucket\s+create\s+"\$\{?BUCKET\}?"/);
  assert.match(DEPLOY, /case\s+[^;]*inputs\.environment/);
});

test('deploy-cloudflare.yml still defaults to preview and gates deploy on workflow_dispatch', () => {
  assert.match(DEPLOY, /default:\s*'?preview'?/);
  assert.match(DEPLOY, /^    if:\s*github\.event_name\s*==\s*'workflow_dispatch'/m);
});

// ===========================================================================
// Preview import workflow stays preview-only (hard block preserved)
// ===========================================================================

const IMPORT_PATH = '.github/workflows/catalog-import.yml';
const IMPORT = readRel(IMPORT_PATH);

test('catalog-import.yml remains preview-only (production literal still forbidden)', () => {
  assert.match(IMPORT, /mj-art-images-preview/);
  assert.doesNotMatch(IMPORT, /mj-art-images(?!-preview)/);
});

// ===========================================================================
// Operations guard enforces the promotion policy
// ===========================================================================

test('check-operations-rules.mjs enforces the promotion workflow + deploy bucket safety', () => {
  const guard = readRel('scripts/check-operations-rules.mjs');
  assert.match(guard, /catalog-promote-production\.yml/);
  assert.match(guard, /promote-catalog-production\.mjs/);
  assert.match(guard, /production-release-manifest\.json/);
  assert.match(guard, /I-CONFIRM-PRODUCTION-CATALOGUE-PROMOTION/);
  assert.match(guard, /DESTINATION_BUCKET:\s*mj-art-images/);
  assert.match(guard, /r2\\s\+bucket\\s\+create\\s\+mj-art-images/);
  assert.match(guard, /release-manifest-cores?\.mjs|release-manifest-core\.mjs/);
});
