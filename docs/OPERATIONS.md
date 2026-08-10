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
- Manual deploys are globally serialized and never cancel an in-progress run. A
  credential-free gate validates the exact target and is the only source for the
  protected GitHub environment binding.
- Before any bucket creation, Worker secret write, or deploy, the workflow checks
  the selected Worker's three Turnstile binding names, Wrangler's effective
  limiter/environment bindings via dry-run, crypto-secret strength, and the live
  Neon catalog using read-only queries.

This workflow **mutates** state: it creates R2 buckets, puts admin secrets, and
deploys the Worker. It is therefore **not safe for inventory or backup**. Do not
repurpose it, or its dispatch, for read-only R2 inspection.

The release is a direct, single `wrangler deploy`; there is no rollback, version
fallback, or controlled rollout in this workflow. Post-deploy smoke can detect a
bad live release but cannot undo it, so a smoke failure may leave the new Worker
already serving until an operator performs a separate corrective deploy. The
stronger mutation-free preflight reduces that risk but cannot eliminate runtime
or propagation failures after deployment.

### 3.1 Worker request and response acceptance

All asset paths run Worker-first. The Worker rejects requests before routing unless
the request URL hostname and any explicit `Host` header agree and match the
environment's `BOOK_EOI_ALLOWED_HOSTNAMES` value. The environment
(`BOOK_EOI_ENVIRONMENT`) and its configured hostname set must be a consistent pair:
local only permits loopback hosts (`localhost`, `127.0.0.1`); preview and production
only permit non-local (public) hosts, each its own Worker hostname. A mismatched
environment/hostname pair fails closed with a sanitized `421` response, including for
health routes.

One response finalizer applies the same security policy to pages, APIs, static/R2
assets, redirects, and errors: a source-exact CSP, HSTS, `nosniff`, clickjacking
protection, strict-origin referrers, a constrained Permissions Policy, COOP, and
same-origin CORP. The CSP permits scripts/frames/connections only from self and the
Cloudflare Turnstile origin, and styles/fonts only from self and Google Fonts. Page
markup has no inline styles or scripts, so no `unsafe-inline` or `unsafe-eval` is
allowed. COEP is deliberately omitted: cross-origin isolation is not required by
this site and can prevent Turnstile or hosted fonts from loading, while COOP and
CORP still provide the intended isolation boundary.

`HEAD` follows every successful `GET` route with the same status and headers and an
empty body. R2 artwork `HEAD` requires the R2 `head()` capability: when the binding
exposes `head()` it answers from object metadata without downloading the body, and
when `head()` is unavailable the Worker declines with `501` rather than fetching the
object body only to discard it. On explicitly handled routes, unsupported methods
return `405` with that route's exact `Allow` value; unhandled dynamic sub-paths (for
example an unknown `/api/books/*` path or a non-PATCH method on an item id under the
PATCH-only admin route) return `404`, not an invented `405`. Every actual `405`
carries an exact `Allow`. `OPTIONS` is not a CORS escape hatch and receives no
access-control headers. Pushes to `main` continue to run checks only; these protocol
rules do not alter the manual-only deployment policy.

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
SSH; the catalogue import and its runtime use no Neon database (Neon is confined
to the Books EOI data layer in §13). These GitHub Actions variables and secrets hold
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
only; no Neon database stores catalogue state.** This is a separate, dedicated,
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
(above). `VPS_ASSETS_CONFIRMED` is a **pre-fetch** attestation: set it to `true`
only after the setup script has completed and its **local account access test**
(the in-script SFTP round-trip from the VPS using the staged key + pinned host
key) succeeds — confirming the account, key, host key, and master root work. It
must be set BEFORE the first GitHub Actions fetch, because the catalogue-import
gate fails closed unless `VPS_ASSETS_CONFIRMED == true`; the GitHub Actions
dry-run is therefore the first end-to-end fetch and cannot run before the
attestation is set. Populate the variables/secrets first, set
`VPS_ASSETS_CONFIRMED` last, then dispatch the dry-run.

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

