/**
 * Test: Budget-Eintrags-Routen (Härtung)
 * Zweck: End-to-End über den echten Budget-Router (server/routes/budget.js →
 *        routes/budget/entries.js) - die untertestete Eintrags-Schicht. Die
 *        Basis-CRUD deckt test-notes-contacts-budget.js ab, Scope/Sichtbarkeit
 *        test-budget-routes-scope.js; hier gezielt die offenen Blöcke:
 *          - GET /summary (Monatsaggregation + byCategory, 400)
 *          - GET /export (CSV, BOM, Formel-Injection-Schutz, resolveExportRange)
 *          - GET / (month-400, category-/account_id-Filter, loan_id-Drilldown)
 *          - POST / (subcategory-400, account-not-found-400, virtuelles Budget)
 *          - PUT /:id (404, subcategory-400, Konto setzen/entfernen, virtuelles
 *            Budget, Loan-Payment-Kopplung: income-Zwang + Rest-Grenze + Sync)
 *          - DELETE /:id (404, Loan-Payment-Cascade + refreshLoanStatus,
 *            Skip-Markierung bei Instanz-Löschung)
 *          - PUT /:id/series (404, not-recurring-400, Parent-Update, Sichtbarkeits-
 *            Propagation auf ALLE Instanzen, Löschung künftiger Instanzen, 403)
 *          - DELETE /:id/series (404, not-recurring-400, Parent + Instanzen weg, 403)
 *
 *        Systemuhr: PUT /:id/series löscht Instanzen ab dem AKTUELLEN Monat
 *        (new Date()). Statt die Uhr zu fixieren werden Extremdaten genutzt:
 *        2000-01 (immer < heute → bleibt) und 2099-12 (immer >= heute → weg).
 *        Die sicherheitskritische Sichtbarkeits-Propagation ist datumsunabhängig
 *        und wird separat geprüft.
 * Ausführen: node --experimental-sqlite --test test/test-budget-entries-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');
const db = dbmod.get();

const A = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','A','x','member')").run().lastInsertRowid;
const B = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('b','B','x','member')").run().lastInsertRowid;
const ADMIN = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run().lastInsertRowid;

function setMode(mode) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('budget_mode', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(mode);
}
setMode('shared'); // Default für die meisten Tests; 403-Tests schalten lokal auf personal.

let actor = { id: A, role: 'member' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = actor.id; req.authRole = actor.role; req.session = { userId: actor.id }; next(); });
app.use('/', budgetRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());
// Modus deterministisch auf den shared-Default zurücksetzen, damit ein Fehlschlag in
// einem personal-Modus-Test den budget_mode nicht in Folgetests leakt.
test.afterEach(() => setMode('shared'));

async function call(method, route, { as = { id: A, role: 'member' }, body } = {}) {
  actor = as;
  const headers = {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  // arrayBuffer statt text(): res.text() strippt ein führendes BOM (U+FEFF) beim
  // WHATWG-Decode; für den CSV-BOM-Check muss der rohe Body erhalten bleiben.
  const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
  let json = null;
  if (ct.includes('application/json')) { try { json = JSON.parse(text); } catch { /* leer */ } }
  return { status: res.status, body: json, text, contentType: ct, disposition: res.headers.get('content-disposition') || '' };
}

// Direkter Eintrags-Insert (umgeht die POST-Validierung für Fixtures).
function insertEntry(fields) {
  const f = {
    title: 'x', amount: -10, category: 'food', subcategory: '', date: '2030-01-10',
    is_recurring: 0, recurrence_rule: null, recurrence_interval: 'monthly',
    recurrence_virtual: 0, recurrence_full_amount: null, recurrence_parent_id: null,
    account_id: null, created_by: A, owner_id: A, visibility: 'shared', ...fields,
  };
  return db.prepare(`
    INSERT INTO budget_entries
      (title, amount, category, subcategory, date, is_recurring, recurrence_rule,
       recurrence_interval, recurrence_virtual, recurrence_full_amount, recurrence_parent_id,
       account_id, created_by, owner_id, visibility)
    VALUES (@title,@amount,@category,@subcategory,@date,@is_recurring,@recurrence_rule,
       @recurrence_interval,@recurrence_virtual,@recurrence_full_amount,@recurrence_parent_id,
       @account_id,@created_by,@owner_id,@visibility)
  `).run(f).lastInsertRowid;
}

