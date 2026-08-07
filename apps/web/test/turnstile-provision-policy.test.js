import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findInputsInRunBlocks, findSecretsInRunBlocks } from '../../../scripts/lib/catalog-import-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workflow = readFileSync(path.join(root, '.github/workflows/turnstile-provision.yml'), 'utf8');
const script = readFileSync(path.join(root, 'scripts/provision-turnstile.mjs'), 'utf8');
const wrangler = readFileSync(path.join(root, 'apps/web/wrangler.jsonc'), 'utf8');

test('Turnstile workflow is manual-only with minimal permissions and fixed concurrency', () => {
  assert.match(workflow, /^on:\s*\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule|workflow_call|workflow_run):/m);
  assert.match(workflow, /^permissions:\s*\n  contents: read$/m);
  assert.match(workflow, /group: turnstile-provision\s*$/m);
  assert.match(workflow, /cancel-in-progress: false/);
});

test('Turnstile workflow exposes only exact probe/provision and preview/production choices', () => {
  assert.match(workflow, /default: 'probe'/);
  assert.match(workflow, /options:\s*\n          - probe\s*\n          - provision/);
  assert.match(workflow, /options:\s*\n          - preview\s*\n          - production/);
  assert.match(workflow, /I-CONFIRM-TURNSTILE-PROVISION/);
  assert.match(workflow, /Fail closed unless dispatch inputs are exact/);
});

test('Turnstile workflow gates before credentials and never injects raw inputs or secrets into run blocks', () => {
  const gateStart = workflow.indexOf('- name: Fail closed unless dispatch inputs are exact');
  const jobsStart = workflow.indexOf('jobs:');
  assert.doesNotMatch(workflow.slice(jobsStart, gateStart), /\$\{\{\s*inputs\.environment\s*\}\}/);
  assert.doesNotMatch(workflow, /^\s+environment:\s*\$\{\{\s*inputs\.environment\s*\}\}\s*$/m);
  assert.ok(workflow.indexOf('Fail closed unless dispatch inputs are exact') < workflow.indexOf('secrets.CLOUDFLARE_API_TOKEN'));
  assert.deepEqual(findInputsInRunBlocks(workflow), []);
  assert.deepEqual(findSecretsInRunBlocks(workflow), []);
});

test('Turnstile workflow pins every action immutably', () => {
  const uses = [...workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)];
  assert.ok(uses.length >= 3);
  for (const match of uses) assert.match(match[1], /^[0-9a-f]{40}$/);
});

test('probe step cannot invoke Wrangler or stage credentials', () => {
  const probeStart = workflow.indexOf('- name: Probe Turnstile widget list permission');
  const probeEnd = workflow.indexOf('- name: Install pnpm for provision mode');
  const probe = workflow.slice(probeStart, probeEnd);
  assert.match(probe, /--mode probe/);
  assert.doesNotMatch(probe, /wrangler|secret put|TURNSTILE_OUTPUT_DIR/);
});

test('provision uses env-only targeting for the exact effective Workers and rejects compounded names', () => {
  assert.match(workflow, /wrangler_args=\(\)/);
  assert.match(workflow, /wrangler_args\+=\(--env preview\)/);
  assert.match(workflow, /wrangler_args\+=\(--env production\)/);
  assert.match(wrangler, /"production"\s*:\s*\{\s*\n\s*"name"\s*:\s*"mj-art"/);
  assert.match(wrangler, /"preview"\s*:\s*\{\s*\n\s*"name"\s*:\s*"mj-art-preview"/);
  assert.doesNotMatch(workflow, /--name\b/);
  assert.doesNotMatch(workflow, /mj-art-preview-preview|mj-art-production/);
});

test('provision masks, puts, verifies, and shreds all three Turnstile bindings', () => {
  assert.match(workflow, /::add-mask::%s/);
  assert.match(workflow, /secret put TURNSTILE_SITE_KEY "\$\{wrangler_args\[@\]\}"/);
  assert.match(workflow, /secret put TURNSTILE_SECRET_KEY "\$\{wrangler_args\[@\]\}"/);
  assert.match(workflow, /secret put TURNSTILE_WIDGET_FINGERPRINT "\$\{wrangler_args\[@\]\}"/);
  assert.match(workflow, /\['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_WIDGET_FINGERPRINT'\]/);
  assert.match(workflow, /wrangler secret list/);
  assert.match(workflow, /shred -u/);
  assert.doesNotMatch(workflow, /actions\/upload-artifact|gh secret|secret delete/i);
});

test('script pins the account, Worker, hostname, and widget name for exactly two environments', () => {
  assert.match(script, /908b6ebad9914f568db2f19a25dd319b/);
  for (const value of [
    'mj-art-preview',
    'mj-art-preview.drhasansabri.workers.dev',
    'mj-art-books-eoi-preview',
    "worker: 'mj-art'",
    'mj-art.drhasansabri.workers.dev',
    'mj-art-books-eoi-production'
  ]) assert.ok(script.includes(value), `missing fixed mapping ${value}`);
  assert.doesNotMatch(script, /CLOUDFLARE_ACCOUNT_ID|--account-id|--hostname|--widget-name|--worker/);
});

test('script has no remote delete, update, or secret-rotation path and matches widgets idempotently', () => {
  assert.doesNotMatch(script, /method:\s*['"](?:DELETE|PUT|PATCH)['"]|rotate_secret|secret delete/i);
  assert.match(script, /method: 'POST'/);
  assert.match(script, /widgets\.filter\(\(widget\) => widget\?\.name === target\.widgetName\)/);
  assert.match(script, /widget\.mode !== 'managed'/);
  assert.match(script, /widget\.domains\.length !== 1/);
});

test('script writes only protected, exclusive files and never prints credential fields', () => {
  assert.match(script, /O_EXCL/);
  assert.match(script, /O_NOFOLLOW/);
  assert.match(script, /fchmodSync\(fd, 0o600\)/);
  assert.match(script, /TURNSTILE_WIDGET_FINGERPRINT/);
  assert.match(script, /createHash\('sha256'\)/);
  assert.match(script, /Buffer\.from\(\[0\]\)/);
  assert.match(script, /must not contain symlinks/);
  assert.doesNotMatch(script, /stdout\.write\([^\n]*(?:sitekey|secret)/i);
});
