// Tests the Supabase security rules (supabase/schema.sql) in a real Postgres engine (WASM).
// Setup: npm i @electric-sql/pglite   Run: node tests/schema.test.js
const { PGlite } = require('@electric-sql/pglite'); const fs = require('fs'); const assert = require('assert');
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
(async () => {
  const db = new PGlite();
  // minimal stand-ins for what Supabase provides
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    insert into auth.users values ('${A}'), ('${B}'); grant usage on schema auth to anon, authenticated; grant usage on schema public to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;`);
  await db.exec(fs.readFileSync(__dirname + '/../supabase/schema.sql', 'utf8')); await db.exec(fs.readFileSync(__dirname + '/../supabase/schema.sql', 'utf8')); console.log('schema runs (and can be re-run safely)');
  const as = async (uid, sql, params) => { await db.exec("reset role"); if (uid === 'anon') await db.exec("set role anon"); else { await db.exec(`select set_config('request.jwt.claim.sub','${uid}', false); set role authenticated`); } try { return await db.query(sql, params); } finally { await db.exec('reset role'); } };
  const fails = async (uid, sql, re) => { try { await as(uid, sql); } catch (e) { assert.ok(re.test(e.message), 'unexpected error: ' + e.message); return; } assert.fail('expected failure: ' + sql); };
  await as(A, `insert into public.user_data(key, value) values ('sn_hw_kid', '[{"t":"A secret"}]')`); await as(B, `insert into public.user_data(key, value) values ('sn_hw_kid', '[{"t":"B secret"}]')`);
  assert.strictEqual((await as(A, 'select * from public.user_data')).rows.length, 1); assert.ok(JSON.stringify((await as(A, 'select value from public.user_data')).rows).includes('A secret') && !JSON.stringify((await as(A, 'select value from public.user_data')).rows).includes('B secret')); console.log('users only see their own rows');
  assert.strictEqual((await as(B, `update public.user_data set value='"hacked"' where user_id='${A}'`)).affectedRows, 0); assert.strictEqual((await as(B, `delete from public.user_data where user_id='${A}'`)).affectedRows, 0); await fails(B, `insert into public.user_data(user_id, key, value) values ('${A}', 'evil', '1')`, /row-level security/i); await fails(B, `update public.user_data set user_id='${A}' where user_id='${B}'`, /row-level security/i); console.log("cannot touch another user's rows, or move rows to them");
  await fails('anon', 'select * from public.user_data', /permission denied/i); await fails('anon', `insert into public.user_data(user_id,key,value) values ('${A}','x','1')`, /permission denied/i); console.log('signed-out (anon) access denied');
  const t1 = (await as(A, `select updated_at from public.user_data`)).rows[0].updated_at; await new Promise(r => setTimeout(r, 15)); await as(A, `insert into public.user_data(key, value) values ('sn_hw_kid', '[1]') on conflict (user_id, key) do update set value = excluded.value`); const r2 = (await as(A, `select value, updated_at from public.user_data`)).rows[0]; assert.deepStrictEqual(r2.value, [1]); assert.ok(new Date(r2.updated_at) > new Date(t1)); console.log('upsert works and updated_at moves');
  await fails(A, `insert into public.user_data(key, value) values ('big', jsonb_build_object('x', repeat('a', 1000001)))`, /check constraint/i); console.log('oversized rows rejected');
  await as(A, `insert into public.user_data(key, value) select 'k' || g, '1' from generate_series(1, 399) g`); await fails(A, `insert into public.user_data(key, value) values ('one-too-many', '1')`, /Too many/i); assert.strictEqual((await as(B, 'select count(*)::int c from public.user_data')).rows[0].c, 1, "other user unaffected by A's cap"); console.log('row cap enforced (400)');
  console.log('SCHEMA ALL PASSED'); process.exit(0);
})().catch(e => { console.error('FAIL', e.message || e); process.exit(1); });
