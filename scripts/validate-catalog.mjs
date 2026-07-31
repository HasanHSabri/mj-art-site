#!/usr/bin/env node
// Dependency-free catalogue validator.
// Validates catalog/catalog.json against schema, counts, invariants, and safety rules.
// Exit code 0 = pass, 1 = fail.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = join(__dirname, "..", "catalog");

let errors = [];
let warnings = [];

function fail(msg) {
  errors.push(msg);
}

function readJson(name) {
  try {
    return JSON.parse(readFileSync(join(CATALOG_DIR, name), "utf8"));
  } catch (e) {
    fail(`Cannot read ${name}: ${e.message}`);
    return null;
  }
}

// ---------- Constants ----------
const EXPECTED_TOTAL = 86;
const EXPECTED_CATALOGUE = 75;
const EXPECTED_MISC = 11;
const EXPECTED_APPROVED = 13;
const EXPECTED_REJECTED = 3;
const EXPECTED_MISC_SOLD = 8;
const EXPECTED_MISC_AVAILABLE = 3;

const ALLOWED_CATEGORIES = new Set(["catalogue", "miscellaneous"]);
const ALLOWED_AVAILABILITY = new Set(["Available", "Sold"]);
const ALLOWED_CURRENCY = new Set(["AUD"]);
const ALLOWED_ORIENTATIONS = new Set(["Horizontal", "Vertical", "Square", "Unknown"]);

const EXPECTED_SIZE_COUNTS = {
  "20x20": 37,
  "20x25": 11,
  "25x25": 4,
  "30x23": 1,
  "30x30": 6,
  "35x28": 2,
  "40x30": 10,
  "47x57": 1,
  "50x25": 1,
  "55x30": 1,
  "58x73": 1,
};

const EXPECTED_MISC_SIZE_COUNT = 11; // all "miscellaneous"

const SHA256_RE = /^[a-f0-9]{64}$/;
const R2_PATH_RE = /^\/artwork-uploaded\/artwork\/catalog\/[a-z]+-\d{3}\/(full|thumb)\.jpg$/;
const LEAK_RE = /\/tmp\/|\/workspace\/|\/home\/|\/Users\/|\\Users\\|C:\\\\/i;
const SECRET_RE = /(secret|token|password|api[_-]?key|authorization|bearer|credential)/i;

// Approved mappings (MJ -> original misc label)
const APPROVED = {
  "MJ-001": "MISC-022",
  "MJ-023": "MISC-020",
  "MJ-053": "MISC-015",
  "MJ-055": "MISC-024",
  "MJ-059": "MISC-001",
  "MJ-060": "MISC-014",
  "MJ-061": "MISC-013",
  "MJ-063": "MISC-018",
  "MJ-064": "MISC-010",
  "MJ-065": "MISC-021",
  "MJ-066": "MISC-019",
  "MJ-069": "MISC-017",
  "MJ-074": "MISC-008",
};

const REJECTED = [
  { drive: "MJ-046", misc: "MISC-023" },
  { drive: "MJ-052", misc: "MISC-011" },
  { drive: "MJ-052", misc: "MISC-006" },
];

// Labels that should NOT appear as mapped-from in any catalogue record
// (they are rejected or remain in misc)
const REJECTED_MISC_LABELS = new Set(["MISC-023", "MISC-011", "MISC-006", "MISC-002", "MISC-003", "MISC-004", "MISC-005", "MISC-007", "MISC-009", "MISC-012", "MISC-016"]);

// ---------- Load ----------
const catalog = readJson("catalog.json");
const approvals = readJson("approvals.json");
const orientationReport = readJson("orientation-report.json");

if (!catalog || !approvals || !orientationReport) {
  console.error(JSON.stringify(errors, null, 2));
  process.exit(1);
}

// ---------- Structural checks ----------
if (!Array.isArray(catalog)) fail("catalog.json must be an array");
if (catalog.length !== EXPECTED_TOTAL)
  fail(`Expected ${EXPECTED_TOTAL} records, got ${catalog.length}`);

// ---------- Per-record validation ----------
const seenIds = new Set();
const seenCatalogNumbers = new Set();
const seenSortOrders = new Set();
const sizeCounts = {};
const availabilityCounts = { catalogue: { Available: 0, Sold: 0 }, miscellaneous: { Available: 0, Sold: 0 } };
const matchedDriveIds = [];

