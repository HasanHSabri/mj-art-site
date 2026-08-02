# MJ-ART Operations

MJ-ART deploys exclusively through GitHub Actions. Cloudflare credentials are GitHub Actions secrets and are not expected in the local shell. Read docs/OPERATIONS.md before proposing deployment, Cloudflare, Wrangler, or R2 work.

This document is the source of truth for how MJ-ART is deployed, how Cloudflare/R2
state is handled, and how read-only inventory and backup work. Agents and operators
must read it before proposing any deployment, Cloudflare, Wrangler, or R2 work.

## 1. Deployment route

- GitHub Actions is the **sole approved** deploy route.
- The existing deploy workflow (`.github/workflows/deploy-cloudflare.yml`) is the
  mechanism that creates buckets, configures admin secrets, and ships the Worker.
- Any `wrangler deploy` / `cf:deploy*` scripts that live in `apps/web/package.json`
  are **CI implementation details** invoked by that workflow. They must never be run
  from a local terminal. Local Cloudflare credentials are intentionally absent.
- Before proposing auth or deploy work, inspect `.github/workflows/`. Do not ask for
  local Cloudflare or R2 credentials by default.

## 2. The four independent state domains

MJ-ART state is split across four domains that can drift independently and must
never be assumed to be equivalent:

1. **Local Git** - working tree, index, and commits on a developer machine.
2. **GitHub repository refs** - branches/tags (e.g. `main`) on GitHub.
3. **Deployed Worker / static code** - the live Cloudflare Worker build and its
   bundled static assets, produced by a deploy.
4. **Live R2 content** - object bodies and metadata in R2 buckets, mutated by the
   admin surface at runtime.

A commit on `main`, a deployed Worker version, and the live R2 `artworks.json` are
three separate things. Changing one does not change the others. Admin edits to R2
are never reflected in Git, and Git commits never change live R2.

## 3. Existing deploy workflow behavior (`.github/workflows/deploy-cloudflare.yml`)

- **Push to `main`** -> checks only (no deploy). Production is never deployed automatically.
- **Pull request against `main`** -> checks only (no deploy).
- **Manual `workflow_dispatch`** -> deploys the chosen `preview` (default) or `production`.

This workflow **mutates** state: it creates R2 buckets, puts admin secrets, and
deploys the Worker. It is therefore **not safe for inventory or backup**. Do not
repurpose it, or its dispatch, for read-only R2 inspection.

## 4. Secrets (names only)

The following GitHub Actions secret names exist (names only, never values):

- `CLOUDFLARE_API_TOKEN` - the deployment token. It is **write-capable** (it creates
  buckets, puts secrets, and deploys). It is unsuitable for read-only maintenance.
- `CLOUDFLARE_ACCOUNT_ID` - the Cloudflare account identifier.
- `ADMIN_PASSWORD` - admin login password.
- `ADMIN_SESSION_SECRET` - admin session signing secret.

Read-only inventory/backup uses a **separate, dedicated** token
(`CLOUDFLARE_R2_READ_TOKEN`) described below, not the write-capable deployment token.

### VPS private master-assets (catalogue import)

The catalogue import fetches private ORIGINAL masters from a hardened VPS over
SSH (no Neon is used anywhere). These GitHub Actions variables and secrets hold
the connection material (names only, never values):

