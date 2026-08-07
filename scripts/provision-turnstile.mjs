#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID = '908b6ebad9914f568db2f19a25dd319b';
const OUTPUT_FILES = Object.freeze({
  sitekey: 'TURNSTILE_SITE_KEY',
  secret: 'TURNSTILE_SECRET_KEY'
});

export const TURNSTILE_TARGETS = Object.freeze({
  preview: Object.freeze({
    accountId: ACCOUNT_ID,
    worker: 'mj-art-preview',
    hostname: 'mj-art-preview.drhasansabri.workers.dev',
    widgetName: 'mj-art-books-eoi-preview'
  }),
  production: Object.freeze({
    accountId: ACCOUNT_ID,
    worker: 'mj-art',
    hostname: 'mj-art.drhasansabri.workers.dev',
    widgetName: 'mj-art-books-eoi-production'
  })
});

class CloudflareApiError extends Error {
  constructor(status, operation) {
    super(`Cloudflare ${operation} request failed (HTTP ${status})`);
    this.name = 'CloudflareApiError';
    this.status = status;
  }
}

function parseArgs(argv) {
  const allowed = new Set(['mode', 'environment', 'output-dir']);
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--') || !allowed.has(flag.slice(2))) {
      throw new Error(`Unsupported argument: ${flag}`);
    }
    const value = argv[++i];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (Object.hasOwn(parsed, flag.slice(2))) {
      throw new Error(`Duplicate argument: ${flag}`);
    }
    parsed[flag.slice(2)] = value;
  }
  return parsed;
}

async function apiRequest(fetchImpl, token, url, { method = 'GET', body } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  if (!response.ok) {
    throw new CloudflareApiError(response.status, method === 'GET' ? 'read' : 'create');
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Cloudflare returned an invalid JSON response');
  }
  if (payload?.success !== true) {
    throw new Error('Cloudflare returned an unsuccessful API response');
  }
  return payload;
}

async function listWidgets(fetchImpl, token, target) {
  const widgets = [];
  let page = 1;
  for (;;) {
    const url = new URL(`${API_ROOT}/accounts/${target.accountId}/challenges/widgets`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '1000');
    const payload = await apiRequest(fetchImpl, token, url, { method: 'GET' });
    if (!Array.isArray(payload.result)) {
      throw new Error('Cloudflare widget list response is missing its result array');
    }
    widgets.push(...payload.result);
    const total = payload.result_info?.total_count;
    if (!Number.isInteger(total) || widgets.length >= total || payload.result.length === 0) {
      return widgets;
    }
    page++;
  }
}

function validateWidget(widget, target) {
  if (!widget || widget.name !== target.widgetName) {
    throw new Error('Cloudflare returned a widget with an unexpected name');
  }
  if (widget.mode !== 'managed') {
    throw new Error(`Existing Turnstile widget mode mismatch for ${target.widgetName}: expected managed`);
  }
  if (!Array.isArray(widget.domains) || widget.domains.length !== 1 || widget.domains[0] !== target.hostname) {
    throw new Error(`Existing Turnstile widget domain mismatch for ${target.widgetName}: expected the single mapped hostname`);
  }
}

function assertSecureOutputDirectory(outputDir) {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || outputDir.includes('\0')) {
    throw new Error('Provision output directory must be an absolute path');
  }
  const rawParts = outputDir.slice(path.parse(outputDir).root.length).split(path.sep);
  if (rawParts.some((part) => part === '.' || part === '..' || part === '')) {
    throw new Error('Provision output directory must be normalized without traversal');
  }

  const resolved = path.resolve(outputDir);
  if (resolved === path.parse(resolved).root) {
    throw new Error('Provision output directory must not be the filesystem root');
  }

  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink()) {
      throw new Error('Provision output directory must not contain symlinks');
    }
    if (!entry.isDirectory()) {
      throw new Error('Provision output path must contain directories only');
    }
  }

  if (realpathSync(resolved) !== resolved) {
    throw new Error('Provision output directory must resolve to itself');
  }
  const stat = lstatSync(resolved);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Provision output directory must be owned by the current user');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('Provision output directory must not be accessible by group or other users');
  }
  return resolved;
}

