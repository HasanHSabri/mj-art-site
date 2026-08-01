#!/usr/bin/env node
// Generate deterministic catalogue image derivatives for MJ-ART.
//
// Resolves each source image SOLELY through the checksum manifest
// (<assets-dir>/SHA256SUMS) and each catalogue record's provenance.sha256,
// never by filename convention. Produces EXIF-orientation-normalized JPEG
// derivatives (full 2000px @0.9, thumb 640px @0.85, never upscaled) into a
// staging tree laid out as `artwork/catalog/<id>/{full,thumb}.jpg`, and emits a
// machine-readable manifest for the preview-only import client.
//
// Engine: system ImageMagick (v7 `magick`, or v6 `convert`/`identify`), which is
// preinstalled on GitHub Actions ubuntu runners and keeps this project
// dependency-free. The script fails closed if no ImageMagick binary is found.
//
// Generated images are NEVER committed to Git. The default output directory is a
// per-process path under the OS temp dir, not inside the repository.
//
// Usage:
//   node scripts/generate-catalog-derivatives.mjs \
//     --assets-dir /path/to/MJ-ART-catalog-assets \
//     --output-dir /tmp/mj-art-derivatives \
//     [--catalog catalog/catalog.json]
//
// Exit code 0 on success (86 records, 172 derivatives, manifest written).
// Any anomaly (duplicate/missing/mismatched checksum, invalid image, invalid
// record, unexpected output) fails closed with a nonzero exit.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_IMAGES,
  EXPECTED_RECORDS,
  FULL_MAX_DIMENSION,
  FULL_QUALITY,
  THUMB_MAX_DIMENSION,
  THUMB_QUALITY,
  buildSourceMap,
  objectKeyFor,
  parseArgs,
  parseSha256Sums
} from './lib/catalog-import-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`generate-catalog-derivatives: FAIL - ${msg}`);
  process.exit(1);
}

// ---- ImageMagick discovery -------------------------------------------------
function discoverImageMagick() {
  // Prefer the v7 unified `magick` binary; fall back to v6 `convert`/`identify`.
  if (commandExists('magick')) {
    const v = versionOf(['magick', '--version']);
    return {
      convert: (args) => run('magick', args),
      identify: (file) => identify(['magick', 'identify', '-format', '%m %w %h', file]),
      version: v
    };
  }
  if (commandExists('convert') && commandExists('identify')) {
    const v = versionOf(['identify', '--version']);
    return {
      convert: (args) => run('convert', args),
      identify: (file) => identify(['identify', '-format', '%m %w %h', file]),
      version: v
    };
  }
  return null;
}

function commandExists(cmd) {
  // Pure PATH scan: avoids spawning a shell (and the DEP0190 shell:true warning).
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return true;
    } catch {
      /* ignore unreadable entries */
    }
  }
  return false;
}

function versionOf(argv) {
  try {
    return execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch {
    return 'unknown';
  }
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1024 * 1024 });
}

function identify(argv) {
  // Returns { magic, width, height } parsed from "MAGIC W H".
  let out;
  try {
    out = execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' }).trim();
  } catch (e) {
    throw new Error(`identify failed: ${(e && e.message) || e}`);
  }
  const parts = out.split(/\s+/);
  if (parts.length < 3) throw new Error(`identify produced unexpected output: "${out}"`);
  const magic = parts[0];
  const width = Number.parseInt(parts[1], 10);
  const height = Number.parseInt(parts[2], 10);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`identify produced non-integer dimensions: "${out}"`);
  }
  return { magic, width, height };
}

