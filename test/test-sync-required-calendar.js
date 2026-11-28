/**
 * Test: "Sync erforderlich" an den Termin-Routen (Fork)
 * Zweck: Mit dem Schalter AUS aendert sich nichts. Mit dem Schalter AN bekommt
 *        ein neuer Termin ein Ziel (ausdruecklich, eigenes Standardziel,
 *        Haushaltsziel - CalDAV wie Google; ein nicht mehr angebotenes Ziel wird
 *        uebersprungen), sonst 400 mit dem Fallcode sync_target_required. Ein
 *        Termin mit Ziel zieht nicht auf lokal um, ein lokaler bleibt
 *        bearbeitbar. Housekeeping (Besuchstermin, Zahlungsaufgabe) bleibt lokal.
 * Ausführen: node --test test/test-sync-required-calendar.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { tempDir } from './tmp-dir.js';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { createCalendarApp } = await import('./calendar-app.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');

const userId = Number(db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')"
).run().lastInsertRowid);

const app = await createCalendarApp({
  mount: ['calendar'],
  auth: (req, _res, next) => {
    req.authUserId = userId; req.authRole = 'admin';
    req.session = { userId, role: 'admin' };
    next();
  },
  after: [['/api/v1/housekeeping', housekeepingRouter]],
});
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
test.after(() => server.close());

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 */
async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * @param {string} key
 * @param {string} value
 */
const cfg = (key, value) => db.prepare(`
  INSERT INTO sync_config (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(key, value);
/** @param {number} id */
const row = (id) => db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);

const CAL_A = 'http://dav.invalid/cal/a/';
const CAL_B = 'http://dav.invalid/cal/b/';
const CAL_OFF = 'http://dav.invalid/cal/off/';
/** @type {number} */
let accountId;
/** @param {string} url */
const target = (url) => `caldav:${accountId}|${url}`;
/** @param {string} url */
const fields = (url) => ({ target_caldav_account_id: accountId, target_caldav_calendar_url: url });
const EVENT = (extra = {}) => ({ title: 'Termin', start_datetime: '2026-12-01T10:00:00', ...extra });

/** @param {{ switchOn: boolean }} options */
function reset({ switchOn }) {
  for (const table of [
    'calendar_pending_deletions', 'calendar_events', 'caldav_calendar_selection', 'caldav_accounts',
    'local_calendars', 'google_calendar_selection', 'outlook_calendar_selection', 'outlook_accounts',
  ]) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare(
    "DELETE FROM sync_config WHERE key LIKE 'calendar_%target%' OR key IN ('sync_required', 'google_access_token', 'google_refresh_token', 'google_readonly')"
  ).run();
  accountId = Number(db.prepare(
    "INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Fake', 'http://dav.invalid/', 'u', 'p')"
  ).run().lastInsertRowid);
  const sel = db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, enabled, writable)
    VALUES (?, ?, ?, ?, 1)
  `);
  sel.run(accountId, CAL_A, 'A', 1);
  sel.run(accountId, CAL_B, 'B', 1);
  sel.run(accountId, CAL_OFF, 'Off', 0);
  if (switchOn) cfg('sync_required', '1');
}

test('Schalter AUS: ein Termin ohne Ziel bleibt lokal, auch mit eigenem Standardziel (unveraendert)', async () => {
  reset({ switchOn: false });
  cfg(`calendar_default_target:user:${userId}`, target(CAL_A));
  const res = await api('POST', '/calendar', EVENT());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(row(res.body.data.id).target_caldav_calendar_url, null);
});

test('AN: ein ausdrueckliches Ziel wird genommen', async () => {
  reset({ switchOn: true });
  cfg(`calendar_default_target:user:${userId}`, target(CAL_A));
  const res = await api('POST', '/calendar', EVENT(fields(CAL_B)));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(row(res.body.data.id).target_caldav_calendar_url, CAL_B);
});

test('AN: ohne Ziel und mit leeren Zielfeldern (alter Client) greift das eigene Standardziel', async () => {
  reset({ switchOn: true });
  cfg(`calendar_default_target:user:${userId}`, target(CAL_A));
  const none = await api('POST', '/calendar', EVENT());
  assert.equal(none.status, 201, JSON.stringify(none.body));
  assert.equal(row(none.body.data.id).target_caldav_calendar_url, CAL_A);
  assert.equal(row(none.body.data.id).target_caldav_account_id, accountId);
  const empty = await api('POST', '/calendar', EVENT({ target_caldav_account_id: null, target_caldav_calendar_url: null }));
  assert.equal(empty.status, 201, JSON.stringify(empty.body));
  assert.equal(row(empty.body.data.id).target_caldav_calendar_url, CAL_A);
});