export function writeCredentialFiles(outputDir, sitekey, secret) {
  if (typeof sitekey !== 'string' || sitekey.length === 0 || typeof secret !== 'string' || secret.length === 0) {
    throw new Error('Cloudflare did not return both required Turnstile credentials');
  }
  if (!/^[A-Za-z0-9_-]{10,256}$/.test(sitekey) || !/^[A-Za-z0-9_-]{10,256}$/.test(secret)) {
    throw new Error('Cloudflare returned a Turnstile credential with an unsafe shape');
  }
  const safeDir = assertSecureOutputDirectory(outputDir);
  const paths = [path.join(safeDir, OUTPUT_FILES.sitekey), path.join(safeDir, OUTPUT_FILES.secret)];

  for (const outputPath of paths) {
    try {
      lstatSync(outputPath);
      throw new Error(`Refusing to overwrite existing output file: ${path.basename(outputPath)}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const fds = [];
  try {
    for (const outputPath of paths) {
      const fd = openSync(
        outputPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      fchmodSync(fd, 0o600);
      fds.push(fd);
    }
    writeSync(fds[0], sitekey, null, 'utf8');
    writeSync(fds[1], secret, null, 'utf8');
    for (const fd of fds) fsyncSync(fd);
  } catch (error) {
    for (const fd of fds) {
      try { closeSync(fd); } catch {}
    }
    for (const outputPath of paths) {
      try { unlinkSync(outputPath); } catch {}
    }
    throw error;
  }
  for (const fd of fds) closeSync(fd);
  for (const outputPath of paths) chmodSync(outputPath, 0o600);
}

export async function runTurnstileProvisioner({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = process.stdout
} = {}) {
  const args = parseArgs(argv);
  if (args.mode !== 'probe' && args.mode !== 'provision') {
    throw new Error('Mode must be exactly probe or provision');
  }
  const target = TURNSTILE_TARGETS[args.environment];
  if (!target) {
    throw new Error('Environment must be exactly preview or production');
  }
  if (args.mode === 'probe' && args['output-dir'] !== undefined) {
    throw new Error('Probe mode does not accept an output directory');
  }
  if (args.mode === 'provision' && args['output-dir'] === undefined) {
    throw new Error('Provision mode requires an operator-supplied --output-dir');
  }
  const token = env.CLOUDFLARE_API_TOKEN;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('CLOUDFLARE_API_TOKEN is missing or empty');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch implementation is unavailable');
  }

  let widgets;
  try {
    widgets = await listWidgets(fetchImpl, token, target);
  } catch (error) {
    if (args.mode === 'probe') {
      const reason = error instanceof CloudflareApiError ? `HTTP ${error.status}` : 'request failed';
      stdout.write(`Turnstile widget list permission: no (${args.environment}, ${reason})\n`);
    }
    throw error;
  }

  if (args.mode === 'probe') {
    stdout.write(`Turnstile widget list permission: yes (${args.environment})\n`);
    return { mode: 'probe', environment: args.environment, permitted: true };
  }

  const exact = widgets.filter((widget) => widget?.name === target.widgetName);
  if (exact.length > 1) {
    throw new Error(`Multiple Turnstile widgets match the exact mapped name ${target.widgetName}`);
  }

  let widget;
  let created = false;
  if (exact.length === 1) {
    validateWidget(exact[0], target);
    if (typeof exact[0].sitekey !== 'string' || exact[0].sitekey.length === 0) {
      throw new Error('Existing Turnstile widget is missing its identifier');
    }
    const detailUrl = `${API_ROOT}/accounts/${target.accountId}/challenges/widgets/${encodeURIComponent(exact[0].sitekey)}`;
    const detail = await apiRequest(fetchImpl, token, detailUrl, { method: 'GET' });
    widget = detail.result;
  } else {
    const createUrl = `${API_ROOT}/accounts/${target.accountId}/challenges/widgets`;
    const createdResponse = await apiRequest(fetchImpl, token, createUrl, {
      method: 'POST',
      body: { name: target.widgetName, domains: [target.hostname], mode: 'managed' }
    });
    widget = createdResponse.result;
    created = true;
  }

  validateWidget(widget, target);
  writeCredentialFiles(args['output-dir'], widget.sitekey, widget.secret);
  stdout.write(`Turnstile provisioning complete (${args.environment}, widget ${created ? 'created' : 'reused'}); credentials written to protected files.\n`);
  return { mode: 'provision', environment: args.environment, created };
}

async function main() {
  try {
    await runTurnstileProvisioner();
  } catch (error) {
    process.stderr.write(`provision-turnstile: FAIL - ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
