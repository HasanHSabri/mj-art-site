#!/usr/bin/env node
// =============================================================================
// Books EOI schema-drift guard (offline by default; optional read-only live probe).
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
//   3. Emits ready-to-run, fail-fast catalog/privilege assertion SQL, or runs
//      the equivalent read-only assertions directly with --live.
//
// This is NOT a migration runner and never writes to the database. Exit status
// is nonzero on any assertion failure. Wire it into CI/release checks via:
//   node scripts/check-book-eoi-schema.mjs
// Optional: --probe prints only the live-catalog/privilege probe SQL.
// Optional: --live runs the health-equivalent catalog comparison read-only.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EXPECTED_SCHEMA_SIGNATURE,
  SCHEMA_TABLE,
  bookEoiSecretsOk,
  compareLiveCatalog,
  compareRuntimePrivileges,
  computeColumnSignature,
  createNeonSqlExecutor,
  normalizePgDefinition,
  probeLiveCatalogShape,
  probeRuntimePrivileges
} from '../apps/web/src/book-eoi.js';

const ROOT = path.resolve(scriptDir(), '..');
const SQL_PATH = path.join(ROOT, 'database', 'mj-eoi-schema.sql');
export const DEFAULT_FUNCTION_PRIVILEGE_CORRECTION =
  'ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;';
export const LIVE_CHECK_IDS = Object.freeze({
  config: 'BEOI-LIVE-001',
  dependencyImport: 'BEOI-LIVE-002',
  unexpected: 'BEOI-LIVE-003',
  catalogQueries: Object.freeze({
    columns: 'BEOI-LIVE-101',
    constraints: 'BEOI-LIVE-102',
    indexes: 'BEOI-LIVE-103'
  }),
  catalogGroups: Object.freeze({
    columns: 'BEOI-LIVE-111',
    constraints: 'BEOI-LIVE-112',
    indexes: 'BEOI-LIVE-113'
  }),
  privilegeQueries: Object.freeze({
    roleDatabase: 'BEOI-LIVE-201',
    schema: 'BEOI-LIVE-202',
    table: 'BEOI-LIVE-203',
    defaultFunctionAcl: 'BEOI-LIVE-204',
    publicRoutines: 'BEOI-LIVE-205',
    columnAcl: 'BEOI-LIVE-206',
    ownership: 'BEOI-LIVE-207',
    settings: 'BEOI-LIVE-208',
    memberships: 'BEOI-LIVE-209'
  }),
  privilegeGroups: Object.freeze({
    role: 'BEOI-LIVE-211',
    database: 'BEOI-LIVE-212',
    schema: 'BEOI-LIVE-213',
    table: 'BEOI-LIVE-214',
    defaultFunctionAcl: 'BEOI-LIVE-215',
    publicRoutines: 'BEOI-LIVE-216',
    columnAcl: 'BEOI-LIVE-217',
    ownership: 'BEOI-LIVE-218',
    settings: 'BEOI-LIVE-219',
    memberships: 'BEOI-LIVE-220'
  })
});

class LiveCheckFailure extends Error {
  constructor(ids) {
    super('Books EOI live check failed');
    this.ids = [...new Set(ids)];
  }
}

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