## 12. Production catalogue promotion (Stop 2)

Stop 2 promotes the **approved preview** catalogue state to **production**. It
runs only through `.github/workflows/catalog-promote-production.yml`
(workflow_dispatch only) and `scripts/promote-catalog-production.mjs`. The
preview catalogue was imported and approved at content commit `e52fc7f` (173
objects: 172 canonical images + `artworks.json`, 86 records); the verified
read-only backup `r2-readonly-backup-20260802T033638Z` pins that state exactly.
Commit `97a11c2` changed only backup tooling (not app or catalogue content), so
the production **Worker deploy** target is the latest `main`, while the
**catalogue content** manifest is the approved preview state at `e52fc7f`.

### Tracked release manifest

`catalog/production-release-manifest.json` pins the approved preview state
exactly: schema version, the approved content commit + verifying backup
snapshot, the source (preview) and destination (production) bucket literals,
catalogue record count (86), the `artworks.json` size/sha256, and 173 sorted
expected objects as `{key,size,sha256}` only. It carries **no** local paths,
etags, timestamps, or secrets. It is generated mechanically from the verified
backup by `scripts/generate-production-release-manifest.mjs` and validated
deterministically against `catalog/catalog.json` (the `artworks.json` hash must
equal the canonical catalogue payload). Its on-disk sha256 is the pin the
promotion workflow requires.

### Promotion order and gates

1. **Fail closed** unless the confirmation boolean is enabled AND the exact strong
   phrase `I-CONFIRM-PRODUCTION-CATALOGUE-PROMOTION` is supplied, AND the pinned
   release-manifest sha256 + expected production object count + expected production
   inventory fingerprint are supplied, AND the maintainer repo variable
   `CLOUDFLARE_R2_READ_TOKEN_CONFIRMED` equals `true`. No credential is exposed at
   this gate; the repo variable (never a secret) is read via `env`, never inside an
   `if:`/raw expression.
2. **Validate** the catalogue (`pnpm check:catalog`), the operations policy
   (`pnpm check:operations`), and pin the release manifest by sha256.
3. **Fresh production backup first.** Create a fresh read-only backup of BOTH
   buckets in THIS run using `CLOUDFLARE_R2_READ_TOKEN` (the read token is
   exposed only here). Upload it as a 90-day retention artifact.
4. **Backup handshake (mandatory).** The promotion client refuses to execute
   unless that fresh backup confirms the **current production inventory** with
   the expected object count (drift guard) **and** the expected content inventory
   fingerprint (content-exact drift guard), and **every production body downloaded
   and checksummed** (a byte-verified rollback source). The fingerprint makes the
   handshake content-exact: a same-count byte/key change cannot pass. It also
   cross-checks the fresh **preview** inventory against the release manifest exactly
   (no missing, no extra). Backup failure or any drift -> no writes.
5. **Dry-run plan** (no writes): validate the manifest + backup handshake +
   preview inventory, print the plan.
6. **Execute** (only when `execute_promotion` is enabled, after the gate +
   backup succeed; `CLOUDFLARE_API_TOKEN` is exposed only on this step):
   - Download all 173 approved objects from PREVIEW (read-only source) to runner
     temp and verify each by size + sha256. A missing/short object -> no writes.
   - Upload the **172 images first** to PRODUCTION, then read back each and
     verify by sha256.
   - Publish the approved `artworks.json` **last**, then read back by exact
     sha256 + byte size + parsed count (86). On any failure before this PUT, the
     prior production metadata stays live.
   - **Never delete** any object. There is no delete code anywhere. The 18 legacy
     production images + the prior `artworks.json` are retained. The 172 canonical
     image keys have **zero overlap** with the legacy keys, so no legacy image is
     overwritten; only `artworks.json` is replaced (the intended metadata cutover).

