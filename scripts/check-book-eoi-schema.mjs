#!/usr/bin/env node
// =============================================================================
// Books EOI schema-drift guard (offline, deterministic, no network).
// =============================================================================
// Parses database/mj-eoi-schema.sql to extract the declared table, columns,
// CHECK constraints, UNIQUE constraint, indexes, and the documented runtime
// privileges. It:
//   1. Computes the column-name signature and asserts it equals the expected
//      signature embedded in apps/web/src/book-eoi.js (EXPECTED_SCHEMA_SIGNATURE).
//      This detects add/remove/rename drift between the SQL and the app's
//      expectation (the value used by /api/books/health).
//   2. Asserts the SQL contains NO DELETE, DROP, or payment/order tables, and
//      that the UNIQUE(book_code, email_hash) + required CHECKs + indexes exist.
//   3. Emits a ready-to-run catalog probe (information_schema + pg_catalog) an
//      operator can execute against Neon to compare the LIVE database to this
//      canonical definition (the comparison query; not executed here).
//
// This is NOT a migration runner and makes no database calls. Exit status is
// nonzero on any assertion failure. Wire it into CI/release checks via:
//   node scripts/check-book-eoi-schema.mjs
// Optional: --probe prints only the live-catalog probe SQL.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import {
  EXPECTED_SCHEMA_SIGNATURE,
  SCHEMA_TABLE,
  computeColumnSignature
} from '../apps/web/src/book-eoi.js';

const ROOT = path.resolve(scriptDir(), '..');
const SQL_PATH = path.join(ROOT, 'database', 'mj-eoi-schema.sql');

function scriptDir() {
  return new URL('.', import.meta.url).pathname.replace(/\/$/, '');
}

function fail(msg) {
  console.error('check-book-eoi-schema: FAIL - ' + msg);
  process.exitCode = 1;
}

// ---- minimal, dependency-free DDL parser -----------------------------------

// Extract the parenthesized body of `CREATE TABLE [IF NOT EXISTS] <name> ( ... )`.
export function extractCreateTableBody(sql) {
  const m = sql.match(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z0-9_.]+)\s*\(([\s\S]*?)\)\s*;/i);
  if (!m) return null;
  return { name: m[1], body: m[2] };
}

// Parse a single column definition line into { name, type, nullable, default }.
// `type` is the normalized base type (e.g. 'uuid', 'char(64)', 'integer',
// 'timestamptz'); column-constraint keywords (NOT NULL, PRIMARY KEY, DEFAULT,
// CHECK, REFERENCES) are separated out.
function parseColumnDefinition(line) {
  const cleaned = line.replace(/--.*$/, '').trim();
  const m = cleaned.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  let rest = m[2];

  let defaultVal = null;
  const dm = rest.match(/\bDEFAULT\s+('(?:[^']|'')*'|[A-Za-z0-9_]+(?:\s*\(\s*\))?)/i);
  if (dm) {
    defaultVal = dm[1].replace(/\s+/g, ' ').trim();
    rest = rest.replace(/\bDEFAULT\s+('(?:[^']|'')*'|[A-Za-z0-9_]+(?:\s*\(\s*\))?)/i, ' ');
  }

  const isPrimaryKey = /\bPRIMARY\s+KEY\b/i.test(rest);
  const nullable = !isPrimaryKey && !/\bNOT\s+NULL\b/i.test(rest);

  const tm = rest.match(
    /^\s*(uuid|text|char\s*\(\s*\d+\s*\)|character(?:\s+varying)?(?:\s*\(\s*\d+\s*\))?|integer|smallint|bigint|boolean|bool|timestamptz|timestamp(?:\s+with(?:out)?\s+time\s+zone)?|date|numeric\s*\(\s*\d+\s*,\s*\d+\s*\)|jsonb?|bytea|serial|bigserial)(?=\s|$)/i
  );
  const type = tm ? tm[1].replace(/\s+/g, ' ').trim().toLowerCase() : rest.replace(/\s+/g, ' ').trim().toLowerCase();

  return { name, type, nullable, default: defaultVal };
}

// Parse column + table-level constraint lines out of a CREATE TABLE body.
// Returns { columns: [{name, type, nullable, default}], tableConstraints: [raw lines] }.
export function parseTableBody(body) {
  const lines = splitTopLevel(body);
  const columns = [];
  const tableConstraints = [];
  const TABLE_CONSTRAINT_RE = /^\s*(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (TABLE_CONSTRAINT_RE.test(trimmed)) {
      tableConstraints.push(trimmed);
      continue;
    }
    const col = parseColumnDefinition(trimmed);
    if (col) columns.push(col);
  }
  return { columns, tableConstraints };
}

// Parse table-level CHECK constraints into { name, values[], bounds[] }.
// `values` are the quoted string literals (for IN-style checks); `bounds` are
// the integer literals (for BETWEEN-style checks). Both sorted.
export function parseChecks(tableConstraints) {
  const out = [];
  for (const line of tableConstraints) {
    const m = line.match(/CONSTRAINT\s+([A-Za-z0-9_]+)\s+CHECK\s*\(([\s\S]*)\)\s*$/i);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const body = m[2];
    const values = (body.match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1)).sort();
    const bounds = (body.match(/\b\d+\b/g) || []).map(Number).sort((a, b) => a - b);
    out.push({ name, values, bounds });
  }
  return out;
}

