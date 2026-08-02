/**
 * Modul: Budget-Konten (#495)
 * Zweck: CRUD für Konten, laufender Saldo (Startsaldo + zugeordnete Einträge),
 *        Nettovermögen, account_id-Verdrahtung (POST/PUT/Filter) und die
 *        Invariante beim Löschen: Einträge bleiben erhalten, account_id → NULL.
 * Ausführen: npm run test:budget-accounts
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'budget-accounts-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

const ADMIN_ID = seedUser();
// Eine garantiert gültige Kategorie je Typ ermitteln (Migrationen seeden Standardkategorien).
const EXPENSE_CAT = pickCategory('expense');
const INCOME_CAT = pickCategory('income');

test.after(() => suiteDatabase.close());

function applyMigration(db, migration) {
  if (typeof migration.up === 'function') migration.up(db);
  else db.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(db, migration);
  return db;
}

function seedUser() {
  const info = suiteDatabase.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('admin', 'Admin', 'x', 'admin')
  `).run();
  return Number(info.lastInsertRowid);
}

function pickCategory(type) {
  const row = suiteDatabase.prepare(
    'SELECT key FROM budget_categories WHERE type = ? ORDER BY sort_order ASC LIMIT 1'
  ).get(type);
  assert.ok(row, `Standardkategorie für ${type} muss durch Migrationen existieren`);
  return row.key;
}

function createHarness({ userId = ADMIN_ID, role = 'admin' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = userId;
    req.authRole = role;
    req.session = { userId, role };
    next();
  });
  app.use('/api/v1/budget', budgetRouter);
  const server = http.createServer(app);
  return {
    async call(method, pathname, body) {
      if (!server.listening) {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      }
      const base = `http://127.0.0.1:${server.address().port}/api/v1/budget`;
      const res = await fetch(`${base}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    close() {
      return new Promise((resolve) => (server.listening ? server.close(resolve) : resolve()));
    },
  };
}

function cleanup() {
  suiteDatabase.exec('DELETE FROM budget_entries; DELETE FROM budget_accounts;');
}

const PAST = '2020-06-15';        // zählt zum aktuellen Saldo (date <= heute)
const FUTURE = '2999-01-01';      // nur im projizierten Saldo

test('POST /accounts legt Konto an; Saldo = Startsaldo ohne Einträge', async () => {
  cleanup();
  const h = createHarness();
  try {
    const res = await h.call('POST', '/accounts', { name: 'Girokonto', type: 'checking', starting_balance: 1000 });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.name, 'Girokonto');
    assert.equal(res.body.data.type, 'checking');
    assert.equal(res.body.data.starting_balance, 1000);
    assert.equal(res.body.data.current_balance, 1000);
    assert.equal(res.body.data.projected_balance, 1000);
  } finally { await h.close(); }
});

test('laufender Saldo = Startsaldo + zugeordnete Einträge bis heute', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Konto', starting_balance: 100 })).body.data;
    // Einkommen +50 (heute-vergangen), Ausgabe -30 (vergangen), +200 (Zukunft, nur projiziert)
    await h.call('POST', '', { title: 'Lohn', amount: 50, category: INCOME_CAT, date: PAST, account_id: acc.id });
    await h.call('POST', '', { title: 'Kauf', amount: -30, category: EXPENSE_CAT, date: PAST, account_id: acc.id });
    await h.call('POST', '', { title: 'Zukunft', amount: 200, category: INCOME_CAT, date: FUTURE, account_id: acc.id });

    const list = (await h.call('GET', '/accounts')).body.data;
    const a = list.accounts.find((x) => x.id === acc.id);
    assert.equal(a.current_balance, 120);        // 100 + 50 - 30
    assert.equal(a.projected_balance, 320);      // + 200 Zukunft
    assert.equal(list.net_worth, 120);           // Nettovermögen = aktueller Saldo
  } finally { await h.close(); }
});

test('Nettovermögen summiert nur aktive Konten', async () => {
  cleanup();
  const h = createHarness();
  try {
    const a = (await h.call('POST', '/accounts', { name: 'A', starting_balance: 100 })).body.data;
    const b = (await h.call('POST', '/accounts', { name: 'B', starting_balance: 250 })).body.data;
    await h.call('PUT', `/accounts/${b.id}`, { archived: true });

    const res = (await h.call('GET', '/accounts')).body.data;
    assert.equal(res.accounts.length, 1, 'archivierte Konten sind standardmäßig ausgeblendet');
    assert.equal(res.net_worth, 100);

    const all = (await h.call('GET', '/accounts?include_archived=1')).body.data;
    assert.equal(all.accounts.length, 2);
    assert.equal(all.net_worth, 100, 'net_worth ignoriert archivierte auch bei include_archived');
    assert.ok(a && b);
  } finally { await h.close(); }
});

test('account_id-Filter in GET /budget', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Konto', starting_balance: 0 })).body.data;
    const month = PAST.slice(0, 7);
    await h.call('POST', '', { title: 'Mit Konto', amount: -10, category: EXPENSE_CAT, date: PAST, account_id: acc.id });
    await h.call('POST', '', { title: 'Ohne Konto', amount: -20, category: EXPENSE_CAT, date: PAST });

    const filtered = (await h.call('GET', `/?month=${month}&account_id=${acc.id}`)).body.data;
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].title, 'Mit Konto');
    assert.equal(filtered[0].account_id, acc.id);

    const all = (await h.call('GET', `/?month=${month}`)).body.data;
    assert.equal(all.length, 2);
  } finally { await h.close(); }
});

test('category-Filter in GET /budget (Drilldown aus dem Kategorien-Diagramm)', async () => {
  cleanup();
  const h = createHarness();
  try {
    const otherCat = suiteDatabase.prepare(
      "SELECT key FROM budget_categories WHERE type = 'expense' AND key != ? ORDER BY sort_order ASC LIMIT 1"
    ).get(EXPENSE_CAT)?.key;
    assert.ok(otherCat, 'zweite Ausgabenkategorie muss für den Test existieren');
    const month = PAST.slice(0, 7);
    await h.call('POST', '', { title: 'Kategorie A', amount: -10, category: EXPENSE_CAT, date: PAST });
    await h.call('POST', '', { title: 'Kategorie B', amount: -20, category: otherCat, date: PAST });

    const filtered = (await h.call('GET', `/?month=${month}&category=${EXPENSE_CAT}`)).body.data;
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].title, 'Kategorie A');
    assert.equal(filtered[0].category, EXPENSE_CAT);

    const all = (await h.call('GET', `/?month=${month}`)).body.data;
    assert.equal(all.length, 2);

    const invalid = (await h.call('GET', `/?month=${month}&category=does-not-exist`)).body.data;
    assert.equal(invalid.length, 2, 'unbekannte Kategorie wird ignoriert statt die Liste leer zu filtern');
  } finally { await h.close(); }
});

test('subcategory-Filter in GET /budget', async () => {
  cleanup();
  const h = createHarness();
  try {
    const subs = suiteDatabase.prepare(
      'SELECT key FROM budget_subcategories WHERE category_key = ? ORDER BY sort_order ASC LIMIT 2'
    ).all(EXPENSE_CAT);
    assert.ok(subs.length >= 2, 'Ausgabenkategorie braucht mindestens zwei Subkategorien für den Test');
    const [subA, subB] = subs.map((s) => s.key);
    const month = PAST.slice(0, 7);
    await h.call('POST', '', { title: 'Sub A', amount: -10, category: EXPENSE_CAT, subcategory: subA, date: PAST });
    await h.call('POST', '', { title: 'Sub B', amount: -20, category: EXPENSE_CAT, subcategory: subB, date: PAST });

    const filtered = (await h.call('GET', `/?month=${month}&subcategory=${subA}`)).body.data;
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].title, 'Sub A');
    assert.equal(filtered[0].subcategory, subA);

    const all = (await h.call('GET', `/?month=${month}`)).body.data;
    assert.equal(all.length, 2);

    const invalid = (await h.call('GET', `/?month=${month}&subcategory=does-not-exist`)).body.data;
    assert.equal(invalid.length, 2, 'unbekannte Subkategorie wird ignoriert statt die Liste leer zu filtern');
  } finally { await h.close(); }
});

test('GET /budget/summary liefert bySubcategory-Aufschlüsselung', async () => {
  cleanup();
  const h = createHarness();
  try {
    const subs = suiteDatabase.prepare(
      'SELECT key FROM budget_subcategories WHERE category_key = ? ORDER BY sort_order ASC LIMIT 1'
    ).all(EXPENSE_CAT);
    assert.ok(subs.length >= 1, 'Ausgabenkategorie braucht mindestens eine Subkategorie für den Test');
    const sub = subs[0].key;
    const month = PAST.slice(0, 7);
    await h.call('POST', '', { title: 'x', amount: -30, category: EXPENSE_CAT, subcategory: sub, date: PAST });
    await h.call('POST', '', { title: 'y', amount: -70, category: EXPENSE_CAT, subcategory: sub, date: PAST });
    await h.call('POST', '', { title: 'income', amount: 500, category: INCOME_CAT, date: PAST });

    const summary = (await h.call('GET', `/summary?month=${month}`)).body.data;
    const row = summary.bySubcategory.find((s) => s.category === EXPENSE_CAT && s.subcategory === sub);
    assert.ok(row, 'bySubcategory enthält die Kategorie/Subkategorie-Kombination');
    assert.equal(row.total, -100);
    assert.equal(row.expenses, -100);
    assert.ok(!summary.bySubcategory.some((s) => s.category === INCOME_CAT), 'Einnahmen tauchen nicht in bySubcategory auf (keine Subkategorien)');
  } finally { await h.close(); }
});

test('category- und account_id-Filter in GET /budget kombinieren sich (UND-Verknüpfung)', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Konto', starting_balance: 0 })).body.data;
    const month = PAST.slice(0, 7);
    await h.call('POST', '', { title: 'Treffer', amount: -10, category: EXPENSE_CAT, date: PAST, account_id: acc.id });
    await h.call('POST', '', { title: 'Falsches Konto', amount: -10, category: EXPENSE_CAT, date: PAST });
    await h.call('POST', '', { title: 'Falsche Kategorie', amount: 50, category: INCOME_CAT, date: PAST, account_id: acc.id });

    const filtered = (await h.call('GET', `/?month=${month}&category=${EXPENSE_CAT}&account_id=${acc.id}`)).body.data;
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].title, 'Treffer');
  } finally { await h.close(); }
});

test('POST /budget: ungültige account_id → 400', async () => {
  cleanup();
  const h = createHarness();
  try {
    const res = await h.call('POST', '', { title: 'x', amount: -5, category: EXPENSE_CAT, date: PAST, account_id: 99999 });
    assert.equal(res.status, 400);
  } finally { await h.close(); }
});

test('PUT /budget/:id setzt und entfernt account_id', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Konto', starting_balance: 0 })).body.data;
    const entry = (await h.call('POST', '', { title: 'x', amount: -5, category: EXPENSE_CAT, date: PAST })).body.data;
    assert.equal(entry.account_id, null);

    const set = await h.call('PUT', `/${entry.id}`, { account_id: acc.id });
    assert.equal(set.body.data.account_id, acc.id);

    const cleared = await h.call('PUT', `/${entry.id}`, { account_id: null });
    assert.equal(cleared.body.data.account_id, null);

    // account_id nicht mitsenden ⇒ unverändert
    await h.call('PUT', `/${entry.id}`, { account_id: acc.id });
    const untouched = await h.call('PUT', `/${entry.id}`, { title: 'y' });
    assert.equal(untouched.body.data.account_id, acc.id);
  } finally { await h.close(); }
});

test('PUT /accounts/:id aktualisiert Felder', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Alt', type: 'checking', starting_balance: 10 })).body.data;
    const res = await h.call('PUT', `/accounts/${acc.id}`, { name: 'Neu', type: 'savings', starting_balance: 500 });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.name, 'Neu');
    assert.equal(res.body.data.type, 'savings');
    assert.equal(res.body.data.starting_balance, 500);
    assert.equal(res.body.data.current_balance, 500);
  } finally { await h.close(); }
});

test('DELETE /accounts/:id: Einträge bleiben erhalten, account_id → NULL', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Konto', starting_balance: 0 })).body.data;
    const entry = (await h.call('POST', '', { title: 'x', amount: -5, category: EXPENSE_CAT, date: PAST, account_id: acc.id })).body.data;

    const del = await h.call('DELETE', `/accounts/${acc.id}`);
    assert.equal(del.status, 204);

    const row = suiteDatabase.prepare('SELECT * FROM budget_entries WHERE id = ?').get(entry.id);
    assert.ok(row, 'Eintrag muss erhalten bleiben');
    assert.equal(row.account_id, null, 'Zuordnung muss geleert sein');

    const list = (await h.call('GET', '/accounts')).body.data;
    assert.equal(list.accounts.length, 0);
  } finally { await h.close(); }
});

test('POST /accounts validiert Name und Typ', async () => {
  cleanup();
  const h = createHarness();
  try {
    assert.equal((await h.call('POST', '/accounts', { name: '', type: 'checking' })).status, 400);
    assert.equal((await h.call('POST', '/accounts', { name: 'X', type: 'bogus' })).status, 400);
    // Negativer Startsaldo ist erlaubt (z. B. Kreditkarte)
    const credit = await h.call('POST', '/accounts', { name: 'Karte', type: 'credit', starting_balance: -300 });
    assert.equal(credit.status, 201);
    assert.equal(credit.body.data.current_balance, -300);
  } finally { await h.close(); }
});

test('color: gültiger HEX wird gespeichert, ungültiger abgelehnt', async () => {
  cleanup();
  const h = createHarness();
  try {
    const ok = await h.call('POST', '/accounts', { name: 'Farbig', color: '#2563EB' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.color, '#2563EB');
    // Ungültige Farbe (kein #RRGGBB) → 400
    assert.equal((await h.call('POST', '/accounts', { name: 'X', color: 'blau' })).status, 400);
    // Farbe entfernen (leerer Wert → NULL)
    const cleared = await h.call('PUT', `/accounts/${ok.body.data.id}`, { color: '' });
    assert.equal(cleared.body.data.color, null);
  } finally { await h.close(); }
});

test('archived: PUT toggelt, include_archived steuert Sichtbarkeit, net_worth ignoriert archivierte', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Alt', starting_balance: 400 })).body.data;
    await h.call('PUT', `/accounts/${acc.id}`, { archived: true });

    const active = (await h.call('GET', '/accounts')).body.data;
    assert.equal(active.accounts.length, 0, 'archiviert ⇒ standardmäßig unsichtbar');
    assert.equal(active.net_worth, 0);

    const withArchived = (await h.call('GET', '/accounts?include_archived=1')).body.data;
    assert.equal(withArchived.accounts.length, 1);
    assert.equal(withArchived.accounts[0].archived, 1);

    // Wiederherstellen
    await h.call('PUT', `/accounts/${acc.id}`, { archived: false });
    const restored = (await h.call('GET', '/accounts')).body.data;
    assert.equal(restored.accounts.length, 1);
    assert.equal(restored.net_worth, 400);
  } finally { await h.close(); }
});