for (const r of catalog) {
  const ctx = r.id || r.catalogNumber || "(unknown)";

  // Required top-level fields
  const requiredFields = ["id", "catalogNumber", "category", "title", "image", "thumbnail",
    "medium", "dimensions", "sizeCategory", "availability", "price", "cardNote",
    "description", "containImage", "sortOrder", "provenance"];
  for (const f of requiredFields) {
    if (!(f in r)) fail(`[${ctx}] missing field: ${f}`);
  }

  // id format
  if (typeof r.id === "string" && !/^[a-z]+-\d{3}$/.test(r.id))
    fail(`[${ctx}] id must be slug like mj-001 or misc-001, got: ${r.id}`);

  // id/catalogNumber consistency
  if (r.id && r.catalogNumber && r.id !== r.catalogNumber.toLowerCase())
    fail(`[${ctx}] id must equal catalogNumber.toLowerCase(): id=${r.id} catalogNumber=${r.catalogNumber}`);

  // category
  if (!ALLOWED_CATEGORIES.has(r.category))
    fail(`[${ctx}] invalid category: ${r.category}`);

  // catalogNumber format
  if (r.category === "catalogue" && !/^MJ-\d{3}$/.test(r.catalogNumber))
    fail(`[${ctx}] catalogue catalogNumber must be MJ-xxx, got: ${r.catalogNumber}`);
  if (r.category === "miscellaneous" && !/^MISC-\d{3}$/.test(r.catalogNumber))
    fail(`[${ctx}] misc catalogNumber must be MISC-xxx, got: ${r.catalogNumber}`);

  // Uniqueness
  if (seenIds.has(r.id)) fail(`[${ctx}] duplicate id: ${r.id}`);
  seenIds.add(r.id);
  if (seenCatalogNumbers.has(r.catalogNumber)) fail(`[${ctx}] duplicate catalogNumber: ${r.catalogNumber}`);
  seenCatalogNumbers.add(r.catalogNumber);
  if (seenSortOrders.has(r.sortOrder)) fail(`[${ctx}] duplicate sortOrder: ${r.sortOrder}`);
  seenSortOrders.add(r.sortOrder);

  // Availability
  if (!ALLOWED_AVAILABILITY.has(r.availability))
    fail(`[${ctx}] invalid availability: ${r.availability}`);
  availabilityCounts[r.category][r.availability]++;

  // title must be non-empty string
  if (typeof r.title !== "string" || r.title.length === 0)
    fail(`[${ctx}] title must be non-empty string`);

  // cardNote / description must be strings
  if (typeof r.cardNote !== "string") fail(`[${ctx}] cardNote must be string`);
  if (typeof r.description !== "string") fail(`[${ctx}] description must be string`);
  if (typeof r.containImage !== "boolean") fail(`[${ctx}] containImage must be boolean`);
  if (!Number.isInteger(r.sortOrder)) fail(`[${ctx}] sortOrder must be integer`);

  // Image paths
  if (typeof r.image === "string" && !R2_PATH_RE.test(r.image))
    fail(`[${ctx}] image path malformed: ${r.image}`);
  if (typeof r.thumbnail === "string" && !R2_PATH_RE.test(r.thumbnail))
    fail(`[${ctx}] thumbnail path malformed: ${r.thumbnail}`);

  // Leak check: no local absolute paths
  const fullJson = JSON.stringify(r);
  if (LEAK_RE.test(fullJson))
    fail(`[${ctx}] leaked local absolute path detected in record`);

  // Secret check
  if (SECRET_RE.test(fullJson))
    fail(`[${ctx}] potential secret value detected in record`);

  // Dimensions
  const dims = r.dimensions;
  if (dims) {
    if (!ALLOWED_ORIENTATIONS.has(dims.orientation))
      fail(`[${ctx}] invalid orientation: ${dims.orientation}`);
    if (typeof dims.label !== "string")
      fail(`[${ctx}] dimensions.label must be string`);
    if (dims.widthCm !== null && typeof dims.widthCm !== "number")
      fail(`[${ctx}] widthCm must be number or null`);
    if (dims.heightCm !== null && typeof dims.heightCm !== "number")
      fail(`[${ctx}] heightCm must be number or null`);
    // Consistency: orientation vs dims
    if (dims.widthCm !== null && dims.heightCm !== null) {
      if (dims.widthCm === dims.heightCm && dims.orientation !== "Square")
        fail(`[${ctx}] equal dims but orientation is ${dims.orientation}, expected Square`);
      if (dims.widthCm > dims.heightCm && dims.orientation !== "Horizontal")
        fail(`[${ctx}] width>height but orientation is ${dims.orientation}, expected Horizontal`);
      if (dims.widthCm < dims.heightCm && dims.orientation !== "Vertical")
        fail(`[${ctx}] width<height but orientation is ${dims.orientation}, expected Vertical`);
    }
  }

  // sizeCategory
  if (r.category === "miscellaneous") {
    if (r.sizeCategory !== "miscellaneous")
      fail(`[${ctx}] misc sizeCategory must be "miscellaneous"`);
  } else {
    if (!EXPECTED_SIZE_COUNTS[r.sizeCategory] && r.sizeCategory !== "miscellaneous") {
      // allow known sizes only
    }
    sizeCounts[r.sizeCategory] = (sizeCounts[r.sizeCategory] || 0) + 1;
  }

  // Price
  if (r.price !== null) {
    if (typeof r.price !== "object")
      fail(`[${ctx}] price must be object or null`);
    else {
      if (typeof r.price.amount !== "number" || r.price.amount <= 0)
        fail(`[${ctx}] price.amount must be positive number`);
      if (!ALLOWED_CURRENCY.has(r.price.currency))
        fail(`[${ctx}] price.currency must be AUD, got: ${r.price.currency}`);
      if (r.price.note !== null && typeof r.price.note !== "string")
        fail(`[${ctx}] price.note must be string or null`);
    }
  }

  // Provenance
  const prov = r.provenance;
  if (prov) {
    if (typeof prov.source !== "string" || prov.source.length === 0)
      fail(`[${ctx}] provenance.source must be non-empty string`);
    // SHA-256 format check
    if (prov.sha256 && !SHA256_RE.test(prov.sha256))
      fail(`[${ctx}] provenance.sha256 must be 64-char hex, got: ${prov.sha256}`);
    // No secret URLs/tokens
    const provJson = JSON.stringify(prov);
    if (SECRET_RE.test(provJson))
      fail(`[${ctx}] potential secret in provenance`);
    if (LEAK_RE.test(provJson))
      fail(`[${ctx}] leaked local path in provenance`);
  }

  // Track matched drive records
  if (r.category === "catalogue" && prov && prov.mappedFromMiscLabel) {
    matchedDriveIds.push({ mj: r.catalogNumber, misc: prov.mappedFromMiscLabel, title: r.title });
  }
}

