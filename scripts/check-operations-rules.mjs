#!/usr/bin/env node
// Static guard for MJ-ART operations policy.
//
// Read-only, dependency-free, deterministic. Verifies:
//   1. The mandatory operations paragraph is present in README.md and
//      docs/OPERATIONS.md verbatim.
//   2. The read-only R2 workflow and its support script exist.
//   3. The workflow is workflow_dispatch-only, minimal permissions, uses only
//      the dedicated read token + account id, never the write token or admin
//      secrets, declares the required inputs, and contains no write commands.
//   4. The support script performs GET-only networking and uses no remote
//      mutation methods, no process launching, and no filesystem deletion APIs.
//
// Exit status is nonzero on the first (or any) failed assertion.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { findInputsInRunBlocks, findSecretsInRunBlocks } from './lib/catalog-import-core.mjs';

const ROOT = path.resolve(scriptDir(), '..');
const MANDATORY_PARAGRAPH =
  'MJ-ART deploys exclusively through GitHub Actions. Cloudflare credentials are GitHub Actions secrets and are not expected in the local shell. Read docs/OPERATIONS.md before proposing deployment, Cloudflare, Wrangler, or R2 work.';

function scriptDir() {
  const url = import.meta.url;
  return new URL('.', url).pathname.replace(/\/$/, '');
}

function readText(rel) {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

function fail(msg) {
  console.error('check-operations-rules: FAIL - ' + msg);
  process.exitCode = 1;
}

// ---- tiny YAML top-level `on:` trigger extractor ----
function extractOnTriggers(text) {
  const lines = text.split(/\r?\n/);
  let onLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^on:\s*$/.test(lines[i]) || /^on:\s* workflow_dispatch/.test(lines[i])) {
      onLineIdx = i;
      break;
    }
  }
  if (onLineIdx === -1) return null;
  const triggers = [];
  for (let i = onLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^[A-Za-z_]+:/.test(line)) break; // next top-level key
    const m = line.match(/^  ([A-Za-z_]+):\s*$/);
    if (m) triggers.push(m[1]);
  }
  return triggers;
}

function hasWorkflowLevelContentsRead(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^permissions:\s*$/.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        if (/^\S/.test(lines[j]) && lines[j].trim() !== '') break;
        if (/^\s+contents:\s*read\s*$/.test(lines[j])) return true;
      }
    }
  }
  return false;
}

