const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { pool, init } = require('./db');

const API_KEY = process.env.API_KEY;
if (!API_KEY) { console.error('API_KEY env var is required'); process.exit(1); }

const RATE_LIMIT = 5, RATE_WINDOW_S = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const app = express();
app.disable('x-powered-by');

// Public: the web page (static files only). The API itself is behind the key.
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// CORS so the page can also be hosted elsewhere.
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'Retry-After',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const err = (res, code, msg) => res.status(code).json({ error: msg });
const wrap = fn => (req, res, next) => fn(req, res).catch(next);

// The booking page calls /web/* so the API key never reaches the browser.
// Only the four actions a patient needs are allowed; /reset and email-based listing are not.
// Everything else (the real API) still requires X-API-Key.
const WEB_ALLOWED = [
  ['GET', /^\/slots$/], ['POST', /^\/bookings$/],
  ['GET', /^\/bookings\/[^/]+$/], ['DELETE', /^\/bookings\/[^/]+$/],
];
app.use((req, res, next) => {
  if (!req.url.startsWith('/web/')) return next();
  const inner = req.url.slice(4);
  const pathOnly = inner.split('?')[0];
  if (!WEB_ALLOWED.some(([m, re]) => m === req.method && re.test(pathOnly))) return err(res, 404, 'not found');
  req.url = inner;
  req.viaWeb = true; // server-side flag, cannot be set by a client
  next();
});

// Level 2: API key on every API request.
app.use((req, res, next) => {
  if (req.viaWeb) return next();
  const given = Buffer.from(String(req.get('X-API-Key') || ''));
  const want = Buffer.from(API_KEY);
  const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!ok) return err(res, 401, 'invalid or missing API key');
  next();
});

app.use(express.json({ limit: '1mb' }));

// ---------- Level 1 ----------
app.post('/reset', wrap(async (req, res) => {
  const slots = req.body && req.body.slots;
  if (!Array.isArray(slots)) return err(res, 400, 'slots must be an array');
  const rows = [];
  for (const s of slots) {
    if (!s || typeof s !== 'object' || [s.id, s.provider, s.start, s.end].some(v => typeof v !== 'string' || !v)
        || isNaN(Date.parse(s.start)) || isNaN(Date.parse(s.end)))
      return err(res, 400, 'each slot needs id, provider, start, end');
    rows.push(s);
  }
  if (new Set(rows.map(s => s.id)).size !== rows.length) return err(res, 400, 'duplicate slot ids');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('TRUNCATE bookings, slots, idempotency, attempts');
    for (const s of rows)
      await c.query('INSERT INTO slots (id, provider, start_raw, end_raw, start_ts) VALUES ($1,$2,$3,$4,$5)',
        [s.id, s.provider, s.start, s.end, new Date(s.start)]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  res.json({ ok: true, slots: rows.length });
}));

app.get('/slots', wrap(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.provider !== undefined) { params.push(String(req.query.provider)); where = 'WHERE s.provider = $1'; }
  const { rows } = await pool.query(
    `SELECT s.id, s.provider, s.start_raw AS start, s.end_raw AS "end",
            NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
     FROM slots s ${where} ORDER BY s.start_ts, s.id`, params);
  res.json({ slots: rows });
}));

const bookingJson = r => ({
  id: r.id, slot_id: r.slot_id, name: r.name, email: r.email,
  status: r.status, created_at: r.created_at.toISOString(),
});

app.get('/bookings/:id', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  if (!rows.length) return err(res, 404, 'booking not found');
  res.json(bookingJson(rows[0]));
}));

// ---------- Booking creation (levels 1-5) ----------
const canonical = v => {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
};

