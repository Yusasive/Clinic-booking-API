# Clinic booking API

Node + Express + Postgres. Serves the JSON API (see https://koyaacademy.com/assessment-api) and the booking web page (`public/index.html`) from one service.

Env: `DATABASE_URL` (Postgres), `API_KEY`, `PORT`.
Run: `npm install && npm start`. Test (wipes data!): `BASE=http://localhost:3000 KEY=... npm test`.

Design notes
- Double-booking: a partial unique index `ON bookings(slot_id) WHERE status='confirmed'` makes the database the arbiter; losers get 409. Cancelling frees the slot.
- Idempotency: key + canonical body hash stored with the response; requests sharing a key are serialized by a Postgres advisory lock.
- Rate limit: attempts table + per-email advisory lock, so it is correct across instances and restarts.
