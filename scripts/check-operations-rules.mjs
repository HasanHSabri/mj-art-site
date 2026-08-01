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

    // Required confirmation + asset-protection inputs.
    for (const inputName of ['confirm_preview_only', 'assets_archive_url', 'assets_archive_sha256', 'execute_upload']) {
      if (!new RegExp('^\\s+' + inputName + ':', 'm').test(importWf)) {
        fail(importWfPath + ' must declare input ' + inputName);
      }
    }
    if (!/confirm_preview_only/.test(importWf)) {
      fail(importWfPath + ' must reference the confirm_preview_only confirmation input');
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
  }

  // Support scripts for the catalogue import.
  const genPath = 'scripts/generate-catalog-derivatives.mjs';
  const importScriptPath = 'scripts/import-catalog-preview.mjs';
  const corePath = 'scripts/lib/catalog-import-core.mjs';
  const genScript = readText(genPath);
  const importScript = readText(importScriptPath);
  const coreLib = readText(corePath);
  if (genScript === null) fail(genPath + ' is missing');
  if (importScript === null) fail(importScriptPath + ' is missing');
  if (coreLib === null) fail(corePath + ' is missing');
  if (importScript !== null) {
    if (!/assertPreviewBucket/.test(importScript)) {
      fail(importScriptPath + ' must call assertPreviewBucket before any upload');
    }
    if (/mj-art-images(?!-preview)/.test(importScript)) {
      fail(importScriptPath + ' must not embed the production bucket literal');
    }
  }
  if (coreLib !== null) {
    if (!/assertPreviewBucket/.test(coreLib) || !/mj-art-images-preview/.test(coreLib)) {
      fail(corePath + ' must define the preview-only bucket guard');
    }
  }

  if (process.exitCode) {
    console.error('check-operations-rules: one or more assertions failed.');
    return;
  }
  console.log('check-operations-rules: OK - operations policy assertions passed.');
}

main();