// Runs everything in one transaction; returns { status, body, headers? }.
async function createBooking(body, idemKey) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // Level 4: serialize all requests sharing an Idempotency-Key, then replay if seen.
    let bodyHash = null;
    if (idemKey) {
      bodyHash = crypto.createHash('sha256').update(canonical(body)).digest('hex');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', ['idem:' + idemKey]);
      const { rows } = await c.query('SELECT * FROM idempotency WHERE key = $1', [idemKey]);
      if (rows.length) {
        await c.query('COMMIT');
        if (rows[0].body_hash !== bodyHash)
          return { status: 422, body: { error: 'Idempotency-Key was already used with a different request body' } };
        return { status: rows[0].status, body: rows[0].response };
      }
    }

    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const str = v => (typeof v === 'string' ? v.trim() : '');
    const slotId = typeof b.slot_id === 'string' ? b.slot_id.trim() : '';
    const name = str(b.name);
    const email = str(b.email).toLowerCase();

    // Level 5: per-email limit, counting every attempt (even invalid ones that carry an email).
    if (email) {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 2))', ['rate:' + email]);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n,
                CEIL(EXTRACT(EPOCH FROM (min(at) + make_interval(secs => $2) - clock_timestamp())))::int AS wait
         FROM attempts WHERE email = $1 AND at > clock_timestamp() - make_interval(secs => $2)`,
        [email, RATE_WINDOW_S]);
      if (rows[0].n >= RATE_LIMIT) {
        await c.query('COMMIT');
        return {
          status: 429,
          body: { error: 'too many booking attempts for this email, slow down' },
          headers: { 'Retry-After': String(Math.max(1, rows[0].wait)) },
        };
      }
      await c.query('INSERT INTO attempts (email) VALUES ($1)', [email]);
    }

    let result;
    if (!slotId || !name || !email) result = { status: 400, body: { error: 'slot_id, name and email are required' } };
    else if (!EMAIL_RE.test(email)) result = { status: 400, body: { error: 'email is not valid' } };
    else {
      const { rows: sl } = await c.query('SELECT start_ts FROM slots WHERE id = $1', [slotId]);
      if (!sl.length) result = { status: 404, body: { error: 'slot not found' } };
      else if (sl[0].start_ts <= new Date()) result = { status: 400, body: { error: 'slot has already started' } };
      else {
        // Level 3: the partial unique index is the arbiter; ON CONFLICT makes losers a clean 409.
        const id = crypto.randomUUID();
        const ins = await c.query(
          `INSERT INTO bookings (id, slot_id, name, email, status) VALUES ($1,$2,$3,$4,'confirmed')
           ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING RETURNING *`,
          [id, slotId, name, email]);
        result = ins.rows.length
          ? { status: 201, body: bookingJson(ins.rows[0]) }
          : { status: 409, body: { error: 'slot is already booked' } };
      }
    }

    if (idemKey) await c.query(
      'INSERT INTO idempotency (key, body_hash, status, response) VALUES ($1,$2,$3,$4)',
      [idemKey, bodyHash, result.status, JSON.stringify(result.body)]);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

app.post('/bookings', wrap(async (req, res) => {
  const key = req.get('Idempotency-Key');
  const r = await createBooking(req.body, key && key.trim() ? key.trim() : null);
  if (r.headers) res.set(r.headers);
  res.status(r.status).json(r.body);
}));

// ---------- Level 3: cancel ----------
app.delete('/bookings/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *`, [req.params.id]);
  if (rows.length) return res.json(bookingJson(rows[0]));
  const { rows: ex } = await pool.query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
  if (!ex.length) return err(res, 404, 'booking not found');
  err(res, 409, 'booking is already cancelled');
}));

// ---------- Level 4: list a person's bookings ----------
app.get('/bookings', wrap(async (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!email) return err(res, 400, 'email is required');
  let limit = 10;
  if (req.query.limit !== undefined) {
    if (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit)) return err(res, 400, 'limit must be an integer from 1 to 50');
    limit = Number(req.query.limit);
    if (limit < 1 || limit > 50) return err(res, 400, 'limit must be an integer from 1 to 50');
  }
  let after = 0;
  if (req.query.cursor !== undefined) {
    const dec = typeof req.query.cursor === 'string' ? Buffer.from(req.query.cursor, 'base64url').toString() : '';
    if (!/^\d{1,15}$/.test(dec)) return err(res, 400, 'invalid cursor');
    after = Number(dec);
  }
  const { rows } = await pool.query(
    'SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq LIMIT $3', [email, after, limit + 1]);
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? Buffer.from(String(page[page.length - 1].seq)).toString('base64url') : null;
  res.json({ bookings: page.map(bookingJson), next_cursor: next });
}));

app.use((req, res) => err(res, 404, 'not found'));
app.use((e, req, res, next) => {
  if (e.type === 'entity.parse.failed') return err(res, 400, 'invalid JSON');
  if (e.type === 'entity.too.large') return err(res, 413, 'body too large');
  console.error(e);
  err(res, 500, 'internal error');
});

// Housekeeping: the rate limit window is 60s, idempotency keys only need to live a day.
const cleanup = () => Promise.all([
  pool.query(`DELETE FROM attempts WHERE at < now() - interval '10 minutes'`),
  pool.query(`DELETE FROM idempotency WHERE created_at < now() - interval '24 hours'`),
]).catch(e => console.error('cleanup failed', e.message));
setInterval(cleanup, 10 * 60 * 1000).unref();

const port = process.env.PORT || 3000;
init().then(cleanup).then(() => app.listen(port, () => console.log('listening on ' + port)))
  .catch(e => { console.error(e); process.exit(1); });
