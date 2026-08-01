#!/usr/bin/env node
// Preview-only catalogue import client for MJ-ART.
//
// Validates the canonical catalogue against the runtime schema, canonicalizes
// and sorts it, enforces the <2MiB artworks.json ceiling, verifies the
// derivative manifest, then (only with --execute AND the exact preview bucket)
// uploads ALL images first, verifies 172 image reads, and only then PUTs the
// complete canonical artworks.json last.
//
// DRY-RUN IS THE DEFAULT. Without --execute the script performs no network I/O,
// spawns no wrangler process, and writes nothing to R2; it validates and prints
// the import plan.
//
// Production import is impossible from this code path: assertPreviewBucket()
// accepts only the literal preview bucket "mj-art-images-preview". No string,
// flag, or control flow here can target the production bucket.
//
// Credentials are taken from the environment (CLOUDFLARE_API_TOKEN,
// CLOUDFLARE_ACCOUNT_ID) exactly as the deploy workflow already does; they are
// never logged, echoed, or written to disk. No Cloudflare secret lives in repo.
//
// Usage:
//   # dry-run (default): validate catalog + manifest + plan, no uploads
//   node scripts/import-catalog-preview.mjs \
//     --manifest /tmp/derivatives/manifest.json \
//     --bucket mj-art-images-preview
//
//   # execute (images-first, artworks.json-last) to PREVIEW only
//   node scripts/import-catalog-preview.mjs \
//     --manifest /tmp/derivatives/manifest.json \
//     --bucket mj-art-images-preview --execute

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '../apps/web/src/artwork-schema.js';
import {
  ARTWORKS_JSON_KEY,
  EXPECTED_IMAGES,
  EXPECTED_RECORDS,
  PREVIEW_BUCKET,
  assertPreviewBucket,
  buildCanonicalArtworksPayload,
  parseArgs,
  validateManifest
} from './lib/catalog-import-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`import-catalog-preview: FAIL - ${msg}`);
  process.exit(1);
}

// Resolve the wrangler command into [bin, ...fixedArgs]. Splits on whitespace;
// never uses a shell. Default "npx wrangler"; CI passes "pnpm exec wrangler".
function wranglerBin(spec) {
  const tokens = String(spec || 'npx wrangler').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) fail('--wrangler command is empty');
  return tokens;
}

// Run wrangler with arg ARRAY (no shell => no injection). Inherits env so the
// Cloudflare token/account id reach wrangler without ever appearing on the CLI.
function runWrangler(binTokens, args, { wantJson = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binTokens[0], [...binTokens.slice(1), ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-6).join('\n');
        reject(new Error(`wrangler exited ${code}: ${tail || stdout || '(no output)'}`));
      } else {
        resolve(wantJson ? stdout : undefined);
      }
    });
  });
}

// Safety: the bucket must already be the preview literal (asserted by caller),
// and the key must be canonical. Belt-and-suspenders before touching wrangler.
function safeKeyForPut(bucket, key) {
  assertPreviewBucket(bucket);
  if (typeof key !== 'string' || !/^artwork\/catalog\/(mj|misc)-\d{3}\/(full|thumb)\.jpg$/.test(key)
      && key !== ARTWORKS_JSON_KEY) {
    throw new Error(`Refusing to put noncanonical key: ${String(key)}`);
  }
  return `${bucket}/${key}`;
}

async function uploadObject(binTokens, bucket, key, localAbs, contentType) {
  const target = safeKeyForPut(bucket, key);
  await runWrangler(binTokens, [
    'r2', 'object', 'put', target,
    '--file', localAbs,
    '--content-type', contentType,
    '--remote'
  ]);
}

async function readAndHashObject(binTokens, bucket, key, destAbs) {
  const target = safeKeyForPut(bucket, key);
  await runWrangler(binTokens, ['r2', 'object', 'get', target, '--file', destAbs, '--remote']);
  if (!existsSync(destAbs)) throw new Error(`wrangler get did not produce ${destAbs}`);
  return createHash('sha256').update(readFileSync(destAbs)).digest('hex');
}