// Policy: EVERY action -- first-party `actions/*` included -- must be pinned
// to a verified 40-character commit SHA. Version tags (@vN) and branch refs
// are mutable and are forbidden; this is the immutable supply-chain guard
// required for the deploy and read-only backup workflows.
function assertThirdPartyActionsPinned(wfPath, text) {
  if (text === null) return; // a missing workflow is reported by its own check
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-?\s*uses:\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)/);
    if (!m) continue;
    const ref = m[2];
    if (!/^[0-9a-f]{40}$/.test(ref)) {
      fail(wfPath + ' action ' + m[1] + ' must be pinned to a 40-char commit SHA (line ' + (i + 1) + '), found @' + ref);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      [
        'check-operations-rules.mjs - static guard for MJ-ART operations policy',
        '',
        'Usage: node scripts/check-operations-rules.mjs [--help]',
        '',
        'Exits nonzero if any policy assertion fails. Read-only; no network access.'
      ].join('\n') + '\n'
    );
    return;
  }

  // 1) Mandatory paragraph in README.md and docs/OPERATIONS.md.
  const readme = readText('README.md');
  if (readme === null) {
    fail('README.md is missing');
  } else if (!readme.includes(MANDATORY_PARAGRAPH)) {
    fail('README.md is missing the mandatory operations paragraph (verbatim).');
  }

  const ops = readText('docs/OPERATIONS.md');
  if (ops === null) {
    fail('docs/OPERATIONS.md is missing');
  } else if (!ops.includes(MANDATORY_PARAGRAPH)) {
    fail('docs/OPERATIONS.md is missing the mandatory operations paragraph (verbatim).');
  }

  // 2) Required files exist.
  const workflowPath = '.github/workflows/r2-readonly-backup.yml';
  const scriptPath = 'scripts/r2-readonly-backup.mjs';
  const workflow = readText(workflowPath);
  const script = readText(scriptPath);
  if (workflow === null) fail(workflowPath + ' is missing');
  if (script === null) fail(scriptPath + ' is missing');
  if (process.exitCode) return;

  // 3) Workflow assertions.
  const triggers = extractOnTriggers(workflow);
  if (triggers === null) {
    fail(workflowPath + ' has no top-level on: trigger block');
  } else {
    const forbidden = ['push', 'pull_request', 'schedule', 'repository_dispatch', 'workflow_run', 'workflow_call'];
    const presentForbidden = triggers.filter((t) => forbidden.includes(t));
    if (presentForbidden.length) {
      fail(workflowPath + ' must be workflow_dispatch only; found triggers: ' + triggers.join(', '));
    }
    const only = triggers.length === 1 && triggers[0] === 'workflow_dispatch';
    if (!only) {
      fail(workflowPath + ' must declare only workflow_dispatch; found: ' + triggers.join(', '));
    }
  }

  if (!hasWorkflowLevelContentsRead(workflow)) {
    fail(workflowPath + ' must declare workflow-level permissions with contents: read');
  }

  // All third-party actions used here must be pinned to a verified SHA.
  assertThirdPartyActionsPinned(workflowPath, workflow);

  // The prerequisite gate must not be conditional on secrets. GitHub Actions
  // does not safely evaluate secrets.* inside `if:` expressions, so any step
  // `if:` that references secrets.* is a policy violation.
  const wfLines = workflow.split(/\r?\n/);
  for (let i = 0; i < wfLines.length; i++) {
    if (/^\s*if:/.test(wfLines[i]) && /secrets\./i.test(wfLines[i])) {
      fail(workflowPath + ' must not reference secrets.* in a step if: condition (line ' + (i + 1) + ')');
    }
  }

  // The workflow must declare an explicit, always-running prerequisite shell
  // gate using strict mode that references the out-of-band confirmation input
  // and the maintainer repo-variable attestation.
  if (!/set -euo pipefail/.test(workflow)) {
    fail(workflowPath + ' must declare a prerequisite shell gate using "set -euo pipefail"');
  }
  if (!/CLOUDFLARE_R2_READ_TOKEN_CONFIRMED/.test(workflow)) {
    fail(workflowPath + ' prerequisite gate must reference the CLOUDFLARE_R2_READ_TOKEN_CONFIRMED repo variable');
  }
  if (!/confirm_read_only_scope/.test(workflow)) {
    fail(workflowPath + ' prerequisite gate must reference the confirm_read_only_scope confirmation input');
  }

  const reqRefs = [
    '${{ secrets.CLOUDFLARE_R2_READ_TOKEN }}',
    '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}'
  ];
  for (const ref of reqRefs) {
    if (!workflow.includes(ref)) {
      fail(workflowPath + ' must reference ' + ref);
    }
  }

  const forbiddenRefs = [
    '${{ secrets.CLOUDFLARE_API_TOKEN }}',
    'ADMIN_PASSWORD',
    'ADMIN_SESSION_SECRET'
  ];
  for (const ref of forbiddenRefs) {
    if (workflow.includes(ref)) {
      fail(workflowPath + ' must not reference ' + ref);
    }
  }

  for (const inputName of ['download_backup', 'confirm_read_only_scope']) {
    if (!new RegExp('^\\s+' + inputName + ':', 'm').test(workflow)) {
      fail(workflowPath + ' must declare input ' + inputName);
    }
  }

  const forbiddenCommands = [
    /\bwrangler\b/i,
    /secret\s+put/i,
    /r2\s+bucket\s+create/i,
    /r2\s+object\s+put/i,
    /r2\s+object\s+delete/i,
    /\bdeploy\b/i
  ];
  for (const re of forbiddenCommands) {
    if (re.test(workflow)) {
      fail(workflowPath + ' must not contain write/deploy command matching ' + re);
    }
  }

  // 4) Support script assertions: GET-only networking, no mutation methods,
  //    no process launching, no filesystem deletion APIs.
  const scriptForbidden = [
    { re: /\b(POST|PUT|PATCH|DELETE)\b/, why: 'remote mutation HTTP method' },
    { re: /\bchild_process\b/, why: 'process module' },
    { re: /\bspawn\b/, why: 'process launching' },
    { re: /\bexec(?:File|Sync)?\b/, why: 'process launching' },
    { re: /unlinkSync|rmSync|rmdirSync|\.unlink\(|\.rmdir\(|\.rm\(/, why: 'filesystem deletion API' }
  ];
  for (const { re, why } of scriptForbidden) {
    if (re.test(script)) {
      fail(scriptPath + ' must not use ' + why + ' (matched ' + re + ')');
    }
  }
  if (!/method:\s*'GET'/.test(script)) {
    fail(scriptPath + " must issue GET network requests via method: 'GET'");
  }

  // 5) Active deploy workflow assertions: deployment is manual-only.
  //    push/pull_request must still run checks, but the deploy job must be
  //    gated to workflow_dispatch only, with preview as the default and no
  //    automatic production fallback or implicit else->production path.
  const deployWfPath = '.github/workflows/deploy-cloudflare.yml';
  const deployWf = readText(deployWfPath);
  if (deployWf === null) {
    fail(deployWfPath + ' is missing');
  } else {
    // The deploy workflow runs on push/PR too (the check job), so it must
    // declare least-repo permissions explicitly at the workflow level.
    if (!hasWorkflowLevelContentsRead(deployWf)) {
      fail(deployWfPath + ' must declare workflow-level permissions with contents: read');
    }
    // All third-party actions used here must be pinned to a verified SHA.
    assertThirdPartyActionsPinned(deployWfPath, deployWf);

    // push, pull_request, and workflow_dispatch triggers must all be declared
    // so push/PR validation is preserved while deployment stays manual.
    const deployTriggers = extractOnTriggers(deployWf);
    if (deployTriggers === null) {
      fail(deployWfPath + ' has no top-level on: trigger block');
    } else {
      for (const required of ['push', 'pull_request', 'workflow_dispatch']) {
        if (!deployTriggers.includes(required)) {
          fail(deployWfPath + ' must declare the ' + required + ' trigger');
        }
      }
    }

    // Manual deploy default must be preview, never production.
    if (!/^(\s*)default:\s*'?preview'?\s*$/m.test(deployWf)) {
      fail(deployWfPath + " workflow_dispatch environment input must default to 'preview'");
    }
    if (/default:\s*'?production'?\s*$/m.test(deployWf)) {
      fail(deployWfPath + " workflow_dispatch environment input must not default to 'production'");
    }

    // The deploy job if: condition (4-space job-level indent) must be gated to
    // workflow_dispatch only and must not reference push.
    const deployIf = deployWf.match(/^    if:\s*(.+)$/m);
    if (!deployIf) {
      fail(deployWfPath + ' deploy job must declare a job-level if: condition');
    } else {
      const cond = deployIf[1];
      if (!/workflow_dispatch/.test(cond)) {
        fail(deployWfPath + ' deploy job if: must be gated to workflow_dispatch only');
      }
      if (/\bpush\b/.test(cond)) {
        fail(deployWfPath + ' deploy job if: must not be triggered by push (manual deploy only)');
      }
    }

    // Job environment must come from inputs with no implicit production fallback.
    if (!/inputs\.environment/.test(deployWf)) {
      fail(deployWfPath + ' must set the deploy environment from inputs.environment');
    }
    if (/\|\|\s*'?production'?/.test(deployWf)) {
      fail(deployWfPath + " must not fall back to 'production' for the deploy environment");
    }

    // Environment selection must use an explicit case over the supported targets
    // (preview/production). No implicit else->production fallback may remain.
    if (!/case\s+[^;]*inputs\.environment/.test(deployWf)) {
      fail(deployWfPath + ' must select environment via an explicit case on inputs.environment');
    }
    if (/\belse\b/.test(deployWf)) {
      fail(deployWfPath + ' must use explicit case targets (preview/production), no else fallback');
    }
  }

  // 6) Catalogue import (preview-only) workflow + support scripts.
  //    This workflow WRITES to R2 (unlike the read-only backup), so it must be
  //    workflow_dispatch only, hard-target the PREVIEW bucket literal, and never
  //    reference the production bucket, production environment, or admin secrets.
  const importWfPath = '.github/workflows/catalog-import.yml';
  const importWf = readText(importWfPath);
  if (importWf === null) {
    fail(importWfPath + ' is missing');
  } else {
    const importTriggers = extractOnTriggers(importWf);
    if (importTriggers === null) {
      fail(importWfPath + ' has no top-level on: trigger block');
    } else {
      const forbidden = ['push', 'pull_request', 'schedule', 'repository_dispatch', 'workflow_run', 'workflow_call'];
      const presentForbidden = importTriggers.filter((t) => forbidden.includes(t));
      if (presentForbidden.length) {
        fail(importWfPath + ' must be workflow_dispatch only; found: ' + importTriggers.join(', '));
      }
      if (!(importTriggers.length === 1 && importTriggers[0] === 'workflow_dispatch')) {
        fail(importWfPath + ' must declare only workflow_dispatch; found: ' + importTriggers.join(', '));
      }
    }

    if (!hasWorkflowLevelContentsRead(importWf)) {
      fail(importWfPath + ' must declare workflow-level permissions with contents: read');
    }
    if (!/set -euo pipefail/.test(importWf)) {
      fail(importWfPath + ' must declare a prerequisite shell gate using "set -euo pipefail"');
    }

    // No secrets.* may appear in a step if: condition (GitHub Actions does not
    // safely evaluate secrets in if:).
    const importWfLines = importWf.split(/\r?\n/);
    for (let i = 0; i < importWfLines.length; i++) {
      if (/^\s*if:/.test(importWfLines[i]) && /secrets\./i.test(importWfLines[i])) {
        fail(importWfPath + ' must not reference secrets.* in a step if: condition (line ' + (i + 1) + ')');
      }
    }

    // Required confirmation + version-select inputs. The old transport-URL
    // inputs (assets_archive_url / assets_archive_sha256) are intentionally
    // forbidden now: masters are fetched from the VPS by version token only.
    for (const inputName of ['confirm_preview_only', 'master_archive_version', 'execute_upload']) {
      if (!new RegExp('^\\s+' + inputName + ':', 'm').test(importWf)) {
        fail(importWfPath + ' must declare input ' + inputName);
      }
    }
    for (const forbiddenInput of ['assets_archive_url', 'assets_archive_sha256']) {
      if (importWf.includes(forbiddenInput)) {
        fail(importWfPath + ' must not declare the removed transport input ' + forbiddenInput);
      }
    }
    if (!/confirm_preview_only/.test(importWf)) {
      fail(importWfPath + ' must reference the confirm_preview_only confirmation input');
    }

    // Out-of-band VPS attestation: a maintainer repo variable must gate every
    // run (mirrors the read-only token confirmation pattern).
    if (!/vars\.VPS_ASSETS_CONFIRMED/.test(importWf)) {
      fail(importWfPath + ' prerequisite gate must reference vars.VPS_ASSETS_CONFIRMED');
    }

    // No archive/write URL may appear anywhere: masters are VPS-fetched by
    // version token, and the public upload is the R2 account+token (no URL).
    if (/[a-z][a-z0-9+.-]*:\/\//i.test(importWf)) {
      fail(importWfPath + ' must not contain any protocol URL (no archive or write URL)');
    }

    // PREVIEW bucket literal must be present; the production bucket must NEVER
    // appear. Negative lookahead: "mj-art-images" not immediately followed by
    // "-preview" is a production-bucket leak.
    if (!/mj-art-images-preview/.test(importWf)) {
      fail(importWfPath + ' must reference the preview bucket literal mj-art-images-preview');
    }
    if (/mj-art-images(?!-preview)/.test(importWf)) {
      fail(importWfPath + ' must not reference the production bucket (mj-art-images without -preview)');
    }

    // No production environment / production deploy paths.
    if (/--env\s+production/.test(importWf)) {
      fail(importWfPath + ' must not target a production environment');
    }
    if (/environment:\s*production/.test(importWf)) {
      fail(importWfPath + ' must not declare a production environment');
    }

    // The execute step must be gated on the execute_upload input (not secrets),
    // and write credentials must be the deployment convention only.
    if (!/inputs\.execute_upload/.test(importWf)) {
      fail(importWfPath + ' must gate the upload step on inputs.execute_upload');
    }
    const importReqRefs = [
      '${{ secrets.CLOUDFLARE_API_TOKEN }}',
      '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}'
    ];
    for (const ref of importReqRefs) {
      if (!importWf.includes(ref)) {
        fail(importWfPath + ' must reference ' + ref + ' for the preview upload step');
      }
    }
    const importForbiddenRefs = [
      'ADMIN_PASSWORD',
      'ADMIN_SESSION_SECRET',
      'CLOUDFLARE_R2_READ_TOKEN'
    ];
    for (const ref of importForbiddenRefs) {
      if (importWf.includes(ref)) {
        fail(importWfPath + ' must not reference ' + ref);
      }
    }

    // VPS connection material: required repo variables + secrets, referenced
    // exclusively through env: (never interpolated in a run script). The exact
    // remote basename is constructed from the validated version only.
    const vpsVarRefs = [
      '${{ vars.VPS_HOST }}',
      '${{ vars.VPS_PORT }}',
      '${{ vars.VPS_USER }}',
      '${{ vars.VPS_MASTER_ROOT }}',
      '${{ vars.VPS_ASSETS_CONFIRMED }}'
    ];
    for (const ref of vpsVarRefs) {
      if (!importWf.includes(ref)) {
        fail(importWfPath + ' must reference ' + ref);
      }
    }
    const vpsSecretRefs = [
      '${{ secrets.VPS_SSH_PRIVATE_KEY }}',
      '${{ secrets.VPS_KNOWN_HOSTS }}'
    ];
    for (const ref of vpsSecretRefs) {
      if (!importWf.includes(ref)) {
        fail(importWfPath + ' must reference ' + ref);
      }
    }
    // The exact remote archive basename must be constructed from the version
    // token (so it can never carry an injected path), not supplied as input.
    if (!/mj-art-master-\$\{?MASTER_VERSION\}?/.test(importWf) && !/mj-art-master-\$\{MASTER_VERSION\}/.test(importWf)) {
      fail(importWfPath + ' must build the remote basename from MASTER_VERSION (mj-art-master-${MASTER_VERSION})');
    }

    // No raw ${{ inputs.* }} may be interpolated inside any step run: script.
    // Inputs must flow through env: (then quoted shell vars) so an
    // attacker-controlled input value can never become shell syntax. Values in
    // env:/if:/with: are not run-script interpolation and are permitted.
    const inputInRun = findInputsInRunBlocks(importWf);
    for (const hit of inputInRun) {
      fail(importWfPath + ' must not interpolate ${{ inputs.* }} in a run script (line ' + hit.line + ')');
    }

    // No raw ${{ secrets.* }} may be interpolated inside any step run: script
    // either. Secrets must flow through env: so a value can never leak into a
    // command line or log line.
    const secretInRun = findSecretsInRunBlocks(importWf);
    for (const hit of secretInRun) {
      fail(importWfPath + ' must not interpolate ${{ secrets.* }} in a run script (line ' + hit.line + ')');
    }

    // Third-party actions must be pinned to full 40-char commit SHAs (not @vN).
    const usesLines = importWf.split(/\r?\n/).filter((l) => /^\s*uses:\s*[^{]*\S/.test(l));
    for (const line of usesLines) {
      const m = line.match(/uses:\s*([^#\s]+)\s*(?:#.*)?$/);
      if (!m) continue;
      const ref = m[1];
      const actionRef = ref.split('@')[1] || '';
      if (!/^[0-9a-f]{40}$/.test(actionRef)) {
        fail(importWfPath + ' must pin actions to 40-char SHAs, found: ' + ref.trim());
      }
    }
  }

  // Support scripts for the catalogue import.
  const genPath = 'scripts/generate-catalog-derivatives.mjs';
  const importScriptPath = 'scripts/import-catalog-preview.mjs';
  const corePath = 'scripts/lib/catalog-import-core.mjs';
  const archiveValidatorPath = 'scripts/validate-archive-listing.mjs';
  const masterVerifyPath = 'scripts/verify-master-archive.mjs';
  const genScript = readText(genPath);
  const importScript = readText(importScriptPath);
  const coreLib = readText(corePath);
  const archiveValidator = readText(archiveValidatorPath);
  const masterVerify = readText(masterVerifyPath);
  if (genScript === null) fail(genPath + ' is missing');
  if (importScript === null) fail(importScriptPath + ' is missing');
  if (coreLib === null) fail(corePath + ' is missing');
  if (archiveValidator === null) fail(archiveValidatorPath + ' is missing');
  if (masterVerify === null) fail(masterVerifyPath + ' is missing');
  if (importScript !== null) {
    if (!/assertPreviewBucket/.test(importScript)) {
      fail(importScriptPath + ' must call assertPreviewBucket before any upload');
    }
    if (/mj-art-images(?!-preview)/.test(importScript)) {
      fail(importScriptPath + ' must not embed the production bucket literal');
    }
    // Metadata readback must verify exact hash/bytes, not only parsed count.
    if (!/verifyArtworksReadback/.test(importScript)) {
      fail(importScriptPath + ' must verify artworks.json readback by hash (verifyArtworksReadback)');
    }
  }
  if (coreLib !== null) {
    if (!/assertPreviewBucket/.test(coreLib) || !/mj-art-images-preview/.test(coreLib)) {
      fail(corePath + ' must define the preview-only bucket guard');
    }
    // VPS master-assets helpers must be defined here (unit-tested, reused by
    // the verify script).
    for (const sym of ['MASTER_VERSION_RE', 'masterArchiveBasename', 'parseMasterSidecar', 'isSafeVpsMasterRoot', 'findSecretsInRunBlocks']) {
      if (!new RegExp('\\b' + sym + '\\b').test(coreLib)) {
        fail(corePath + ' must define/export ' + sym);
      }
    }
  }
  if (masterVerify !== null) {
    // The verifier must parse the sidecar strictly and re-hash the archive; it
    // must NOT shell out to `sha256sum -c` (which would read an untrusted path).
    if (!/parseMasterSidecar/.test(masterVerify)) {
      fail(masterVerifyPath + ' must parse the sidecar via parseMasterSidecar');
    }
    if (/sha256sum\s+-c/.test(masterVerify)) {
      fail(masterVerifyPath + ' must not invoke sha256sum -c on the sidecar');
    }
    if (!/createHash\('sha256'\)/.test(masterVerify) && !/createHash\("sha256"\)/.test(masterVerify)) {
      fail(masterVerifyPath + ' must re-hash the archive with createHash');
    }
  }
  if (genScript !== null) {
    // ImageMagick invocations must apply resource limits and a source size cap.
    if (!/-limit/.test(genScript)) {
      fail(genPath + ' must apply ImageMagick -limit resource controls');
    }
    if (!/SOURCE_MAX_BYTES/.test(genScript)) {
      fail(genPath + ' must enforce a source file size cap before decode');
    }
    if (!/SOURCE_MAX_DIMENSION/.test(genScript)) {
      fail(genPath + ' must enforce a source dimension cap before decode');
    }
  }

  // 7) VPS fetch-access setup script invariants (robust fail-closed forced-SFTP).
  //    The script must enforce ForceCommand internal-sftp at the sshd level via a
  //    narrow drop-in Match snippet that is validated before reload and rolled
  //    back on failure. It must never write to the main /etc/ssh/sshd_config.
  const setupScriptPath = 'scripts/setup-mjart-vps-fetch-access.sh';
  const setupScript = readText(setupScriptPath);
  if (setupScript === null) {
    fail(setupScriptPath + ' is missing');
  } else {
    if (!/Match\s+User\s+\$\{?FETCH_USER\}?/.test(setupScript) && !/Match\s+User\s+mjart-fetch/.test(setupScript)) {
      fail(setupScriptPath + ' must define a "Match User" block for the fetch account');
    }
    if (!/ForceCommand\s+internal-sftp\b/.test(setupScript)) {
      fail(setupScriptPath + ' must ForceCommand internal-sftp in the sshd Match block');
    }
    if (!/DisableForwarding\s+yes/.test(setupScript)) {
      fail(setupScriptPath + ' Match block must set DisableForwarding yes');
    }
    if (!/PermitTTY\s+no/.test(setupScript)) {
      fail(setupScriptPath + ' Match block must set PermitTTY no');
    }
    // Must validate the full config with sshd -t before reload.
    if (!/SSH_BIN"\s+-t\b/.test(setupScript)) {
      fail(setupScriptPath + ' must validate sshd config with sshd -t before reload');
    }
    // Must verify effective per-user state with sshd -T -C.
    if (!/SSH_BIN"\s+-T\s+-C/.test(setupScript)) {
      fail(setupScriptPath + ' must verify effective settings with sshd -T -C');
    }
    // Must implement rollback (restore prior snippet incl. absent state).
    if (!/rollback_snippet/.test(setupScript)) {
      fail(setupScriptPath + ' must implement rollback_snippet of the snippet on failure');
    }
    // Must use the sshd_config.d drop-in dir.
    if (!/sshd_config\.d/.test(setupScript)) {
      fail(setupScriptPath + ' must use a sshd_config.d drop-in snippet');
    }
    // Must NOT redirect/write to the main /etc/ssh/sshd_config (reads are allowed;
    // writes must go through sshd_config.d). Negative lookahead excludes ".d".
    if (/(>>?)\s*\/etc\/ssh\/sshd_config(?!\.)/.test(setupScript)) {
      fail(setupScriptPath + ' must not redirect/write to the main /etc/ssh/sshd_config');
    }
    // Must prove global effective config does not drift when the snippet is added.
    if (!/sshd_global\.before/.test(setupScript) || !/sshd_global\.after/.test(setupScript)) {
      fail(setupScriptPath + ' must compare global sshd -T before/after the snippet (no drift)');
    }

    // ~/.ssh and authorized_keys must be ACCOUNT-owned (mjart-fetch), not
    // root-owned. sshd reads authorized_keys as the target user (it drops to
    // that uid before opening the file), so a root-owned 0600 authorized_keys
    // is unreadable by the account -> "Could not open authorized keys ...
    // Permission denied" and pubkey auth fails closed. Stock OpenSSH under
    // StrictModes (the default) requires these files to be account-owned (or
    // root) and not group/other-writable; we require account ownership and
    // forbid the root-owned regression to 0600.
    if (!/install\s+-d\s+-m\s+0700\s+-o\s+"\$\{?FETCH_USER\}?"\s+-g\s+"\$\{?FETCH_USER\}?"\s+"\$\{?FETCH_HOME\}?\/\.ssh"/.test(setupScript)) {
      fail(setupScriptPath + ' must create ~/.ssh as account-owned (install -d -m 0700 -o "$FETCH_USER" -g "$FETCH_USER" "$FETCH_HOME/.ssh"), not root-owned, so sshd can read keys as the user');
    }
    if (!/chown\s+"\$\{?FETCH_USER\}?:\$\{?FETCH_USER\}?"\s+"\$\{?FETCH_HOME\}?\/\.ssh\/authorized_keys\.new"/.test(setupScript)) {
      fail(setupScriptPath + ' must chown authorized_keys to the fetch account ("$FETCH_USER:$FETCH_USER"), not root, so sshd can read it as the user');
    }
    // Forbid the regression: a root-owned .ssh or authorized_keys.
    if (/install\s+-d\s+-m\s+0700\s+-o\s+root\s+-g\s+root\s+"\$\{?FETCH_HOME\}?\/\.ssh"/.test(setupScript)) {
      fail(setupScriptPath + ' must NOT create ~/.ssh as root-owned 0700 (root ownership blocks sshd reading authorized_keys as the user -> Permission denied)');
    }
    if (/chown\s+root:root\s+"\$\{?FETCH_HOME\}?\/\.ssh\/authorized_keys/.test(setupScript)) {
      fail(setupScriptPath + ' must NOT chown authorized_keys to root (root-owned 0600 is unreadable by the account under StrictModes -> Permission denied)');
    }
    // Must enforce the exact ownership/mode invariant at runtime (exact-config
    // check that fails closed on drift back to root-owned 0600).
    if (!/stat\s+-c\s+'%U:%G'\s+"\$\{?FETCH_HOME\}?\/\.ssh\/authorized_keys"/.test(setupScript)) {
      fail(setupScriptPath + ' must assert authorized_keys ownership at runtime (stat -c \'%U:%G\' "$FETCH_HOME/.ssh/authorized_keys") to prevent regression to root-owned');
    }
  }

  // 8) Production catalogue promotion workflow + support scripts.
  //    This workflow is the ONLY place that may write the canonical catalogue
  //    to the PRODUCTION bucket. It must be workflow_dispatch only, hard-pin the
  //    source (preview) and destination (production) literals, require the exact
  //    confirmation boolean + phrase, create a fresh verified production backup
  //    (read token) before any write token is exposed, gate the write on the
  //    execute input, and contain no delete commands or admin secrets.
  const promoteWfPath = '.github/workflows/catalog-promote-production.yml';
  const promoteWf = readText(promoteWfPath);
  if (promoteWf === null) {
    fail(promoteWfPath + ' is missing');
  } else {
    const promoteTriggers = extractOnTriggers(promoteWf);
    if (promoteTriggers === null) {
      fail(promoteWfPath + ' has no top-level on: trigger block');
    } else {
      const forbidden = ['push', 'pull_request', 'schedule', 'repository_dispatch', 'workflow_run', 'workflow_call'];
      const presentForbidden = promoteTriggers.filter((t) => forbidden.includes(t));
      if (presentForbidden.length) {
        fail(promoteWfPath + ' must be workflow_dispatch only; found: ' + promoteTriggers.join(', '));
      }
      if (!(promoteTriggers.length === 1 && promoteTriggers[0] === 'workflow_dispatch')) {
        fail(promoteWfPath + ' must declare only workflow_dispatch; found: ' + promoteTriggers.join(', '));
      }
    }

    if (!hasWorkflowLevelContentsRead(promoteWf)) {
      fail(promoteWfPath + ' must declare workflow-level permissions with contents: read');
    }
    if (!/set -euo pipefail/.test(promoteWf)) {
      fail(promoteWfPath + ' must declare a prerequisite shell gate using "set -euo pipefail"');
    }
    // No secrets.* in any step if: condition.
    const promoteWfLines = promoteWf.split(/\r?\n/);
    for (let i = 0; i < promoteWfLines.length; i++) {
      if (/^\s*if:/.test(promoteWfLines[i]) && /secrets\./i.test(promoteWfLines[i])) {
        fail(promoteWfPath + ' must not reference secrets.* in a step if: condition (line ' + (i + 1) + ')');
      }
    }

    // Required dispatch inputs (confirmation boolean + phrase + manifest hash +
    // production drift count + content-exact production fingerprint + execute flag).
    for (const inputName of [
      'confirm_promote_to_production',
      'confirmation_phrase',
      'release_manifest_sha256',
      'expected_production_object_count',
      'expected_production_inventory_fingerprint',
      'execute_promotion'
    ]) {
      if (!new RegExp('^\\s+' + inputName + ':', 'm').test(promoteWf)) {
        fail(promoteWfPath + ' must declare input ' + inputName);
      }
    }

    // The maintainer out-of-band read-scope attestation (repo VARIABLE, never a
    // secret) must be referenced via env and validated == 'true' in the gate. It
    // must never appear inside an if:/raw expression.
    if (!/vars\.CLOUDFLARE_R2_READ_TOKEN_CONFIRMED/.test(promoteWf)) {
      fail(promoteWfPath + ' prerequisite gate must read vars.CLOUDFLARE_R2_READ_TOKEN_CONFIRMED via env');
    }
    // The actual enforcement: a shell comparison of the env var against "true".
    if (!/TOKEN_CONFIRMED_VAR.*!=.*"true"/.test(promoteWf)) {
      fail(promoteWfPath + ' prerequisite gate must compare CLOUDFLARE_R2_READ_TOKEN_CONFIRMED to "true" and fail closed');
    }
    // The content-exact production fingerprint must be shape-validated (64 hex) in
    // the gate and passed to the promotion client.
    if (!/expected_production_inventory_fingerprint must be 64 lowercase hex/.test(promoteWf)) {
      fail(promoteWfPath + ' prerequisite gate must validate expected_production_inventory_fingerprint as 64 lowercase hex');
    }

    // The exact strong confirmation phrase must appear and be gated on.
    if (!/I-CONFIRM-PRODUCTION-CATALOGUE-PROMOTION/.test(promoteWf)) {
      fail(promoteWfPath + ' must reference the exact promotion phrase I-CONFIRM-PRODUCTION-CATALOGUE-PROMOTION');
    }
    if (!/confirm_promote_to_production/.test(promoteWf)) {
      fail(promoteWfPath + ' must reference the confirm_promote_to_production confirmation input');
    }
    if (!/inputs\.execute_promotion/.test(promoteWf)) {
      fail(promoteWfPath + ' must gate the execute step on inputs.execute_promotion');
    }

    // Source/destination literals are fixed and non-invertible. Both must appear;
    // preview is the read-only source, production the write destination.
    if (!/mj-art-images-preview/.test(promoteWf)) {
      fail(promoteWfPath + ' must reference the preview source bucket literal mj-art-images-preview');
    }
    if (!/mj-art-images(?!-preview)/.test(promoteWf)) {
      fail(promoteWfPath + ' must reference the production destination bucket literal mj-art-images');
    }
    if (!/SOURCE_BUCKET:\s*mj-art-images-preview/.test(promoteWf)) {
      fail(promoteWfPath + ' must define SOURCE_BUCKET: mj-art-images-preview');
    }
    if (!/DESTINATION_BUCKET:\s*mj-art-images(?!-preview)/.test(promoteWf)) {
      fail(promoteWfPath + ' must define DESTINATION_BUCKET: mj-art-images (production)');
    }

    // Read token is used for the backup; the write token is exposed ONLY on the
    // promotion-execute step (never the backup step). Admin secrets are forbidden.
    if (!promoteWf.includes('${{ secrets.CLOUDFLARE_R2_READ_TOKEN }}')) {
      fail(promoteWfPath + ' must reference the read token for the backup step');
    }
    if (!promoteWf.includes('${{ secrets.CLOUDFLARE_API_TOKEN }}')) {
      fail(promoteWfPath + ' must reference the write token for the execute step');
    }
    for (const ref of ['ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET']) {
      if (promoteWf.includes(ref)) {
        fail(promoteWfPath + ' must not reference admin secret ' + ref);
      }
    }

    // No delete commands anywhere (legacy production objects are never deleted).
    if (/r2\s+object\s+delete/i.test(promoteWf)) {
      fail(promoteWfPath + ' must not contain any r2 object delete command');
    }

    // No raw inputs.* or secrets.* interpolated inside any step run: script.
    const promoteInputInRun = findInputsInRunBlocks(promoteWf);
    for (const hit of promoteInputInRun) {
      fail(promoteWfPath + ' must not interpolate ${{ inputs.* }} in a run script (line ' + hit.line + ')');
    }
    const promoteSecretInRun = findSecretsInRunBlocks(promoteWf);
    for (const hit of promoteSecretInRun) {
      fail(promoteWfPath + ' must not interpolate ${{ secrets.* }} in a run script (line ' + hit.line + ')');
    }

    // Third-party actions pinned to full 40-char commit SHAs.
    const promoteUsesLines = promoteWf.split(/\r?\n/).filter((l) => /^\s*uses:\s*[^{]*\S/.test(l));
    for (const line of promoteUsesLines) {
      const m = line.match(/uses:\s*([^#\s]+)\s*(?:#.*)?$/);
      if (!m) continue;
      const ref = m[1];
      const actionRef = ref.split('@')[1] || '';
      if (!/^[0-9a-f]{40}$/.test(actionRef)) {
        fail(promoteWfPath + ' must pin actions to 40-char SHAs, found: ' + ref.trim());
      }
    }

    // Concurrency + timeout must be declared (production promotions must not be
    // cancelled mid-flight, and must have a bounded runtime).
    if (!/concurrency:/.test(promoteWf)) {
      fail(promoteWfPath + ' must declare a concurrency group');
    }
    if (!/cancel-in-progress:\s*false/.test(promoteWf)) {
      fail(promoteWfPath + ' must not allow cancel-in-progress on a production promotion');
    }
    if (!/timeout-minutes:/.test(promoteWf)) {
      fail(promoteWfPath + ' must declare a timeout-minutes');
    }
  }

  // 8b) Promotion client script invariants: fixed source/dest literals,
  //     dry-run default, exact confirmation phrase, no delete path.
  const promoteScriptPath = 'scripts/promote-catalog-production.mjs';
  const promoteScript = readText(promoteScriptPath);
  if (promoteScript === null) {
    fail(promoteScriptPath + ' is missing');
  } else {
    if (!/\bSOURCE_BUCKET\b/.test(promoteScript)) {
      fail(promoteScriptPath + ' must reference the fixed SOURCE_BUCKET constant');
    }
    if (!/\bDESTINATION_BUCKET\b/.test(promoteScript)) {
      fail(promoteScriptPath + ' must reference the fixed DESTINATION_BUCKET constant');
    }
    // The script must NOT redefine the buckets as swappable local string literals
    // (the only literal definitions live in the core module, checked below). It
    // must reference the imported constants instead.
    if (/\b(?:const|let|var)\s+SOURCE_BUCKET\s*=\s*['"]/.test(promoteScript)) {
      fail(promoteScriptPath + ' must not redefine SOURCE_BUCKET as a local literal (import the fixed constant)');
    }
    if (/\b(?:const|let|var)\s+DESTINATION_BUCKET\s*=\s*['"]/.test(promoteScript)) {
      fail(promoteScriptPath + ' must not redefine DESTINATION_BUCKET as a local literal (import the fixed constant)');
    }
    if (!/DRY-RUN/.test(promoteScript)) {
      fail(promoteScriptPath + ' must be dry-run by default (DRY-RUN marker)');
    }
    if (!/--execute/.test(promoteScript)) {
      fail(promoteScriptPath + ' must require --execute for writes');
    }
    if (!/PROMOTION_CONFIRM_PHRASE/.test(promoteScript)) {
      fail(promoteScriptPath + ' must define the exact promotion confirmation phrase');
    }
    // No R2 delete commands (legacy production objects are never deleted). Temp
    // cleanup of the runner's own scratch dir with rmSync is permitted, mirroring
    // the preview import client; the guard targets R2 object deletion only.
    if (/r2\s+object\s+delete/i.test(promoteScript)) {
      fail(promoteScriptPath + ' must not contain any r2 object delete command');
    }
    // The handshake helpers (backup-gated writes) must be invoked.
    if (!/verifyProductionBackupHandshake/.test(promoteScript)) {
      fail(promoteScriptPath + ' must call verifyProductionBackupHandshake before any production write');
    }
    if (!/verifyPreviewInventoryMatchesRelease/.test(promoteScript)) {
      fail(promoteScriptPath + ' must call verifyPreviewInventoryMatchesRelease (reject missing/extra preview objects)');
    }
    // The content-exact production drift guard: the client must require the
    // operator-pinned production inventory fingerprint and enforce it via the
    // handshake (count match + fingerprint mismatch must fail closed).
    if (!/--expected-production-fingerprint/.test(promoteScript)) {
      fail(promoteScriptPath + ' must require --expected-production-fingerprint (content-exact production drift guard)');
    }
    if (!/\binventoryFingerprint\b/.test(promoteScript)) {
      fail(promoteScriptPath + ' must compute inventoryFingerprint to report/verify the production fingerprint');
    }
    // Images must upload before artworks.json (metadata-last ordering).
    if (!/artworks.json LAST|Publishing approved artworks.json.*LAST|artworks\.json.*LAST/i.test(promoteScript)) {
      fail(promoteScriptPath + ' must publish artworks.json LAST (after images)');
    }
  }

  // 8c) Tracked release manifest + pure helpers must exist and be internally
  //     consistent in shape (full validation is in the release-manifest tests).
  const releaseManifestPath = 'catalog/production-release-manifest.json';
  const releaseManifest = readText(releaseManifestPath);
  if (releaseManifest === null) {
    fail(releaseManifestPath + ' is missing');
  } else {
    if (!/"schemaVersion":\s*1/.test(releaseManifest)) {
      fail(releaseManifestPath + ' must declare schemaVersion 1');
    }
    if (!/"manifestKind":\s*"mj-art-production-catalogue-release"/.test(releaseManifest)) {
      fail(releaseManifestPath + ' must declare the production-catalogue-release manifestKind');
    }
    if (!/"expectedObjectCount":\s*173/.test(releaseManifest)) {
      fail(releaseManifestPath + ' must pin exactly 173 expected objects');
    }
    // No local paths, etags, timestamps, or secrets may be committed.
    for (const forbidden of [/backupPath/i, /etag/i, /lastModified/i, /\.local-assets/, /\/tmp\//, /token/i, /secret/i, /password/i]) {
      if (forbidden.test(releaseManifest)) {
        fail(releaseManifestPath + ' must not contain forbidden field/pattern ' + forbidden);
      }
    }
  }
  const releaseCorePath = 'scripts/lib/release-manifest-core.mjs';
  const releaseGenPath = 'scripts/generate-production-release-manifest.mjs';
  if (readText(releaseCorePath) === null) fail(releaseCorePath + ' is missing');
  if (readText(releaseGenPath) === null) fail(releaseGenPath + ' is missing');
  const releaseCore = readText(releaseCorePath);
  if (releaseCore !== null) {
    for (const sym of [
      'SOURCE_BUCKET',
      'DESTINATION_BUCKET',
      'PROMOTION_CONFIRM_PHRASE',
      'INVENTORY_FINGERPRINT_ALGORITHM',
      'buildReleaseManifest',
      'validateReleaseManifest',
      'verifyProductionBackupHandshake',
      'verifyPreviewInventoryMatchesRelease',
      'inventoryFingerprint'
    ]) {
      if (!new RegExp('\\b' + sym + '\\b').test(releaseCore)) {
        fail(releaseCorePath + ' must define/export ' + sym);
      }
    }
    // The fixed bucket literals must be pinned in the core (the single source of
    // truth). Preview is the read-only source; production is the write destination.
    if (!/SOURCE_BUCKET\s*=\s*'mj-art-images-preview'/.test(releaseCore)) {
      fail(releaseCorePath + " must pin SOURCE_BUCKET = 'mj-art-images-preview'");
    }
    if (!/DESTINATION_BUCKET\s*=\s*'mj-art-images(?!-preview)'/.test(releaseCore)) {
      fail(releaseCorePath + " must pin DESTINATION_BUCKET = 'mj-art-images' (production)");
    }
  }

  // 8d) Deploy workflow bucket safety: a preview deploy must never target or
  //     create the production bucket. The bucket-create step must select the
  //     bucket via a case on inputs.environment (variable form), never create
  //     both buckets or a literal production bucket in a create command.
  if (deployWf !== null) {
    if (/r2\s+bucket\s+create\s+mj-art-images/.test(deployWf)) {
      fail(deployWfPath + ' must not create a bucket by literal name in a wrangler command (use a case-selected variable)');
    }
    if (!/r2\s+bucket\s+create\s+"\$\{?BUCKET\}?"/.test(deployWf)) {
      fail(deployWfPath + ' must create the selected bucket via a case-selected "$BUCKET" variable');
    }
  }

  // 9) Guarded Turnstile provisioning. Probe is list-GET-only. Provision is
  //    manual, exact-target, strongly confirmed, non-rotating, and non-deleting.
  const turnstileWfPath = '.github/workflows/turnstile-provision.yml';
  const turnstileScriptPath = 'scripts/provision-turnstile.mjs';
  const turnstileWf = readText(turnstileWfPath);
  const turnstileScript = readText(turnstileScriptPath);
  if (turnstileWf === null) fail(turnstileWfPath + ' is missing');
  if (turnstileScript === null) fail(turnstileScriptPath + ' is missing');
  if (turnstileWf !== null) {
    const turnstileTriggers = extractOnTriggers(turnstileWf);
    if (!(turnstileTriggers?.length === 1 && turnstileTriggers[0] === 'workflow_dispatch')) {
      fail(turnstileWfPath + ' must be workflow_dispatch only');
    }
    if (!hasWorkflowLevelContentsRead(turnstileWf)) {
      fail(turnstileWfPath + ' must declare workflow-level contents: read');
    }
    assertThirdPartyActionsPinned(turnstileWfPath, turnstileWf);
    if (!/I-CONFIRM-TURNSTILE-PROVISION/.test(turnstileWf)) {
      fail(turnstileWfPath + ' must require the exact provision confirmation phrase');
    }
    if (!/group:\s*turnstile-provision\s*$/m.test(turnstileWf)) {
      fail(turnstileWfPath + ' must serialize all provisioning runs with a fixed concurrency group');
    }
    const gateIndex = turnstileWf.indexOf('Fail closed unless dispatch inputs are exact');
    const jobsIndex = turnstileWf.indexOf('jobs:');
    if (jobsIndex < 0 || gateIndex < 0 || /\$\{\{\s*inputs\.environment\s*\}\}/.test(turnstileWf.slice(jobsIndex, gateIndex))) {
      fail(turnstileWfPath + ' must not bind raw environment input in the pre-gate job context');
    }
    if (/^\s+environment:\s*\$\{\{\s*inputs\.environment\s*\}\}\s*$/m.test(turnstileWf)) {
      fail(turnstileWfPath + ' must not bind the job environment to raw dispatch input');
    }
    if (!/options:\s*\n\s+- probe\s*\n\s+- provision/.test(turnstileWf) ||
        !/options:\s*\n\s+- preview\s*\n\s+- production/.test(turnstileWf)) {
      fail(turnstileWfPath + ' must expose only probe|provision and preview|production choices');
    }
    if (findInputsInRunBlocks(turnstileWf).length || findSecretsInRunBlocks(turnstileWf).length) {
      fail(turnstileWfPath + ' must not interpolate raw inputs or secrets in run blocks');
    }
    const credentialIndex = turnstileWf.indexOf('secrets.CLOUDFLARE_API_TOKEN');
    if (gateIndex < 0 || credentialIndex < 0 || gateIndex >= credentialIndex) {
      fail(turnstileWfPath + ' must run the provision gate before exposing credentials');
    }
    for (const required of [
      'secret put TURNSTILE_SITE_KEY',
      'secret put TURNSTILE_SECRET_KEY',
      'wrangler secret list',
      '::add-mask::%s',
      'shred -u'
    ]) {
      if (!turnstileWf.includes(required)) fail(turnstileWfPath + ' is missing required guard: ' + required);
    }
    for (const forbidden of [/actions\/upload-artifact/i, /gh\s+secret/i, /secret\s+delete/i]) {
      if (forbidden.test(turnstileWf)) fail(turnstileWfPath + ' contains forbidden operation ' + forbidden);
    }
  }
  if (turnstileScript !== null) {
    for (const required of [
      '908b6ebad9914f568db2f19a25dd319b',
      'mj-art-preview.drhasansabri.workers.dev',
      'mj-art.drhasansabri.workers.dev',
      'mj-art-books-eoi-preview',
      'mj-art-books-eoi-production',
      'O_EXCL',
      'O_NOFOLLOW',
      '0o600'
    ]) {
      if (!turnstileScript.includes(required)) fail(turnstileScriptPath + ' is missing fixed safety value ' + required);
    }
    for (const forbidden of [
      /method:\s*['"](?:DELETE|PUT|PATCH)['"]/,
      /rotate_secret/i,
      /CLOUDFLARE_ACCOUNT_ID/,
      /--(?:account-id|hostname|widget-name|worker)/
    ]) {
      if (forbidden.test(turnstileScript)) fail(turnstileScriptPath + ' contains forbidden override/mutation ' + forbidden);
    }
    if (!/widgets\.filter\(\(widget\) => widget\?\.name === target\.widgetName\)/.test(turnstileScript)) {
      fail(turnstileScriptPath + ' must find widgets by exact mapped name');
    }
  }

  if (process.exitCode) {
    console.error('check-operations-rules: one or more assertions failed.');
    return;
  }
  console.log('check-operations-rules: OK - operations policy assertions passed.');
}

main();
