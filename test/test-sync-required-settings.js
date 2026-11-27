/**
 * Test: "Sync erforderlich" - Schalter und Haushalts-Standardziele (Fork)
 * Zweck: GET liefert sync_required (false) und die zwei Haushaltsziele (''); nur
 *        ein Admin schreibt sie; die Ziele folgen denselben Formregeln wie die
 *        persoenlichen (Aufgaben nehmen kein google:). isSyncRequired() und
 *        targetCandidates() lesen sie fuer die Erstellrouten.
 * Ausführen: node --test test/test-sync-required-settings.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreferencesApp, PREFERENCES_PREFIX } from './preferences-app.js';

const dbmod = await import('../server/db.js');
const { isSyncRequired, targetCandidates, SYNC_TARGET_REQUIRED } = await import('../server/services/sync-required.js');

let currentUserId = 1;
let currentRole = 'admin';

async function startApp() {
  const app = await createPreferencesApp({
    mount: ['preferences'],
    auth: (req, _res, next) => { req.authUserId = currentUserId; req.authRole = currentRole; next(); },
  });
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${s.address().port}${PREFERENCES_PREFIX}`,
      close: () => new Promise((r) => s.close(r)),
    }));
  });
}

const get = async (baseUrl) => (await (await fetch(`${baseUrl}/`)).json()).data;
const put = async (baseUrl, body) => {
  const res = await fetch(`${baseUrl}/`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test('GET: Schalter aus, Haushaltsziele leer', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const prefs = await get(baseUrl);
    assert.equal(prefs.sync_required, false);
    assert.equal(prefs.calendar_household_target, '');
    assert.equal(prefs.tasks_household_target, '');
    assert.equal(isSyncRequired(dbmod.get()), false);
  } finally { await close(); }
});

test('PUT: ein Admin schaltet "Sync erforderlich" ein, GET und Service sehen es', async () => {
  const { baseUrl, close } = await startApp();
  try {
    currentRole = 'admin';
    const res = await put(baseUrl, { sync_required: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.sync_required, true);
    assert.equal((await get(baseUrl)).sync_required, true);
    assert.equal(isSyncRequired(dbmod.get()), true);
  } finally { await close(); }
});

test('PUT: ein Mitglied darf weder Schalter noch Haushaltsziele setzen (403)', async () => {
  const { baseUrl, close } = await startApp();
  try {
    currentRole = 'member';
    assert.equal((await put(baseUrl, { sync_required: false })).status, 403);
    assert.equal((await put(baseUrl, { calendar_household_target: 'caldav:1|https://x/' })).status, 403);
    assert.equal((await put(baseUrl, { tasks_household_target: 'caldav:1|https://x/' })).status, 403);
  } finally { currentRole = 'admin'; await close(); }
});

test('PUT: Haushaltsziele folgen den Formregeln der persoenlichen Ziele', async () => {
  const { baseUrl, close } = await startApp();
  try {
    currentRole = 'admin';
    assert.equal((await put(baseUrl, { calendar_household_target: 'junk' })).status, 400);
    assert.equal((await put(baseUrl, { tasks_household_target: 'google:x@example.com' })).status, 400,
      'Aufgaben nehmen kein google:');
    assert.equal((await put(baseUrl, { sync_required: 'yes' })).status, 400);
    const ok = await put(baseUrl, { calendar_household_target: 'caldav:1|https://x/' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.calendar_household_target, 'caldav:1|https://x/');
  } finally { await close(); }
});

test('targetCandidates: eigenes Ziel zuerst, dann Haushaltsziel; leer und doppelt entfallen', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const database = dbmod.get();
    currentRole = 'admin';
    await put(baseUrl, { calendar_household_target: 'caldav:1|https://x/home/', tasks_household_target: '' });
    currentUserId = 7;
    assert.deepEqual(targetCandidates(database, 'calendar', 7), ['caldav:1|https://x/home/'],
      'ohne eigenes Ziel nur das Haushaltsziel');
    await put(baseUrl, { calendar_default_target: 'caldav:1|https://x/mine/' });
    assert.deepEqual(targetCandidates(database, 'calendar', 7),
      ['caldav:1|https://x/mine/', 'caldav:1|https://x/home/']);
    await put(baseUrl, { calendar_default_target: 'caldav:1|https://x/home/' });
    assert.deepEqual(targetCandidates(database, 'calendar', 7), ['caldav:1|https://x/home/'],
      'gleiche Werte stehen nur einmal');
    assert.deepEqual(targetCandidates(database, 'tasks', 7), [], 'leeres Haushaltsziel zaehlt nicht');
  } finally { currentUserId = 1; await close(); }
});

test('SYNC_TARGET_REQUIRED: 400 mit dem Fallcode', () => {
  assert.equal(SYNC_TARGET_REQUIRED.code, 400);
  assert.equal(SYNC_TARGET_REQUIRED.reason, 'sync_target_required');
  assert.equal(typeof SYNC_TARGET_REQUIRED.error, 'string');
});