test('AN: ohne eigenes Standardziel greift das Haushaltsziel', async () => {
  reset({ switchOn: true });
  cfg('calendar_household_target', target(CAL_B));
  const res = await api('POST', '/calendar', EVENT());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(row(res.body.data.id).target_caldav_calendar_url, CAL_B);
});

const GOOGLE = 'familie@example.com';
/** Ein verbundenes Google-Konto mit diesem Kalender in der Auswahl (kein Netz noetig). */
function connectGoogle({ enabled = 1 } = {}) {
  cfg('google_access_token', 'access');
  cfg('google_refresh_token', 'token');
  db.prepare('INSERT INTO google_calendar_selection (calendar_id, name, enabled) VALUES (?, ?, ?)').run(GOOGLE, 'Familie', enabled);
}

test('AN: das Haushaltsziel darf auch ein verbundener, aktivierter Google-Kalender sein (anbieterunabhaengig)', async () => {
  reset({ switchOn: true });
  connectGoogle();
  cfg('calendar_household_target', `google:${GOOGLE}`);
  const res = await api('POST', '/calendar', EVENT());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(row(res.body.data.id).target_google_calendar_id, GOOGLE);
  assert.equal(row(res.body.data.id).target_caldav_calendar_url, null);
});

test('AN: ein Google-Standard ohne Verbindung wird uebersprungen, nicht still gespeichert', async () => {
  reset({ switchOn: true });
  cfg('calendar_household_target', `google:${GOOGLE}`);
  const res = await api('POST', '/calendar', EVENT());
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'sync_target_required');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 0);
});

test('AN: ein abgewaehlter Google-Kalender wird uebersprungen, der naechste Kandidat gilt', async () => {
  reset({ switchOn: true });
  connectGoogle({ enabled: 0 });
  cfg(`calendar_default_target:user:${userId}`, `google:${GOOGLE}`);
  cfg('calendar_household_target', target(CAL_A));
  const res = await api('POST', '/calendar', EVENT());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(row(res.body.data.id).target_caldav_calendar_url, CAL_A);
  assert.equal(row(res.body.data.id).target_google_calendar_id, null);
});

test('AN: Google im Nur-Lesen-Modus nimmt keine neuen Termine an -> uebersprungen', async () => {
  reset({ switchOn: true });
  connectGoogle();
  cfg('google_readonly', '1');
  cfg('calendar_household_target', `google:${GOOGLE}`);
  assert.equal((await api('POST', '/calendar', EVENT())).status, 400);
});

