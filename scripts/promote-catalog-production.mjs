#!/usr/bin/env node
// Guarded production catalogue promotion client for MJ-ART.
//
// Promotes the APPROVED PREVIEW catalogue state to PRODUCTION:
//   preview (mj-art-images-preview, read-only source)
//     -> production (mj-art-images, write destination)
//
// HARD SAFETY CONTRACT (enforced by construction and by static checks):
//   * Source and destination buckets are FIXED LITERALS. No argument, manifest
//     field, env var, or control flow can swap, invert, or override them.
//   * DRY-RUN IS THE DEFAULT. Without --execute the script performs no R2 writes
//     and spawns no wrangler PUT. Execute requires BOTH --execute AND --confirm
//     equal to the exact promotion phrase.
//   * Before ANY production write, a VERIFIED FRESH production backup artifact
//     (from the same workflow run) must be supplied and must confirm the current
//     production inventory with every body downloaded and checksummed. A missing
//     or short backup -> no writes. This is the rollback-source handshake.
//     The handshake is CONTENT-EXACT: the operator pins the expected production
//     inventory fingerprint (sha256 over sorted key/size/sha256 lines) and the
//     fresh backup must reproduce it, so a same-count byte/key drift cannot pass.
//   * The approved preview inventory (from that same fresh backup) must match the
//     release manifest expected set EXACTLY: no missing, no extra.
//   * All 173 expected objects are downloaded from preview and verified by
//     size + sha256 before any upload. A missing/short preview object -> no writes.
//   * Uploads are images FIRST (172), each read back and verified by sha256, then
//     artworks.json LAST, read back by sha256 + byte size + parsed count (86). On
//     any failure before the artworks.json PUT, the prior production metadata
//     stays live (the old artworks.json references the retained legacy images).
//   * There is NO delete path anywhere. Legacy production objects are never
//     touched. The canonical image keys do not overlap the legacy keys.
//
// Credentials are taken from the environment (CLOUDFLARE_API_TOKEN,
// CLOUDFLARE_ACCOUNT_ID) exactly as the deploy workflow does; they are never
// logged, echoed, or written to disk.
//
// Usage:
//   # dry-run (default): validate manifest + backup handshake + preview inventory
//   # cross-check + plan; NO R2 writes, NO preview downloads.
//   node scripts/promote-catalog-production.mjs \
//     --release-manifest catalog/production-release-manifest.json \
//     --backup-manifest <run-temp>/r2-output/manifest.json \
//     --expected-production-count 19 \
//     --expected-production-fingerprint <64-hex production inventory fingerprint>
//
//   # execute (images first, readback, artworks.json last, readback) to PRODUCTION
//   node scripts/promote-catalog-production.mjs \
//     --release-manifest catalog/production-release-manifest.json \
//     --release-manifest-sha256 <pinned-sha> \
//     --backup-manifest <run-temp>/r2-output/manifest.json \
//     --expected-production-count 19 \
//     --expected-production-fingerprint <64-hex production inventory fingerprint> \
//     --execute --confirm I-CONFIRM-PRODUCTION-CATALOGUE-PROMOTION \
//     --wrangler "pnpm exec wrangler"

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '../apps/web/src/artwork-schema.js';
import {
  ARTWORKS_JSON_KEY,
  DESTINATION_BUCKET,
  EXPECTED_IMAGES,
  INVENTORY_FINGERPRINT_ALGORITHM,
  OBJECT_KEY_RE,
  PROMOTION_CONFIRM_PHRASE,
  SOURCE_BUCKET,
  hashReleaseManifestBytes,
  inventoryFingerprint,
  validateReleaseManifest,
  verifyArtworksReadback,
  verifyPreviewInventoryMatchesRelease,
  verifyProductionBackupHandshake
} from './lib/release-manifest-core.mjs';
import { parseArgs } from './lib/catalog-import-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`promote-catalog-production: FAIL - ${msg}`);
  process.exit(1);
}

