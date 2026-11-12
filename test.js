// Usage: BASE=http://localhost:3111 KEY=testkey node test.js   (resets all data!)
const BASE = process.env.BASE || 'http://localhost:3000', KEY = process.env.KEY || 'testkey';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const call = async (method, path, body, headers = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { s: r.status, j, h: r.headers };
};
const future = h => new Date(Date.now() + h * 3600e3).toISOString();
(async () => {
  const slots = [
    { id: 'past', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' },
    { id: 's2', provider: 'Dr Bee', start: future(48), end: future(49) },
    { id: 's1', provider: 'Dr Ade', start: future(24), end: future(25) },
    ...[3, 4, 5, 6, 7, 8, 9].map(n => ({ id: 'x' + n, provider: 'Dr Ade', start: future(50 + n), end: future(51 + n) })),
  ];
  ok((await call('POST', '/reset', { slots })).s === 200, 'reset');
  let r = await fetch(BASE + '/slots'); ok(r.status === 401, '401 no key');
  r = await call('GET', '/slots', undefined, { 'X-API-Key': 'bad' }); ok(r.s === 401 && r.j.error, '401 bad key');
  r = await call('GET', '/slots'); ok(r.s === 200 && r.j.slots[0].id === 'past' && r.j.slots[1].id === 's1' && r.j.slots.every(s => s.available), 'slots sorted & available');
  r = await call('GET', '/slots?provider=Dr%20Bee'); ok(r.j.slots.length === 1, 'provider filter');

  r = await call('POST', '/bookings', { slot_id: 's1', name: '  Ada  ', email: '  ADA@Example.com ' });
  ok(r.s === 201 && r.j.name === 'Ada' && r.j.email === 'ada@example.com' && r.j.status === 'confirmed', '201 + trim + lowercase');
  const id = r.j.id;
  r = await call('GET', '/bookings/' + id); ok(r.s === 200 && r.j.id === id, 'get booking');
  r = await call('GET', '/bookings/nope'); ok(r.s === 404, 'get 404');
  r = await call('GET', '/slots'); ok(r.j.slots.find(s => s.id === 's1').available === false, 'slot unavailable');

  r = await call('POST', '/bookings', { slot_id: 's1', name: 'Bob', email: 'bob@example.com' }); ok(r.s === 409, '409 taken');
  r = await call('POST', '/bookings', { slot_id: 'nope', name: 'Bob', email: 'bob@example.com' }); ok(r.s === 404, '404 slot');
  r = await call('POST', '/bookings', { slot_id: 'past', name: 'Bob', email: 'bob@example.com' }); ok(r.s === 400, '400 started');
  r = await call('POST', '/bookings', { slot_id: 's2', name: ' ', email: 'v@example.com' }); ok(r.s === 400, '400 empty name');
  r = await call('POST', '/bookings', { slot_id: 's2', name: 'V', email: 'notanemail' }); ok(r.s === 400, '400 bad email');
  r = await call('POST', '/bookings', { name: 'V', email: 'v@example.com' }); ok(r.s === 400, '400 missing slot');
  r = await call('POST', '/bookings', [1]); ok(r.s === 400, '400 array body');

  // Level 3 race
  const race = await Promise.all(Array.from({ length: 30 }, (_, i) => call('POST', '/bookings', { slot_id: 's2', name: 'R' + i, email: `r${i}@example.com` })));
  ok(race.filter(x => x.s === 201).length === 1 && race.filter(x => x.s === 409).length === 29, 'race: exactly one winner');
  r = await call('DELETE', '/bookings/' + id); ok(r.s === 200 && r.j.status === 'cancelled', 'cancel');
  r = await call('DELETE', '/bookings/' + id); ok(r.s === 409, 'cancel twice 409');
  r = await call('DELETE', '/bookings/nope'); ok(r.s === 404, 'cancel 404');
  r = await call('POST', '/bookings', { slot_id: 's1', name: 'Bob', email: 'bob@example.com' }); ok(r.s === 201, 'rebook after cancel');

  // Level 4 idempotency
  const H = { 'Idempotency-Key': 'k1' }, body = { slot_id: 'x3', name: 'Ida', email: 'ida@example.com' };
  const [a, b] = await Promise.all([call('POST', '/bookings', body, H), call('POST', '/bookings', body, H)]);
  ok(a.s === 201 && b.s === 201 && a.j.id === b.j.id, 'idempotent concurrent same id');
  r = await call('POST', '/bookings', body, H); ok(r.s === 201 && r.j.id === a.j.id, 'idempotent replay');
  r = await call('POST', '/bookings', { ...body, name: 'Other' }, H); ok(r.s === 422, '422 key reuse');
  r = await call('GET', '/bookings?email=IDA@example.com'); ok(r.j.bookings.length === 1, 'no duplicate');
  // pagination: 4 more bookings for pg@ (rate limit 5)
  for (const sid of ['x4', 'x5', 'x6', 'x7']) await call('POST', '/bookings', { slot_id: sid, name: 'P', email: 'pg@example.com' });
  let all = [], cur = null, pages = 0;
  do { r = await call('GET', `/bookings?email=PG@example.com&limit=3${cur ? '&cursor=' + cur : ''}`); all.push(...r.j.bookings); cur = r.j.next_cursor; pages++; } while (cur);
  ok(all.length === 4 && pages === 2 && new Set(all.map(x => x.id)).size === 4, 'cursor pagination');
  for (const l of ['0', '51', 'abc', '1.5']) ok((await call('GET', `/bookings?email=a@b.co&limit=${l}`)).s === 400, 'limit ' + l + ' -> 400');
  ok((await call('GET', '/bookings')).s === 400, 'email required');

  // Level 5
  const rl = [];
  for (let i = 0; i < 6; i++) rl.push(await call('POST', '/bookings', { slot_id: 'nope', name: 'S', email: 'spam@example.com' }));
  ok(rl.slice(0, 5).every(x => x.s === 404) && rl[5].s === 429 && /^\d+$/.test(rl[5].h.get('Retry-After')), '6th attempt 429 + Retry-After ' + rl[5].h.get('Retry-After'));
  r = await call('POST', '/bookings', { slot_id: 'nope', name: 'S', email: 'other@example.com' }); ok(r.s === 404, 'other email unaffected');
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})();
