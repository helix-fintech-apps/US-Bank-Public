import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poolConfig } from '../../lib/db.mjs';

test("Neon's connection string keeps the database name clean and turns TLS on", () => {
  const c = poolConfig('postgresql://owner:pw@ep-cool-name-123-pooler.c-4.us-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require');
  const u = new URL(c.connectionString);
  assert.equal(u.pathname, '/neondb');
  assert.equal(u.search, '');
  assert.deepEqual(c.ssl, { rejectUnauthorized: true });
});

test('other query options survive; a local database stays without TLS', () => {
  const c = poolConfig('postgres://payroll@localhost:5433/usabanc?application_name=usab&sslmode=disable');
  assert.equal(new URL(c.connectionString).searchParams.get('application_name'), 'usab');
  assert.equal(new URL(c.connectionString).pathname, '/usabanc');
  assert.equal(c.ssl, undefined);
});