### Drift, retention, and rollback

- **Expected production drift.** Before promotion, production has 19 objects (18
  legacy images + `artworks.json`). The drift guard pins `expected_production_object_count`
  to this value; if production has drifted (objects added/removed), the handshake
  fails closed. After promotion, production has 191 objects (18 legacy + 172
  canonical images + `artworks.json`).
- **Content-exact production fingerprint (`expected_production_inventory_fingerprint`).**
  The count guard alone cannot detect a same-count change (a byte change or a key
  rename). The dispatch input `expected_production_inventory_fingerprint` therefore
  pins the **exact** current production inventory by content. The fresh in-run
  backup must reproduce it before any write. Current value (count 19, verified
  against the approved pre-promotion production state):

  ```
  61e08a337f9920c177df74cf8dd928bcb06ee61cc737156ba3d61e7b1141141e
  ```

  - **Algorithm** (`mj-art-inventory-fingerprint-v1`, implemented by
    `inventoryFingerprint` in `scripts/lib/release-manifest-core.mjs`): deterministic
    and order-independent. Each object is normalized to `{key, size, sha256}`;
    records are sorted ascending by `key`; each record is rendered as
    `<key>\t<size>\t<sha256>` (`-` if a body was not checksummed); lines are joined
    with `\n`; the fingerprint is the sha256 of that UTF-8 text. Any change to a
    key, size, or sha256 — including a same-count byte/key swap — changes the digest.
    Bump the label only on an incompatible algorithm change.
  - **Operator derivation.** Derive the input from a **verified** read-only
    production backup (every body downloaded and checksummed), never from a
    listing-only inventory. With the backup `manifest.json` on hand, run a small
    Node snippet against the production bucket entry, e.g.:

    ```js
    import { readFileSync } from 'node:fs';
    import { extractBackupBucket, inventoryFingerprint, DESTINATION_BUCKET }
      from './scripts/lib/release-manifest-core.mjs';
    const backup = JSON.parse(readFileSync('<verified-backup-manifest.json>', 'utf8'));
    console.log(inventoryFingerprint(extractBackupBucket(backup, DESTINATION_BUCKET)).sha256);
    ```

    Copy the 64-hex digest into `expected_production_inventory_fingerprint`. Never
    commit the local backup path into repo data; only the fingerprint hash is
    committed (it reveals no object contents). Re-derive it whenever production
    changes before a promotion.
- **Legacy retention.** Retain the 18 legacy production image objects for at
  least 90 days after promotion. **No cleanup is performed now** (no delete path
  exists). The new `artworks.json` references only the 172 canonical images, so
  the legacy images become unreferenced but remain present for rollback.
- **Rollback.** Because the 18 legacy images are retained and the prior
  `artworks.json` references them, **restoring the prior `artworks.json` alone is
  sufficient** to roll back the public site to its pre-promotion state — no image
  restore is needed. Restore the prior `artworks.json` from the fresh production
  backup artifact (§8) created in the promotion run. (Image rollback is not
  required; if ever desired, the canonical images are additive and can be left
  in place.)
- **Post-promotion.** After a successful promotion, perform the **production
  Worker deploy** manually (§1; the deploy code target is latest `main`), then
  run a read-only production drift report and post-deploy tests.

### Scope and hard limits

- **Preview is source-only; production is the only write destination.** The
  source/destination bucket literals are fixed constants; no argument, manifest
  field, or control flow can swap, invert, or override them.
- **Dry-run is the default.** Execute requires `--execute` AND the exact
  confirmation phrase.
- **Read token vs write token isolation.** `CLOUDFLARE_R2_READ_TOKEN` is exposed
  only on the backup/inventory steps; `CLOUDFLARE_API_TOKEN` only on the execute
  step, after the gate + backup succeed. Admin secrets are never referenced.