// Resolve a wrangler command spec into [bin, ...fixedArgs]. Splits on whitespace;
// never uses a shell. Default "npx wrangler"; CI passes "pnpm exec wrangler".
function wranglerBin(spec) {
  const tokens = String(spec || 'npx wrangler').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) fail('--wrangler command is empty');
  return tokens;
}

// Run wrangler with an arg ARRAY (no shell => no injection). Inherits env so the
// Cloudflare token/account id reach wrangler without ever appearing on the CLI.
function runWrangler(binTokens, args) {
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
        resolve();
      }
    });
  });
}

// Belt-and-suspenders key guard before any R2 operation target is built. The
// bucket is the fixed literal (re-asserted), the key is canonical or artworks.
function safeTarget(bucket, key) {
  if (bucket !== SOURCE_BUCKET && bucket !== DESTINATION_BUCKET) {
    throw new Error(`Refusing R2 op: bucket must be a fixed literal, got "${bucket}"`);
  }
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('Refusing R2 op: empty key');
  }
  if (!OBJECT_KEY_RE.test(key) && key !== ARTWORKS_JSON_KEY) {
    throw new Error(`Refusing R2 op: noncanonical key "${key}"`);
  }
  return `${bucket}/${key}`;
}

async function downloadAndHash(binTokens, bucket, key, destAbs) {
  await runWrangler(binTokens, ['r2', 'object', 'get', safeTarget(bucket, key), '--file', destAbs, '--remote']);
  if (!existsSync(destAbs)) throw new Error(`wrangler get did not produce ${destAbs}`);
  const buf = readFileSync(destAbs);
  return { size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

async function uploadObject(binTokens, bucket, key, localAbs, contentType) {
  await runWrangler(binTokens, [
    'r2', 'object', 'put', safeTarget(bucket, key),
    '--file', localAbs,
    '--content-type', contentType,
    '--remote'
  ]);
}

function contentTypeFor(key) {
  return key === ARTWORKS_JSON_KEY ? 'application/json' : 'image/jpeg';
}

function main() {
  const booleanFlags = new Set(['execute', 'help']);
  const args = parseArgs(process.argv.slice(2), booleanFlags);
  if (args.help) {
    process.stdout.write('See header comment of scripts/promote-catalog-production.mjs\n');
    return;
  }
  if (!args['release-manifest']) fail('--release-manifest <path> is required (catalog/production-release-manifest.json)');
  if (!args['backup-manifest']) fail('--backup-manifest <path> is required (the fresh production backup manifest from this run)');
  if (!args['expected-production-count']) fail('--expected-production-count <n> is required (drift guard)');
  if (!args['expected-production-fingerprint']) fail('--expected-production-fingerprint <64-hex> is required (content-exact production drift guard)');

  const releaseManifestPath = path.resolve(args['release-manifest']);
  const backupManifestPath = path.resolve(args['backup-manifest']);
  if (!existsSync(releaseManifestPath)) fail(`release manifest not found: ${releaseManifestPath}`);
  if (!existsSync(backupManifestPath)) fail(`backup manifest not found: ${backupManifestPath}`);

  const expectedProductionCount = Number.parseInt(args['expected-production-count'], 10);
  if (!Number.isInteger(expectedProductionCount) || expectedProductionCount < 0) {
    fail('--expected-production-count must be a non-negative integer');
  }

  // Content-exact production drift guard: the operator supplies the canonical
  // production inventory fingerprint (64 lowercase hex), derived from a verified
  // production backup. The fresh in-run backup must reproduce it exactly before
  // any write, so a same-count byte/key change cannot pass the handshake.
  const expectedProductionFingerprint = args['expected-production-fingerprint'];
  if (!/^[0-9a-f]{64}$/.test(expectedProductionFingerprint)) {
    fail('--expected-production-fingerprint must be exactly 64 lowercase hex characters');
  }

  // 1) Release manifest file hash pin (if supplied). Prevents a tampered manifest.
  const releaseBytes = readFileSync(releaseManifestPath, 'utf8');
  const releaseOnDiskSha = hashReleaseManifestBytes(releaseBytes);
  if (args['release-manifest-sha256']) {
    if (args['release-manifest-sha256'] !== releaseOnDiskSha) {
      fail(`release manifest sha256 mismatch: on-disk ${releaseOnDiskSha} != expected ${args['release-manifest-sha256']}`);
    }
  }

  // 2) Parse + validate the release manifest against the committed catalogue.
  const release = JSON.parse(releaseBytes);
  const catalogPath = path.join(REPO_ROOT, 'catalog', 'catalog.json');
  if (!existsSync(catalogPath)) fail(`catalog not found: ${catalogPath}`);
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  validateReleaseManifest(release, catalog, schema);

  // 3) Fresh production backup handshake + preview inventory cross-check. Both
  //    come from the SAME fresh backup artifact produced earlier in this run.
  //    The handshake enforces the expected count AND the content-exact inventory
  //    fingerprint, so the run cannot pass with a count match but a content
  //    (key/size/sha256) mismatch.
  const backup = JSON.parse(readFileSync(backupManifestPath, 'utf8'));
  const prodInventory = verifyProductionBackupHandshake(backup, expectedProductionCount, expectedProductionFingerprint);
  const actualProdFingerprint = inventoryFingerprint(prodInventory);
  verifyPreviewInventoryMatchesRelease(backup, release);

  const imageObjects = release.expectedObjects.filter((e) => OBJECT_KEY_RE.test(e.key));
  const artworksObject = release.expectedObjects.find((e) => e.key === ARTWORKS_JSON_KEY);
  if (imageObjects.length !== EXPECTED_IMAGES) fail(`release manifest has ${imageObjects.length} image objects, expected ${EXPECTED_IMAGES}`);
  if (!artworksObject) fail('release manifest has no artworks.json object');

  const binTokens = wranglerBin(args.wrangler);

  console.log('--- production catalogue promotion plan ---');
  console.log(`source (read-only):  ${SOURCE_BUCKET}`);
  console.log(`destination (write): ${DESTINATION_BUCKET}`);
  console.log(`approved commit:     ${release.approvedPreview && release.approvedPreview.contentCommit}`);
  console.log(`backup snapshot:     ${release.approvedPreview && release.approvedPreview.verifiedByBackupSnapshot}`);
  console.log(`preview objects:     ${release.expectedObjectCount} (172 images + artworks.json)`);
  console.log(`production now:      ${prodInventory.objectCount} legacy objects (retained, never deleted)`);
  console.log(`prod fingerprint:    ${actualProdFingerprint.sha256} (${INVENTORY_FINGERPRINT_ALGORITHM}, content-exact)`);
  console.log(`artworks.json:       ${artworksObject.size} bytes, sha256 ${artworksObject.sha256} (PUT last)`);
  console.log(`manifest sha256:     ${releaseOnDiskSha}`);
  console.log(`wrangler:            ${binTokens.join(' ')}`);
  console.log(`order:               download 173 from preview + verify, upload 172 images + readback, artworks.json last + readback`);

  if (!args.execute) {
    console.log('DRY-RUN: --execute not set. No downloads, no uploads. Re-run with --execute --confirm <phrase> to promote to PRODUCTION.');
    return;
  }

  // EXECUTE PATH. Requires the exact confirmation phrase.
  if (args.confirm !== PROMOTION_CONFIRM_PHRASE) {
    fail(`--execute requires --confirm to equal the exact promotion phrase (got "${args.confirm || '(none)'}")`);
  }
  if (!process.env.CLOUDFLARE_API_TOKEN) fail('--execute requires env CLOUDFLARE_API_TOKEN (set by the workflow)');
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) fail('--execute requires env CLOUDFLARE_ACCOUNT_ID (set by the workflow)');

  run(binTokens, release, imageObjects, artworksObject).catch((e) => fail(e && e.message ? e.message : String(e)));
}

async function run(binTokens, release, imageObjects, artworksObject) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mj-art-promote-'));
  try {
    // 1) Download all 173 expected objects from PREVIEW (read-only source) and
    //    verify each by size + sha256. A missing/short preview object aborts
    //    before any production write.
    console.log(`\n[1/4] Downloading ${release.expectedObjectCount} approved objects from "${SOURCE_BUCKET}" and verifying...`);
    const localPath = new Map();
    let downloaded = 0;
    for (const e of release.expectedObjects) {
      const dest = path.join(tmp, 'src-' + downloaded.toString().padStart(3, '0') + '-' + path.basename(e.key));
      const got = await downloadAndHash(binTokens, SOURCE_BUCKET, e.key, dest);
      if (got.size !== e.size) {
        throw new Error(`preview download size mismatch for ${e.key}: ${got.size} != ${e.size}`);
      }
      if (got.sha256 !== e.sha256) {
        throw new Error(`preview download sha256 mismatch for ${e.key}: ${got.sha256} != ${e.sha256}`);
      }
      localPath.set(e.key, dest);
      downloaded++;
      if (downloaded % 25 === 0 || downloaded === release.expectedObjectCount) {
        console.log(`      downloaded+verified ${downloaded}/${release.expectedObjectCount}`);
      }
    }

    // 2) Upload 172 images FIRST to PRODUCTION, then read back each and verify
    //    by sha256. Any failure here aborts BEFORE artworks.json is touched, so
    //    the prior production metadata stays live.
    console.log(`\n[2/4] Uploading ${EXPECTED_IMAGES} images to "${DESTINATION_BUCKET}" and reading back...`);
    let uploaded = 0;
    for (const e of imageObjects) {
      const src = localPath.get(e.key);
      await uploadObject(binTokens, DESTINATION_BUCKET, e.key, src, contentTypeFor(e.key));
      const rb = path.join(tmp, 'rb-' + uploaded.toString().padStart(3, '0') + '-' + path.basename(e.key));
      const got = await downloadAndHash(binTokens, DESTINATION_BUCKET, e.key, rb);
      if (got.sha256 !== e.sha256) {
        throw new Error(`production image readback sha256 mismatch for ${e.key}: ${got.sha256} != ${e.sha256}`);
      }
      uploaded++;
      if (uploaded % 25 === 0 || uploaded === EXPECTED_IMAGES) {
        console.log(`      uploaded+readback ${uploaded}/${EXPECTED_IMAGES}`);
      }
    }

    // 3) Publish the approved artworks.json LAST, then read back by exact
    //    sha256 + byte size + parsed record count (86). This is the metadata
    //    cutover: only after every image is verified in production.
    console.log(`\n[3/4] Publishing approved artworks.json (${artworksObject.size} bytes) LAST to "${DESTINATION_BUCKET}"...`);
    const awSrc = localPath.get(ARTWORKS_JSON_KEY);
    await uploadObject(binTokens, DESTINATION_BUCKET, ARTWORKS_JSON_KEY, awSrc, 'application/json');
    const awRb = path.join(tmp, 'rb-artworks.json');
    const got = await downloadAndHash(binTokens, DESTINATION_BUCKET, ARTWORKS_JSON_KEY, awRb);
    verifyArtworksReadback(readFileSync(awRb), {
      sha256: artworksObject.sha256,
      size: artworksObject.size,
      count: release.catalog.recordCount
    });
    if (got.sha256 !== artworksObject.sha256) {
      throw new Error('artworks.json readback sha256 mismatch (post-verify guard)');
    }

    // 4) Final summary.
    console.log(`\n[4/4] \u2713 PRODUCTION promotion complete.`);
    console.log(`      ${EXPECTED_IMAGES} images uploaded + readback-verified to "${DESTINATION_BUCKET}".`);
    console.log(`      artworks.json published + verified (${got.size} bytes, 86 records).`);
    console.log(`      Legacy production objects retained (never deleted).`);
    console.log(`      Next: production Worker deploy (manual) + post-deploy drift report.`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  main();
} catch (e) {
  fail(e && e.message ? e.message : String(e));
}
