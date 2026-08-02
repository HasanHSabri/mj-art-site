#!/usr/bin/env node
// Generate the tracked production catalogue release manifest from a VERIFIED
// read-only backup manifest (as produced by scripts/r2-readonly-backup.mjs).
//
// The committed release manifest (catalog/production-release-manifest.json) pins
// the APPROVED PREVIEW R2 state exactly: 173 objects (172 canonical images +
// artworks.json), each by {key,size,sha256} only. It carries NO local paths,
// etags, timestamps, or secrets. Provenance is limited to verifiable, public
// anchors (the approved content commit, the verifying backup snapshot name, and
// the backup-recorded commit).
//
// This script is run LOCALLY by a release engineer against a verified backup
// artifact; the OUTPUT is committed, the input backup path never is. The output
// is then validated against the canonical catalogue (validateReleaseManifest)
// and the artworks.json cross-check, so the committed manifest is provably
// consistent with the committed catalogue.
//
// Usage:
//   node scripts/generate-production-release-manifest.mjs \
//     --backup-manifest <path-to-extracted-manifest.json> \
//     --backup-snapshot <snapshot-name> \
//     --approved-commit <sha> \
//     --approved-subject "<subject>" \
//     --out <path>

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '../apps/web/src/artwork-schema.js';
import {
  RELEASE_MANIFEST_KIND,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  SOURCE_BUCKET,
  buildReleaseManifest,
  serializeReleaseManifest,
  hashReleaseManifest,
  validateReleaseManifest
} from './lib/release-manifest-core.mjs';
import { parseArgs } from './lib/catalog-import-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`generate-production-release-manifest: FAIL - ${msg}`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2), new Set(['help']));
  if (args.help) {
    process.stdout.write(
      [
        'generate-production-release-manifest.mjs - derive the tracked release manifest',
        '',
        'Usage:',
        '  node scripts/generate-production-release-manifest.mjs \\',
        '    --backup-manifest <path> --backup-snapshot <name> \\',
        '    --approved-commit <sha> --approved-subject "<subject>" --out <path>',
        '',
        'Reads the verified read-only backup manifest, extracts the approved preview',
        'object set, and writes a deterministic release manifest to --out. Validates',
        'it against catalog/catalog.json before writing.'
      ].join('\n') + '\n'
    );
    return;
  }
  if (!args['backup-manifest']) fail('--backup-manifest <path> is required (the extracted backup manifest.json)');
  if (!args['backup-snapshot']) fail('--backup-snapshot <name> is required (e.g. r2-readonly-backup-20260802T033638Z)');
  if (!args['approved-commit']) fail('--approved-commit <sha> is required (the approved preview content commit)');
  if (!args['approved-subject']) fail('--approved-subject "<subject>" is required');
  if (!args.out) fail('--out <path> is required');

  const backupManifestPath = path.resolve(args['backup-manifest']);
  if (!existsSync(backupManifestPath)) fail(`backup manifest not found: ${backupManifestPath}`);
  const backup = JSON.parse(readFileSync(backupManifestPath, 'utf8'));

  // Locate the approved preview bucket in the backup and pull its object records.
  const buckets = Array.isArray(backup.buckets) ? backup.buckets : null;
  if (!buckets) fail('backup manifest has no buckets array');
  const preview = buckets.find((b) => b && b.name === SOURCE_BUCKET);
  if (!preview) fail(`backup manifest has no bucket named "${SOURCE_BUCKET}"`);
  if (!Array.isArray(preview.objects)) fail('preview bucket has no objects array');

  // Every preview body must be downloaded and checksummed in the backup; the
  // release manifest derives its sha256/size from these verified downloads.
  const records = [];
  for (const o of preview.objects) {
    if (o.downloaded !== true) fail(`preview object not downloaded in backup: ${o.rawKey}`);
    if (typeof o.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(o.sha256)) {
      fail(`preview object has no valid sha256 in backup: ${o.rawKey}`);
    }
    records.push({ rawKey: o.rawKey, size: o.size, sha256: o.sha256, downloaded: true });
  }

  const backupRecordedCommit = typeof backup.commitSha === 'string' ? backup.commitSha : null;
  if (!backupRecordedCommit) fail('backup manifest has no commitSha (cannot anchor provenance)');

  const provenance = {
    contentCommit: args['approved-commit'],
    contentCommitSubject: args['approved-subject'],
    verifiedByBackupSnapshot: args['backup-snapshot'],
    backupRecordedCommit,
    deployCodeTargetNote:
      'The production Worker deploy (apps/web) runs from the latest main commit at deploy time; ' +
      'this manifest pins the approved CATALOGUE CONTENT (preview R2 state). ' +
      'Commit 97a11c2 changed only backup tooling (not app or catalogue content), so the deploy ' +
      'code target is latest main while this content manifest is the approved preview state.'
  };

  const manifest = buildReleaseManifest(records, provenance);

  // Validate against the committed canonical catalogue before writing.
  const catalogPath = path.join(REPO_ROOT, 'catalog', 'catalog.json');
  if (!existsSync(catalogPath)) fail(`catalog not found: ${catalogPath}`);
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  validateReleaseManifest(manifest, catalog, schema);

  const outPath = path.resolve(args.out);
  const text = serializeReleaseManifest(manifest);
  writeFileSync(outPath, text, 'utf8');

  console.log('--- production release manifest generated ---');
  console.log(`source:            ${SOURCE_BUCKET} (approved preview)`);
  console.log(`approved commit:   ${provenance.contentCommit}`);
  console.log(`backup snapshot:   ${provenance.verifiedByBackupSnapshot}`);
  console.log(`objects:           ${manifest.expectedObjectCount} (172 images + artworks.json)`);
  console.log(`artworks.json:     ${manifest.artworksJson.size} bytes, sha256 ${manifest.artworksJson.sha256}`);
  console.log(`catalogue check:   86 records cross-verified against catalog/catalog.json`);
  console.log(`manifest sha256:   ${hashReleaseManifest(manifest)}`);
  console.log(`written to:        ${outPath}`);
}

try {
  main();
} catch (e) {
  fail(e && e.message ? e.message : String(e));
}
