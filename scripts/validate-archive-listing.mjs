#!/usr/bin/env node
// Validate a GNU tar verbose listing before extraction.
//
// Reads `tar -tvzf <archive>` output from a file and rejects any entry that is a
// symlink/hardlink or has an unsafe (absolute / parent-traversal) path, so the
// subsequent `tar -xzf` can never create a link that escapes the target dir or
// write outside it. Fail-closed: unparseable lines are rejected, not ignored.
//
// Usage:
//   tar -tvzf archive.tar.gz > listing.txt
//   node scripts/validate-archive-listing.mjs --verbose-listing listing.txt
//
// The pure validation logic lives in scripts/lib/catalog-import-core.mjs
// (validateTarVerboseListing) and is unit-tested directly.

import { readFileSync } from 'node:fs';
import { validateTarVerboseListing } from './lib/catalog-import-core.mjs';

function fail(msg) {
  console.error(`validate-archive-listing: FAIL - ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
let listingPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--verbose-listing') {
    listingPath = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    process.stdout.write(
      'Usage: validate-archive-listing.mjs --verbose-listing <path-to-tar-tvzf-output>\n'
    );
    process.exit(0);
  } else {
    fail(`unknown argument: ${args[i]}`);
  }
}
if (!listingPath) fail('--verbose-listing <path> is required');

try {
  const text = readFileSync(listingPath, 'utf8');
  validateTarVerboseListing(text);
  console.log('validate-archive-listing: OK - no unsafe paths, symlinks, or hardlinks in archive listing.');
} catch (e) {
  fail(e && e.message ? e.message : String(e));
}