- **Read-scope attestation.** The repo variable `CLOUDFLARE_R2_READ_TOKEN_CONFIRMED`
  must equal `true` (set it only after a maintainer verifies, out of band, that the
  read token has the narrow Workers R2 Storage Read scope). The promotion gate
  reads it via `env` and fails closed unless it is `true`; it is never a secret and
  never appears in an `if:`/raw expression.
- **No deletes, ever.** Legacy objects are retained; canonical image keys do not
  overlap legacy keys.

## 13. Books EOI Neon data layer (isolated, greenfield)

The Books Expression-of-Interest (EOI) backend is the **only** Neon consumer in
MJ-ART. It is provisioned as two **physically isolated** Neon projects, one per
deployment environment. Everything in this section is non-secret; no connection
string, password, or key value is recorded here or in Git.

### 13.1 Environments and Neon project mapping

| GitHub environment | Neon project (name) | Neon project id | Region |
| --- | --- | --- | --- |
| `preview` | `mj-art-eoi-preview` | `square-truth-11468808` | `aws-ap-southeast-2` (Sydney) |
| `production` | `mj-art-eoi-production` | `cool-art-04117635` | `aws-ap-southeast-2` (Sydney) |

Both projects live in organization `org-tiny-fog-95413927` (Neon "Ihab"). They
are unrelated to, and must never be confused with, the Drawer Organiser project
`fancy-poetry-96136890` in the same org, which is out of scope here.

- Each project's default Postgres database is `neondb`; the EOI schema is `mj_eoi`.
- Each project has exactly one root branch (`main`). **No branches are created or
  used** for EOI: there is **no migration framework, no ALTER compatibility path,
  and no child branches**. The canonical schema in
  `database/mj-eoi-schema.sql` is applied once as initial provisioning on a
  verified-empty database.
- Architecture: schema-as-provisioning (not migrations). To change the shape,
  edit `database/mj-eoi-schema.sql` and `apps/web/src/book-eoi.js`
  (`EXPECTED_COLUMNS`/`EXPECTED_LIVE_CATALOG`) together; the drift tool and
  health probe enforce consistency.

### 13.2 Schema signature (drift probe contract)

The single table is `mj_eoi.book_eoi`. Its column-name signature is:

```
mj_eoi.book_eoi|book_code,created_at,email_hash,format_code,id,pii_ciphertext,pii_iv,quantity,status,updated_at
```

This is recomputed from `information_schema` at runtime by `/api/books/health`
and from `database/mj-eoi-schema.sql` by `scripts/check-book-eoi-schema.mjs`
(offline drift guard). The runtime check also compares exact normalized, named
PK/UNIQUE/CHECK/FK definitions and the exact full index set. Full index
definitions include method, key order/direction, operator classes, null
semantics, predicates, INCLUDE columns, validity/readiness, and options. Extra
constraints or indexes are drift. Initial provisioning was verified to contain
10 columns, 4 CHECK constraints, 1 primary key, 1
`UNIQUE(book_code, email_hash)`, no foreign keys, and 4 indexes (PK + UNIQUE +
`book_eoi_book_status_idx` + `book_eoi_book_created_idx`).

### 13.3 Runtime role contract (`mj_eoi_app`)

Each project has a dedicated SQL login role `mj_eoi_app`, least-privilege:

- Attributes: not superuser, not createdb, not createrole, not replication, not
  bypassrls. It owns no objects and holds no `ALL`/DDL.
- Per-database settings: `search_path = pg_catalog, mj_eoi` and a short
  `statement_timeout = 5000` (ms).
- Granted only: `CONNECT` on `neondb`, `USAGE` on schema `mj_eoi`, and
  `SELECT, INSERT, UPDATE` on `mj_eoi.book_eoi`.
- Revoked/denied: database `TEMPORARY`/`TEMP`; `USAGE` and `CREATE` on schema
  `public`; `EXECUTE` on every function/procedure in schema `public`; `DELETE`,
  `TRUNCATE`, `REFERENCES`, `TRIGGER`; schema `CREATE` (and thus any DDL); and
  `PUBLIC` table grants.