// Parse complete named CHECK definitions without reducing their expressions to
// literal bags. Exact normalized definitions are compared by the contract.
export function parseChecks(tableConstraints) {
  const out = [];
  for (const line of tableConstraints) {
    const m = line.match(/CONSTRAINT\s+([A-Za-z0-9_]+)\s+CHECK\s*\(([\s\S]*)\)\s*$/i);
    if (!m) continue;
    const name = m[1].toLowerCase();
    out.push({ name, definition: `CHECK (${m[2]})` });
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

// Extract complete CREATE INDEX statements through the terminating semicolon so
// predicates, methods, operator classes, INCLUDE columns, and options survive.
export function extractIndexes(sql) {
  const re = /CREATE\s+(UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z0-9_]+)\s+ON\s+([A-Za-z0-9_.]+)\s+([\s\S]*?);/gi;
  const out = [];
  let m;
  while ((m = re.exec(sql)) !== null) {
    out.push({
      name: m[2].toLowerCase(),
      table: m[3].toLowerCase(),
      definition: `CREATE ${m[1] || ''}INDEX ${m[2]} ON ${m[3]} ${m[4]}`
    });
  }
  return out;
}

const EXPECTED_OFFLINE_CONSTRAINTS = [
  { name: 'book_eoi_book_code_check', definition: "CHECK (book_code IN ('biography', 'childrens'))" },
  { name: 'book_eoi_book_email_unique', definition: 'UNIQUE (book_code, email_hash)' },
  { name: 'book_eoi_format_code_check', definition: "CHECK (format_code IN ('hardcover', 'paperback', 'ebook', 'unsure'))" },
  { name: 'book_eoi_pkey', definition: 'PRIMARY KEY (id)' },
  { name: 'book_eoi_quantity_check', definition: 'CHECK (quantity BETWEEN 1 AND 10)' },
  { name: 'book_eoi_status_check', definition: "CHECK (status IN ('new', 'contacted', 'withdrawn'))" }
];

const EXPECTED_OFFLINE_INDEXES = [
  {
    name: 'book_eoi_book_created_idx',
    table: SCHEMA_TABLE,
    definition: 'CREATE INDEX book_eoi_book_created_idx ON mj_eoi.book_eoi (book_code, created_at DESC)'
  },
  {
    name: 'book_eoi_book_status_idx',
    table: SCHEMA_TABLE,
    definition: 'CREATE INDEX book_eoi_book_status_idx ON mj_eoi.book_eoi (book_code, status)'
  }
];

function parseNamedConstraints(tableConstraints) {
  return tableConstraints.map((line) => {
    const match = line.match(/^CONSTRAINT\s+([A-Za-z0-9_]+)\s+([\s\S]+)$/i);
    return match ? { name: match[1].toLowerCase(), definition: match[2] } : { name: '', definition: line };
  });
}

export function compareCanonicalDefinitions(tableConstraints, indexes) {
  const mismatches = [];
  const exact = (kind, actualRows, expectedRows) => {
    const actual = actualRows
      .map((row) => ({
        name: row.name,
        ...(row.table ? { table: row.table } : {}),
        definition: normalizePgDefinition(row.definition)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const expected = expectedRows
      .map((row) => ({
        name: row.name,
        ...(row.table ? { table: row.table } : {}),
        definition: normalizePgDefinition(row.definition)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (actual.length !== expected.length) {
      mismatches.push(`${kind} count: expected ${expected.length}, got ${actual.length}`);
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push(`${kind} definitions differ`);
  };
  exact('constraint', parseNamedConstraints(tableConstraints), EXPECTED_OFFLINE_CONSTRAINTS);
  exact('index', indexes, EXPECTED_OFFLINE_INDEXES);
  return mismatches;
}

// Build the catalog probe an operator runs against the live Neon database to
// compare it to this canonical definition. Printed by --probe.
export function liveCatalogProbe() {
  return [
    "\\set ON_ERROR_STOP on",
    "",
    "-- Columns (signature source)",
    "SELECT column_name, data_type, is_nullable",
    "FROM information_schema.columns",
    "WHERE table_schema = 'mj_eoi' AND table_name = 'book_eoi'",
    "ORDER BY column_name;",
    "",
    "-- Expected signature:",
    "-- " + EXPECTED_SCHEMA_SIGNATURE,
    "",
    "-- Exact PK/UNIQUE/CHECK/FK constraint set",
    "SELECT con.conname, con.contype, pg_get_constraintdef(con.oid)",
    "FROM pg_constraint con",
    "JOIN pg_class rel ON rel.oid = con.conrelid",
    "JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace",
    "WHERE nsp.nspname = 'mj_eoi' AND rel.relname = 'book_eoi' ORDER BY con.conname;",
    "",
    "-- Indexes",
    "SELECT idx.relname, pg_get_indexdef(idx.oid), ind.indisunique, ind.indisprimary,",
    "  ind.indisvalid, ind.indisready, ind.indnullsnotdistinct, idx.reloptions",
    "FROM pg_index ind",
    "JOIN pg_class idx ON idx.oid = ind.indexrelid",
    "JOIN pg_class rel ON rel.oid = ind.indrelid",
    "JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace",
    "WHERE nsp.nspname = 'mj_eoi' AND rel.relname = 'book_eoi' ORDER BY idx.relname;",
    "",
    "-- Effective runtime-role boundaries (run while connected as the app role)",
    "SELECT current_user AS role_name, current_database() AS database_name,",
    "  has_database_privilege(current_user, current_database(), 'CONNECT') AS has_connect,",
    "  has_database_privilege(current_user, current_database(), 'CREATE') AS has_database_create,",
    "  has_database_privilege(current_user, current_database(), 'TEMPORARY') AS has_temp,",
    "  has_schema_privilege(current_user, 'mj_eoi', 'USAGE') AS has_mj_eoi_usage,",
    "  has_schema_privilege(current_user, 'mj_eoi', 'CREATE') AS has_mj_eoi_create,",
    "  has_schema_privilege(current_user, 'public', 'USAGE') AS has_public_usage,",
    "  has_schema_privilege(current_user, 'public', 'CREATE') AS has_public_create,",
    "  has_table_privilege(current_user, 'mj_eoi.book_eoi', 'SELECT') AS has_select,",
    "  has_table_privilege(current_user, 'mj_eoi.book_eoi', 'INSERT') AS has_insert,",
    "  has_table_privilege(current_user, 'mj_eoi.book_eoi', 'UPDATE') AS has_update,",
    "  has_table_privilege(current_user, 'mj_eoi.book_eoi', 'DELETE') AS has_delete,",
    "  has_table_privilege(current_user, 'mj_eoi.book_eoi', 'TRUNCATE') AS has_truncate,",
    "  has_table_privilege(current_user, 'mj_eoi.book_eoi', 'REFERENCES') AS has_references,",
    "  has_table_privilege(current_user, 'mj_eoi.book_eoi', 'TRIGGER') AS has_trigger;",
    "",
    "-- Must return zero rows: no executable routines in public for the app role",
    "SELECT p.oid::regprocedure::text AS executable_public_routine",
    "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace",
    "WHERE n.nspname = 'public' AND has_function_privilege(current_user, p.oid, 'EXECUTE')",
    "ORDER BY 1;",
    "",
    "-- Required owner correction if the global default assertion fails:",
    "-- " + DEFAULT_FUNCTION_PRIVILEGE_CORRECTION,
    "-- Must return one global function row with public_execute false; schema-specific rows are irrelevant.",
    "SELECT r.rolname AS owner, (d.defaclnamespace = 0) AS is_global, d.defaclobjtype AS object_type,",
    "  EXISTS (SELECT 1 FROM aclexplode(COALESCE(d.defaclacl, acldefault('f', r.oid))) acl",
    "    WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_execute",
    "FROM pg_roles r LEFT JOIN pg_default_acl d ON d.defaclrole = r.oid",
    "  AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'",
    "WHERE r.rolname = 'neondb_owner';",
    "",
    "-- Machine assertion: psql exits nonzero on schema or least-privilege drift.",
    "DO $books_contract$",
    "DECLARE",
    "  attrs record;",
    "  settings text[];",
    "BEGIN",
    "  IF EXISTS (",
    "    (SELECT column_name, data_type, is_nullable, column_default, character_maximum_length",
    "       FROM information_schema.columns WHERE table_schema = 'mj_eoi' AND table_name = 'book_eoi'",
    "     EXCEPT VALUES",
    "       ('id', 'uuid', 'NO', NULL::text, NULL::integer),",
    "       ('book_code', 'text', 'NO', NULL::text, NULL::integer),",
    "       ('email_hash', 'character', 'NO', NULL::text, 64),",
    "       ('pii_ciphertext', 'text', 'NO', NULL::text, NULL::integer),",
    "       ('pii_iv', 'text', 'NO', NULL::text, NULL::integer),",
    "       ('quantity', 'integer', 'NO', NULL::text, NULL::integer),",
    "       ('format_code', 'text', 'NO', NULL::text, NULL::integer),",
    "       ('status', 'text', 'NO', '''new''::text', NULL::integer),",
    "       ('created_at', 'timestamp with time zone', 'NO', 'now()', NULL::integer),",
    "       ('updated_at', 'timestamp with time zone', 'NO', 'now()', NULL::integer))",
    "    UNION ALL",
    "    (VALUES",
    "       ('id', 'uuid', 'NO', NULL::text, NULL::integer),",
    "       ('book_code', 'text', 'NO', NULL::text, NULL::integer),",
    "       ('email_hash', 'character', 'NO', NULL::text, 64),",
    "       ('pii_ciphertext', 'text', 'NO', NULL::text, NULL::integer),",
    "       ('pii_iv', 'text', 'NO', NULL::text, NULL::integer),",
    "       ('quantity', 'integer', 'NO', NULL::text, NULL::integer),",
    "       ('format_code', 'text', 'NO', NULL::text, NULL::integer),",
    "       ('status', 'text', 'NO', '''new''::text', NULL::integer),",
    "       ('created_at', 'timestamp with time zone', 'NO', 'now()', NULL::integer),",
    "       ('updated_at', 'timestamp with time zone', 'NO', 'now()', NULL::integer)",
    "     EXCEPT SELECT column_name, data_type, is_nullable, column_default, character_maximum_length",
    "       FROM information_schema.columns WHERE table_schema = 'mj_eoi' AND table_name = 'book_eoi')",
    "  ) THEN RAISE EXCEPTION 'Books columns violate the contract'; END IF;",
    "  IF EXISTS (",
    "    (SELECT con.conname, con.contype, pg_get_constraintdef(con.oid)",
    "       FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid",
    "       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace",
    "       WHERE nsp.nspname = 'mj_eoi' AND rel.relname = 'book_eoi'",
    "     EXCEPT VALUES",
    "       ('book_eoi_book_code_check', 'c'::\"char\", 'CHECK ((book_code = ANY (ARRAY[''biography''::text, ''childrens''::text])))'),",
    "       ('book_eoi_book_email_unique', 'u'::\"char\", 'UNIQUE (book_code, email_hash)'),",
    "       ('book_eoi_format_code_check', 'c'::\"char\", 'CHECK ((format_code = ANY (ARRAY[''hardcover''::text, ''paperback''::text, ''ebook''::text, ''unsure''::text])))'),",
    "       ('book_eoi_pkey', 'p'::\"char\", 'PRIMARY KEY (id)'),",
    "       ('book_eoi_quantity_check', 'c'::\"char\", 'CHECK (((quantity >= 1) AND (quantity <= 10)))'),",
    "       ('book_eoi_status_check', 'c'::\"char\", 'CHECK ((status = ANY (ARRAY[''new''::text, ''contacted''::text, ''withdrawn''::text])))'))",
    "    UNION ALL",
    "    (VALUES",
    "       ('book_eoi_book_code_check', 'c'::\"char\", 'CHECK ((book_code = ANY (ARRAY[''biography''::text, ''childrens''::text])))'),",
    "       ('book_eoi_book_email_unique', 'u'::\"char\", 'UNIQUE (book_code, email_hash)'),",
    "       ('book_eoi_format_code_check', 'c'::\"char\", 'CHECK ((format_code = ANY (ARRAY[''hardcover''::text, ''paperback''::text, ''ebook''::text, ''unsure''::text])))'),",
    "       ('book_eoi_pkey', 'p'::\"char\", 'PRIMARY KEY (id)'),",
    "       ('book_eoi_quantity_check', 'c'::\"char\", 'CHECK (((quantity >= 1) AND (quantity <= 10)))'),",
    "       ('book_eoi_status_check', 'c'::\"char\", 'CHECK ((status = ANY (ARRAY[''new''::text, ''contacted''::text, ''withdrawn''::text])))')",
    "     EXCEPT SELECT con.conname, con.contype, pg_get_constraintdef(con.oid)",
    "       FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid",
    "       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace",
    "       WHERE nsp.nspname = 'mj_eoi' AND rel.relname = 'book_eoi')",
    "  ) THEN RAISE EXCEPTION 'Books constraints violate the contract'; END IF;",
    "  IF EXISTS (",
    "    (SELECT idx.relname, pg_get_indexdef(idx.oid), ind.indisunique, ind.indisprimary,",
    "       ind.indisvalid, ind.indisready, ind.indnullsnotdistinct, idx.reloptions::text",
    "       FROM pg_index ind JOIN pg_class idx ON idx.oid = ind.indexrelid",
    "       JOIN pg_class rel ON rel.oid = ind.indrelid JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace",
    "       WHERE nsp.nspname = 'mj_eoi' AND rel.relname = 'book_eoi'",
    "     EXCEPT VALUES",
    "       ('book_eoi_book_created_idx', 'CREATE INDEX book_eoi_book_created_idx ON mj_eoi.book_eoi USING btree (book_code, created_at DESC)', false, false, true, true, false, NULL::text),",
    "       ('book_eoi_book_email_unique', 'CREATE UNIQUE INDEX book_eoi_book_email_unique ON mj_eoi.book_eoi USING btree (book_code, email_hash)', true, false, true, true, false, NULL::text),",
    "       ('book_eoi_book_status_idx', 'CREATE INDEX book_eoi_book_status_idx ON mj_eoi.book_eoi USING btree (book_code, status)', false, false, true, true, false, NULL::text),",
    "       ('book_eoi_pkey', 'CREATE UNIQUE INDEX book_eoi_pkey ON mj_eoi.book_eoi USING btree (id)', true, true, true, true, false, NULL::text))",
    "    UNION ALL",
    "    (VALUES",
    "       ('book_eoi_book_created_idx', 'CREATE INDEX book_eoi_book_created_idx ON mj_eoi.book_eoi USING btree (book_code, created_at DESC)', false, false, true, true, false, NULL::text),",
    "       ('book_eoi_book_email_unique', 'CREATE UNIQUE INDEX book_eoi_book_email_unique ON mj_eoi.book_eoi USING btree (book_code, email_hash)', true, false, true, true, false, NULL::text),",
    "       ('book_eoi_book_status_idx', 'CREATE INDEX book_eoi_book_status_idx ON mj_eoi.book_eoi USING btree (book_code, status)', false, false, true, true, false, NULL::text),",
    "       ('book_eoi_pkey', 'CREATE UNIQUE INDEX book_eoi_pkey ON mj_eoi.book_eoi USING btree (id)', true, true, true, true, false, NULL::text)",
    "     EXCEPT SELECT idx.relname, pg_get_indexdef(idx.oid), ind.indisunique, ind.indisprimary,",
    "       ind.indisvalid, ind.indisready, ind.indnullsnotdistinct, idx.reloptions::text",
    "       FROM pg_index ind JOIN pg_class idx ON idx.oid = ind.indexrelid",
    "       JOIN pg_class rel ON rel.oid = ind.indrelid JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace",
    "       WHERE nsp.nspname = 'mj_eoi' AND rel.relname = 'book_eoi')",
    "  ) THEN RAISE EXCEPTION 'Books indexes violate the contract'; END IF;",
    "  SELECT * INTO attrs FROM pg_roles WHERE rolname = current_user;",
    "  IF attrs.rolsuper OR NOT attrs.rolinherit OR attrs.rolcreaterole OR attrs.rolcreatedb",
    "     OR NOT attrs.rolcanlogin OR attrs.rolreplication OR attrs.rolbypassrls THEN",
    "    RAISE EXCEPTION 'Books app role attributes violate the contract';",
    "  END IF;",
    "  IF NOT has_database_privilege(current_user, current_database(), 'CONNECT')",
    "     OR has_database_privilege(current_user, current_database(), 'CONNECT WITH GRANT OPTION')",
    "     OR has_database_privilege(current_user, current_database(), 'CREATE')",
    "     OR has_database_privilege(current_user, current_database(), 'TEMPORARY') THEN",
    "    RAISE EXCEPTION 'Books database privileges violate the contract';",
    "  END IF;",
    "  IF NOT has_schema_privilege(current_user, 'mj_eoi', 'USAGE')",
    "     OR has_schema_privilege(current_user, 'mj_eoi', 'USAGE WITH GRANT OPTION')",
    "     OR has_schema_privilege(current_user, 'mj_eoi', 'CREATE')",
    "     OR has_schema_privilege(current_user, 'public', 'USAGE')",
    "     OR has_schema_privilege(current_user, 'public', 'CREATE') THEN",
    "    RAISE EXCEPTION 'Books schema privileges violate the contract';",
    "  END IF;",
    "  IF EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_'",
    "      AND n.nspname NOT IN ('information_schema', 'mj_eoi', 'public')",
    "      AND (has_schema_privilege(current_user, n.oid, 'USAGE')",
    "        OR has_schema_privilege(current_user, n.oid, 'CREATE'))) THEN",
    "    RAISE EXCEPTION 'Books role has privileges on an extra schema';",
    "  END IF;",
    "  IF NOT has_table_privilege(current_user, 'mj_eoi.book_eoi', 'SELECT')",
    "     OR has_table_privilege(current_user, 'mj_eoi.book_eoi', 'SELECT WITH GRANT OPTION')",
    "     OR NOT has_table_privilege(current_user, 'mj_eoi.book_eoi', 'INSERT')",
    "     OR has_table_privilege(current_user, 'mj_eoi.book_eoi', 'INSERT WITH GRANT OPTION')",
    "     OR NOT has_table_privilege(current_user, 'mj_eoi.book_eoi', 'UPDATE')",
    "     OR has_table_privilege(current_user, 'mj_eoi.book_eoi', 'UPDATE WITH GRANT OPTION')",
    "     OR has_table_privilege(current_user, 'mj_eoi.book_eoi', 'DELETE')",
    "     OR has_table_privilege(current_user, 'mj_eoi.book_eoi', 'TRUNCATE')",
    "     OR has_table_privilege(current_user, 'mj_eoi.book_eoi', 'REFERENCES')",
    "     OR has_any_column_privilege(current_user, 'mj_eoi.book_eoi', 'REFERENCES')",
    "     OR has_table_privilege(current_user, 'mj_eoi.book_eoi', 'TRIGGER') THEN",
    "    RAISE EXCEPTION 'Books table privileges violate the contract';",
    "  END IF;",
    "  IF EXISTS (SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl",
    "      JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace",
    "      WHERE a.attnum > 0 AND NOT a.attisdropped",
    "      AND acl.grantee IN (0, attrs.oid) AND n.nspname !~ '^pg_'",
    "      AND n.nspname <> 'information_schema') THEN",
    "    RAISE EXCEPTION 'Books role database contains column ACLs';",
    "  END IF;",
    "  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace",
    "      WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname !~ '^pg_'",
    "      AND n.nspname <> 'information_schema'",
    "      AND NOT (n.nspname = 'mj_eoi' AND c.relname = 'book_eoi')",
    "      AND (has_table_privilege(current_user, c.oid, 'SELECT')",
    "        OR has_any_column_privilege(current_user, c.oid, 'SELECT')",
    "        OR has_table_privilege(current_user, c.oid, 'INSERT')",
    "        OR has_any_column_privilege(current_user, c.oid, 'INSERT')",
    "        OR has_table_privilege(current_user, c.oid, 'UPDATE')",
    "        OR has_any_column_privilege(current_user, c.oid, 'UPDATE')",
    "        OR has_table_privilege(current_user, c.oid, 'DELETE')",
    "        OR has_table_privilege(current_user, c.oid, 'TRUNCATE')",
    "        OR has_table_privilege(current_user, c.oid, 'REFERENCES')",
    "        OR has_any_column_privilege(current_user, c.oid, 'REFERENCES')",
    "        OR has_table_privilege(current_user, c.oid, 'TRIGGER'))) THEN",
    "    RAISE EXCEPTION 'Books role has privileges on an extra table';",
    "  END IF;",
    "  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace",
    "      WHERE n.nspname = 'public' AND has_function_privilege(current_user, p.oid, 'EXECUTE')) THEN",
    "    RAISE EXCEPTION 'Books role can execute a public routine';",
    "  END IF;",
    "  IF COALESCE((SELECT bool_or(acl.grantee = 0 AND acl.privilege_type = 'EXECUTE')",
    "      FROM pg_roles r LEFT JOIN pg_default_acl d ON d.defaclrole = r.oid",
    "        AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'",
    "      CROSS JOIN LATERAL aclexplode(COALESCE(d.defaclacl, acldefault('f', r.oid))) acl",
    "      WHERE r.rolname = 'neondb_owner'), true) THEN",
    "    RAISE EXCEPTION 'Books owner global function defaults grant EXECUTE to PUBLIC';",
    "  END IF;",
    "  IF EXISTS (SELECT 1 FROM pg_auth_members m",
    "      WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN",
    "    RAISE EXCEPTION 'Books role has a role membership';",
    "  END IF;",
    "  IF EXISTS (SELECT 1 FROM pg_shdepend dep",
    "      WHERE dep.refclassid = 'pg_authid'::regclass AND dep.refobjid = attrs.oid AND dep.deptype = 'o') THEN",
    "    RAISE EXCEPTION 'Books role owns database objects';",
    "  END IF;",
    "  SELECT array_agg(setting ORDER BY setting) INTO settings",
    "  FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) AS setting",
    "  WHERE s.setrole = attrs.oid AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database());",
    "  IF settings IS DISTINCT FROM ARRAY['search_path=pg_catalog, mj_eoi', 'statement_timeout=5000']",
    "     OR EXISTS (SELECT 1 FROM pg_db_role_setting s",
    "       WHERE s.setrole = attrs.oid AND s.setdatabase <> (SELECT oid FROM pg_database WHERE datname = current_database())) THEN",
    "    RAISE EXCEPTION 'Books role settings violate the contract';",
    "  END IF;",
    "END",
    "$books_contract$;"
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

function collectFailureIds(error) {
  if (error instanceof LiveCheckFailure) return error.ids;
  if (error instanceof AggregateError) return error.errors.flatMap(collectFailureIds);
  return [LIVE_CHECK_IDS.unexpected];
}

function labeledSql(sql, labels) {
  let index = 0;
  return async (...args) => {
    const ids = labels[index++] || [LIVE_CHECK_IDS.unexpected];
    try {
      return await sql(...args);
    } catch {
      throw new LiveCheckFailure(ids);
    }
  };
}

export function reportLiveCheckFailure(error) {
  for (const id of [...new Set(collectFailureIds(error))]) fail(id);
}

export async function runLiveCheck(env = process.env, loadDriver = () => import('@neondatabase/serverless')) {
  try {
    if (typeof env.NEON_DATABASE_URL !== 'string' || env.NEON_DATABASE_URL.length === 0 || !bookEoiSecretsOk(env)) {
      throw new LiveCheckFailure([LIVE_CHECK_IDS.config]);
    }
  } catch {
    throw new LiveCheckFailure([LIVE_CHECK_IDS.config]);
  }

  let sql;
  try {
    const { neon } = await loadDriver();
    if (typeof neon !== 'function') throw new Error();
    sql = createNeonSqlExecutor(neon(env.NEON_DATABASE_URL));
  } catch {
    throw new LiveCheckFailure([LIVE_CHECK_IDS.dependencyImport]);
  }

  const catalogLabels = [
    [LIVE_CHECK_IDS.catalogQueries.columns, LIVE_CHECK_IDS.catalogGroups.columns],
    [LIVE_CHECK_IDS.catalogQueries.constraints, LIVE_CHECK_IDS.catalogGroups.constraints],
    [LIVE_CHECK_IDS.catalogQueries.indexes, LIVE_CHECK_IDS.catalogGroups.indexes]
  ];
  const privilegeLabels = [
    [LIVE_CHECK_IDS.privilegeQueries.roleDatabase, LIVE_CHECK_IDS.privilegeGroups.role, LIVE_CHECK_IDS.privilegeGroups.database],
    [LIVE_CHECK_IDS.privilegeQueries.schema, LIVE_CHECK_IDS.privilegeGroups.schema],
    [LIVE_CHECK_IDS.privilegeQueries.table, LIVE_CHECK_IDS.privilegeGroups.table],
    [LIVE_CHECK_IDS.privilegeQueries.defaultFunctionAcl, LIVE_CHECK_IDS.privilegeGroups.defaultFunctionAcl],
    [LIVE_CHECK_IDS.privilegeQueries.publicRoutines, LIVE_CHECK_IDS.privilegeGroups.publicRoutines],
    [LIVE_CHECK_IDS.privilegeQueries.columnAcl, LIVE_CHECK_IDS.privilegeGroups.columnAcl],
    [LIVE_CHECK_IDS.privilegeQueries.ownership, LIVE_CHECK_IDS.privilegeGroups.ownership],
    [LIVE_CHECK_IDS.privilegeQueries.settings, LIVE_CHECK_IDS.privilegeGroups.settings],
    [LIVE_CHECK_IDS.privilegeQueries.memberships, LIVE_CHECK_IDS.privilegeGroups.memberships]
  ];
  const [catalogResult, privilegeResult] = await Promise.allSettled([
    probeLiveCatalogShape(labeledSql(sql, catalogLabels)),
    probeRuntimePrivileges(labeledSql(sql, privilegeLabels))
  ]);
  const queryFailureIds = [catalogResult, privilegeResult]
    .filter((result) => result.status === 'rejected')
    .flatMap((result) => collectFailureIds(result.reason));
  if (queryFailureIds.length) throw new LiveCheckFailure(queryFailureIds);

  let catalogComparison;
  let privilegeComparison;
  try {
    catalogComparison = compareLiveCatalog(catalogResult.value);
    privilegeComparison = compareRuntimePrivileges(privilegeResult.value);
  } catch {
    throw new LiveCheckFailure([LIVE_CHECK_IDS.unexpected]);
  }
  const driftIds = [
    ...Object.entries(catalogComparison.groups)
      .filter(([, match]) => !match)
      .map(([group]) => LIVE_CHECK_IDS.catalogGroups[group]),
    ...Object.entries(privilegeComparison.groups)
      .filter(([, match]) => !match)
      .map(([group]) => LIVE_CHECK_IDS.privilegeGroups[group])
  ];
  if (driftIds.length) throw new LiveCheckFailure(driftIds);
  console.log('check-book-eoi-schema: OK - live catalog and least-privilege role match canonical contracts (read-only)');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      [
        'check-book-eoi-schema.mjs - offline Books EOI schema-drift guard',
        '',
        'Usage: node scripts/check-book-eoi-schema.mjs [--probe|--live|--help]',
        '',
        'Exits nonzero if the canonical SQL signature drifts from the app expectation,',
        'or if exact constraints/indexes differ. No database writes.',
        '  --probe  print fail-fast live catalog/privilege assertion SQL and exit.',
        '  --live   assert the live catalog and app-role privileges read-only.'
      ].join('\n') + '\n'
    );
    return;
  }

  if (args.includes('--live')) {
    try {
      await runLiveCheck();
    } catch (error) {
      reportLiveCheckFailure(error);
    }
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

  const documentedSql = sql.replace(/^\s*--\s?/gm, '').replace(/\s+/g, ' ');
  if (!documentedSql.includes(DEFAULT_FUNCTION_PRIVILEGE_CORRECTION)) {
    fail('canonical SQL must document the global neondb_owner default function privilege correction');
  }
  if (/ALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+ROLE\s+neondb_owner\s+IN\s+SCHEMA\s+public/i.test(sql)) {
    fail('canonical SQL must not use a schema-specific default function privilege correction');
  }

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

  // Exact complete named constraint and explicit-index sets. Comparison keeps
  // full expressions/definitions; extras are drift, not harmless additions.
  const indexes = extractIndexes(sql);
  for (const mismatch of compareCanonicalDefinitions(tableConstraints, indexes)) fail(mismatch);

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

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
