#!/usr/bin/env node
// Verify a fetched VPS master archive against its sidecar WITHOUT delegating
// to the coreutils checksum-check subcommand (which would read an untrusted
// path from the file).
//
// Usage:
//   node scripts/verify-master-archive.mjs \
//     --version <master_archive_version> \
//     --archive <path/to/mj-art-master-<version>.tar.gz> \
//     --sidecar <path/to/mj-art-master-<version>.sha256>
//
// Steps:
//   1. Validate the version token (strict regex).
//   2. Derive the exact expected archive basename from the version.
//   3. Read the sidecar; require EXACTLY "<sha256>  <expected-basename>".
//   4. Re-hash the archive bytes (streaming) and compare to the sidecar digest.
//
// Exit 0 only on an exact match; nonzero (fail closed) on any problem.
// Dependency-free, deterministic, no network.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFileSync } from 'node:fs';
import {
  MASTER_VERSION_RE,
  masterArchiveBasename,
  parseMasterSidecar
} from './lib/catalog-import-core.mjs';
import { parseArgs } from './lib/catalog-import-core.mjs';

function fail(msg) {
  console.error('verify-master-archive: FAIL - ' + msg);
  process.exit(1);
}

async function sha256OfFile(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const stream = createReadStream(p);
    stream.on('error', reject);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { version, archive, sidecar } = args;
  if (!version) fail('--version is required');
  if (!archive) fail('--archive is required');
  if (!sidecar) fail('--sidecar is required');
  if (!MASTER_VERSION_RE.test(version)) {
    fail('--version must match [A-Za-z0-9._-]{1,64}');
  }
  const expectedBasename = masterArchiveBasename(version);

  let sidecarText;
  try {
    sidecarText = readFileSync(sidecar, 'utf8');
  } catch (e) {
    fail(`cannot read sidecar: ${(e && e.message) || e}`);
  }

  let expectedSha;
  try {
    expectedSha = parseMasterSidecar(sidecarText, expectedBasename);
  } catch (e) {
    fail(`sidecar is invalid: ${(e && e.message) || e}`);
  }

  let actualSha;
  try {
    actualSha = await sha256OfFile(archive);
  } catch (e) {
    fail(`cannot hash archive: ${(e && e.message) || e}`);
  }

  if (actualSha !== expectedSha) {
    fail(
      `archive sha256 mismatch: computed ${actualSha}, sidecar expected ${expectedSha}`
    );
  }
  console.log('verify-master-archive: OK - archive sha256 matches sidecar');
}

main().catch((e) => fail(`unexpected error: ${(e && e.message) || e}`));