- Verified live on both projects as the app role: it can read the catalog and
  SELECT/INSERT/UPDATE (write tests were rolled back so the table stays empty),
  and is denied `DELETE`, `TRUNCATE`, `CREATE TABLE`, and `DROP`. Both tables
  were empty (count 0) at handover.

**Pending infrastructure correction:** preview has the existing database,
schema, and routine revocations, but still needs the global owner default below.
Production has not been mutated and still needs the complete correction. The
global default is required because a schema-specific `ALTER DEFAULT PRIVILEGES`
does not override PostgreSQL's built-in global `PUBLIC EXECUTE` default for new
functions.
Repository checks change no database state. `node
scripts/check-book-eoi-schema.mjs --probe` emits fail-fast SQL (`ON_ERROR_STOP`
plus contract exceptions) for manual execution as `mj_eoi_app`. `--live` uses
the app-role `NEON_DATABASE_URL` to assert the same effective matrix and exits
nonzero for any violation; it never prints the URL or secrets. Both modes check
database TEMP/CREATE, exact schema and table privileges, public routine
execution, ownership, role memberships/attributes, grant options and column
ACLs, the exact documented per-database settings, and the effective global
default function ACL for `neondb_owner`. The expected `pg_default_acl` row has
`defaclnamespace = 0`, `defaclobjtype = 'f'`, and no `PUBLIC EXECUTE`; no
schema-specific default ACL is required. The generated SQL also asserts the
exact column, constraint, and index contract. Run it after operator revocations
and retain the result with release evidence.

The live preflight reports only the stable check IDs below. It never reports a
driver message, connection detail, query text, result value, or stack. Use the
ID's remediation category to choose the next diagnostic step; inspect protected
CI configuration or perform an authorized read-only catalog review separately.

| Check ID | Remediation category |
| --- | --- |
| `BEOI-LIVE-001` | Required live-check configuration |
| `BEOI-LIVE-002` | Root Neon driver dependency/import and adapter setup |
| `BEOI-LIVE-003` | Unexpected internal preflight failure |
| `BEOI-LIVE-101` / `BEOI-LIVE-111` | Columns catalog query / columns contract |
| `BEOI-LIVE-102` / `BEOI-LIVE-112` | Constraints catalog query / constraints contract |
| `BEOI-LIVE-103` / `BEOI-LIVE-113` | Indexes catalog query / indexes contract |
| `BEOI-LIVE-201` | Combined role/database privilege query |
| `BEOI-LIVE-202` | Schema privilege query |
| `BEOI-LIVE-203` | Table privilege query |
| `BEOI-LIVE-204` | Default-function-ACL query |
| `BEOI-LIVE-205` | Public-routines query |
| `BEOI-LIVE-206` | Column-ACL query |
| `BEOI-LIVE-207` | Ownership query |
| `BEOI-LIVE-208` | Settings query |
| `BEOI-LIVE-209` | Memberships query |
| `BEOI-LIVE-211` | Role contract |
| `BEOI-LIVE-212` | Database contract |
| `BEOI-LIVE-213` | Schema contract |
| `BEOI-LIVE-214` | Table contract |
| `BEOI-LIVE-215` | Default-function-ACL contract |
| `BEOI-LIVE-216` | Public-routines contract |
| `BEOI-LIVE-217` | Column-ACL contract |
| `BEOI-LIVE-218` | Ownership contract |
| `BEOI-LIVE-219` | Settings contract |
| `BEOI-LIVE-220` | Memberships contract |

For each isolated `neondb`, `neondb_owner` must apply the remaining applicable
statements below, then reconnect as `mj_eoi_app` and run the generated probe.
Revoking from `PUBLIC` is required because PostgreSQL has no `DENY`; a direct
revoke from `mj_eoi_app` cannot override an inherited public grant.

