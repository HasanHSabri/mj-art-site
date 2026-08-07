import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_CHECK_IDS,
  reportLiveCheckFailure,
  runLiveCheck
} from '../../../scripts/check-book-eoi-schema.mjs';
import {
  EXPECTED_LIVE_CATALOG,
  EXPECTED_RUNTIME_PRIVILEGES
} from '../src/book-eoi.js';

const VALID_ENV = {
  NEON_DATABASE_URL: 'postgres://user:password@sensitive.example/database?token=driver-token',
  BOOK_EOI_HMAC_KEY: 'h'.repeat(32),
  BOOK_EOI_ENCRYPTION_KEY: 'e'.repeat(32)
};
const SENSITIVE_DRIVER_ERROR =
  'driver failed for postgres://role:password@sensitive.example/database token=driver-token SELECT secret_value';

function passingRows() {
  const role = EXPECTED_RUNTIME_PRIVILEGES.role;
  const database = EXPECTED_RUNTIME_PRIVILEGES.database;
  return [
    EXPECTED_LIVE_CATALOG.columns.map((column) => ({
      column_name: column.name,
      data_type: column.dataType,
      is_nullable: column.nullable ? 'YES' : 'NO',
      column_default: column.default,
      character_maximum_length: column.charLength
    })),
    EXPECTED_LIVE_CATALOG.constraints.map((constraint) => ({ ...constraint })),
    EXPECTED_LIVE_CATALOG.indexes.map((index) => ({
      name: index.name,
      definition: index.definition,
      unique: index.unique,
      primary: index.primary,
      valid: true,
      ready: true,
      nulls_not_distinct: false,
      options: null
    })),
    [{
      database_name: 'neondb',
      superuser: role.superuser,
      inherit: role.inherit,
      create_role: role.createRole,
      create_db: role.createDb,
      can_login: role.canLogin,
      replication: role.replication,
      bypass_rls: role.bypassRls,
      has_connect: database.connect,
      has_connect_grant: database.connectGrant,
      has_create: database.create,
      has_temporary: database.temporary
    }],
    EXPECTED_RUNTIME_PRIVILEGES.schemas.map((schema) => ({
      name: schema.name,
      usage: schema.usage,
      usage_grant: schema.usageGrant,
      create: schema.create,
      create_grant: schema.createGrant
    })),
    EXPECTED_RUNTIME_PRIVILEGES.tables.map((table) => ({
      schema: table.schema,
      name: table.name,
      select: table.select,
      select_grant: table.selectGrant,
      insert: table.insert,
      insert_grant: table.insertGrant,
      update: table.update,
      update_grant: table.updateGrant,
      delete: table.delete,
      truncate: table.truncate,
      references: table.references,
      trigger: table.trigger
    })),
    EXPECTED_RUNTIME_PRIVILEGES.defaultFunctionAcls.map((acl) => ({
      owner: acl.owner,
      is_global: acl.isGlobal,
      object_type: acl.objectType,
      public_execute: acl.publicExecute
    })),
    [],
    [],
    [],
    EXPECTED_RUNTIME_PRIVILEGES.settings.map((setting) => ({
      database: setting.database === 'CURRENT' ? 'neondb' : setting.database,
      setting: setting.setting
    })),
    []
  ];
}

function driverFor(rows, failureIndex = -1) {
  let call = 0;
  return async () => ({
    neon: () => ({
      query: async () => {
        const index = call++;
        if (index === failureIndex) throw new Error(SENSITIVE_DRIVER_ERROR);
        return structuredClone(rows[index]);
      }
    })
  });
}

