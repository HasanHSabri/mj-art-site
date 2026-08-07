#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ACCIDENTAL_WORKERS = Object.freeze([
  'mj-art-preview-preview',
  'mj-art-production'
]);
export const INTENDED_WORKERS = Object.freeze(['mj-art-preview', 'mj-art']);

const API_BASE = 'https://api.cloudflare.com/client/v4';
const KNOWN_WORKERS = new Set([...ACCIDENTAL_WORKERS, ...INTENDED_WORKERS]);

function fail(message) {
  throw new Error(`fail closed: ${message}`);
}

export function confirmationPhraseFor(target) {
  assertCleanupTarget(target);
  return `I-CONFIRM-WORKER-DELETE-${target}`;
}

export function assertCleanupTarget(target) {
  if (typeof target !== 'string' || !target) fail('cleanup target is required');
  if (target === 'mj-art-preview' || target === 'mj-art') {
    fail('intended Worker is never a cleanup target');
  }
  if (/[\\/%\s]/.test(target) || encodeURIComponent(target) !== target) {
    fail('cleanup target must not contain slash, encoding, or whitespace');
  }
  if (!ACCIDENTAL_WORKERS.includes(target)) fail('cleanup target is not allowlisted');
  return target;
}

export function validateGate(target, confirmation) {
  const safeTarget = assertCleanupTarget(target);
  if (confirmation !== confirmationPhraseFor(safeTarget)) {
    fail('exact target-specific confirmation phrase is required');
  }
  return safeTarget;
}

export function workerScriptUrl(accountId, worker) {
  if (typeof accountId !== 'string' || !/^[0-9a-f]{32}$/.test(accountId)) {
    fail('CLOUDFLARE_ACCOUNT_ID is required and must be a lowercase 32-character hex identifier');
  }
  if (!KNOWN_WORKERS.has(worker)) fail('Worker endpoint name is not hard-coded');
  return `${API_BASE}/accounts/${accountId}/workers/scripts/${worker}`;
}

async function requestStatus(fetchImpl, url, method, token) {
  const response = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error'
  });
  if (response.body) await response.body.cancel();
  return response.status;
}

function requireStatus(status, expected, label) {
  if (status !== expected) fail(`${label} returned HTTP ${status}; required HTTP ${expected}`);
}

export async function cleanupAccidentalWorker({
  target,
  accountId,
  token,
  fetchImpl = globalThis.fetch
}) {
  const safeTarget = assertCleanupTarget(target);
  if (typeof token !== 'string' || !token.trim()) fail('CLOUDFLARE_API_TOKEN is required');
  if (typeof fetchImpl !== 'function') fail('HTTP client is unavailable');

  const urls = new Map(
    [...INTENDED_WORKERS, safeTarget].map((worker) => [worker, workerScriptUrl(accountId, worker)])
  );
  const pre = {};
  for (const worker of INTENDED_WORKERS) {
    pre[worker] = await requestStatus(fetchImpl, urls.get(worker), 'GET', token);
    requireStatus(pre[worker], 200, `pre-delete intended Worker ${worker}`);
  }
  pre[safeTarget] = await requestStatus(fetchImpl, urls.get(safeTarget), 'GET', token);
  requireStatus(pre[safeTarget], 200, `pre-delete cleanup target ${safeTarget}`);

  const deleteStatus = await requestStatus(fetchImpl, urls.get(safeTarget), 'DELETE', token);
  if (deleteStatus < 200 || deleteStatus >= 300) {
    fail(`exact-target delete returned HTTP ${deleteStatus}; required HTTP 2xx`);
  }

  const post = {};
  post[safeTarget] = await requestStatus(fetchImpl, urls.get(safeTarget), 'GET', token);
  requireStatus(post[safeTarget], 404, `post-delete cleanup target ${safeTarget}`);
  for (const worker of INTENDED_WORKERS) {
    post[worker] = await requestStatus(fetchImpl, urls.get(worker), 'GET', token);
    requireStatus(post[worker], 200, `post-delete intended Worker ${worker}`);
  }

  return { target: safeTarget, pre, deleteStatus, post };
}

export function formatAuditSummary(result) {
  return [
    'Accidental Worker cleanup audit summary',
    `target=${result.target}`,
    ...INTENDED_WORKERS.map((worker) => `pre intended ${worker}=HTTP ${result.pre[worker]}`),
    `pre target ${result.target}=HTTP ${result.pre[result.target]}`,
    `delete target ${result.target}=HTTP ${result.deleteStatus}`,
    `post target ${result.target}=HTTP ${result.post[result.target]}`,
    ...INTENDED_WORKERS.map((worker) => `post intended ${worker}=HTTP ${result.post[worker]}`)
  ].join('\n');
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--gate', '--execute'].includes(mode)) {
    fail('usage is --gate or --execute with values supplied only through environment variables');
  }

  if (mode === '--gate') {
    const target = validateGate(process.env.TARGET_INPUT, process.env.CONFIRMATION_INPUT);
    if (!process.env.GITHUB_OUTPUT) fail('GITHUB_OUTPUT is required for the credential-free gate');
    appendFileSync(process.env.GITHUB_OUTPUT, `target=${target}\n`, { encoding: 'utf8' });
    process.stdout.write(`Credential-free cleanup gate passed for ${target}.\n`);
    return;
  }

  const result = await cleanupAccidentalWorker({
    target: process.env.CLEANUP_TARGET,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN
  });
  process.stdout.write(`${formatAuditSummary(result)}\n`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