```sql
REVOKE TEMPORARY ON DATABASE neondb FROM PUBLIC, mj_eoi_app;
REVOKE USAGE, CREATE ON SCHEMA public FROM PUBLIC, mj_eoi_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, mj_eoi_app;
REVOKE EXECUTE ON ALL PROCEDURES IN SCHEMA public FROM PUBLIC, mj_eoi_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
```

### 13.4 Connection and GitHub secrets (names only)

The Worker connects via the **pooled** Neon endpoint (pooler host) through
`NEON_DATABASE_URL`, stored as a **GitHub Actions environment secret** (not a
repo-level secret) under each environment, so preview and production never share
a database. Each environment also has its own distinct, high-entropy
(>=32-byte ASCII) `BOOK_EOI_HMAC_KEY` (HMAC-SHA256 email-hash key) and
`BOOK_EOI_ENCRYPTION_KEY` (AES-256-GCM PII key material, HKDF-derived at runtime).
Secret names configured (names only, never values):

- `NEON_DATABASE_URL` (environment: preview, production)
- `BOOK_EOI_HMAC_KEY` (environment: preview, production)
- `BOOK_EOI_ENCRYPTION_KEY` (environment: preview, production)

`TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY`, and
`TURNSTILE_WIDGET_FINGERPRINT` are **not** GitHub secrets.
They are provisioned directly on the selected Worker by the guarded, manual-only
`.github/workflows/turnstile-provision.yml` workflow. The workflow receives the
widget credentials from Cloudflare into mode-`0600` runner-temp files, derives
SHA-256 over the exact UTF-8 `sitekey + NUL + secret` tuple, masks all three
values, pipes them directly to `wrangler secret put`, validates only the resulting
Worker secret **names**, and shreds the files. No Turnstile value is stored in
GitHub, an artifact, logs, Git, or this document. They are unrelated to the Neon
data-layer provisioning, but they are **not optional for the Books page or a
deploy**:

- `TURNSTILE_SITE_KEY` (non-secret, but kept out of Git) is injected by the
  Worker into the `/books` page's Turnstile widget. If it is absent the Worker
  **fails closed with 503** for `/books` (no half-functional page is served).
- `TURNSTILE_SECRET_KEY` verifies submitted tokens server-side.
- `TURNSTILE_WIDGET_FINGERPRINT` binds the exact sitekey/secret pair without
  exposing either value. Health recomputes and compares it without returning it.

All three are enforced by the post-deploy **`/api/books/health` smoke** in the
deploy workflow (`.github/workflows/deploy-cloudflare.yml`, "Verify deployment"): that
probe's config gate requires `NEON_DATABASE_URL`, all three Turnstile bindings,
the limiter `limit()` interface, the committed environment marker, both crypto
keys, and the non-secret allowed Turnstile action/host, then compares the live
schema. A preview/production deploy **deliberately cannot succeed** until the pair
and fingerprint are present and matched and the schema
matches — it is not merely pending. No existing repo-level secret was modified
to add EOI; the EOI data/crypto secrets are environment-scoped only, and the three
Turnstile bindings are Worker-scoped only.

The deploy workflow (`.github/workflows/deploy-cloudflare.yml`) reads the
data/crypto secrets as environment secrets under the selected `environment:` and
pushes them to the Worker as Wrangler secrets on manual `workflow_dispatch`
deploy. The three Turnstile bindings are **excluded** from that push list because
they are provisioned by the separate guarded workflow. Push/PR still run checks
only; production is never deployed automatically.

No connection string, password, or key value is stored in Git or this document.
Rotation re-provisions the role password/keys against the project and resets the
environment secret; there is no row data to migrate (the table is empty,
greenfield), so there is intentionally no rotation/compatibility fallback path.

### 13.5 Guarded Turnstile widget and Worker-secret provisioning