// Split a CREATE TABLE body on commas that are not nested in parentheses.
function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

// Extract CREATE INDEX statements as raw lines.
export function extractIndexes(sql) {
  const re = /CREATE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z0-9_]+)\s+ON\s+([A-Za-z0-9_.]+)\s*\(([^)]*)\)/gi;
  const out = [];
  let m;
  while ((m = re.exec(sql)) !== null) {
    out.push({ name: m[1], table: m[2], columns: m[3].trim() });
  }
  return out;
}

// Build the catalog probe an operator runs against the live Neon database to
// compare it to this canonical definition. Printed by --probe.
export function liveCatalogProbe() {
  return [
    "-- Columns (signature source)",
    "SELECT column_name, data_type, is_nullable",
    "FROM information_schema.columns",
    "WHERE table_schema = 'mj_eoi' AND table_name = 'book_eoi'",
    "ORDER BY column_name;",
    "",
    "-- Expected signature:",
    "-- " + EXPECTED_SCHEMA_SIGNATURE,
    "",
    "-- Table-level CHECK constraints",
    "SELECT con.conname, pg_get_constraintdef(con.oid)",
    "FROM pg_constraint con",
    "JOIN pg_class rel ON rel.oid = con.conrelid",
    "JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace",
    "WHERE nsp.nspname = 'mj_eoi' AND rel.relname = 'book_eoi' AND con.contype = 'c';",
    "",
    "-- UNIQUE constraints",
    "SELECT con.conname, pg_get_constraintdef(con.oid)",
    "FROM pg_constraint con",
    "JOIN pg_class rel ON rel.oid = con.conrelid",
    "JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace",
    "WHERE nsp.nspname = 'mj_eoi' AND rel.relname = 'book_eoi' AND con.contype = 'u';",
    "",
    "-- Indexes",
    "SELECT indexname, indexdef FROM pg_indexes",
    "WHERE schemaname = 'mj_eoi' AND tablename = 'book_eoi';",
    "",
    "-- Table privileges granted to the app role (substitute your role name):",
    "SELECT grantee, privilege_type FROM information_schema.role_table_grants",
    "WHERE table_schema = 'mj_eoi' AND table_name = 'book_eoi' ORDER BY grantee, privilege_type;"
  ].join('\n');
}