// ---------- Count checks ----------
const catCount = catalog.filter(r => r.category === "catalogue").length;
const miscCount = catalog.filter(r => r.category === "miscellaneous").length;
if (catCount !== EXPECTED_CATALOGUE) fail(`Expected ${EXPECTED_CATALOGUE} catalogue, got ${catCount}`);
if (miscCount !== EXPECTED_MISC) fail(`Expected ${EXPECTED_MISC} misc, got ${miscCount}`);

if (availabilityCounts.miscellaneous.Sold !== EXPECTED_MISC_SOLD)
  fail(`Expected ${EXPECTED_MISC_SOLD} misc Sold, got ${availabilityCounts.miscellaneous.Sold}`);
if (availabilityCounts.miscellaneous.Available !== EXPECTED_MISC_AVAILABLE)
  fail(`Expected ${EXPECTED_MISC_AVAILABLE} misc Available, got ${availabilityCounts.miscellaneous.Available}`);
if (availabilityCounts.catalogue.Available !== EXPECTED_CATALOGUE)
  fail(`Expected all ${EXPECTED_CATALOGUE} catalogue Available, got ${availabilityCounts.catalogue.Available}`);
if (availabilityCounts.catalogue.Sold !== 0)
  fail(`Expected 0 catalogue Sold, got ${availabilityCounts.catalogue.Sold}`);

// Size counts
for (const [size, expected] of Object.entries(EXPECTED_SIZE_COUNTS)) {
  if ((sizeCounts[size] || 0) !== expected)
    fail(`Size category "${size}": expected ${expected}, got ${sizeCounts[size] || 0}`);
}

// Sort order: catalogue 1-75, misc 76-86
for (let i = 1; i <= 75; i++) {
  if (!seenSortOrders.has(i)) fail(`Missing sortOrder ${i} (catalogue)`);
}
for (let i = 76; i <= 86; i++) {
  if (!seenSortOrders.has(i)) fail(`Missing sortOrder ${i} (misc)`);
}

// ---------- Mapping invariants ----------
if (matchedDriveIds.length !== EXPECTED_APPROVED)
  fail(`Expected ${EXPECTED_APPROVED} approved mappings, found ${matchedDriveIds.length}`);

// Verify each approved mapping matches the expected pairs
for (const { mj, misc } of matchedDriveIds) {
  if (APPROVED[mj] !== misc) {
    fail(`Mapping mismatch: record ${mj} claims mappedFrom ${misc}, expected ${APPROVED[mj] || "(none)"}`);
  }
}
// Verify all approved mappings are present
for (const [mj, misc] of Object.entries(APPROVED)) {
  const found = matchedDriveIds.find(m => m.mj === mj && m.misc === misc);
  if (!found) fail(`Approved mapping ${mj} <- ${misc} not found in catalogue`);
}