// ── GET /summary ────────────────────────────────────────────────────────────────
test('GET /summary: ungültiger Monat → 400', async () => {
  const r = await call('GET', '/summary?month=2030-13-01');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /YYYY-MM/);
});

test('GET /summary: aggregiert income/expenses/balance + byCategory', async () => {
  insertEntry({ title: 'salary', amount: 100, category: 'food', date: '2030-03-05' });
  insertEntry({ title: 'lunch', amount: -30, category: 'food', date: '2030-03-06' });
  insertEntry({ title: 'gas', amount: -20, category: 'transport', date: '2030-03-07' });
  const r = await call('GET', '/summary?month=2030-03');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.income, 100);
  assert.equal(r.body.data.expenses, -50);
  assert.equal(r.body.data.balance, 50);
  // byCategory nach |Summe| absteigend: food (net 70) vor transport (net -20).
  assert.deepEqual(r.body.data.byCategory.map((c) => c.category), ['food', 'transport']);
  const food = r.body.data.byCategory.find((c) => c.category === 'food');
  assert.equal(food.income, 100);
  assert.equal(food.expenses, -30);
  assert.equal(food.total, 70);
});

// ── GET /export ─────────────────────────────────────────────────────────────────
test('GET /export: CSV mit BOM, Header und Zeilen (month-Range)', async () => {
  insertEntry({ title: 'Kaffee', amount: -4.5, category: 'food', date: '2031-02-10' });
  const r = await call('GET', '/export?month=2031-02');
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/csv/);
  assert.match(r.disposition, /budget-2031-02\.csv/);
  assert.equal(r.text.charCodeAt(0), 0xFEFF, 'BOM (U+FEFF) vorangestellt');
  assert.match(r.text, /Date,Title,Amount,Category,Subcategory,Recurring,Created by/);
  assert.match(r.text, /"Kaffee"/);
  // Punkt-Dezimal ohne Tausendertrennung (#521): in einem komma-getrennten CSV
  // wäre ein Komma-Dezimaltrenner ein zweites Feldtrennzeichen und würde die
  // Betragsspalte zerreißen. Die Datenzeile muss exakt 7 Felder behalten.
  assert.match(r.text, /-4\.50/, 'Betrag mit Dezimalpunkt');
  const dataLine = r.text.replace(/^﻿/, '').trim().split('\n')[1];
  assert.equal(dataLine.split(',').length, 7, 'Betrag erzeugt kein zusätzliches CSV-Feld');
});

test('GET /export: schützt vor CSV-Formel-Injection (führendes =)', async () => {
  insertEntry({ title: '=SUM(A1:A9)', amount: -1, category: 'food', date: '2031-03-10' });
  const r = await call('GET', '/export?from=2031-03-01&to=2031-03-31');
  assert.equal(r.status, 200);
  assert.match(r.disposition, /budget-2031-03-01_2031-03-31\.csv/, 'from/to-Range im Dateinamen');
  assert.match(r.text, /"'=SUM\(A1:A9\)"/, 'gefährlicher Titel wird mit \' entschärft');
});

// ── GET / (Liste): Filter + Drilldown ────────────────────────────────────────────
test('GET /: ungültiger Monat ohne loan_id → 400', async () => {
  const r = await call('GET', '/?month=nope');
  assert.equal(r.status, 400);
});

test('GET /: category-Filter grenzt die Liste ein', async () => {
  insertEntry({ title: 'food-a', amount: -5, category: 'food', date: '2032-04-10' });
  insertEntry({ title: 'trans-a', amount: -5, category: 'transport', date: '2032-04-11' });
  const r = await call('GET', '/?month=2032-04&category=transport');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((e) => e.title), ['trans-a']);
});