/** @param {{ canEdit: number }} options */
function outlookCalendar({ canEdit }) {
  const account = Number(db.prepare(
    "INSERT INTO outlook_accounts (name, access_token, refresh_token) VALUES ('MS', 'a', 'r')"
  ).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO outlook_calendar_selection (account_id, calendar_id, calendar_name, can_edit, enabled)
    VALUES (?, 'cal-1', 'Outlook', ?, 1)
  `).run(account, canEdit);
  return account;
}

test('AN: ein angebotener Outlook-Kalender als Haushaltsziel wird gesetzt', async () => {
  reset({ switchOn: true });
  const account = outlookCalendar({ canEdit: 1 });
  cfg('calendar_household_target', `outlook:${account}|cal-1`);
  const res = await api('POST', '/calendar', EVENT());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(row(res.body.data.id).target_outlook_account_id, account);
  assert.equal(row(res.body.data.id).target_outlook_calendar_id, 'cal-1');
});

test('AN: ein nur lesbarer oder entfernter Outlook-Kalender wird uebersprungen', async () => {
  reset({ switchOn: true });
  const account = outlookCalendar({ canEdit: 0 });
  cfg('calendar_household_target', `outlook:${account}|cal-1`);
  assert.equal((await api('POST', '/calendar', EVENT())).body.reason, 'sync_target_required');
  cfg('calendar_household_target', 'outlook:999|gone');
  assert.equal((await api('POST', '/calendar', EVENT())).body.reason, 'sync_target_required');
});

test('AN: ein nicht mehr angebotenes eigenes Standardziel wird uebersprungen', async () => {
  reset({ switchOn: true });
  cfg(`calendar_default_target:user:${userId}`, target(CAL_OFF));
  cfg('calendar_household_target', target(CAL_A));
  const res = await api('POST', '/calendar', EVENT());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(row(res.body.data.id).target_caldav_calendar_url, CAL_A);
});

test('AN: kein Ziel verfuegbar -> 400 sync_target_required, nichts gespeichert', async () => {
  reset({ switchOn: true });
  cfg(`calendar_default_target:user:${userId}`, target(CAL_OFF));
  const res = await api('POST', '/calendar', EVENT());
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'sync_target_required');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 0);
  db.prepare("DELETE FROM sync_config WHERE key LIKE 'calendar_%target%'").run();
  assert.equal((await api('POST', '/calendar', EVENT())).body.reason, 'sync_target_required');
});

test('AN: ein lokaler Kalender ohne Ziel zaehlt als lokal -> 400 sync_target_required', async () => {
  reset({ switchOn: true });
  cfg('calendar_household_target', target(CAL_A));
  const localCal = Number(db.prepare(
    "INSERT INTO local_calendars (name, color, is_default, sort_order) VALUES ('Lokal', '#007AFF', 0, 1)"
  ).run().lastInsertRowid);
  const res = await api('POST', '/calendar', EVENT({ local_calendar_id: localCal }));
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'sync_target_required');
});

test('AN: ein Termin mit Ziel laesst sich nicht auf lokal umziehen', async () => {
  reset({ switchOn: true });
  cfg('calendar_household_target', target(CAL_A));
  const created = await api('POST', '/calendar', EVENT());
  const id = created.body.data.id;
  const res = await api('PUT', `/calendar/${id}`, { target_caldav_account_id: null, target_caldav_calendar_url: null });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'sync_target_required');
  assert.equal(row(id).target_caldav_calendar_url, CAL_A);
});

test('AN: ein schon lokaler Termin bleibt bearbeitbar', async () => {
  reset({ switchOn: false });
  const created = await api('POST', '/calendar', EVENT());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  cfg('sync_required', '1');
  const title = await api('PUT', `/calendar/${id}`, { title: 'Neuer Titel' });
  assert.equal(title.status, 200, JSON.stringify(title.body));
  const stay = await api('PUT', `/calendar/${id}`, { target_caldav_account_id: null, target_caldav_calendar_url: null });
  assert.equal(stay.status, 200, JSON.stringify(stay.body));
});

test('AN: Housekeeping bleibt lokal - Besuchstermin und Zahlungsaufgabe bekommen kein Ziel', async () => {
  reset({ switchOn: true });
  cfg('calendar_household_target', target(CAL_A));
  cfg('tasks_household_target', target(CAL_A));
  db.prepare('DELETE FROM tasks').run();
  const worker = await api('POST', '/housekeeping/worker', { display_name: 'Putzhilfe', daily_rate: 50, rate_type: 'daily' });
  assert.equal(worker.status, 201, JSON.stringify(worker.body));
  const workers = await api('GET', '/housekeeping/workers');
  const checkIn = await api('POST', '/housekeeping/work-sessions/check-in', {
    worker_id: workers.body.data[0].id, daily_rate: 50, extras: 0,
  });
  assert.equal(checkIn.status, 201, JSON.stringify(checkIn.body));
  const events = db.prepare('SELECT * FROM calendar_events').all();
  assert.ok(events.length >= 1, 'der Besuch legt seinen Termin an');
  for (const event of events) {
    assert.equal(event.external_source, 'local');
    assert.equal(event.target_caldav_calendar_url, null);
    assert.equal(event.target_google_calendar_id, null);
  }
  for (const task of db.prepare('SELECT * FROM tasks').all()) {
    assert.equal(task.target_caldav_list_url, null);
  }
});

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('AN: eine abgelehnte Aenderung laesst keinen hochgeladenen Anhang als Waise liegen', async () => {
  reset({ switchOn: true });
  cfg('calendar_household_target', target(CAL_A));
  const created = await api('POST', '/calendar', EVENT());
  const id = created.body.data.id;
  const root = tempDir('yuvomi-sync-required-');
  process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = '1';
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = root;
  try {
    const res = await api('PUT', `/calendar/${id}`, {
      target_caldav_account_id: null, target_caldav_calendar_url: null,
      attachment_data: PNG, attachment_name: 'a.png',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.reason, 'sync_target_required');
    assert.deepEqual(readdirSync(root, { recursive: true }), [], 'die Abweisung kommt vor dem Staging');
  } finally {
    delete process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
    delete process.env.DOCUMENT_STORAGE_LOCAL_PATH;
  }
});