function sha256File(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

// Build a single derivative. Order matters: auto-orient FIRST (apply EXIF), then
// strip profiles/metadata, then resize (longest-edge box, shrink-only '>'), then
// set JPEG quality. Output is then re-verified as JPEG with sane dimensions.
function makeDerivative(im, input, output, maxDim, quality) {
  const geom = `${maxDim}x${maxDim}>`;
  im.convert([input, '-auto-orient', '-strip', '-resize', geom, '-quality', String(quality), output]);
  if (!existsSync(output)) throw new Error(`ImageMagick produced no output: ${output}`);
  const info = im.identify(output);
  if (info.magic !== 'JPEG' && info.magic !== 'JPG') {
    throw new Error(`Output is not JPEG (identify magic=${info.magic}): ${output}`);
  }
  const longest = Math.max(info.width, info.height);
  if (longest > maxDim) {
    throw new Error(`Derivative longest edge ${longest} exceeds ${maxDim}: ${output}`);
  }
  return info;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalogPath = args.catalog
    ? path.resolve(args.catalog)
    : path.join(REPO_ROOT, 'catalog', 'catalog.json');
  const assetsDir = args['assets-dir']
    ? path.resolve(args['assets-dir'])
    : (process.env.MJ_ART_CATALOG_ASSETS_DIR || '/workspace/projects/MJ-ART-catalog-assets');
  const outputDir = args['output-dir']
    ? path.resolve(args['output-dir'])
    : path.join(os.tmpdir(), 'mj-art-catalog-derivatives');

  if (!existsSync(catalogPath)) fail(`catalog not found: ${catalogPath}`);
  if (!existsSync(assetsDir)) fail(`assets-dir not found: ${assetsDir} (pass --assets-dir or set MJ_ART_CATALOG_ASSETS_DIR)`);
  const sumsPath = path.join(assetsDir, 'SHA256SUMS');
  if (!existsSync(sumsPath)) fail(`SHA256SUMS not found in assets-dir: ${sumsPath}`);

  const im = discoverImageMagick();
  if (!im) {
    fail('No ImageMagick found. Install ImageMagick (v7 magick, or v6 convert+identify) and retry.');
  }

  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  if (!Array.isArray(catalog)) fail('catalog.json must be an array');
  if (catalog.length !== EXPECTED_RECORDS) {
    fail(`catalog has ${catalog.length} records, expected ${EXPECTED_RECORDS}`);
  }

  const sums = parseSha256Sums(readFileSync(sumsPath, 'utf8'));
  const sourceMap = buildSourceMap(catalog, sums);
  if (sourceMap.size !== EXPECTED_RECORDS) {
    fail(`resolved ${sourceMap.size} sources, expected ${EXPECTED_RECORDS}`);
  }

  // Reset a clean staging tree so stale files can never leak into the manifest.
  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true, force: true });
  }
  mkdirSync(outputDir, { recursive: true });

  console.log(`ImageMagick: ${im.version}`);
  console.log(`assets-dir: ${assetsDir}`);
  console.log(`output-dir: ${outputDir}`);
  console.log(`Generating ${EXPECTED_IMAGES} derivatives for ${EXPECTED_RECORDS} records...`);

  const entries = [];
  for (const record of catalog) {
    const src = sourceMap.get(record.id);
    if (!src) fail(`no source resolved for record ${record.id}`);
    const srcAbs = path.join(assetsDir, src.sourceRelPath);
    if (!existsSync(srcAbs)) fail(`source file missing for ${record.id}: ${src.sourceRelPath}`);

    // Checksum guard: re-hash the source bytes and compare to the manifest sha.
    const actualSha = sha256File(srcAbs);
    if (actualSha !== src.sourceSha) {
      fail(`source checksum mismatch for ${record.id}: expected ${src.sourceSha}, got ${actualSha}`);
    }
    const srcSize = statSync(srcAbs).size;
    if (!Number.isInteger(srcSize) || srcSize <= 0) {
      fail(`source file has invalid size for ${record.id}: ${srcSize}`);
    }

    for (const variant of ['full', 'thumb']) {
      const key = objectKeyFor(record.id, variant);
      const rel = key; // deterministic staging path == object key
      const abs = path.join(outputDir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      const maxDim = variant === 'full' ? FULL_MAX_DIMENSION : THUMB_MAX_DIMENSION;
      const quality = variant === 'full' ? FULL_QUALITY : THUMB_QUALITY;
      const info = makeDerivative(im, srcAbs, abs, maxDim, quality);
      const sha = sha256File(abs);
      const bytes = statSync(abs).size;
      if (!Number.isInteger(bytes) || bytes <= 0) fail(`derivative has invalid size: ${abs}`);
      entries.push({
        id: record.id,
        variant,
        key,
        localRelFile: rel,
        sha256: sha,
        width: info.width,
        height: info.height,
        bytes,
        sourceSha: src.sourceSha,
        sourceRelFile: src.sourceRelPath
      });
    }
  }

  if (entries.length !== EXPECTED_IMAGES) {
    fail(`produced ${entries.length} derivatives, expected ${EXPECTED_IMAGES}`);
  }

  // Deterministic ordering: by key (id then variant, full before thumb).
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const manifest = {
    version: 1,
    engine: `imagemagick:${im.version}`,
    baseDir: outputDir,
    expectedRecords: EXPECTED_RECORDS,
    expectedImages: EXPECTED_IMAGES,
    derivative: {
      full: { maxDimension: FULL_MAX_DIMENSION, quality: FULL_QUALITY },
      thumb: { maxDimension: THUMB_MAX_DIMENSION, quality: THUMB_QUALITY },
      normalize: 'auto-orient then strip then resize(shrink-only) then JPEG quality'
    },
    entries
  };
  const manifestPath = path.join(outputDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const totalBytes = entries.reduce((n, e) => n + e.bytes, 0);
  console.log(`✓ Generated ${entries.length} derivatives (${totalBytes} bytes total).`);
  console.log(`✓ Manifest written: ${manifestPath}`);
}

try {
  main();
} catch (e) {
  fail(e && e.message ? e.message : String(e));
}
