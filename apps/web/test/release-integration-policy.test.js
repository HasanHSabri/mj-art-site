import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const deploy = readFileSync(path.join(root, '.github/workflows/deploy-cloudflare.yml'), 'utf8');
const turnstile = readFileSync(path.join(root, '.github/workflows/turnstile-provision.yml'), 'utf8');
const wrangler = readFileSync(path.join(root, 'apps/web/wrangler.jsonc'), 'utf8');

test('Wrangler environments resolve to only the intended Worker names', () => {
  assert.match(wrangler, /"production"\s*:\s*\{\s*\n\s*"name"\s*:\s*"mj-art"/);
  assert.match(wrangler, /"preview"\s*:\s*\{\s*\n\s*"name"\s*:\s*"mj-art-preview"/);
  assert.doesNotMatch(`${wrangler}\n${turnstile}`, /mj-art-preview-preview|mj-art-production/);
  assert.doesNotMatch(turnstile, /--name\b/);
});

test('local, preview, and production rate limits have distinct namespaces and key markers', () => {
  const namespaceIds = [...wrangler.matchAll(/"namespace_id"\s*:\s*"(\d+)"/g)].map((match) => match[1]);
  assert.equal(namespaceIds.length, 3);
  assert.equal(new Set(namespaceIds).size, 3);

  const markers = [...wrangler.matchAll(/"BOOK_EOI_ENVIRONMENT"\s*:\s*"(local|preview|production)"/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(markers, ['local', 'preview', 'production']);
});

test('deploy workflow serializes without cancelling and binds environment only from the gate output', () => {
  assert.match(deploy, /concurrency:\s*\n\s*group:\s*deploy-cloudflare\s*\n\s*cancel-in-progress:\s*false/);
  assert.match(deploy, /gate:[\s\S]*outputs:\s*\n\s*environment:\s*\$\{\{\s*steps\.validate\.outputs\.environment\s*\}\}/);
  assert.match(deploy, /case "\$\{REQUESTED_ENVIRONMENT\}" in\s*\n\s*preview\|production\)/);
  assert.match(deploy, /needs:\s*\[check, gate\]/);
  assert.match(deploy, /^\s*environment:\s*\$\{\{\s*needs\.gate\.outputs\.environment\s*\}\}\s*$/m);

  const deployJob = deploy.slice(deploy.indexOf('  deploy:'));
  assert.doesNotMatch(deployJob, /\$\{\{\s*inputs\.environment\s*\}\}/);
});

test('pushes remain checks-only and manual dispatch is the only deploy path', () => {
  assert.match(deploy, /push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.match(deploy, /gate:\s*\n\s*if:\s*github\.event_name == 'workflow_dispatch'/);
  assert.match(deploy, /deploy:[\s\S]*if:\s*github\.event_name == 'workflow_dispatch'/);

  const commands = [...deploy.matchAll(/pnpm exec wrangler deploy ([^\n]+)/g)].map((match) => match[1]);
  assert.equal(commands.filter((command) => command.includes('--dry-run')).length, 1);
  assert.equal(commands.filter((command) => !command.includes('--dry-run')).length, 1);
  assert.doesNotMatch(deploy, /wrangler (?:rollback|versions deploy|deployments status)|controlled rollout/i);
});

test('all read-only preflights precede every deploy mutation', () => {
  const preflight = deploy.indexOf('- name: Run mutation-free Worker and Books EOI preflight');
  const bucket = deploy.indexOf('- name: Ensure selected-environment storage exists');
  const secretPut = deploy.indexOf('wrangler secret put ADMIN_PASSWORD');
  const liveDeploy = deploy.indexOf('pnpm exec wrangler deploy "${deploy_args[@]}"');
  assert.ok(preflight > -1 && preflight < bucket && bucket < secretPut && secretPut < liveDeploy);

  const preflightBlock = deploy.slice(preflight, bucket);
  assert.match(preflightBlock, /wrangler secret list --env "\$\{TARGET_ENVIRONMENT\}" --format json/);
  assert.match(preflightBlock, /\['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_WIDGET_FINGERPRINT'\]/);
  assert.match(preflightBlock, /wrangler deploy --env "\$\{TARGET_ENVIRONMENT\}" --dry-run/);
  assert.match(preflightBlock, /BOOK_EOI_RATE_LIMITER/);
  assert.match(preflightBlock, /BOOK_EOI_ENVIRONMENT/);
  assert.match(preflightBlock, /check-book-eoi-schema\.mjs --live/);
  assert.doesNotMatch(preflightBlock, /secret put|r2 bucket create|wrangler deploy "\$\{deploy_args/);
});