function main() {
  const booleanFlags = new Set(['execute', 'help']);
  const args = parseArgs(process.argv.slice(2), booleanFlags);
  if (args.help) {
    process.stdout.write('See header comment of scripts/import-catalog-preview.mjs\n');
    return;
  }
  if (!args.manifest) fail('--manifest <path> is required (the generator manifest.json)');
  if (!args.bucket) fail('--bucket <name> is required (must be the preview bucket)');

  const manifestPath = path.resolve(args.manifest);
  const catalogPath = args.catalog
    ? path.resolve(args.catalog)
    : path.join(REPO_ROOT, 'catalog', 'catalog.json');

  // Hard gate FIRST: only the preview bucket literal is ever accepted.
  assertPreviewBucket(args.bucket);

  if (!existsSync(manifestPath)) fail(`manifest not found: ${manifestPath}`);
  if (!existsSync(catalogPath)) fail(`catalog not found: ${catalogPath}`);

  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  if (!Array.isArray(catalog)) fail('catalog.json must be an array');
  if (catalog.length !== EXPECTED_RECORDS) {
    fail(`catalog has ${catalog.length} records, expected ${EXPECTED_RECORDS}`);
  }

  // Runtime schema validation + canonicalization + sort + <2MiB ceiling.
  const payload = buildCanonicalArtworksPayload(catalog, schema);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.expectedImages !== EXPECTED_IMAGES || manifest.entries.length !== EXPECTED_IMAGES) {
    fail(`manifest must contain exactly ${EXPECTED_IMAGES} image entries`);
  }
  validateManifest(manifest, catalog);

  const binTokens = wranglerBin(args.wrangler);

  console.log('--- preview catalogue import plan ---');
  console.log(`bucket:        ${args.bucket} (preview)`);
  console.log(`catalog:       ${catalogPath} (${catalog.length} records)`);
  console.log(`manifest:      ${manifestPath} (${manifest.entries.length} derivatives)`);
  console.log(`artworks.json: ${payload.count} records, ${payload.size} bytes (< ${2 * 1024 * 1024} via runtime schema)`);
  console.log(`wrangler:      ${binTokens.join(' ')}`);
  console.log(`order:         all 172 images first, verify 172 reads, then artworks.json last`);

  if (!args.execute) {
    console.log('DRY-RUN: --execute not set. No uploads performed. Re-run with --execute to publish to PREVIEW only.');
    return;
  }

  // EXECUTE PATH (preview only). Secrets must be present in env.
  if (!process.env.CLOUDFLARE_API_TOKEN) fail('--execute requires env CLOUDFLARE_API_TOKEN (set by the workflow)');
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) fail('--execute requires env CLOUDFLARE_ACCOUNT_ID (set by the workflow)');

  run(binTokens, args.bucket, manifest, payload).catch((e) => fail(e && e.message ? e.message : String(e)));
}

async function run(binTokens, bucket, manifest, payload) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mj-art-import-'));
  try {
    // 1) Upload all images first.
    const imageEntries = manifest.entries.slice().sort((a, b) => (a.key < b.key ? -1 : 1));
    console.log(`\n[1/3] Uploading ${imageEntries.length} image derivatives to "${bucket}"...`);
    let done = 0;
    for (const e of imageEntries) {
      const abs = path.join(manifest.baseDir, e.localRelFile);
      if (!existsSync(abs)) throw new Error(`manifest local file missing: ${abs}`);
      // Re-verify the staged file hash before upload (defend against staging drift).
      const h = createHash('sha256').update(readFileSync(abs)).digest('hex');
      if (h !== e.sha256) throw new Error(`staged file hash mismatch for ${e.key}: ${h} != ${e.sha256}`);
      await uploadObject(binTokens, bucket, e.key, abs, 'image/jpeg');
      done++;
      if (done % 25 === 0 || done === imageEntries.length) {
        console.log(`      put ${done}/${imageEntries.length}`);
      }
    }

    // 2) Verify 172 reads; hash-compare each downloaded body to the manifest.
    console.log(`\n[2/3] Verifying ${EXPECTED_IMAGES} image reads (get + sha256 compare)...`);
    let verified = 0;
    for (const e of imageEntries) {
      const dest = path.join(tmp, path.basename(e.key) + '.' + verified + '.jpg');
      const got = await readAndHashObject(binTokens, bucket, e.key, dest);
      if (got !== e.sha256) {
        throw new Error(`readback hash mismatch for ${e.key}: ${got} != ${e.sha256}`);
      }
      verified++;
      if (verified % 25 === 0 || verified === imageEntries.length) {
        console.log(`      verified ${verified}/${EXPECTED_IMAGES}`);
      }
    }
    if (verified !== EXPECTED_IMAGES) {
      throw new Error(`expected ${EXPECTED_IMAGES} verified reads, got ${verified}`);
    }

    // 3) PUT complete canonical artworks.json LAST.
    console.log(`\n[3/3] Publishing canonical artworks.json (${payload.size} bytes) LAST...`);
    const jsonTmp = path.join(tmp, 'artworks.json');
    writeFileSync(jsonTmp, payload.json, 'utf8');
    await uploadObject(binTokens, bucket, ARTWORKS_JSON_KEY, jsonTmp, 'application/json');

    // Confirm artworks.json is readable.
    const back = path.join(tmp, 'artworks.back.json');
    await runWrangler(binTokens, ['r2', 'object', 'get', `${bucket}/${ARTWORKS_JSON_KEY}`, '--file', back, '--remote']);
    const readBack = JSON.parse(readFileSync(back, 'utf8'));
    if (!Array.isArray(readBack) || readBack.length !== payload.count) {
      throw new Error(`artworks.json readback length mismatch: ${readBack && readBack.length}`);
    }

    console.log(`\n✓ PREVIEW import complete: ${EXPECTED_IMAGES} images verified + artworks.json published to "${bucket}".`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  main();
} catch (e) {
  fail(e && e.message ? e.message : String(e));
}
