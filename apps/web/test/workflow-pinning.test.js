import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WF_DIR = path.join(REPO_ROOT, '.github', 'workflows');

const SHA_RE = /^[0-9a-f]{40}$/;

// Extract every `uses: <owner>/<repo>@<ref>` entry from a workflow, ignoring
// trailing `# comments`. Matches both the standard
//   - name: ...
//     uses: owner/repo@ref
// layout and the single-line `- uses:` form. Returns [{ line, repo, ref }].
function extractUses(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-?\s*uses:\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)/);
    if (!m) continue;
    out.push({ line: i + 1, repo: m[1], ref: m[2] });
  }
  return out;
}

const workflows = existsSync(WF_DIR)
  ? readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort()
  : [];

test('the workflows directory contains workflow files', () => {
  assert.ok(workflows.length > 0, '.github/workflows must contain at least one workflow file');
});

// Every `uses:` entry in EVERY workflow -- first-party `actions/*` included --
// must be pinned to an immutable 40-character commit SHA. No moving version
// tags (@vN), no branch refs (@main). This is the immutable supply-chain guard.
test('every workflow pins all actions to immutable 40-char commit SHAs', () => {
  for (const file of workflows) {
    const text = readFileSync(path.join(WF_DIR, file), 'utf8');
    const uses = extractUses(text);
    assert.ok(uses.length > 0, `${file} must declare at least one \`uses:\` action`);
    for (const u of uses) {
      assert.ok(
        SHA_RE.test(u.ref),
        `${file}:${u.line} action ${u.repo} must be pinned to a 40-char commit SHA, found @${u.ref}`
      );
    }
  }
});
