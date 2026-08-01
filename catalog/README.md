# MJ Painting Catalogue

Canonical, validated 86-record MJ painting catalogue. Single schema for all
records. This is the **authoritative source of truth** for the MJ art catalogue.

> **Runtime is now wired to this catalogue's schema.** The web Worker reads
> artwork metadata from the R2 `ARTWORK_IMAGES` key `artworks.json`, validated
> against the single schema below. Public endpoints serve a projected, ordered
> view (no `catalogNumber`, `sortOrder`, or `provenance`). The admin PUT accepts
> only this canonical schema. Uploading images to R2 and full admin/public UI
> are separate phases.

## Counts

| Category       | Count |
|----------------|-------|
| Catalogue      | 75    |
| Miscellaneous  | 11    |
| **Total**      | **86**|

## Files

| File                       | Description                                          |
|----------------------------|------------------------------------------------------|
| `catalog.json`             | 86 canonical records (the source of truth)           |
| `catalog.csv`              | Review-friendly flat summary                         |
| `approvals.json`           | Authoritative approved/rejected mapping decisions    |
| `orientation-report.json`  | Deterministic orientation analysis for 6 photos      |
| `README.md`                | This document                                        |

## Schema (single schema for all 86 records)

Every record has exactly these fields:

```
id            string   stable slug: mj-001..mj-075, misc-001..misc-011
catalogNumber string   MJ-xxx or MISC-xxx (admin-only, never public)
category      string   "catalogue" | "miscellaneous"
title         string   public title (UMJ-xxx for untitled; approved title for mapped)
image         string   planned R2 path /artwork-uploaded/artwork/catalog/<id>/full.jpg
thumbnail     string   planned R2 path /artwork-uploaded/artwork/catalog/<id>/thumb.jpg
medium        string|null  art medium, or null if unknown
dimensions    object   { widthCm, heightCm, label, orientation }
sizeCategory  string   canonical size key (e.g. "20x25") or "miscellaneous"
availability  string   "Available" | "Sold"
price         object|null  { amount:number, currency:"AUD", note:string|null }
cardNote      string   display note (transferred exactly from live data for mapped)
description   string   artwork description (transferred for mapped; "" for untitled)
containImage  boolean  whether image should be object-fit:contained
sortOrder     integer  unique; catalogue 1-75 then misc 76-86
provenance    object   audit-only: source, identifiers, hashes; no secrets
```

**No legacy runtime fields, no dual schema, no migration path.** Provenance is
for audit only and is never consumed by the runtime.

## Dimensions & Orientation

- **Folder suffix is authoritative** where present (`Horizontal`, `Vertical`,
  `Square`).
- For the 6 photos whose folders lack an orientation suffix (`MJ-060`, `MJ-061`,
  `MJ-072`, `MJ-073`, `MJ-074`, `MJ-075`), orientation was determined by
  deterministic offline canvas/frame analysis (see `orientation-report.json`).
  All 6 are **Vertical**.
- Orientation is text-only metadata. **No image rotation** is performed or
  implied.
- Photo timestamps malformed as `2026-07:23 14:52:58` were fixed to
  ISO 8601 `2026-07-23T14:52:58` in provenance.

## Mapping Decisions

13 Drive catalogue entries were mapped from existing live Miscellaneous entries
(approved by the artist). The existing title, medium, cardNote, and description
transfer **exactly**. See `approvals.json` for the full list.

Rejected mappings (3) remain distinct — see `approvals.json`.

### Price Rules

- Currency is **AUD** throughout.
- Explicit prices: Beautiful Chaos A$70, Still Waters A$40 (postage extra
  noted separately), Veil of Agony A$100, Distant Tide A$30 (historical; now
  Sold).
- All other prices are `null` (public display: "Price on enquiry").

## Size Category Counts (catalogue only)

| Size   | Count |
|--------|-------|
| 20x20  | 37    |
| 20x25  | 11    |
| 25x25  | 4     |
| 30x23  | 1     |
| 30x30  | 6     |
| 35x28  | 2     |
| 40x30  | 10    |
| 47x57  | 1     |
| 50x25  | 1     |
| 55x30  | 1     |
| 58x73  | 1     |
| **Total** | **75** |

## Availability Summary

|                | Available | Sold |
|----------------|-----------|------|
| Catalogue      | 75        | 0    |
| Miscellaneous  | 3         | 8    |

## Sources & Provenance

| Source | Used for |
|--------|----------|
| Google Drive read-only export (`/tmp/opencode/mj-drive-readonly/`) | 75 Drive originals |
| R2 read-only backup (run 30610273474, 2026-07-31T06:39:18Z) | Live metadata + artwork-uploaded images |
| Cross-set matching artifacts (`/tmp/opencode/mj-catalog-review/matching/`) | Mapping proposals |

Durable byte-identical image copies (outside Git):
`.local-assets/catalog-assets/` (gitignored, within the repo tree) with `SHA256SUMS`.

## Validation

```sh
pnpm check:catalog
```

Runs `scripts/validate-catalog.mjs` — a dependency-free validator that checks
schema integrity, uniqueness, exact counts, size-category counts, allowed
statuses/currency, mapping invariants, R2 path shape, SHA-256 formats, and
absence of local absolute paths or secrets.