// Verify rejected misc labels do NOT appear as mappedFrom
for (const r of catalog) {
  if (r.provenance && r.provenance.mappedFromMiscLabel) {
    if (REJECTED_MISC_LABELS.has(r.provenance.mappedFromMiscLabel))
      fail(`Rejected/misc-only label ${r.provenance.mappedFromMiscLabel} found as mappedFrom in ${r.catalogNumber}`);
  }
}

// Verify MJ-046 and MJ-052 are NOT mapped (rejected)
const mj046 = catalog.find(r => r.catalogNumber === "MJ-046");
const mj052 = catalog.find(r => r.catalogNumber === "MJ-052");
if (mj046 && mj046.provenance && mj046.provenance.mappedFromMiscLabel)
  fail(`MJ-046 should be unmapped (rejected), but has mappedFromMiscLabel`);
if (mj052 && mj052.provenance && mj052.provenance.mappedFromMiscLabel)
  fail(`MJ-052 should be unmapped (rejected), but has mappedFromMiscLabel`);

// ---------- Approvals.json checks ----------
if (approvals) {
  if (approvals.approvedCount !== EXPECTED_APPROVED)
    fail(`approvals.json approvedCount=${approvals.approvedCount}, expected ${EXPECTED_APPROVED}`);
  if (approvals.rejectedCount !== EXPECTED_REJECTED)
    fail(`approvals.json rejectedCount=${approvals.rejectedCount}, expected ${EXPECTED_REJECTED}`);
  if (approvals.remainingMiscCount !== EXPECTED_MISC)
    fail(`approvals.json remainingMiscCount=${approvals.remainingMiscCount}, expected ${EXPECTED_MISC}`);
  if (!Array.isArray(approvals.approvedMappings) || approvals.approvedMappings.length !== EXPECTED_APPROVED)
    fail(`approvals.json approvedMappings length mismatch`);
  if (approvals.miscAvailabilityDecisions) {
    if (approvals.miscAvailabilityDecisions.sold.length !== EXPECTED_MISC_SOLD)
      fail(`approvals.json sold count mismatch`);
    if (approvals.miscAvailabilityDecisions.available.length !== EXPECTED_MISC_AVAILABLE)
      fail(`approvals.json available count mismatch`);
  }
}

// ---------- Orientation report checks ----------
if (orientationReport) {
  if (!Array.isArray(orientationReport.items) || orientationReport.items.length !== 6)
    fail(`orientation-report.json must have 6 items, got ${orientationReport.items?.length}`);
  for (const item of orientationReport.items) {
    if (item.orientation !== "Vertical" && item.orientation !== "Unknown")
      fail(`orientation-report ${item.catalogNumber}: unexpected orientation ${item.orientation}`);
    if (!item.confidence || !["high", "medium", "low"].includes(item.confidence))
      fail(`orientation-report ${item.catalogNumber}: invalid confidence ${item.confidence}`);
  }
}

// ---------- CSV row count check ----------
try {
  const csvContent = readFileSync(join(CATALOG_DIR, "catalog.csv"), "utf8");
  const csvLines = csvContent.trim().split("\n").length - 1; // minus header
  if (csvLines !== EXPECTED_TOTAL)
    fail(`catalog.csv has ${csvLines} data rows, expected ${EXPECTED_TOTAL}`);
} catch (e) {
  fail(`Cannot read catalog.csv: ${e.message}`);
}

// ---------- Output ----------
const recordCount = catalog.length;

// Price checks: verify known prices
const mj059 = catalog.find(r => r.catalogNumber === "MJ-059");
if (mj059 && (!mj059.price || mj059.price.amount !== 70))
  fail(`MJ-059 (Beautiful Chaos) price must be A$70`);
const mj001 = catalog.find(r => r.catalogNumber === "MJ-001");
if (mj001 && (!mj001.price || mj001.price.amount !== 40))
  fail(`MJ-001 (Still Waters) price must be A$40`);
const miscVeil = catalog.find(r => r.title === "Veil of Agony");
if (miscVeil && (!miscVeil.price || miscVeil.price.amount !== 100))
  fail(`Veil of Agony price must be A$100`);
const miscDistant = catalog.find(r => r.title === "Distant Tide");
if (miscDistant && (!miscDistant.price || miscDistant.price.amount !== 30))
  fail(`Distant Tide price must be A$30`);
if (miscDistant && miscDistant.availability !== "Sold")
  fail(`Distant Tide must be Sold`);

if (errors.length > 0) {
  console.error(`\n❌ Catalogue validation FAILED with ${errors.length} error(s):\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn(`⚠️  ${warnings.length} warning(s):`);
  for (const w of warnings) console.warn(`  - ${w}`);
}

console.log(`✅ Catalogue validation PASSED: ${recordCount} records (75 catalogue + 11 misc), 13 approved mappings, 3 rejected, all invariants OK.`);
