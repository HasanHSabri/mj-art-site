#!/usr/bin/env node
// MJ-ART archive review tool.
//
// Read-only by design. Reads archive/manifest.json, reports collection records
// that are due for review (or all with --all), re-checks whether each collection
// is still referenced by active app/deployment/config paths, recomputes and
// verifies each collection's tree checksum, and prints a non-binding
// recommendation (KEEP / EXTEND / DELETE).
//
// THIS SCRIPT PERFORMS NO DELETION AND EXPOSES NO DELETE FLAG.
// A DELETE recommendation is advisory text for a human that requires explicit
// human confirmation. Deletion (if ever desired) is always a separate,
// explicit, human-only action.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const MANIFEST_PATH = join(SCRIPT_DIR, "manifest.json");
const ARCHIVE_ROOT = join(REPO_ROOT, "archive");

// ---- checksum: identical to manifest "tree-sha256-sorted-path-content-v1" ----
function toPosix(p) {
  return p.split(sep).join("/");
}
function walkFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else if (ent.isFile()) out.push(p);
  }
  return out;
}
function treeChecksum(dir) {
  const rels = walkFiles(dir).map((p) => toPosix(relative(dir, p))).sort();
  let stream = "";
  let count = 0;
  let bytes = 0;
  for (const rel of rels) {
    const data = readFileSync(join(dir, ...rel.split("/")));
    const sha = createHash("sha256").update(data).digest("hex");
    stream += `${rel}|${sha}|${data.length}\n`;
    count += 1;
    bytes += data.length;
  }
  const sha = createHash("sha256").update(Buffer.from(stream, "utf8")).digest("hex");
  return { sha256: sha, fileCount: count, totalBytes: bytes };
}

// ---- active-reference scan ----
// Active repo inputs = app/deployment/config inputs only.
// Root README.md is documentation, not an active website runtime/build input,
// so it is excluded to avoid false references from documentation pointers.
// Excludes archive, .git, node_modules, generated caches.
const ACTIVE_ROOTS = [
  "apps/web",
  ".github",
  "package.json",
  "pnpm-workspace.yaml",
  ".gitignore",
];
const SKIP_SEGMENTS = new Set([
  "archive", ".git", "node_modules", ".wrangler",
  "dist", "build", ".cache", ".mf", ".turbo",
]);
// Generic path segments that must never be used as reference-search needles.
// Only sufficiently specific leaf path/name segments are used.
const SKIP_NEEDLE_SEGMENTS = new Set([
  "archive", "history", "retired", "superseded", "preview-qa",
  "quarantine", "deletion-candidates",
]);

function listActiveFiles() {
  const out = [];
  const consider = (abs) => {
    const rel = toPosix(relative(REPO_ROOT, abs));
    const segs = rel.split("/");
    if (segs.some((s) => SKIP_SEGMENTS.has(s))) return;
    out.push(abs);
  };
  for (const root of ACTIVE_ROOTS) {
    const abs = join(REPO_ROOT, root);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isFile()) {
      consider(abs);
    } else if (st.isDirectory()) {
      const stack = [abs];
      while (stack.length) {
        const d = stack.pop();
        for (const ent of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, ent.name);
          if (ent.isDirectory()) stack.push(p);
          else if (ent.isFile()) consider(p);
        }
      }
    }
  }
  return out;
}
function needlesFor(rec) {
  const set = new Set();
  // Stable record id (only if sufficiently specific, >= 4 chars)
  if (typeof rec.id === "string" && rec.id.trim().length >= 4) set.add(rec.id);
  const cap = String(rec.currentArchivePath || "").replace(/\/+$/, "");
  if (cap) {
    // Full archive path is always meaningful and specific
    set.add(cap);
    // Only the leaf path segment if it is not a generic intermediate word
    const segs = cap.split("/").filter(Boolean);
    if (segs.length) {
      const leaf = segs[segs.length - 1];
      if (!SKIP_NEEDLE_SEGMENTS.has(leaf) && leaf.length >= 4) set.add(leaf);
    }
  }
  return [...set];
}
function scanReferences(activeFiles, rec) {
  const needles = needlesFor(rec);
  const hits = [];
  for (const f of activeFiles) {
    let buf;
    try {
      buf = readFileSync(f);
    } catch {
      continue;
    }
    if (buf.subarray(0, 8000).includes(0)) continue; // likely binary
    const text = buf.toString("utf8");
    const matched = needles.filter((n) => text.includes(n));
    if (matched.length) {
      hits.push({ file: toPosix(relative(REPO_ROOT, f)), needles: matched });
    }
  }
  return hits;
}