test('GET /: account_id-Filter grenzt auf ein Konto ein', async () => {
  const acc = db.prepare("INSERT INTO budget_accounts (name, created_by) VALUES ('Giro', ?)").run(A).lastInsertRowid;
  insertEntry({ title: 'with-acc', amount: -7, category: 'food', date: '2032-05-10', account_id: acc });
  insertEntry({ title: 'no-acc', amount: -7, category: 'food', date: '2032-05-11' });
  const r = await call('GET', `/?month=2032-05&account_id=${acc}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((e) => e.title), ['with-acc']);
});

test('GET /?loan_id=: Drilldown listet die verknüpften Zahlungs-Einträge', async () => {
  const loan = db.prepare(`INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by)
                           VALUES ('Auto','Bob',1000,10,'2032-01',?)`).run(A).lastInsertRowid;
  const eid = insertEntry({ title: 'rate-1', amount: 100, category: 'Sonstiges Einkommen', date: '2032-06-01' });
  db.prepare(`INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
              VALUES (?,1,100,'2032-06-01',?,?)`).run(loan, eid, A);
  const r = await call('GET', `/?loan_id=${loan}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.some((e) => e.id === eid && e.loan_id === loan), 'verknüpfter Eintrag erscheint');
});

// ── POST / ───────────────────────────────────────────────────────────────────────
test('POST /: ungültige Subkategorie → 400', async () => {
  const r = await call('POST', '/', { body: { title: 'x', amount: -5, category: 'food', subcategory: 'does-not-exist', date: '2033-01-10' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /subcategory/i);
});

test('POST /: unbekanntes Konto → 400', async () => {
  const r = await call('POST', '/', { body: { title: 'x', amount: -5, category: 'food', date: '2033-01-11', account_id: 999999 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Konto/);
});

test('POST /: virtuelles Budget glättet den Jahresbetrag auf den Monatsanteil', async () => {
  const r = await call('POST', '/', {
    body: { title: 'Versicherung', amount: -1200, category: 'financial_other', date: '2033-02-01',
            is_recurring: true, recurrence_virtual: true, recurrence_interval: 'yearly' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.amount, -100, 'amount = -1200 / 12 Monate');
  assert.equal(r.body.data.recurrence_full_amount, -1200, 'voller Periodenbetrag bleibt erhalten');
  assert.equal(r.body.data.recurrence_virtual, 1);
});

// ── PUT /:id ───────────────────────────────────────────────────────────────────
test('PUT /:id: unbekannte id → 404', async () => {
  const r = await call('PUT', '/999999', { body: { title: 'x' } });
  assert.equal(r.status, 404);
});

test('PUT /:id: ungültige Subkategorie → 400', async () => {
  const id = insertEntry({ title: 'edit-me', amount: -5, category: 'food', date: '2033-03-10' });
  const r = await call('PUT', `/${id}`, { body: { category: 'food', subcategory: 'bogus' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /subcategory/i);
});

test('PUT /:id: Konto setzen und wieder entfernen', async () => {
  const acc = db.prepare("INSERT INTO budget_accounts (name, created_by) VALUES ('Spar', ?)").run(A).lastInsertRowid;
  const id = insertEntry({ title: 'acc-toggle', amount: -5, category: 'food', date: '2033-04-10' });
  const set = await call('PUT', `/${id}`, { body: { account_id: acc } });
  assert.equal(set.status, 200);
  assert.equal(set.body.data.account_id, acc);
  const clear = await call('PUT', `/${id}`, { body: { account_id: null } });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.data.account_id, null, 'null entfernt die Zuordnung');
});

test('PUT /:id: virtuelles Budget rechnet den Halbjahresbetrag neu', async () => {
  const id = insertEntry({ title: 'v-edit', amount: -50, category: 'financial_other', date: '2033-05-10' });
  const r = await call('PUT', `/${id}`, { body: { is_recurring: true, recurrence_virtual: true, recurrence_interval: 'half_year', amount: -600 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.amount, -100, 'amount = -600 / 6 Monate');
  assert.equal(r.body.data.recurrence_full_amount, -600);
});

test('PUT /:id: ungültiger Betrag → 400', async () => {
  const id = insertEntry({ title: 'amt', amount: -5, category: 'food', date: '2033-05-20' });
  const r = await call('PUT', `/${id}`, { body: { amount: 'viel' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Betrag/);
});

test('PUT /:id: unbekanntes Konto → 400', async () => {
  const id = insertEntry({ title: 'acc-bad', amount: -5, category: 'food', date: '2033-05-21' });
  const r = await call('PUT', `/${id}`, { body: { account_id: 888888 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Konto/);
});

test('PUT /:id: Sichtbarkeit umschalten (owner_id bleibt fix)', async () => {
  const id = insertEntry({ title: 'vis', amount: -5, category: 'food', date: '2033-05-22', owner_id: A, visibility: 'shared' });
  const r = await call('PUT', `/${id}`, { body: { visibility: 'private' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.visibility, 'private');
  assert.equal(r.body.data.owner_id, A, 'owner_id unverändert');
});

// ── PUT /:id: Loan-Payment-Kopplung ──────────────────────────────────────────────
test('PUT /:id: verknüpfte Rückzahlung muss Einkommen bleiben (Betrag ≤ 0 → 400)', async () => {
  const loan = db.prepare(`INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by)
                           VALUES ('L1','Bo',1000,10,'2033-01',?)`).run(A).lastInsertRowid;
  const eid = insertEntry({ title: 'pay', amount: 100, category: 'Sonstiges Einkommen', date: '2033-06-01' });
  db.prepare(`INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
              VALUES (?,1,100,'2033-06-01',?,?)`).run(loan, eid, A);
  const r = await call('PUT', `/${eid}`, { body: { amount: -50 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /income/i);
});

test('PUT /:id: Rückzahlung über dem Restbetrag → 400', async () => {
  const loan = db.prepare(`INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by)
                           VALUES ('L2','Bo',1000,10,'2033-01',?)`).run(A).lastInsertRowid;
  const eid = insertEntry({ title: 'pay2', amount: 100, category: 'Sonstiges Einkommen', date: '2033-07-01' });
  db.prepare(`INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
              VALUES (?,1,100,'2033-07-01',?,?)`).run(loan, eid, A);
  const r = await call('PUT', `/${eid}`, { body: { amount: 5000 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /remaining loan/i);
});

test('PUT /:id: gültige Rückzahlung aktualisiert Eintrag + Payment synchron', async () => {
  const loan = db.prepare(`INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by)
                           VALUES ('L3','Bo',1000,10,'2033-01',?)`).run(A).lastInsertRowid;
  const eid = insertEntry({ title: 'pay3', amount: 100, category: 'Sonstiges Einkommen', date: '2033-08-01' });
  const pid = db.prepare(`INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
              VALUES (?,1,100,'2033-08-01',?,?)`).run(loan, eid, A).lastInsertRowid;
  const r = await call('PUT', `/${eid}`, { body: { amount: 500 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.amount, 500, 'Eintragsbetrag aktualisiert');
  const pay = db.prepare('SELECT amount FROM budget_loan_payments WHERE id = ?').get(pid);
  assert.equal(pay.amount, 500, 'Payment folgt dem Eintragsbetrag');
});

test('PUT /:id: Fremdwährungs-Darlehen (#582) rechnet den Eintragsbetrag zurück', async () => {
  // Darlehen in USD, 1 USD = 0,50 EUR. Der Budget-Eintrag steht in EUR, die
  // gekoppelte Rate in USD - ein Edit des Eintrags darf die Restschuld nicht
  // verdoppeln, sondern muss über den Kurs zurückrechnen.
  const loan = db.prepare(`INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by, currency, exchange_rate)
                           VALUES ('L-USD','Bo',1000,10,'2033-01',?,'USD',0.5)`).run(A).lastInsertRowid;
  const eid = insertEntry({ title: 'pay-usd', amount: 50, category: 'Sonstiges Einkommen', date: '2033-09-01' });
  const pid = db.prepare(`INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
              VALUES (?,1,100,'2033-09-01',?,?)`).run(loan, eid, A).lastInsertRowid;

  const r = await call('PUT', `/${eid}`, { body: { amount: 100 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.amount, 100, 'Eintrag bleibt in Budget-Währung');
  const pay = db.prepare('SELECT amount FROM budget_loan_payments WHERE id = ?').get(pid);
  assert.equal(pay.amount, 200, '100 EUR / 0,50 = 200 USD Rate');
});

test('PUT /:id: Rest-Grenze eines Fremdwährungs-Darlehens gilt in Darlehenswährung', async () => {
  // Restschuld 1000 USD. 400 EUR entsprechen bei 0,50 genau 800 USD (erlaubt),
  // 600 EUR wären 1200 USD und müssen abgewiesen werden.
  const loan = db.prepare(`INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by, currency, exchange_rate)
                           VALUES ('L-USD2','Bo',1000,10,'2033-01',?,'USD',0.5)`).run(A).lastInsertRowid;
  const eid = insertEntry({ title: 'pay-usd2', amount: 50, category: 'Sonstiges Einkommen', date: '2033-10-01' });
  db.prepare(`INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
              VALUES (?,1,100,'2033-10-01',?,?)`).run(loan, eid, A);

  assert.equal((await call('PUT', `/${eid}`, { body: { amount: 400 } })).status, 200);
  const tooMuch = await call('PUT', `/${eid}`, { body: { amount: 600 } });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.body.error, /remaining loan/i);
});

// ── DELETE /:id ──────────────────────────────────────────────────────────────────
test('DELETE /:id: unbekannte id → 404', async () => {
  const r = await call('DELETE', '/999999');
  assert.equal(r.status, 404);
});

test('DELETE /:id: entfernt verknüpfte Rückzahlung mit (Cascade)', async () => {
  const loan = db.prepare(`INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by)
                           VALUES ('L4','Bo',1000,10,'2034-01',?)`).run(A).lastInsertRowid;
  const eid = insertEntry({ title: 'pay4', amount: 100, category: 'Sonstiges Einkommen', date: '2034-02-01' });
  const pid = db.prepare(`INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
              VALUES (?,1,100,'2034-02-01',?,?)`).run(loan, eid, A).lastInsertRowid;
  const r = await call('DELETE', `/${eid}`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT 1 FROM budget_entries WHERE id = ?').get(eid), undefined, 'Eintrag weg');
  assert.equal(db.prepare('SELECT 1 FROM budget_loan_payments WHERE id = ?').get(pid), undefined, 'Payment mit-gelöscht');
});

test('DELETE /:id: gelöschte Serien-Instanz markiert den Monat als übersprungen', async () => {
  const parent = insertEntry({ title: 'series', amount: -20, category: 'food', date: '2034-03-01', is_recurring: 1 });
  const inst = insertEntry({ title: 'series', amount: -20, category: 'food', date: '2034-05-15', recurrence_parent_id: parent });
  const r = await call('DELETE', `/${inst}`);
  assert.equal(r.status, 204);
  const skip = db.prepare('SELECT 1 FROM budget_recurrence_skipped WHERE parent_id = ? AND month = ?').get(parent, '2034-05');
  assert.ok(skip, 'Skip-Markierung gesetzt, damit die Instanz nicht neu materialisiert wird');
});

// ── PUT /:id/series ──────────────────────────────────────────────────────────────
test('PUT /:id/series: unbekannte id → 404', async () => {
  const r = await call('PUT', '/999999/series', { body: { title: 'x' } });
  assert.equal(r.status, 404);
});

test('PUT /:id/series: Nicht-Serie → 400', async () => {
  const id = insertEntry({ title: 'plain', amount: -5, category: 'food', date: '2035-01-10', is_recurring: 0 });
  const r = await call('PUT', `/${id}/series`, { body: { amount: -9 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /recurring/i);
});

test('PUT /:id/series: ungültiger Betrag → 400', async () => {
  const parent = insertEntry({ title: 's-amt', amount: -5, category: 'food', date: '2035-01-20', is_recurring: 1 });
  const r = await call('PUT', `/${parent}/series`, { body: { amount: 'nope' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Betrag/);
});

test('PUT /:id/series: virtuelles Budget glättet den Serien-Jahresbetrag', async () => {
  const parent = insertEntry({ title: 's-virt', amount: -50, category: 'financial_other', date: '2035-01-25', is_recurring: 1 });
  const r = await call('PUT', `/${parent}/series`, { body: { recurrence_virtual: true, recurrence_interval: 'yearly', amount: -1200 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.amount, -100, 'geglätteter Monatsanteil -1200/12');
  assert.equal(r.body.data.recurrence_full_amount, -1200);
  assert.equal(r.body.data.recurrence_interval, 'yearly');
});

test('PUT /:id/series: aktualisiert das Original und propagiert Sichtbarkeit auf alle Instanzen', async () => {
  const parent = insertEntry({ title: 'orig', amount: -20, category: 'food', date: '2035-02-01', is_recurring: 1, visibility: 'shared' });
  const past = insertEntry({ title: 'orig', amount: -20, category: 'food', date: '2000-01-15', recurrence_parent_id: parent, visibility: 'shared' });
  const future = insertEntry({ title: 'orig', amount: -20, category: 'food', date: '2099-12-15', recurrence_parent_id: parent, visibility: 'shared' });
  setMode('personal'); // Sichtbarkeit greift nur im personal-Modus, Propagation ist aber datumsunabhängig
  const r = await call('PUT', `/${parent}/series`, { as: { id: A, role: 'member' }, body: { title: 'neu', visibility: 'private' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.title, 'neu', 'Original-Titel aktualisiert');
  // Sichtbarkeit trifft ALLE Instanzen (privat→geteilt-Leak-Schutz), unabhängig vom Datum.
  assert.equal(db.prepare('SELECT visibility FROM budget_entries WHERE id = ?').get(past).visibility, 'private', 'Vergangenheits-Instanz geerbt');
  // Künftige Instanz (>= aktueller Monat) wird gelöscht; die Vergangenheits-Instanz bleibt.
  assert.equal(db.prepare('SELECT 1 FROM budget_entries WHERE id = ?').get(future), undefined, '2099er-Instanz gelöscht (>= heute)');
  assert.ok(db.prepare('SELECT 1 FROM budget_entries WHERE id = ?').get(past), '2000er-Instanz bleibt (< heute)');
});

test('PUT /:id/series: fremder Nutzer im personal-Modus → 403 (kein Bypass)', async () => {
  const parent = insertEntry({ title: 'a-series', amount: -20, category: 'food', date: '2035-03-01', is_recurring: 1, owner_id: A, visibility: 'shared' });
  setMode('personal');
  const asMember = await call('PUT', `/${parent}/series`, { as: { id: B, role: 'member' }, body: { title: 'hijack' } });
  const asAdmin = await call('PUT', `/${parent}/series`, { as: { id: ADMIN, role: 'admin' }, body: { title: 'hijack' } });
  assert.equal(asMember.status, 403, 'B darf A-Serie nicht ändern');
  assert.equal(asAdmin.status, 403, 'Admin ist kein Owner → auch 403');
  assert.equal(db.prepare('SELECT title FROM budget_entries WHERE id = ?').get(parent).title, 'a-series', 'unverändert');
});

// ── DELETE /:id/series ───────────────────────────────────────────────────────────
test('DELETE /:id/series: unbekannte id → 404', async () => {
  const r = await call('DELETE', '/999999/series');
  assert.equal(r.status, 404);
});

test('DELETE /:id/series: Nicht-Serie → 400', async () => {
  const id = insertEntry({ title: 'plain2', amount: -5, category: 'food', date: '2036-01-10', is_recurring: 0 });
  const r = await call('DELETE', `/${id}/series`);
  assert.equal(r.status, 400);
});

test('DELETE /:id/series: löscht Original und alle Instanzen', async () => {
  const parent = insertEntry({ title: 'kill', amount: -20, category: 'food', date: '2036-02-01', is_recurring: 1 });
  const i1 = insertEntry({ title: 'kill', amount: -20, category: 'food', date: '2036-03-15', recurrence_parent_id: parent });
  const i2 = insertEntry({ title: 'kill', amount: -20, category: 'food', date: '2036-04-15', recurrence_parent_id: parent });
  const r = await call('DELETE', `/${parent}/series`);
  assert.equal(r.status, 204);
  for (const id of [parent, i1, i2]) {
    assert.equal(db.prepare('SELECT 1 FROM budget_entries WHERE id = ?').get(id), undefined, `Eintrag ${id} weg`);
  }
});

test('DELETE /:id/series: fremder Nutzer im personal-Modus → 403 (kein Bypass)', async () => {
  const parent = insertEntry({ title: 'a-keep', amount: -20, category: 'food', date: '2036-05-01', is_recurring: 1, owner_id: A, visibility: 'shared' });
  setMode('personal');
  const asAdmin = await call('DELETE', `/${parent}/series`, { as: { id: ADMIN, role: 'admin' } });
  assert.equal(asAdmin.status, 403);
  assert.ok(db.prepare('SELECT 1 FROM budget_entries WHERE id = ?').get(parent), 'Serie unangetastet');
});
