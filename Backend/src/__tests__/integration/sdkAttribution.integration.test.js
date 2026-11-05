/**
 * Anonymous SDK sessions are attributed to the person who identifies next in that browser
 * (TAS, 3 Nov 2026: an active user missing from "Most active users").
 *
 * Pins, against a real database:
 *   - identify() claims this browser's earlier anonymous sessions and their page views;
 *   - a shared PC: never across a different person who signed in in between, and an
 *     anonymous session before that person stays anonymous;
 *   - nothing older than 14 days;
 *   - migration 024 applies the same rule to sessions recorded before, and is idempotent.
 * Requires DATABASE_URL; skipped otherwise.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });

const { pool } = require('../../db/pool');
const { runMigrations } = require('../../db/migrate');
const sdkDb = require('../../db/sdkDb');

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const anon = { userId: null, email: null };
const person = (email) => ({ userId: null, email });
let app;
let seq = 0;

async function batch(anonymousId, user, sessionKey = `s${(seq += 1)}-${Date.now()}`) {
  await sdkDb.recordBatch(pool, {
    app, sessionKey, anonymousId, user, userAgent: 'jest', ip: '127.0.0.1', release: null,
    events: [{ type: 'page_view', path: '/positions', title: 'Positions' }],
  });
  return sessionKey;
}

async function backdate(sessionKey, interval) {
  await pool.query(
    `UPDATE app_sessions SET started_at = now() - $3::interval, last_seen_at = now() - $3::interval
     WHERE application_id = $1 AND session_key = $2`,
    [app.id, sessionKey, interval]
  );
}

async function owner(sessionKey) {
  const s = await pool.query('SELECT user_email FROM app_sessions WHERE application_id = $1 AND session_key = $2', [app.id, sessionKey]);
  const e = await pool.query('SELECT DISTINCT user_email FROM app_events WHERE application_id = $1 AND session_key = $2', [app.id, sessionKey]);
  return { session: s.rows[0].user_email, events: e.rows.map((r) => r.user_email) };
}

d('SDK anonymous-session attribution', () => {
  beforeAll(async () => {
    await runMigrations();
    const { rows } = await pool.query(
      "INSERT INTO applications (name, target_url) VALUES ('SDK attribution test', 'https://tas.example.com') RETURNING id"
    );
    app = { id: rows[0].id };
  });

  afterAll(async () => {
    if (app) await pool.query('DELETE FROM applications WHERE id = $1', [app.id]);
    await pool.end();
  });

  it('identify() claims the anonymous sessions this browser recorded before it', async () => {
    const a1 = await batch('aid-rio', anon);
    await backdate(a1, '2 days');
    const a2 = await batch('aid-rio', anon);
    await backdate(a2, '1 hour');
    const known = await batch('aid-rio', person('rio@example.com'));

    expect(await owner(a1)).toEqual({ session: 'rio@example.com', events: ['rio@example.com'] });
    expect(await owner(a2)).toEqual({ session: 'rio@example.com', events: ['rio@example.com'] });
    expect((await owner(known)).session).toBe('rio@example.com');
  });

  it('on a shared PC, stops at the previous person who signed in', async () => {
    const before = await batch('aid-shared', anon);
    await backdate(before, '5 hours');
    const alice = await batch('aid-shared', person('alice@example.com'));
    await backdate(alice, '4 hours');
    const gap = await batch('aid-shared', anon);
    await backdate(gap, '1 hour');
    await batch('aid-shared', person('bob@example.com'));

    expect((await owner(alice)).session).toBe('alice@example.com');
    expect((await owner(gap)).session).toBe('bob@example.com');
    // Before Alice signed in: claimed by Alice when she identified, never by Bob.
    expect((await owner(before)).session).toBe('alice@example.com');
  });

  it('never reaches past the previous person, even for a session nobody claimed', async () => {
    // Rows written directly (as before this change), so Dan's sign-in claimed nothing.
    const raw = (key, email, ago) => pool.query(
      `INSERT INTO app_sessions (application_id, session_key, user_email, anonymous_id, started_at, last_seen_at)
       VALUES ($1, $2, $3, 'aid-boundary', now() - $4::interval, now() - $4::interval)`,
      [app.id, key, email, ago]
    );
    await raw('boundary-anon', null, '5 hours');
    await raw('boundary-dan', 'dan@example.com', '4 hours');
    await batch('aid-boundary', person('erin@example.com'));

    expect((await owner('boundary-anon')).session).toBeNull();
    expect((await owner('boundary-dan')).session).toBe('dan@example.com');
  });

  it('leaves sessions older than 14 days alone, and other browsers alone', async () => {
    const old = await batch('aid-old', anon);
    await backdate(old, '20 days');
    const elsewhere = await batch('aid-other-browser', anon);
    await batch('aid-old', person('carol@example.com'));

    expect((await owner(old)).session).toBeNull();
    expect((await owner(elsewhere)).session).toBeNull();
  });

  it('migration 024 attributes sessions recorded before the change, once', async () => {
    // Recorded the old way: straight rows, no attribution at identify time.
    const ins = (key, email, ago) => pool.query(
      `INSERT INTO app_sessions (application_id, session_key, user_email, anonymous_id, started_at, last_seen_at)
       VALUES ($1, $2, $3, 'aid-history', now() - $4::interval, now() - $4::interval)`,
      [app.id, key, email, ago]
    );
    await ins('hist-anon', null, '3 days');
    await pool.query(
      "INSERT INTO app_events (application_id, session_key, event_type, path) VALUES ($1, 'hist-anon', 'page_view', '/positions')",
      [app.id]
    );
    await ins('hist-known', 'rio2@example.com', '2 days');

    const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/024_sdk_anonymous_attribution.sql'), 'utf8');
    await pool.query(sql);
    await pool.query(sql);

    expect(await owner('hist-anon')).toEqual({ session: 'rio2@example.com', events: ['rio2@example.com'] });
  });
});