// Remove `-- ...` line comments and `/* ... */` block comments so the
// forbidden-content checks scan only executable SQL (string literals such as
// COMMENT ON TABLE are preserved; destructive-statement patterns below are
// chosen to not collide with documentation prose).
export function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      [
        'check-book-eoi-schema.mjs - offline Books EOI schema-drift guard',
        '',
        'Usage: node scripts/check-book-eoi-schema.mjs [--probe] [--help]',
        '',
        'Exits nonzero if the canonical SQL signature drifts from the app expectation,',
        'or if required constraints/indexes are missing. No network access.',
        '  --probe  print the live-catalog comparison SQL and exit.'
      ].join('\n') + '\n'
    );
    return;
  }

  if (!existsSync(SQL_PATH)) {
    fail('database/mj-eoi-schema.sql is missing');
    return;
  }
  const sql = readFileSync(SQL_PATH, 'utf8');

  if (args.includes('--probe')) {
    process.stdout.write(liveCatalogProbe() + '\n');
    return;
  }

  const table = extractCreateTableBody(sql);
  if (!table) {
    fail('no CREATE TABLE mj_eoi.book_eoi statement found');
    return;
  }
  if (table.name.toLowerCase() !== SCHEMA_TABLE) {
    fail('CREATE TABLE name is ' + table.name + ', expected ' + SCHEMA_TABLE);
  }

  const { columns, tableConstraints } = parseTableBody(table.body);

  // Exact ordered columns with exact base type, nullability, and default.
  // Mirrors database/mj-eoi-schema.sql verbatim (the canonical source).
  const EXPECTED_COLUMNS_FULL = [
    { name: 'id', type: 'uuid', nullable: false, default: null },
    { name: 'book_code', type: 'text', nullable: false, default: null },
    { name: 'email_hash', type: 'char(64)', nullable: false, default: null },
    { name: 'pii_ciphertext', type: 'text', nullable: false, default: null },
    { name: 'pii_iv', type: 'text', nullable: false, default: null },
    { name: 'quantity', type: 'integer', nullable: false, default: null },
    { name: 'format_code', type: 'text', nullable: false, default: null },
    { name: 'status', type: 'text', nullable: false, default: "'new'" },
    { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()' },
    { name: 'updated_at', type: 'timestamptz', nullable: false, default: 'now()' }
  ];
  if (columns.length !== EXPECTED_COLUMNS_FULL.length) {
    fail(`expected ${EXPECTED_COLUMNS_FULL.length} columns, found ${columns.length}`);
  }
  for (let i = 0; i < EXPECTED_COLUMNS_FULL.length; i++) {
    const want = EXPECTED_COLUMNS_FULL[i];
    const got = columns[i];
    if (!got) { fail(`column #${i + 1} missing: expected ${want.name}`); continue; }
    if (got.name !== want.name) fail(`column #${i + 1} name: expected ${want.name}, got ${got.name}`);
    if (got.type !== want.type) fail(`column ${want.name} type: expected ${want.type}, got ${got.type}`);
    if (got.nullable !== want.nullable) fail(`column ${want.name} nullable: expected ${want.nullable}, got ${got.nullable}`);
    const gotDefault = got.default == null ? null : got.default.toLowerCase().replace(/\s+/g, ' ').trim();
    const wantDefault = want.default == null ? null : want.default.toLowerCase().replace(/\s+/g, ' ').trim();
    if (gotDefault !== wantDefault) fail(`column ${want.name} default: expected ${want.default}, got ${got.default}`);
  }

  // Column-name signature still must match the app constant.
  const requiredColumns = new Set(
    'id,book_code,email_hash,pii_ciphertext,pii_iv,quantity,format_code,status,created_at,updated_at'.split(',')
  );
  const declared = new Set(columns.map((c) => c.name));
  for (const col of requiredColumns) {
    if (!declared.has(col)) fail('missing column: ' + col);
  }
  for (const col of declared) {
    if (!requiredColumns.has(col)) fail('unexpected extra column: ' + col);
  }

  const signature = computeColumnSignature(SCHEMA_TABLE, columns.map((c) => c.name));
  if (signature !== EXPECTED_SCHEMA_SIGNATURE) {
    fail('column signature drift:\n  expected: ' + EXPECTED_SCHEMA_SIGNATURE + '\n  got:      ' + signature);
  }

  // Exact CHECK value sets / numeric bounds.
  const checks = parseChecks(tableConstraints);
  const checkByName = new Map(checks.map((c) => [c.name, c]));
  const EXPECTED_CHECKS = {
    book_eoi_book_code_check: { values: ['biography', 'childrens'] },
    book_eoi_format_code_check: { values: ['ebook', 'hardcover', 'paperback', 'unsure'] },
    book_eoi_status_check: { values: ['contacted', 'new', 'withdrawn'] },
    book_eoi_quantity_check: { bounds: [1, 10] }
  };
  for (const [name, want] of Object.entries(EXPECTED_CHECKS)) {
    const got = checkByName.get(name);
    if (!got) { fail('missing CHECK constraint: ' + name); continue; }
    if (want.values && got.values.join(',') !== want.values.join(',')) {
      fail(`CHECK ${name} values: expected ${want.values.join(',')}, got ${got.values.join(',')}`);
    }
    if (want.bounds && (got.bounds.length !== 2 || got.bounds[0] !== want.bounds[0] || got.bounds[1] !== want.bounds[1])) {
      fail(`CHECK ${name} bounds: expected ${want.bounds.join(',')}, got ${got.bounds.join(',')}`);
    }
  }

  if (!/UNIQUE\s*\(\s*book_code\s*,\s*email_hash\s*\)/i.test(tableConstraints.join(' '))) {
    fail('UNIQUE(book_code, email_hash) constraint not found');
  }

  // Exact indexes (name + exact column list/direction).
  const indexes = extractIndexes(sql);
  const indexByName = new Map(indexes.map((i) => [i.name.toLowerCase(), i.columns.toLowerCase().replace(/\s+/g, ' ').trim()]));
  const EXPECTED_INDEXES = {
    book_eoi_book_status_idx: 'book_code, status',
    book_eoi_book_created_idx: 'book_code, created_at desc'
  };
  for (const [name, cols] of Object.entries(EXPECTED_INDEXES)) {
    const got = indexByName.get(name);
    if (got === undefined) fail('index ' + name + ' not found');
    else if (got !== cols) fail(`index ${name} columns: expected "${cols}", got "${got}"`);
  }

  // Forbidden content (scanned over executable SQL only): no destructive
  // statements, and exactly one CREATE TABLE named mj_eoi.book_eoi (this also
  // rules out any payment/order tables).
  const stripped = stripSqlComments(sql);
  if (/\bDELETE\s+FROM\b/i.test(stripped)) fail('DELETE FROM must not appear in the canonical schema');
  if (/\bTRUNCATE\b/i.test(stripped)) fail('TRUNCATE must not appear in the canonical schema');
  if (/\bDROP\s+(TABLE|SCHEMA|INDEX|DATABASE)\b/i.test(stripped)) fail('DROP must not appear in the canonical schema');
  const declaredTables = [...stripped.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z0-9_.]+)/gi)].map(
    (m) => m[1].toLowerCase()
  );
  if (declaredTables.length !== 1 || declaredTables[0] !== SCHEMA_TABLE) {
    fail('exactly one CREATE TABLE mj_eoi.book_eoi expected; found: ' + declaredTables.join(', '));
  }

  if (process.exitCode) {
    console.error('check-book-eoi-schema: one or more assertions failed.');
    return;
  }
  console.log('check-book-eoi-schema: OK - signature ' + signature);
}

main();
