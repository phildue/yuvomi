/**
 * Test: "Sync erforderlich" an den Aufgaben-Routen (Fork)
 * Zweck: Mit dem Schalter AUS aendert sich nichts. Mit dem Schalter AN bekommt
 *        eine neue Aufgabe ein Ziel (ausdruecklich, eigenes Standardziel,
 *        Haushaltsziel; ein nicht mehr angebotenes Ziel wird uebersprungen),
 *        sonst 400 mit dem Fallcode sync_target_required. Unteraufgaben bleiben
 *        ausgenommen. Eine Aufgabe darf nicht auf "lokal" umgezogen werden; eine
 *        schon lokale bleibt bearbeitbar.
 * Ausführen: node --test test/test-sync-required-tasks.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { createTasksApp, TASKS_PREFIX } = await import('./tasks-app.js');

const userId = Number(db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')"
).run().lastInsertRowid);

const app = await createTasksApp({
  auth: (req, _res, next) => { req.authUserId = userId; req.authRole = 'admin'; next(); },
});
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}${TASKS_PREFIX}`;
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
const row = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);

const LIST_A = 'http://dav.invalid/lists/a/';
const LIST_B = 'http://dav.invalid/lists/b/';
const LIST_OFF = 'http://dav.invalid/lists/off/';
/** @type {number} */
let accountId;
/** @param {string} url */
const target = (url) => `caldav:${accountId}|${url}`;

/** @param {{ switchOn: boolean }} options */
function reset({ switchOn }) {
  for (const table of ['caldav_todo_pending_deletions', 'tasks', 'caldav_reminder_selection', 'caldav_accounts']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("DELETE FROM sync_config WHERE key LIKE 'tasks_%target%' OR key = 'sync_required'").run();
  accountId = Number(db.prepare(
    "INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Fake', 'http://dav.invalid/', 'u', 'p')"
  ).run().lastInsertRowid);
  const sel = db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, writable)
    VALUES (?, ?, ?, 'tasks', ?, 1)
  `);
  sel.run(accountId, LIST_A, 'A', 1);
  sel.run(accountId, LIST_B, 'B', 1);
  sel.run(accountId, LIST_OFF, 'Off', 0);
  if (switchOn) cfg('sync_required', '1');
}

test('Schalter AUS: eine Aufgabe ohne Ziel bleibt lokal, auch mit eigenem Standardziel (unveraendert)', async () => {
  reset({ switchOn: false });
  cfg(`tasks_default_target:user:${userId}`, target(LIST_A));
  const res = await api('POST', '/', { title: 'Lokal' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(row(res.body.data.id).target_caldav_list_url, null);
});

test('AN: ein ausdrueckliches Ziel wird genommen', async () => {
  reset({ switchOn: true });
  cfg(`tasks_default_target:user:${userId}`, target(LIST_A));
  const res = await api('POST', '/', { title: 'Mit Ziel', sync_target: target(LIST_B) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(row(res.body.data.id).target_caldav_list_url, LIST_B);
});

test('AN: ohne Ziel und mit leerem Ziel (alter Client) greift das eigene Standardziel', async () => {
  reset({ switchOn: true });
  cfg(`tasks_default_target:user:${userId}`, target(LIST_A));
  const none = await api('POST', '/', { title: 'Ohne' });
  assert.equal(none.status, 201, JSON.stringify(none.body));
  assert.equal(row(none.body.data.id).target_caldav_list_url, LIST_A);
  const empty = await api('POST', '/', { title: 'Leer', sync_target: '' });
  assert.equal(empty.status, 201, JSON.stringify(empty.body));
  assert.equal(row(empty.body.data.id).target_caldav_list_url, LIST_A);
});

test('AN: ohne eigenes Standardziel greift das Haushaltsziel', async () => {
  reset({ switchOn: true });
  cfg('tasks_household_target', target(LIST_B));
  const res = await api('POST', '/', { title: 'Haushalt' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(row(res.body.data.id).target_caldav_list_url, LIST_B);
});

test('AN: ein nicht mehr angebotenes eigenes Standardziel wird uebersprungen', async () => {
  reset({ switchOn: true });
  cfg(`tasks_default_target:user:${userId}`, target(LIST_OFF));
  cfg('tasks_household_target', target(LIST_A));
  const res = await api('POST', '/', { title: 'Ueberspringen' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(row(res.body.data.id).target_caldav_list_url, LIST_A);
});

test('AN: kein Ziel verfuegbar -> 400 sync_target_required, nichts gespeichert', async () => {
  reset({ switchOn: true });
  cfg(`tasks_default_target:user:${userId}`, target(LIST_OFF));
  const res = await api('POST', '/', { title: 'Abgelehnt' });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'sync_target_required');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  // Frische Installation ohne jedes Standardziel: dieselbe Antwort.
  db.prepare("DELETE FROM sync_config WHERE key LIKE 'tasks_%target%'").run();
  assert.equal((await api('POST', '/', { title: 'Noch einmal' })).body.reason, 'sync_target_required');
});

test('AN: eine Unteraufgabe braucht kein Ziel', async () => {
  reset({ switchOn: true });
  cfg('tasks_household_target', target(LIST_A));
  const parent = await api('POST', '/', { title: 'Eltern' });
  assert.equal(parent.status, 201, JSON.stringify(parent.body));
  const sub = await api('POST', '/', { title: 'Teil', parent_task_id: parent.body.data.id });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(row(sub.body.data.id).target_caldav_list_url, null);
});

test('AN: eine synchronisierte Aufgabe laesst sich nicht auf lokal umziehen', async () => {
  reset({ switchOn: true });
  cfg('tasks_household_target', target(LIST_A));
  const created = await api('POST', '/', { title: 'Synchron' });
  const id = created.body.data.id;
  const res = await api('PUT', `/${id}`, { sync_target: '' });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'sync_target_required');
  assert.equal(row(id).target_caldav_list_url, LIST_A);
});

test('AN: eine schon lokale Aufgabe bleibt bearbeitbar', async () => {
  reset({ switchOn: false });
  const created = await api('POST', '/', { title: 'Alt und lokal' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  cfg('sync_required', '1');
  const title = await api('PUT', `/${id}`, { title: 'Neuer Titel' });
  assert.equal(title.status, 200, JSON.stringify(title.body));
  const stay = await api('PUT', `/${id}`, { sync_target: '' });
  assert.equal(stay.status, 200, JSON.stringify(stay.body));
  assert.equal(row(id).target_caldav_list_url, null);
});