async function capturedFailure(env, loadDriver) {
  const lines = [];
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  console.error = (...args) => lines.push(args.join(' '));
  process.exitCode = undefined;
  try {
    await assert.rejects(runLiveCheck(env, loadDriver), (error) => {
      reportLiveCheckFailure(error);
      return true;
    });
  } finally {
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
  return lines;
}

function expectedLines(...ids) {
  return ids.map((id) => `check-book-eoi-schema: FAIL - ${id}`);
}

test('live configuration and dependency failures emit only stable opaque IDs', async () => {
  const config = await capturedFailure({}, () => {
    throw new Error(SENSITIVE_DRIVER_ERROR);
  });
  assert.deepEqual(config, expectedLines(LIVE_CHECK_IDS.config));

  const dependency = await capturedFailure(VALID_ENV, async () => {
    throw new Error(SENSITIVE_DRIVER_ERROR);
  });
  assert.deepEqual(dependency, expectedLines(LIVE_CHECK_IDS.dependencyImport));
  assert.doesNotMatch(`${config}\n${dependency}`, /sensitive|postgres:|password|driver-token|SELECT|secret_value/i);
});

test('every live query failure emits its exact query and group IDs without driver details', async () => {
  const cases = [
    [LIVE_CHECK_IDS.catalogQueries.columns, LIVE_CHECK_IDS.catalogGroups.columns],
    [LIVE_CHECK_IDS.catalogQueries.constraints, LIVE_CHECK_IDS.catalogGroups.constraints],
    [LIVE_CHECK_IDS.catalogQueries.indexes, LIVE_CHECK_IDS.catalogGroups.indexes],
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
  for (let index = 0; index < cases.length; index++) {
    const lines = await capturedFailure(VALID_ENV, driverFor(passingRows(), index));
    assert.deepEqual(lines, expectedLines(...cases[index]));
    assert.doesNotMatch(lines.join('\n'), /sensitive|postgres:|password|driver-token|SELECT|secret_value|at .*\.mjs/i);
  }
});

test('every live contract group drift emits only its exact stable group ID', async () => {
  const cases = [
    [LIVE_CHECK_IDS.catalogGroups.columns, (rows) => rows[0].pop()],
    [LIVE_CHECK_IDS.catalogGroups.constraints, (rows) => rows[1].pop()],
    [LIVE_CHECK_IDS.catalogGroups.indexes, (rows) => rows[2].pop()],
    [LIVE_CHECK_IDS.privilegeGroups.role, (rows) => { rows[3][0].superuser = true; }],
    [LIVE_CHECK_IDS.privilegeGroups.database, (rows) => { rows[3][0].has_create = true; }],
    [LIVE_CHECK_IDS.privilegeGroups.schema, (rows) => rows[4].pop()],
    [LIVE_CHECK_IDS.privilegeGroups.table, (rows) => rows[5].pop()],
    [LIVE_CHECK_IDS.privilegeGroups.defaultFunctionAcl, (rows) => rows[6].pop()],
    [LIVE_CHECK_IDS.privilegeGroups.publicRoutines, (rows) => rows[7].push({ routine: 'public.sensitive' })],
    [LIVE_CHECK_IDS.privilegeGroups.columnAcl, (rows) => rows[8].push({ column: 'sensitive' })],
    [LIVE_CHECK_IDS.privilegeGroups.ownership, (rows) => rows[9].push({ name: 'sensitive' })],
    [LIVE_CHECK_IDS.privilegeGroups.settings, (rows) => rows[10].pop()],
    [LIVE_CHECK_IDS.privilegeGroups.memberships, (rows) => rows[11].push({ role: 'sensitive' })]
  ];
  for (const [id, mutate] of cases) {
    const rows = passingRows();
    mutate(rows);
    const lines = await capturedFailure(VALID_ENV, driverFor(rows));
    assert.deepEqual(lines, expectedLines(id));
    assert.doesNotMatch(lines.join('\n'), /sensitive|postgres:|password|driver-token|SELECT|secret_value|at .*\.mjs/i);
  }
});

test('successful live preflight output is status-only', async () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await runLiveCheck(VALID_ENV, driverFor(passingRows()));
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(lines, [
    'check-book-eoi-schema: OK - live catalog and least-privilege role match canonical contracts (read-only)'
  ]);
  assert.doesNotMatch(lines.join('\n'), /postgres:|password|driver-token|SELECT|secret_value/i);
});
