# MJ-ART Archive

Inactive, non-production MJ Art material. Nothing in `archive/` is deployed or
served by the active app (the live production source is `apps/web`).

This file is the short authoritative policy and recovery guide. The machine-
readable register is [`manifest.json`](./manifest.json). The read-only review
tool is [`review.mjs`](./review.mjs).

## Taxonomy

```
archive/
├── history/superseded/   permanent snapshots of superseded code
├── preview-qa/           historical preview / QA captures
├── retired/              formerly-active systems taken out of service
└── quarantine/deletion-candidates/   possible future deletions (currently empty)
```

Every collection is an archival unit with one record in `manifest.json`.

## Classification

Each record has exactly one classification:

| Value               | Meaning                                                       | Default review  |
|---------------------|---------------------------------------------------------------|-----------------|
| `permanent history` | Kept indefinitely as a historical record.                     | 1 year          |
| `retired`           | A formerly-active site/system, no longer deployed.            | 1 year          |
| `duplicate`         | Exact duplicate of material that exists elsewhere.            | 90 days         |
| `deletion candidate`| Queued for possible future deletion after review.             | 90 days         |

## Safety policy (read this)

- **Review dates are NOT expiry or deletion dates.** They are reminders only.
- **No automatic deletion ever occurs.** Reaching a review date deletes nothing.
- **Explicit human confirmation is always required** to delete anything, and even
  then the review tool cannot do it — deletion is a separate, deliberate action.
- Material was archived **conservatively**: anything unique or ambiguous was kept.
  There are currently **no deletion candidates** (`quarantine/deletion-candidates/`
  is intentionally empty).

## Default review periods

- **Deletion candidates / duplicates:** archive date + **90 days**.
  Example: a candidate archived `2026-07-29` would be reviewed `2026-10-27`.
- **Permanent history / retired:** annual integrity review (archive date + 1 year).
  All current records use `2027-07-29`. Rationale: these are not deletion targets;
  an annual check only verifies the collection is still intact and unreferenced,
  it never triggers deletion.

## Running the review tool

Dependency-free, read-only. No network. **Performs no deletion.**

```sh
# records whose review date is due today or earlier (default)
node archive/review.mjs

# all records, regardless of due date
node archive/review.mjs --all

# help
node archive/review.mjs --help
```

For each due record it prints original/current paths and reason, re-checks whether
the collection is still referenced in active app/deployment/config paths (root
README.md documentation pointers do not count as active references), recomputes
and verifies the collection tree checksum, and recommends exactly one of
**KEEP**, **EXTEND**, or **DELETE**.

- **KEEP** — preserved; no action needed (permanent history, retired, still
  referenced, not yet due, or conservatively retained for unknown classification).
- **EXTEND** — do not delete; re-investigate (checksum mismatch, validation
  warning, or path outside `archive/`).
- **DELETE** — recommendation-only; human-confirmation-required. Only ever issued
  for a deletion candidate or duplicate that is due, unreferenced, checksum-valid,
  and has `deletionEvidence.hasDuplicateRecoverableEvidence === true` in the
  manifest. No current record qualifies. The review tool **never** performs or
  exposes deletion — there is no delete flag, API, or file operation.

### Checksum path ordering

The tree checksum sorts file paths using JavaScript's default `.sort()` on
POSIX-relative path strings, which compares by **UTF-16 code-unit order**
(`String.prototype.charCodeAt`). This is NOT locale-aware and NOT byte-order
for non-BMP characters. The sort is deterministic and identical across runs on
any platform.

### Deletion evidence

Each record may optionally carry a `deletionEvidence` structure (see
`deletionEvidenceSchema` in `manifest.json`). A record can only receive a DELETE
recommendation when `deletionEvidence.hasDuplicateRecoverableEvidence` is `true`
and the content is independently verified to exist recoverably elsewhere. All
current records have `deletionEvidence: null` — none is approved for deletion.

## Restoring / copying archived material

Archived files are ordinary files; copy them wherever needed (no special tooling):

```sh
# copy a whole collection back into the repo (example)
cp -R archive/retired/legacy-github-pages /tmp/restored-legacy-site

# copy a single file out
cp "archive/preview-qa/2026-04/mj-art-site-preview.md" /tmp/
```

Because the pre-refactor snapshot preserves relative paths, it can be restored in
place by copying its contents to the repo root, e.g.:

```sh
# (dry-run preview)
rsync -a -n archive/history/superseded/pre-refactor-snapshot/ ./
```

Pre-existing copies of the same bytes may also exist in git history or under
`apps/web`; see each record's `dependenciesAndReferences` and `provenance`.

## Pre-archive baseline

The repository state immediately before archiving is identified by git commit:

```
e44c1fd145858810ec8da75b2579bec592d286ac   (branch: main)
```

To inspect the pre-archive tree:

```sh
git show e44c1fd145858810ec8da75b2579bec592d286ac --stat
git checkout e44c1fd145858810ec8da75b2579bec592d286ac -- docs/   # restore former docs/ if ever needed
```

## Provenance notes (corrected)

- `retired/legacy-github-pages/` is byte-for-byte the former top-level `docs/`
  site (proven identical to `e44c1fd` `docs/`, 26/26 files by path/size/SHA-256).
  Independently verified overlap against `apps/web/public`: **21 of 26** files are
  byte-identical (same relative path, SHA-256, and byte size) — all artwork
  images, `artworks.json`, `admin.css`, `styles.css`, and
  `artwork/inventory-template.txt`. The 5 differing files (`index.html`,
  `admin.html`, `admin.js`, `script.js`, `artwork/README.txt`) have divergent
  content vs their `apps/web` counterparts. These duplicate bytes are retained as
  internal dependencies of the self-contained legacy snapshot; this does **not**
  make the record a deletion candidate (`deletionEvidence` is `null`).
- `history/superseded/pre-refactor-snapshot/` preserves the seven divergent files
  of a retired older duplicate. Note: these snapshots contain **secret references**
  (configuration keys/variable names and endpoints) — not actual secrets. No live
  secret values are stored here.
- `preview-qa/2026-04/` was consolidated from an unrelated workspace folder.

## Production safety

No production, Cloudflare, R2, database, secret, network, deploy, or external
access was performed during archiving or while creating this register/tools.
