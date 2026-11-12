const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id        text PRIMARY KEY,
  provider  text NOT NULL,
  start_raw text NOT NULL,
  end_raw   text NOT NULL,
  start_ts  timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  seq        bigserial PRIMARY KEY,
  id         text UNIQUE NOT NULL,
  slot_id    text NOT NULL,
  name       text NOT NULL,
  email      text NOT NULL,
  status     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- The core guarantee: at most ONE confirmed booking per slot, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);
CREATE TABLE IF NOT EXISTS idempotency (
  key       text PRIMARY KEY,
  body_hash text NOT NULL,
  status    int  NOT NULL,
  response  jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id    bigserial PRIMARY KEY,
  email text NOT NULL,
  at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS attempts_email_at ON attempts (email, at);
`;

async function init() {
  // Serialize concurrent boots (e.g. two instances) creating the schema.
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727001)');
    await c.query(SCHEMA);
    await c.query('SELECT pg_advisory_unlock(727001)');
  } finally { c.release(); }
}

module.exports = { pool, init };
