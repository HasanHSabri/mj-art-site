import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCIDENTAL_WORKERS,
  INTENDED_WORKERS,
  assertCleanupTarget,
  cleanupAccidentalWorker,
  confirmationPhraseFor,
  formatAuditSummary,
  validateGate,
  workerScriptUrl
} from '../../../scripts/cleanup-accidental-worker.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workflow = readFileSync(path.join(root, '.github/workflows/cleanup-accidental-workers.yml'), 'utf8');
const script = readFileSync(path.join(root, 'scripts/cleanup-accidental-worker.mjs'), 'utf8');
const accountId = '0123456789abcdef0123456789abcdef';

test('cleanup allowlist and target-specific phrases are exact', () => {
  assert.deepEqual([...ACCIDENTAL_WORKERS], ['mj-art-preview-preview', 'mj-art-production']);
  assert.deepEqual([...INTENDED_WORKERS], ['mj-art-preview', 'mj-art']);
  for (const target of ACCIDENTAL_WORKERS) {
    const phrase = `I-CONFIRM-WORKER-DELETE-${target}`;
    assert.equal(confirmationPhraseFor(target), phrase);
    assert.equal(validateGate(target, phrase), target);
    assert.throws(() => validateGate(target, `${phrase} `), /exact target-specific/);
  }
});

test('cleanup rejects intended, unallowlisted, encoded, slash, and whitespace targets', () => {
  for (const target of ['mj-art-preview', 'mj-art', 'other', 'mj-art-production/x', 'mj-art-production%2F', 'mj-art-production x']) {
    assert.throws(() => assertCleanupTarget(target), /fail closed/);
  }
});

test('Worker endpoint construction is exact and accepts only hard-coded names', () => {
  for (const worker of [...INTENDED_WORKERS, ...ACCIDENTAL_WORKERS]) {
    assert.equal(
      workerScriptUrl(accountId, worker),
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}`
    );
  }
  assert.throws(() => workerScriptUrl(accountId, 'mj-art-production%2Fother'), /hard-coded/);
  assert.throws(() => workerScriptUrl('', ACCIDENTAL_WORKERS[0]), /CLOUDFLARE_ACCOUNT_ID/);
});

test('cleanup performs one exact request per check with no force, retry, or fallback', async () => {
  const target = ACCIDENTAL_WORKERS[0];
  const statuses = [200, 200, 200, 204, 404, 200, 200];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { status: statuses[calls.length - 1], body: { cancel: async () => {} } };
  };
  const result = await cleanupAccidentalWorker({ target, accountId, token: 'test-token', fetchImpl });

  assert.deepEqual(calls.map((call) => call.options.method), ['GET', 'GET', 'GET', 'DELETE', 'GET', 'GET', 'GET']);
  assert.equal(calls.filter((call) => call.options.method === 'DELETE').length, 1);
  assert.equal(calls[3].url, workerScriptUrl(accountId, target));
  for (const call of calls) assert.doesNotMatch(call.url, /[?&]force=/);
  assert.equal(result.post[target], 404);
  for (const worker of INTENDED_WORKERS) assert.equal(result.post[worker], 200);

  const summary = formatAuditSummary(result);
  assert.match(summary, /Accidental Worker cleanup audit summary/);
  assert.doesNotMatch(summary, new RegExp(accountId));
  assert.doesNotMatch(summary, /test-token/);
});

test('cleanup aborts before DELETE unless pre-delete intended Workers and target are HTTP 200', async () => {
  const calls = [];
  await assert.rejects(
    cleanupAccidentalWorker({
      target: ACCIDENTAL_WORKERS[1],
      accountId,
      token: 'test-token',
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { status: calls.length === 2 ? 404 : 200, body: null };
      }
    }),
    /pre-delete intended Worker mj-art/
  );
  assert.doesNotMatch(calls.map((call) => call.options.method).join(','), /DELETE/);
});

test('cleanup requires credentials and never includes them in its audit output', async () => {
  await assert.rejects(
    cleanupAccidentalWorker({ target: ACCIDENTAL_WORKERS[0], accountId, token: '', fetchImpl: async () => {} }),
    /CLOUDFLARE_API_TOKEN is required/
  );
  assert.throws(() => workerScriptUrl(undefined, ACCIDENTAL_WORKERS[0]), /CLOUDFLARE_ACCOUNT_ID is required/);
});

test('cleanup fails unless target is 404 and both intended Workers remain 200 after DELETE', async () => {
  for (const statuses of [
    [200, 200, 200, 200, 200],
    [200, 200, 200, 200, 404, 404]
  ]) {
    let index = 0;
    await assert.rejects(
      cleanupAccidentalWorker({
        target: ACCIDENTAL_WORKERS[1],
        accountId,
        token: 'test-token',
        fetchImpl: async () => ({ status: statuses[index++], body: null })
      }),
      /post-delete/
    );
  }
});

test('workflow is temporary, dispatch-only, read-permissioned, and globally serialized', () => {
  assert.match(workflow, /^# TEMPORARY: remove immediately/m);
  assert.match(workflow, /^on:\s*\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule|workflow_call|workflow_run):/m);
  assert.match(workflow, /^permissions:\s*\n  contents: read$/m);
  assert.match(workflow, /group: accidental-worker-cleanup\s*$/m);
  assert.match(workflow, /cancel-in-progress: false/);
});

test('workflow has one choice input containing only the two accidental names', () => {
  const targetInput = workflow.slice(workflow.indexOf('      target:'), workflow.indexOf('      confirmation_phrase:'));
  const options = [...targetInput.matchAll(/^\s+- (\S+)\s*$/gm)].map((match) => match[1]);
  assert.equal((workflow.match(/type: choice/g) || []).length, 1);
  assert.deepEqual(options, ['mj-art-preview-preview', 'mj-art-production']);
  assert.match(workflow, /confirmation_phrase:[\s\S]*required: true[\s\S]*type: string/);
});

test('credentialed cleanup consumes only gate output and gate has no credentials', () => {
  const cleanupJob = workflow.slice(workflow.indexOf('\n  cleanup:'));
  const gateJob = workflow.slice(workflow.indexOf('\n  gate:'), workflow.indexOf('\n  cleanup:'));
  assert.doesNotMatch(cleanupJob, /inputs\./);
  assert.match(cleanupJob, /CLEANUP_TARGET: \$\{\{ needs\.gate\.outputs\.target \}\}/);
  assert.doesNotMatch(gateJob, /secrets\.|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/);
  assert.equal((workflow.match(/secrets\.CLOUDFLARE_API_TOKEN/g) || []).length, 1);
  assert.equal((workflow.match(/secrets\.CLOUDFLARE_ACCOUNT_ID/g) || []).length, 1);
});

test('script uses direct Workers Scripts API with protected exact DELETE semantics', () => {
  assert.match(script, /api\.cloudflare\.com\/client\/v4/);
  assert.match(script, /method,\s*\n\s*headers:/);
  assert.match(script, /'DELETE'/);
  assert.doesNotMatch(script, /wrangler|\bforce\b|setTimeout|retry/i);
  assert.match(script, /response\.body\.cancel\(\)/);
});
