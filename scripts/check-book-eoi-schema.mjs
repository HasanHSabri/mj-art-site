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

// Parse column + table-level constraint lines out of a CREATE TABLE body.
// Returns { columns: [{name, type}], tableConstraints: [raw lines] }.
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
    const cm = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.+?)(?:\s+--.*)?$/);
    if (cm) {
      columns.push({ name: cm[1].toLowerCase(), type: cm[2].replace(/\s+--.*/, '').trim() });
    }
  }
  return { columns, tableConstraints };
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

  const joined = tableConstraints.join('\n');
  for (const needle of ['book_code', 'format_code', 'status', 'quantity', 'BETWEEN 1 AND 10']) {
    if (!joined.includes(needle)) fail('expected CHECK referencing "' + needle + '" not found');
  }
  if (!/UNIQUE\s*\(\s*book_code\s*,\s*email_hash\s*\)/i.test(tableConstraints.join(' '))) {
    fail('UNIQUE(book_code, email_hash) constraint not found');
  }

  const indexes = extractIndexes(sql);
  const indexNames = new Set(indexes.map((i) => i.name));
  if (!indexNames.has('book_eoi_book_status_idx')) fail('index book_eoi_book_status_idx not found');
  if (!indexNames.has('book_eoi_book_created_idx')) fail('index book_eoi_book_created_idx not found');

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
