import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testEnv, client } from '../helpers.mjs';
import { tx } from '../../lib/db.mjs';
import { seed } from '../../lib/seed.mjs';
import { TEAM } from '../../lib/seeds/team.mjs';

let env;
before(async () => { env = await testEnv(); });
after(async () => { await env.close(); });

for (const [u, pw, name] of [['asim@helixbots.ai', 'asim', 'Asim'], ['zak@helixbots.ai', 'zak', 'Zak']]) {
  test(`${name} signs straight in and has their own accounts`, async () => {
    const c = client(env.base);
    const r = await c.post('/api/session', { username: u, password: pw });
    assert.equal(r.body.next, 'done');
    const me = await c.get('/api/me');
    assert.equal(me.body.user.displayName, name);
    // their own three accounts from the team seed (other features' seeds may add more, e.g. a child's account)
    const mine = me.body.accounts.filter(a => TEAM.find(t => t.username === u).last4.includes(a.last4));
    assert.deepEqual(mine.map(a => a.kind).sort(), ['checking', 'credit_card', 'savings']);
    assert.ok(mine.every(a => a.role === 'owner'));
  });
}

test('running the seed again adds nobody twice and moves no money twice', async () => {
  const before = (await env.q('SELECT count(*)::int u, (SELECT count(*)::int FROM journal_entries) j FROM users')).rows[0];
  await tx(env.pool, seed);
  const after = (await env.q('SELECT count(*)::int u, (SELECT count(*)::int FROM journal_entries) j FROM users')).rows[0];
  assert.deepEqual(after, before);
});