// ---- date helpers (UTC, deterministic) ----
const STRICT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function todayUTC() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function isValidStrictDate(s) {
  if (typeof s !== "string" || !STRICT_DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function parseDate(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function isDue(rec, now) {
  if (!isValidStrictDate(rec.proposedReviewDate)) return false;
  return parseDate(rec.proposedReviewDate).getTime() <= now.getTime();
}

// ---- recommendation logic ----
function classify(rec) {
  const c = String(rec.classification).toLowerCase().trim();
  if (c === "permanent history") return "permanent-history";
  if (c === "retired") return "retired";
  if (c === "duplicate") return "duplicate";
  if (c === "deletion candidate") return "deletion-candidate";
  return "unknown";
}

// ---- path containment: confine currentArchivePath to <repo>/archive/ ----
function isWithinArchive(currentArchivePath) {
  if (typeof currentArchivePath !== "string" || !currentArchivePath.trim()) return false;
  const resolved = resolve(REPO_ROOT, currentArchivePath.replace(/\/+$/, ""));
  const rel = relative(ARCHIVE_ROOT, resolved);
  // Separator-aware: rel must be non-empty, not escape upward, and not be absolute.
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// ---- record shape validation ----
function validateRecord(rec, idx) {
  const warnings = [];
  const label = (typeof rec === "object" && rec && typeof rec.id === "string" && rec.id.trim())
    ? rec.id : `record[${idx}]`;
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
    return { valid: false, warnings: [`${label}: not a valid record object`] };
  }
  if (typeof rec.id !== "string" || !rec.id.trim())
    warnings.push(`${label}: missing or non-string id`);
  if (typeof rec.currentArchivePath !== "string" || !rec.currentArchivePath.trim())
    warnings.push(`${label}: missing or non-string currentArchivePath`);
  if (!rec.treeChecksum || typeof rec.treeChecksum !== "object" ||
      typeof rec.treeChecksum.sha256 !== "string" || !rec.treeChecksum.sha256.trim())
    warnings.push(`${label}: missing or malformed treeChecksum.sha256`);
  if (typeof rec.fileCount !== "number" || !Number.isFinite(rec.fileCount))
    warnings.push(`${label}: missing or non-number fileCount`);
  if (typeof rec.totalBytes !== "number" || !Number.isFinite(rec.totalBytes))
    warnings.push(`${label}: missing or non-number totalBytes`);
  if (typeof rec.classification !== "string" || !rec.classification.trim())
    warnings.push(`${label}: missing or non-string classification`);
  if (!isValidStrictDate(rec.proposedReviewDate))
    warnings.push(`${label}: missing or malformed proposedReviewDate (expected strict YYYY-MM-DD)`);
  return { valid: warnings.length === 0, warnings };
}
function recommend(rec, { checksumOk, referenced, due, recordValid, pathContained }) {
  // Invalid record shape or path outside archive → EXTEND (investigate, never delete)
  if (!recordValid) {
    return { decision: "EXTEND", reason: "record has validation warnings — do not delete; re-investigate and correct the manifest." };
  }
  if (!pathContained) {
    return { decision: "EXTEND", reason: "currentArchivePath is outside archive/ — not traversed; do not delete, re-investigate." };
  }
  const kind = classify(rec);
  if (kind === "permanent-history" || kind === "retired") {
    return { decision: "KEEP", reason: "permanent-history/retired: preserved indefinitely; never a deletion target." };
  }
  if (referenced) {
    return { decision: "KEEP", reason: "still referenced by active app/deployment/config paths." };
  }
  if (!checksumOk) {
    return { decision: "EXTEND", reason: "checksum mismatch; contents changed since register — do not delete, re-investigate." };
  }
  if (!due) {
    return { decision: "KEEP", reason: "not yet due for review." };
  }
  // due, unreferenced, checksum-valid — only consider DELETE for duplicate/deletion-candidate
  if (kind === "deletion-candidate" || kind === "duplicate") {
    const hasEvidence = rec.deletionEvidence &&
      rec.deletionEvidence.hasDuplicateRecoverableEvidence === true;
    if (!hasEvidence) {
      return {
        decision: "EXTEND",
        reason: `${kind}: due, unreferenced, checksum-valid, but deletionEvidence.hasDuplicateRecoverableEvidence is not true — do not delete; add evidence or reclassify.`,
      };
    }
    return {
      decision: "DELETE",
      reason: "recommendation-only; human-confirmation-required. Due, unreferenced, checksum-valid, with explicit duplicate/recoverable evidence. NO deletion is performed by this tool.",
    };
  }
  // unknown / ambiguous → conservative keep
  return { decision: "KEEP", reason: "unknown classification; conservatively retained." };
}

// ---- output ----
function hr() {
  console.log("------------------------------------------------------------------------------");
}
function printRecord(rec, checks) {
  const storedSha = (rec.treeChecksum && typeof rec.treeChecksum.sha256 === "string")
    ? rec.treeChecksum.sha256 : "<missing>";
  const storedAlgo = (rec.treeChecksum && typeof rec.treeChecksum.algorithm === "string")
    ? rec.treeChecksum.algorithm : "<missing>";
  console.log(`id               : ${rec.id ?? "<missing>"}`);
  console.log(`classification   : ${rec.classification ?? "<missing>"}`);
  console.log(`originalPath     : ${rec.originalPath ?? "<missing>"}`);
  console.log(`currentArchivePath: ${rec.currentArchivePath ?? "<missing>"}`);
  console.log(`reason           : ${rec.reason ?? "<missing>"}`);
  console.log(`proposedReview   : ${rec.proposedReviewDate ?? "<missing>"} (review reminder only; NOT an expiry/deletion date)`);
  if (checks.warnings && checks.warnings.length) {
    for (const w of checks.warnings) console.log(`WARNING          : ${w}`);
  }
  console.log(`checksum (stored): ${storedSha} [${storedAlgo}]`);
  console.log(`checksum (now)   : ${checks.now.sha256}`);
  console.log(`checksum files   : stored=${rec.fileCount ?? "<missing>"} now=${checks.now.fileCount}`);
  console.log(`checksum bytes   : stored=${rec.totalBytes ?? "<missing>"} now=${checks.now.totalBytes}`);
  console.log(`checksum status  : ${checks.ok ? "VERIFIED" : "*** MISMATCH ***"}`);
  if (!checks.pathContained) {
    console.log(`path containment : *** OUTSIDE archive/ — not traversed ***`);
  }
  if (checks.refs.length) {
    console.log(`active references: ${checks.refs.length} file(s)`);
    for (const r of checks.refs) console.log(`  - ${r.file}  (matched: ${r.needles.join(", ")})`);
  } else {
    console.log(`active references: none in scanned active paths`);
  }
  const rec2 = recommend(rec, {
    checksumOk: checks.ok,
    referenced: checks.refs.length > 0,
    due: checks.due,
    recordValid: checks.recordValid,
    pathContained: checks.pathContained,
  });
  console.log(`recommendation   : ${rec2.decision}`);
  console.log(`  -> ${rec2.reason}`);
}

function help() {
  console.log(`MJ-ART archive review tool

Usage:
  node archive/review.mjs            Review records due on/before today (default).
  node archive/review.mjs --all      Review ALL records regardless of due date.
  node archive/review.mjs --help     Show this help.

What it does:
  - Reads archive/manifest.json.
  - For each reviewed record: recomputes the collection tree checksum and
    verifies it against the manifest, scans active app/deployment/config paths
    for references, and prints a non-binding recommendation
    (KEEP / EXTEND / DELETE).

Safety:
  - READ-ONLY. This tool PERFORMS NO DELETION and exposes NO delete flag.
  - DELETE is a recommendation-only value that requires human confirmation;
    it never triggers any file operation.
  - Review dates are reminders only, not expiry/deletion dates.
  - Any deletion is always a separate, explicit, human-only action.
`);
}

// ---- main ----
function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    help();
    return;
  }
  const all = args.includes("--all");
  const unknown = args.filter((a) => a !== "--all");
  if (unknown.length) {
    console.error(`Unknown argument(s): ${unknown.join(" ")}`);
    help();
    process.exit(2);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch (e) {
    console.error(`Could not read manifest at ${MANIFEST_PATH}: ${e.message}`);
    process.exit(1);
  }
  const records = Array.isArray(manifest.records) ? manifest.records : [];
  const now = todayUTC();
  const todayStr = now.toISOString().slice(0, 10);
  const activeFiles = listActiveFiles();

  console.log(`MJ-ART archive review  (read-only; no deletion performed)`);
  console.log(`manifest: ${toPosix(relative(REPO_ROOT, MANIFEST_PATH))}`);
  console.log(`today(UTC): ${todayStr}   mode: ${all ? "--all" : "due-only"}`);
  console.log(`active files scanned: ${activeFiles.length}`);
  hr();

  // integrity pass over ALL records, always
  let integrityWarnings = 0;
  const checksByRecord = new Map();
  const recordKey = (rec, i) =>
    (rec && typeof rec.id === "string" && rec.id.trim()) ? rec.id : `record[${i}]`;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const key = recordKey(rec, i);
    const validation = validateRecord(rec, i);
    for (const w of validation.warnings) console.warn(`WARNING: ${w}`);

    const pathOk = isWithinArchive(rec && rec.currentArchivePath);
    if (!pathOk && rec && typeof rec.currentArchivePath === "string" && rec.currentArchivePath.trim()) {
      console.warn(`WARNING: ${key}: currentArchivePath "${rec.currentArchivePath}" is outside archive/ — not traversing`);
    }

    let nowSum = { sha256: "<not-computed>", fileCount: 0, totalBytes: 0 };
    if (pathOk && validation.valid) {
      const dir = join(REPO_ROOT, String(rec.currentArchivePath).replace(/\/+$/, ""));
      try {
        nowSum = treeChecksum(dir);
      } catch (e) {
        nowSum = { sha256: "<unreadable>", fileCount: 0, totalBytes: 0, error: e.message };
      }
    }

    const storedSha = (rec && rec.treeChecksum && typeof rec.treeChecksum.sha256 === "string")
      ? rec.treeChecksum.sha256 : "<missing>";
    const ok = validation.valid && pathOk &&
      nowSum.sha256 === storedSha &&
      nowSum.fileCount === rec.fileCount &&
      nowSum.totalBytes === rec.totalBytes;
    if (!ok) integrityWarnings += 1;

    const refs = scanReferences(activeFiles, rec || {});
    const due = isDue(rec || {}, now);
    const dateValid = isValidStrictDate(rec && rec.proposedReviewDate);
    const needsAttention = !validation.valid || !pathOk || !dateValid;

    checksByRecord.set(key, {
      now: nowSum, ok, refs, due,
      recordValid: validation.valid,
      pathContained: pathOk,
      needsAttention,
      warnings: validation.warnings,
    });
  }
  console.log(`integrity: ${records.length - integrityWarnings}/${records.length} collections checksum-verified${integrityWarnings ? "  *** WARNINGS ABOVE/BELOW ***" : ""}`);
  hr();

  const toShow = all ? records : records.filter((r, i) => {
    const c = checksByRecord.get(recordKey(r, i));
    return c && (c.due || c.needsAttention);
  });
  if (!toShow.length) {
    console.log("No records are due for review today. (Use --all to list every record.)");
    hr();
    if (all) {
      for (let i = 0; i < records.length; i++) {
        printRecord(records[i], checksByRecord.get(recordKey(records[i], i)));
        hr();
      }
    }
    return;
  }

  console.log(`records to review: ${toShow.length}`);
  hr();
  for (let i = 0; i < toShow.length; i++) {
    const rec = toShow[i];
    const origIdx = records.indexOf(rec);
    printRecord(rec, checksByRecord.get(recordKey(rec, origIdx)));
    hr();
  }

  console.log("Reminder: review dates are NOT deletion dates. This tool performs NO deletion.");
}

main();