- **Variables** (set under Settings > Secrets and variables > Actions > Variables):
  `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `VPS_MASTER_ROOT`, and the one-time
  attestation `VPS_ASSETS_CONFIRMED` (set **last**, only after the VPS account,
  key, host key, and master root are confirmed).
- **Secrets** (set under Settings > Secrets and variables > Actions > Secrets):
  `VPS_SSH_PRIVATE_KEY` (the restricted VPS account's private key) and
  `VPS_KNOWN_HOSTS` (the pinned host key line for `VPS_HOST`).

The run fails closed until every one of these is present, and again unless
`VPS_ASSETS_CONFIRMED == true`. None is ever echoed or interpolated in a run
script; they flow through `env:` only. **No secret or private-key value is ever
pasted into chat, logs, or a commit.** The VPS private key and host key are
placed only into GitHub from the protected, caller-owned files produced by the
setup script below.

## 5. R2 buckets and binding

- Production bucket: `mj-art-images`.
- Preview bucket: `mj-art-images-preview`.
- Worker binding name: `ARTWORK_IMAGES` (bound to the relevant bucket per
  environment in `apps/web/wrangler.jsonc`).

## 6. Admin surface behavior (runtime R2 writes)

- The production admin writes to the **production** bucket; the preview admin writes
  to the **preview** bucket (driven by the deployed environment's binding).
- Image upload is **canonical**: the admin must enter a catalog number first, then
  sends two in-browser JPEG derivatives (full ~2000px, thumb ~640px). The Worker
  writes exactly two keys and returns canonical public URLs:
  - `artwork/catalog/<catalogNumber-lower>/full.jpg`
  - `artwork/catalog/<catalogNumber-lower>/thumb.jpg`
  Both are stored with `image/jpeg` metadata and served with
  `X-Content-Type-Options: nosniff`. The `/artwork-uploaded/` route
  strict-whitelists only canonical catalog JPEG keys
  (`artwork/catalog/(mj|misc)-NNN/(full|thumb).jpg`); `artworks.json`,
  arbitrary keys, SVG, and noncanonical paths all return 404 before any R2
  lookup, so raw metadata is never fetchable through the image route. There is
  no upload delete path. The previous timestamp-based upload path
  (`artwork/<timestamp>-<slug>`) is removed.
- Add / edit / remove perform a **full overwrite** of the root `artworks.json`
  object in the bucket. Records are canonicalized (exact canonical field set,
  deep-cloned) and sorted by `sortOrder` before persistence.
- The admin has explicit **Move Up / Move Down** reorder controls. Reordering
  renumbers `sortOrder` to a contiguous `1..N` sequence. The public display is
  sorted **ascending** by `sortOrder` (it does not reverse the array).
- `id` always equals `catalogNumber.toLowerCase()`; there are no title-slug ids.
- Remove / replace **never delete** old image objects. Replacing an artwork's image
  therefore can **orphan** the previous object (it remains in the bucket but is no
  longer referenced). Orphans accumulate until handled explicitly.
- There is **no static fallback**. The Worker hydrates the gallery from the live R2
  `artworks.json`; a missing object renders an empty gallery and an invalid object
  returns 500. `apps/web/public/artwork/` holds build-time source images only and is
  not a runtime data path.

**Admin edits never become Git commits.** They are live R2 mutations only.

## 7. Correct R2 inventory / backup route

Read-only inspection and backup use a **separate** workflow:
`.github/workflows/r2-readonly-backup.yml`, backed by
`scripts/r2-readonly-backup.mjs`.

- Trigger: `workflow_dispatch` only.
- Dedicated, read-scoped GitHub secret: `CLOUDFLARE_R2_READ_TOKEN`, verified out of
  band via the repo variable `CLOUDFLARE_R2_READ_TOKEN_CONFIRMED == true`.
- **Read-only scope is an out-of-band maintainer attestation.** The repo variable
  is set only after a maintainer confirms (without any write) that the token is
  limited to the Workers R2 Storage Read scope. The script's token `verify` call
  only proves the token is **active**; it does **not** prove the scope, which is
  why the repo-variable attestation gates every run.
- **REST endpoints are supported, but the first run is the operational validation.**
  The Cloudflare R2 REST endpoints used here (list bucket objects, get object) are
  covered by the Workers R2 Storage Read permission; the first preview inventory
  run is the operational confirmation that the token actually can list and read
  both buckets end to end.
- **List and GET metadata are preserved.** Every object records its normalized
  listing fields (key, size, ETag, last-modified, HTTP/custom metadata, storage
  class) plus the raw list record; downloaded bodies additionally record the
  sanitized GET response headers. Listing is cursor-paginated and page-bounded;
  GET/list response limits are Cloudflare's, not configurable here.
- **Inventory is the default.** Inventory mode lists every object in both buckets and
  downloads only `artworks.json` (when present) to run reference analysis.
- **Backup is explicit.** Backup mode additionally downloads every object body, gated
  by the `download_backup` input and a byte budget.
- The workflow references only `CLOUDFLARE_R2_READ_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`. It never references the write-capable
  `CLOUDFLARE_API_TOKEN` or any admin secret.

## 8. Backup / recovery contract

- A backup contains **exact object keys, metadata, ETags, and SHA-256 hashes** of
  downloaded bodies, plus per-bucket inventories and reference reports.
- **Body files are dispersed by bucket.** Each downloaded body is stored under
  `objects/<sha256(bucket + NUL + rawKey)>`. The NUL separator makes the name
  unambiguous, and the same raw key present in both buckets (notably
  `artworks.json`, which lives in production `mj-art-images` **and** preview
  `mj-art-images-preview`) is stored as **two separate, independently verifiable
  bodies** rather than one overwriting the other. Every manifest entry records
  its origin `bucket`, `rawKey`, relative `backupPath`, and content SHA-256, so
  restore resolves the exact (bucket, key) even if entries are flattened out of
  the per-bucket structure.
- **Restore follows the manifest's recorded `backupPath`.** Do not recompute
  body paths from keys; the on-disk name is a function of bucket+key and an
  artifact is self-contained (its manifest and its `objects/` bodies travel
  together). `SHA256SUMS` lists one line per `(bucket, rawKey)` with no
  deduplication.
- **Credentials are excluded** from every artifact. The token and Authorization
  header are never written, logged, or echoed.
- The backup artifact is a dated, SHA-256-checksummed tarball uploaded as a GitHub
  Actions artifact with fixed retention.
- **Restore is a separate, deliberate operation** and is never inferred from a
  backup run. Any restore must be tested in an **isolated** bucket first.
- Restore order: **images first, `artworks.json` last**. Restoring metadata before
  its referenced images creates a window of broken references.
- **Permission to inspect or back up never implies permission to change production.**

### 8a. Historical backup status (dual-bucket body collision)

The body-naming scheme above is a fix. Earlier `backupFilenameFor` hashed only the
raw key, ignoring the bucket, so the production and preview copies of the same raw
key collapsed onto one body file and the later download overwrote the earlier one.

- **Backup `20260731` — UNAFFECTED.** At that time only the production bucket was
  non-empty (the preview bucket had not yet been populated), so no two-bucket key
  overlap occurred and all of its bodies are intact and correct.
- **Backup `20260802` (workflow run `30730562456`) — ONE MISSING BODY.** By then
  both buckets were populated, so production `artworks.json` and preview
  `artworks.json` mapped to the same body file. Production was listed first, then
  preview overwrote it. The artifact's 192 manifest entries are otherwise
  complete, but **the production `artworks.json` body is not durable in that
  artifact** (the stored bytes are the preview copy). Do not restore production
  `artworks.json` from run `30730562456`; take it from the `20260731` artifact or
  from a fresh post-fix backup. All non-colliding bodies in `20260802` are fine.
- **All post-fix backups** disperse bodies by bucket and contain every body.

## 9. Safe operational sequence

1. Read this document and inspect `.github/workflows/`.
2. Confirm a read-only scope is in place (token verified, repo variable set).
3. Run inventory first to inspect counts, references, orphans, and integrity.
4. Only if explicitly required, run backup mode within the byte budget.
5. Treat the produced artifact as the source of truth for that point in time.
6. Never use the deploy workflow or the write-capable token for inventory/backup.

## 10. Recovery caveats

- The artifact is a **best-effort, point-in-time** snapshot. Concurrent admin edits
  during a run can create races between the listing and the body downloads; the tool
  detects size/ETag mismatch between the list record and the GET response and
  **aborts** rather than shipping an inconsistent artifact, but a backup is still a
  snapshot of a moving target, not a transactional consistency guarantee.
- **Token verification is not scope verification.** The `verify` call proves the token
  is active; only the out-of-band attestation (repo variable) and the first preview
  inventory run establish that the scope is read-only and that listing/GET work.
- **ETags are not always full-file hashes.** For multipart objects the ETag is not a
  simple content digest; rely on the computed SHA-256 of the downloaded bytes for
  integrity, and treat ETags as advisory only.

## 11. Catalogue import (PREVIEW only) — VPS private masters

The canonical 86-record catalogue (`catalog/catalog.json`) is published to the
PREVIEW R2 bucket as a set of image derivatives plus a single `artworks.json`.
Private ORIGINAL masters are a **versioned library on a hardened VPS** (mirroring
the Drawer Organiser Library admin-curated draft -> preview -> publish model);
public processed derivatives and the public `artworks.json` are **Cloudflare R2
only. There is no Neon anywhere in this project.** This is a separate, dedicated,
preview-only workflow: `.github/workflows/catalog-import.yml`, backed by
`scripts/generate-catalog-derivatives.mjs` (generation),
`scripts/import-catalog-preview.mjs` (preview import client),
`scripts/verify-master-archive.mjs` (safe sidecar/archive verifier), and
`scripts/lib/catalog-import-core.mjs` (shared pure helpers).

### Public/private storage boundary

- **Private originals** live only on the VPS, as a versioned archive library
  under `VPS_MASTER_ROOT`. They are never in Git, never in R2, never on a runner
  beyond a single import run's temp directory.
- **Public derivatives** (`artwork/catalog/<id>/{full,thumb}.jpg`) and the
  **public metadata** (`artworks.json`) live only in the PREVIEW R2 bucket.
- No database (Neon or otherwise) stores catalogue state. The Worker hydrates the
  gallery from the live R2 `artworks.json`.

### One-time setup

Perform these steps once. **Set `VPS_ASSETS_CONFIRMED` last.**

1. **Create a restricted VPS account** dedicated to this workflow. It must be
   key-only (no password login), and have read-only access to a master root
   directory (e.g. `/srv/mj-art/masters`) that holds the versioned archives. Do
   not reuse a general-purpose account.
2. **Generate a dedicated SSH key pair** for that account; authorize the public
   key in the account's `authorized_keys`.
3. **Pin the host key.** From a trusted machine, capture the host key line for
   `VPS_HOST` (e.g. `ssh-keyscan -t ed25519 <host>` and verify it out of band).
   This exact line becomes the `VPS_KNOWN_HOSTS` secret.
4. **Add the GitHub Actions variables** (Settings > Secrets and variables >
   Actions > Variables): `VPS_HOST`, `VPS_PORT`, `VPS_USER`, and
   `VPS_MASTER_ROOT` (the absolute path to the master root on the VPS).
5. **Add the GitHub Actions secrets** (Settings > Secrets and variables >
   Actions > Secrets): `VPS_SSH_PRIVATE_KEY` (the private key from step 2) and
   `VPS_KNOWN_HOSTS` (the pinned host key line from step 3).
6. **Set `VPS_ASSETS_CONFIRMED` to `true` last**, only after you have confirmed
   the account, key, pinned host key, and master root. Every run fails closed
   until this is `true`, and again until all variables/secrets above are present.

No real host names, keys, passwords, or URLs appear in this document or the
workflow; the operator fills in the values above out of band.

### Required master archive layout

Each published version is two files under `VPS_MASTER_ROOT`:

- `mj-art-master-<version>.tar.gz` — the archive.
- `mj-art-master-<version>.sha256` — the sidecar (GNU coreutils form:
  `<64-hex>  mj-art-master-<version>.tar.gz`, two spaces, exact basename).

`<version>` is a strict token matching `[A-Za-z0-9._-]{1,64}` (e.g. a date or a
semver-ish tag). The archive root must contain `originals/` (75 Drive JPEGs),
`misc-originals/` (11 misc images, mixed `.jpg`/`.jpeg`), and `SHA256SUMS`. The
operator builds these locally as a staging source; the local staging path is not
part of the server process. A suggested build:

```
tar -czf mj-art-master-<version>.tar.gz -C <staging-root> .
sha256sum mj-art-master-<version>.tar.gz > mj-art-master-<version>.sha256
```

Then place both files under `VPS_MASTER_ROOT`.

### Operational status: first master archive (2026-08-01-1)

The unified VPS import root on this host is `.local-assets/imports/` — this is the
value bound to `VPS_MASTER_ROOT`. It is dedicated solely to versioned MJ import
archives and sidecars; the masters library (`.local-assets/catalog-assets/`) and
backups (`.local-assets/backups/`) are unchanged and outside this root. The
entire `.local-assets/` tree is gitignored, so archives never enter Git.

Permissions are conservative: the imports directory is `0755` with the
`developers` group granted read+list only (no write); published archives and
sidecars are `0444` (read-only for all principals including the owner).

The first published archive is **`mj-art-master-2026-08-01-1`**:

- Built from `.local-assets/catalog-assets/` containing exactly `originals/`
  (75 Drive JPEGs), `misc-originals/` (11 misc images), and `SHA256SUMS` (86
  records). No `provenance/`, `README.md`, wrapper root directory, symlinks, or
  hardlinks are present.
- Passes `scripts/verify-master-archive.mjs` (archive SHA-256 matches the strict
  sidecar) and the `validateTarVerboseListing` extraction-safety guard.
- Extracted `SHA256SUMS` verifies **86/86 OK, 0 failed**.

**Restricted fetch account (`mjart-fetch`)**: intended as a key-only system user
with a forced `internal-sftp` + `restrict` authorized-keys entry rooted at exactly
the imports directory, read-only by filesystem rights. **Status: pending** —
account creation, key installation, sshd configuration, and local access testing
require elevated privileges on the host and have not yet been completed.
Accordingly, **no GitHub Actions variables or secrets have been set** and
`VPS_ASSETS_CONFIRMED` remains unset. The next safe action is for an operator
with elevated privileges to create the account and complete the one-time setup
(above), after which the GitHub variables/secrets can be populated and the
end-to-end fetch validated before setting `VPS_ASSETS_CONFIRMED`.

**One-time VPS-side setup script.** The local account, forced-command
authorized key, pinned host key, and read-only access tests are produced by
`scripts/setup-mjart-vps-fetch-access.sh`, run with sudo from a non-root
account on the VPS (`--host <public-host-or-ip>`, `--port` optional, default
22). It is idempotent, makes **no** GitHub changes itself, and prints the exact
`gh` commands to populate `VPS_SSH_PRIVATE_KEY` / `VPS_KNOWN_HOSTS` and the
`VPS_HOST` / `VPS_PORT` / `VPS_USER` / `VPS_MASTER_ROOT` variables (with
`VPS_ASSETS_CONFIRMED` deliberately left for the operator to set last). Note:
the workflow fetch uses the SFTP protocol (the scp default; never the legacy
`-O` SCP protocol) to match the forced `internal-sftp` account. The legacy
`scp -O` protocol requires a remote shell, which the forced-command account
denies, so it must never be re-added; the setup script only documents this.

**Forced-SFTP is enforced at two layers (defense-in-depth).** In addition to
the account's `authorized_keys` `command="internal-sftp ...",restrict` entry,
the script manages ONE narrow sshd drop-in snippet — a root-owned `0644`,
marker-delimited `Match User mjart-fetch` block (e.g.
`/etc/ssh/sshd_config.d/90-mjart-fetch.conf`) that sets `ForceCommand
internal-sftp -d <imports>` and disables all forwarding and PTY **for that user
only**; it sets no global options and weakens no other sshd setting. The script
**never edits** `/etc/ssh/sshd_config` directly; it requires the host's main
config to already `Include sshd_config.d/*.conf` (it fails closed with guidance
otherwise). The full config is validated with `sshd -t`, the **global**
effective config is proven byte-identical before/after (no drift), and the
per-user effective config is verified with `sshd -T -C user=mjart-fetch`
before sshd is reloaded. On any validation or reload failure it restores the
prior (absent) snippet and fails loudly. The `authorized_keys` forced command
remains as a second layer; the sshd `ForceCommand` takes precedence and both
pin the same `internal-sftp` root. The account's `~/.ssh` (`0700`) and
`authorized_keys` (`0600`) are owned by `mjart-fetch:mjart-fetch` — **not**
root — because sshd reads `authorized_keys` as the target user (it drops to
that account's uid before opening the file); a root-owned `0600` file is
unreadable by the account, which fails closed with `Could not open authorized
keys ... Permission denied`. The setup script asserts this exact
ownership/mode on every (idempotent) run and repairs a prior root-owned state
in place.

### Publishing cycle

1. **Build** the versioned archive + sidecar (above) and place them on the VPS.
2. **Dry-run the workflow**: dispatch `.github/workflows/catalog-import.yml` with
   `confirm_preview_only` enabled, `master_archive_version` set to the version,
   and `execute_upload` **off**. The run fetches from the VPS, verifies the
   checksum, extracts (hardened), generates derivatives, validates the catalogue
   and operations policy, and prints the import plan — **no uploads**.
3. **Execute preview**: re-dispatch with the same version and `execute_upload`
   **on**. All 172 images upload first, 172 reads are verified, then the
   canonical `artworks.json` is PUT last.

### Scope and hard limits

- **Preview only.** The import client (`assertPreviewBucket`) accepts **only**
  the literal preview bucket `mj-art-images-preview`. The production bucket is
  never a valid target. **Production catalogue import remains blocked until the
  Stop 2 milestone.**
- **Workflow dispatch only**, with a mandatory `confirm_preview_only`
  confirmation input, the out-of-band `vars.VPS_ASSETS_CONFIRMED` attestation,
  and a `set -euo pipefail` fail-closed gate. Triggers `push`/`pull_request`/
  `schedule` are forbidden. **No archive URL or write URL appears anywhere** —
  masters are fetched by version token only.
- **Credentials**: preview upload uses `CLOUDFLARE_API_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID`; VPS access uses the variables/secrets above. All of
  them flow through `env:` only (never interpolated in a run script, never
  echoed). The workflow never references the read token, the admin password, or
  the session secret.
- **Hardened fetch.** SSH/SCP is key-only, batch mode, strict host checking
  against the pinned `VPS_KNOWN_HOSTS`, identity pinned. The remote basename is
  constructed solely from the validated version, so it can never carry an
  injected path. The sidecar is parsed strictly (exact basename match) and the
  archive bytes are re-hashed by the verifier — no untrusted `sha256sum -c` path
  read. Extraction runs only after the tar listing check rejects symlinks,
  hardlinks, absolute, and parent-traversal paths; `--no-same-owner` is used.

### How derivatives are produced

- Each source image is resolved **solely** through `SHA256SUMS` + the record's
  `provenance.sha256` (never by filename). The source bytes are re-hashed and
  compared before generation (checksum guard). Source integrity therefore relies
  on the generator's strict rehash; a separate checksum-check pass over
  `SHA256SUMS` is intentionally not run (it would read untrusted paths and is
  fully redundant with the rehash).
- Each source is size-capped (50 MiB) and dimension-checked (≤8000px) **before**
  decode, and every ImageMagick `convert`/`identify` invocation applies bounded
  resource limits (`-limit memory/disk/width/height`). EXIF auto-orient behavior
  is preserved. Residual risk: a runner-installed `policy.xml` would be more
  comprehensive than CLI limits, but is version/path-specific; the CLI limits
  plus the source caps are the portable, IM6/IM7-agnostic defence used here.
- Derivatives are EXIF-orientation-normalized JPEGs produced by system
  ImageMagick (`-auto-orient -strip -resize <box>> -quality <q>`): `full.jpg`
  longest edge 2000 @0.9, `thumb.jpg` longest edge 640 @0.85, **never
  upscaled**. Output is re-verified as JPEG with sane **per-variant** dimensions
  (full ≤2000, thumb ≤640). This mirrors the in-browser reference in
  `apps/web/public/admin.js`.
- Exact counts are enforced: **86 records / 172 derivatives**, else fail closed.
- Staging paths are deterministic: `artwork/catalog/<id>/{full,thumb}.jpg` (the
  R2 key). A machine-readable `manifest.json` (key, relative file, hashes,
  dimensions, bytes, source sha) drives the import client.

### Import order and gates

1. Fail closed unless preview-only scope + VPS attestation confirmed.
2. Fetch archive + sidecar from VPS; verify the archive against the sidecar.
3. Extract (hardened listing check first); locate the `SHA256SUMS` root.
4. Validate the catalogue (`pnpm check:catalog`) and operations policy
   (`pnpm check:operations`).
5. Generate derivatives into runner temp; write `manifest.json`.
6. **Dry-run** (`import-catalog-preview.mjs` without `--execute`): validate the
   catalogue against the runtime schema, canonicalize + sort, enforce the `<2MiB`
   `artworks.json` ceiling, validate the manifest, and print the plan — **no
   uploads, no network**.
7. **Execute** (only when `execute_upload` is enabled): upload **all 172 images
   first**, then **verify 172 reads** (wrangler `r2 object get` + sha256
   compare), and only then **PUT the complete canonical `artworks.json` last**.
   The `artworks.json` readback is verified by **exact sha256 + byte size +
   parsed count**, not by parsed count alone, so silent corruption or a partial
   rewrite is detected.

### Invocation inputs

- `confirm_preview_only` (required boolean) — fail closed unless true.
- `master_archive_version` (required) — version token of the VPS master archive
  to fetch (strict `[A-Za-z0-9._-]{1,64}`). No URL is supplied or accepted.
- `execute_upload` (default false) — when disabled, the run validates +
  generates + plans only; when enabled, it uploads to PREVIEW after all gates
  pass.

### Retention and rollback

- **Versioned retention.** Each publish is a distinct versioned archive on the
  VPS; old versions are retained on the VPS (operator-managed) and are the
  rollback source.
- The preview bucket is **overwrite-only on the canonical key set**: there is no
  delete path. Re-running with the same catalogue idempotently overwrites each
  `artwork/catalog/<id>/{full,thumb}.jpg` and `artworks.json`.
- Orphan detection/drift between Git, the preview bucket, and production is
  reported by the **read-only** R2 inventory workflow (§7), not by this workflow.
- **Rollback** is a separate deliberate operation: it is never inferred from an
  import run. To revert the preview `artworks.json`, re-run the import against a
  prior master version (and/or a prior catalogue commit), or restore from a
  read-only backup artifact per §8. Production rollback is not available from
  this code path; **production remains blocked until the Stop 2 milestone.**