The only approved Turnstile automation is
`.github/workflows/turnstile-provision.yml`, backed by
`scripts/provision-turnstile.mjs`. It is `workflow_dispatch` only, has
`contents: read`, serializes globally across both environments, uses immutable
action pins, uploads no artifact, and has no widget update/delete/secret-rotation operation. Its token
is supplied only through the `CLOUDFLARE_API_TOKEN` environment variable. The
token must cover account `908b6ebad9914f568db2f19a25dd319b` and have Turnstile
Sites Read for probes; provisioning additionally needs Turnstile Sites Write and
Workers Scripts Write for the three Worker secret puts.

The script accepts only the following hardcoded targets; account, Worker,
hostname, and widget name cannot be overridden:

| Environment | Worker | Single allowed hostname | Exact widget name |
| --- | --- | --- | --- |
| `preview` | `mj-art-preview` | `mj-art-preview.drhasansabri.workers.dev` | `mj-art-books-eoi-preview` |
| `production` | `mj-art` | `mj-art.drhasansabri.workers.dev` | `mj-art-books-eoi-production` |

Exact operator procedure:

1. Dispatch **Turnstile Provision** with `mode=probe`, first for
   `environment=preview`, then for `environment=production`; leave
   `confirmation_phrase` empty. Probe performs only paginated `GET` requests to
   the account widget-list endpoint. It reports list permission yes/no and never
   prints a sitekey or secret. An HTTP 403 is a hard stop: fix the token's
   Turnstile Sites Read/account scope before any provision attempt.
2. Review both probe runs. Do not proceed unless both succeeded and no unexpected
   workflow change is present.
3. For the intended environment only, re-dispatch with `mode=provision` and the
   exact phrase `I-CONFIRM-TURNSTILE-PROVISION`. The credential-free first step
   fails closed before checkout or token exposure if the mode, environment, or
   phrase differs.
4. Provision lists widgets and matches the exact mapped name. No match creates
   one `managed` widget with exactly the single mapped hostname. One match is
   reused only if its mode and domain list are exact; mismatch or duplicates fail
   closed. Reuse performs an exact-widget `GET` to retrieve its current secret.
   There is no update, delete, or rotate fallback.
5. The script refuses relative, traversing, permissive, foreign-owned, symlinked,
   or pre-existing output paths. It exclusively creates
   `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, and
   `TURNSTILE_WIDGET_FINGERPRINT` files at mode `0600` in the runner's mode-`0700`
   temporary directory. The fingerprint is never printed. The workflow masks all
   three loaded values before piping them directly to the exact environment's
   env-only (`--env`, never `--name`) `wrangler secret put` commands; only secret
   names are read back. Temp files
   are shredded on every provision outcome. Values never become GitHub secrets.
6. Verify the workflow succeeded and that its name-only check found all three exact
   Worker bindings. Do not copy credentials out of the run.
7. Each of the three `wrangler secret put` commands creates and immediately
   deploys a **secret-only Worker version**. This does not replace the normal application release. After
   provisioning, run the final application deployment through the manual
   `.github/workflows/deploy-cloudflare.yml` workflow for the same environment;
   its `/api/books/health` smoke proves the complete
   Turnstile/limiter/Neon/crypto setup.

Historical incident evidence: the one-time Turnstile mis-targeting repair completed
successfully in GitHub Actions runs `31189090300` and `31189222411`. No temporary
repair tooling remains in the repository.

Rate-limit state is isolated twice. `apps/web/wrangler.jsonc` assigns distinct
namespace IDs to local/base (`1001`), preview (`1002`), and production (`1003`),
and commits `BOOK_EOI_ENVIRONMENT=local|preview|production`; every limiter key is
prefixed with that marker. This prevents counter collision even if a future
namespace configuration drifts.

Until this release commit is manually deployed, a live `404` on `/books` is the
expected predeploy state and is not a code defect. Do not open a route bug for
that observation alone.
