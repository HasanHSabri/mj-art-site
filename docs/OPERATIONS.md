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
  `X-Content-Type-Options: nosniff`. There is no user-controlled path and no
  upload delete path. The previous timestamp-based upload path (`artwork/<timestamp>-<slug>`)
  is removed.
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
- **Credentials are excluded** from every artifact. The token and Authorization
  header are never written, logged, or echoed.
- The backup artifact is a dated, SHA-256-checksummed tarball uploaded as a GitHub
  Actions artifact with fixed retention.
- **Restore is a separate, deliberate operation** and is never inferred from a
  backup run. Any restore must be tested in an **isolated** bucket first.
- Restore order: **images first, `artworks.json` last**. Restoring metadata before
  its referenced images creates a window of broken references.
- **Permission to inspect or back up never implies permission to change production.**

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
