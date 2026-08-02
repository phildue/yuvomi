/**
 * Tests: MCP-Server (server/mcp/*)
 * Fokus: JSON-RPC-Dispatch (initialize / tools/list / tools/call), Kern-Tool-Logik
 *        (Anlegen + Lesen), Validierung und Fehlerpfade sowie die generische
 *        OpenAPI-Brücke (list/get/call_api_operation) inklusive Loopback-Verhalten
 *        (Operation-Auflösung, Path-Params, Query, Auth-Weiterleitung, Payload,
 *        Fehlerpropagation) über einen gemockten `fetch`.
 * Ausführen: node --experimental-sqlite --test test/test-mcp.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { handleMcpRequest, LATEST_PROTOCOL_VERSION } from '../server/mcp/protocol.js';
import { callTool, TOOL_DEFINITIONS } from '../server/mcp/tools.js';

// Deterministische Loopback-Basis für die OpenAPI-Brücke (fetch wird gemockt).
process.env.MCP_INTERNAL_BASE_URL = 'http://mcp.test';

// ── Test-DB aufsetzen ────────────────────────────────────────────────────────
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[1]);

const uid = db.prepare(
  `INSERT INTO users (username, display_name, password_hash, avatar_color, role)
   VALUES ('admin', 'Anna', 'x', '#007AFF', 'admin')`
).run().lastInsertRowid;

const listId = db.prepare(
  `INSERT INTO shopping_lists (name, created_by) VALUES ('Wocheneinkauf', ?)`
).run(uid).lastInsertRowid;

const in3days = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

const actor = { id: uid, role: 'admin' };

// Hilfsfunktion: JSON-RPC-Request absetzen und Antwort zurückgeben.
let internalErrors = [];
function rpc(method, params, id = 1) {
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (id !== null) body.id = id;
  return handleMcpRequest(db, actor, body, (err) => internalErrors.push(err));
}
function toolCall(name, args) {
  return rpc('tools/call', { name, arguments: args });
}
function toolCallWithHeaders(name, args, requestHeaders) {
  return handleMcpRequest(
    db, actor,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    (err) => internalErrors.push(err),
    { requestHeaders },
  );
}
function parseContent(res) {
  return JSON.parse(res.result.content[0].text);
}

// ── fetch-Mock für die OpenAPI-Brücke ────────────────────────────────────────
const realFetch = global.fetch;
function installFetchMock(handler) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  return calls;
}
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok, status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
  };
}
function binaryResponse(bytes, { contentLength, contentType = 'application/octet-stream', ok = true, status = 200 } = {}) {
  const buf = Buffer.from(bytes);
  const map = { 'content-type': contentType };
  if (contentLength !== undefined) map['content-length'] = String(contentLength);
  return {
    ok, status,
    headers: { get: (h) => (map[String(h).toLowerCase()] ?? null) },
    json: async () => null,
    text: async () => buf.toString(),
    // Kein body.getReader → readCappedBinary nutzt den arrayBuffer-Fallback.
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

function emptyResponse({ ok = true, status = 204 } = {}) {
  return {
    ok, status,
    headers: { get: () => null },
    json: async () => null,
    text: async () => '',
    arrayBuffer: async () => Buffer.alloc(0),
  };
}

// ── initialize ───────────────────────────────────────────────────────────────

test('initialize: liefert serverInfo, Capabilities und Protokollversion', async () => {
  const res = await rpc('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION });
  assert.equal(res.result.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.equal(res.result.serverInfo.name, 'yuvomi');
  assert.ok(res.result.serverInfo.version, 'Version muss gesetzt sein');
  assert.ok(res.result.capabilities.tools, 'tools-Capability muss vorhanden sein');
});

test('initialize: unbekannte Protokollversion fällt auf die neueste zurück', async () => {
  const res = await rpc('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(res.result.protocolVersion, LATEST_PROTOCOL_VERSION);
});

// ── tools/list ───────────────────────────────────────────────────────────────

test('tools/list: listet Kern-Tools, Budget/Meals-Tools und OpenAPI-Brücken-Tools', async () => {
  const res = await rpc('tools/list');
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'add_shopping_item', 'call_api_operation', 'create_event', 'create_expense',
    'create_meal', 'create_task', 'delete_expense', 'delete_meal',
    'get_api_operation', 'get_budget_summary', 'list_api_operations',
    'list_budget_categories', 'list_expenses', 'list_meals',
    'list_shopping_items', 'list_tasks', 'list_upcoming_events',
    'update_expense', 'update_meal',
  ]);
  assert.equal(res.result.tools.length, TOOL_DEFINITIONS.length);
  for (const t of res.result.tools) {
    assert.equal(t.inputSchema.type, 'object', `${t.name} braucht ein object-Schema`);
    // Issue #599: Properties ohne `type` werden von manchen Clients zu Strings
    // koerziert — jede Property muss ihren Typ deklarieren.
    for (const [prop, schema] of Object.entries(t.inputSchema.properties || {})) {
      assert.ok(schema.type, `${t.name}.${prop} braucht ein deklariertes type`);
    }
  }
});

test('Scope-Durchsetzung: budget:read darf list_expenses, aber nicht create_expense', async () => {
  installFetchMock(() => jsonResponse({ data: [] }));
  try {
    const scopedActor = { id: uid, role: 'admin', scopes: ['budget:read'] };
    const listRes = await handleMcpRequest(
      db, scopedActor,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_expenses', arguments: {} } },
      (err) => internalErrors.push(err),
      { requestHeaders: { authorization: 'Bearer test-token' } },
    );
    assert.equal(listRes.result.isError, false, listRes.result.content?.[0]?.text);

    const createRes = await handleMcpRequest(
      db, scopedActor,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_expense', arguments: { title: 'X', amount: 10, date: '2026-07-01' } } },
      (err) => internalErrors.push(err),
      { requestHeaders: { authorization: 'Bearer test-token' } },
    );
    assert.equal(createRes.result.isError, true);
    assert.match(createRes.result.content[0].text, /not permitted by this token's scopes/i);
  } finally {
    global.fetch = realFetch;
  }
});

test('Scope-Durchsetzung: meals:write darf list_meals und create_meal', async () => {
  installFetchMock(() => jsonResponse({ data: { id: 1 } }, { status: 201 }));
  try {
    const scopedActor = { id: uid, role: 'admin', scopes: ['meals:write'] };
    const listRes = await handleMcpRequest(
      db, scopedActor,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_meals', arguments: {} } },
      (err) => internalErrors.push(err),
      { requestHeaders: { authorization: 'Bearer test-token' } },
    );
    assert.equal(listRes.result.isError, false, listRes.result.content?.[0]?.text);

    const createRes = await handleMcpRequest(
      db, scopedActor,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_meal', arguments: { date: '2026-07-28', meal_type: 'dinner', title: 'Pasta' } } },
      (err) => internalErrors.push(err),
      { requestHeaders: { authorization: 'Bearer test-token' } },
    );
    assert.equal(createRes.result.isError, false, createRes.result.content?.[0]?.text);
  } finally {
    global.fetch = realFetch;
  }
});

test('Scope-Durchsetzung: budget:read darf keine Meals-Tools nutzen', async () => {
  const scopedActor = { id: uid, role: 'admin', scopes: ['budget:read'] };
  const res = await handleMcpRequest(
    db, scopedActor,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_meals', arguments: {} } },
    (err) => internalErrors.push(err),
  );
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /not permitted by this token's scopes/i);
});

// ── create_task ──────────────────────────────────────────────────────────────

test('tools/call create_task: legt Task an und gibt sie zurück', async () => {
  const res = await toolCall('create_task', { title: 'Müll rausbringen', priority: 'high', due_date: in3days });
  assert.equal(res.result.isError, false);
  const task = parseContent(res);
  assert.equal(task.title, 'Müll rausbringen');
  assert.equal(task.priority, 'high');
  assert.equal(task.status, 'open');

  const row = db.prepare('SELECT title, created_by, status FROM tasks WHERE id = ?').get(task.id);
  assert.equal(row.title, 'Müll rausbringen');
  assert.equal(row.created_by, uid, 'created_by muss der Actor sein');
});

test('tools/call create_task: ohne Kategorie fällt auf den Key misc, nicht auf Sonstiges', async () => {
  // 'Sonstiges' war der Anzeigename der Auffangkategorie vor v83, nie ein Key in
  // task_categories. Der alte Fallback ließ jede per MCP erzeugte Aufgabe aus
  // Dropdown und Filter fallen und sie beim ersten Speichern im Modal still auf
  // die erste echte Kategorie springen. Migration v114 hat den Bestand geputzt -
  // ohne diesen Guard liefert die Tool-Schicht ihn weiter nach.
  // priority explizit: die Test-DB hier steht auf dem v1-Schema, dessen
  // CHECK-Constraint den späteren Wert 'none' noch nicht kennt. Das ist eine
  // eigene Baustelle (server/db-schema-test.js endet bei v97) und soll diesen
  // Guard nicht mit einem fremden Fehlschlag verdecken.
  const res = await toolCall('create_task', { title: 'Ohne Kategorie', priority: 'low' });
  assert.equal(res.result.isError, false);
  const task = parseContent(res);
  assert.equal(task.category, 'misc');
});

test('tools/call create_task: fehlender Titel → isError mit Meldung', async () => {
  const res = await toolCall('create_task', {});
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /title/i);
});

test('tools/call create_task: ungültige Priorität → isError', async () => {
  const res = await toolCall('create_task', { title: 'X', priority: 'sofort' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /priority/i);
});

// ── list_tasks ───────────────────────────────────────────────────────────────

test('tools/call list_tasks: enthält den neu angelegten Task', async () => {
  const res = await toolCall('list_tasks', {});
  assert.equal(res.result.isError, false);
  const tasks = parseContent(res);
  assert.ok(tasks.some((t) => t.title === 'Müll rausbringen'), 'neuer Task muss gelistet sein');
});

test('tools/call create_task + list_tasks: Tags reisen mit (#586)', async () => {
  const created = await toolCall('create_task', {
    title: 'Rasen mähen', priority: 'low', tags: ['Garten', 'Sommer'],
  });
  assert.equal(created.result.isError, false);
  assert.deepEqual(parseContent(created).tags, ['Garten', 'Sommer']);

  const listed = parseContent(await toolCall('list_tasks', {}));
  const row = listed.find((t) => t.title === 'Rasen mähen');
  // Als Liste, nicht als verbundene Zeichenkette: ein Tag darf selbst ein Komma
  // enthalten ("Haus, Hof"), verbunden wäre er nicht mehr eindeutig trennbar.
  assert.deepEqual(row.tags, ['Garten', 'Sommer']);
});

test('tools/call list_tasks: der tag-Filter engt UND-verknüpft ein', async () => {
  await toolCall('create_task', { title: 'Nur Garten', priority: 'low', tags: ['Garten'] });

  const beide = parseContent(await toolCall('list_tasks', { tag: ['Garten', 'Sommer'] }));
  assert.deepEqual(beide.map((t) => t.title), ['Rasen mähen'],
    'Eine Aufgabe muss alle genannten Tags tragen');

  const einer = parseContent(await toolCall('list_tasks', { tag: ['garten'] }));
  assert.equal(einer.length, 2, 'Die Schreibweise zählt beim Filtern nicht');
});

test('tools/call list_tasks: private Aufgaben anderer bleiben verborgen (#474)', async () => {
  // Diese Prüfung fehlte, obwohl die Termin-Abfrage sie führt und docs/SPEC.md
  // sie für MCP zusagt: ein Token sah jede private Aufgabe des Haushalts. Mit
  // den Tags käme deren Freitext gleich mit.
  const other = db.prepare(
    `INSERT INTO users (username, display_name, password_hash, avatar_color, role)
     VALUES ('bob', 'Bob', 'x', '#FF0000', 'member')`
  ).run().lastInsertRowid;
  db.prepare(
    `INSERT INTO tasks (title, created_by, status, visibility) VALUES (?, ?, 'open', 'private')`
  ).run('Geschenk für Anna', other);

  const seenByAnna = await callTool({ db, actor }, 'list_tasks', {});
  assert.equal(seenByAnna.some((t) => t.title === 'Geschenk für Anna'), false);
  // Gegenprobe: die Ersteller:in sieht sie sehr wohl.
  const seenByBob = await callTool({ db, actor: { id: other, role: 'member' } }, 'list_tasks', {});
  assert.equal(seenByBob.some((t) => t.title === 'Geschenk für Anna'), true);
});

test('tools/call list_tasks: ein unsinniger tag-Filter wird abgewiesen', async () => {
  // Die gefährliche Richtung: callTool erzwingt das JSON-Schema zur Laufzeit
  // nicht, und normalizeTags macht aus einem Objekt stillschweigend eine leere
  // Liste. Ein einschränkender Filter lieferte damit die VOLLE Liste statt
  // eines Fehlers, und eine Automatisierung handelte an fremden Aufgaben.
  const res = await toolCall('list_tasks', { tag: { nope: 1 } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /tag/i);
});

// ── Shopping ─────────────────────────────────────────────────────────────────

test('tools/call add_shopping_item: fügt Artikel zur Standardliste hinzu', async () => {
  const res = await toolCall('add_shopping_item', { name: 'Milch', quantity: '2' });
  assert.equal(res.result.isError, false);
  const item = parseContent(res);
  assert.equal(item.name, 'Milch');
  assert.equal(item.quantity, '2');

  const row = db.prepare('SELECT name, list_id FROM shopping_items WHERE id = ?').get(item.id);
  assert.equal(row.list_id, listId, 'muss der ersten Liste zugeordnet sein');
});

test('tools/call add_shopping_item: unbekannte Liste → isError', async () => {
  const res = await toolCall('add_shopping_item', { name: 'Brot', list: 'Gibt-es-nicht' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Gibt-es-nicht/);
});

test('tools/call list_shopping_items: unerledigte Artikel enthalten Milch', async () => {
  const items = parseContent(await toolCall('list_shopping_items', {}));
  assert.ok(items.some((i) => i.name === 'Milch'));
});

// ── Kalender ─────────────────────────────────────────────────────────────────

test('tools/call create_event: legt Event an', async () => {
  const res = await toolCall('create_event', { title: 'Zahnarzt', start_datetime: `${in3days}T09:30` });
  assert.equal(res.result.isError, false);
  const ev = parseContent(res);
  assert.equal(ev.title, 'Zahnarzt');
  assert.equal(ev.start_datetime, `${in3days}T09:30`);

  const row = db.prepare('SELECT title, external_source, created_by FROM calendar_events WHERE id = ?').get(ev.id);
  assert.equal(row.external_source, 'local');
  assert.equal(row.created_by, uid);
});

test('tools/call create_event: fehlender Start → isError', async () => {
  const res = await toolCall('create_event', { title: 'Ohne Start' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /start_datetime/i);
});

test('tools/call list_upcoming_events: enthält das neue Event', async () => {
  const events = parseContent(await toolCall('list_upcoming_events', { limit: 10 }));
  assert.ok(events.some((e) => e.title === 'Zahnarzt'));
});

// ── Budget: list/create ──────────────────────────────────────────────────────

test('tools/call list_expenses: baut Query aus month/category/account_id', async () => {
  const calls = installFetchMock(() => jsonResponse({ data: [{ id: 1, title: 'Miete', amount: -800 }] }));
  try {
    const res = await toolCallWithHeaders(
      'list_expenses',
      { month: '2026-07', category: 'housing', account_id: 3 },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.deepEqual(parseContent(res), { data: [{ id: 1, title: 'Miete', amount: -800 }] });
    assert.equal(calls[0].url, 'http://mcp.test/api/v1/budget?month=2026-07&category=housing&account_id=3');
    assert.equal(calls[0].options.method, 'GET');
  } finally {
    global.fetch = realFetch;
  }
});

test('tools/call create_expense: sendet Betrag als negativ (money out)', async () => {
  const calls = installFetchMock(() => jsonResponse({ data: { id: 5, title: 'Miete', amount: -800 } }, { status: 201 }));
  try {
    const res = await toolCallWithHeaders(
      'create_expense',
      { title: 'Miete', amount: 800, date: '2026-07-01', category: 'housing' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].url, 'http://mcp.test/api/v1/budget');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.amount, -800, 'amount must be stored negative (money out)');
    assert.equal(body.title, 'Miete');
    assert.equal(body.date, '2026-07-01');
    assert.equal(body.category, 'housing');
  } finally {
    global.fetch = realFetch;
  }
});

test('tools/call create_expense: nicht-numerischer Betrag → isError (kein fetch)', async () => {
  const calls = installFetchMock(() => jsonResponse({}));
  try {
    const res = await toolCallWithHeaders(
      'create_expense',
      { title: 'Miete', amount: 'viel', date: '2026-07-01' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /amount must be a valid number/i);
    assert.equal(calls.length, 0, 'bei Validierungsfehler darf kein Request abgehen');
  } finally {
    global.fetch = realFetch;
  }
});

test('tools/call create_expense: Upstream-Fehler wird als isError durchgereicht', async () => {
  installFetchMock(() => jsonResponse({ error: 'Kategorie must be one of: housing, food.' }, { ok: false, status: 400 }));
  try {
    const res = await toolCallWithHeaders(
      'create_expense',
      { title: 'X', amount: 10, date: '2026-07-01', category: 'not_a_category' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Kategorie must be one of/);
  } finally {
    global.fetch = realFetch;
  }
});

test('tools/call update_expense: sendet nur gesetzte Felder, Betrag negativ', async () => {
  const calls = installFetchMock(() => jsonResponse({ data: { id: 5, title: 'Miete neu', amount: -850 } }));
  try {
    const res = await toolCallWithHeaders(
      'update_expense',
      { id: 5, amount: 850 },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].options.method, 'PUT');
    assert.equal(calls[0].url, 'http://mcp.test/api/v1/budget/5');
    assert.deepEqual(JSON.parse(calls[0].options.body), { amount: -850 });
  } finally {
    global.fetch = realFetch;
  }
});

test('tools/call update_expense: nicht-numerischer Betrag → isError (kein fetch)', async () => {
  const calls = installFetchMock(() => jsonResponse({}));
  try {
    const res = await toolCallWithHeaders(
      'update_expense',
      { id: 5, amount: 'viel' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /amount must be a valid number/i);
    assert.equal(calls.length, 0);
  } finally {
    global.fetch = realFetch;
  }
});

test('tools/call delete_expense: DELETE auf /budget/:id, leere Antwort ist kein Fehler', async () => {
  const calls = installFetchMock(() => emptyResponse());
  try {
    const res = await toolCallWithHeaders('delete_expense', { id: 5 }, { authorization: 'Bearer test-token' });
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].url, 'http://mcp.test/api/v1/budget/5');
    assert.equal(calls[0].options.method, 'DELETE');
  } finally {
    global.fetch = realFetch;
  }
});

test('tools/call delete_expense: Upstream-Fehler wird durchgereicht', async () => {
  installFetchMock(() => jsonResponse({ error: 'Entry not found', code: 404 }, { ok: false, status: 404 }));
  try {
    const res = await toolCallWithHeaders('delete_expense', { id: 999 }, { authorization: 'Bearer test-token' });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Entry not found/);
  } finally {
    global.fetch = realFetch;
  }
});

test('tools/call list_budget_categories: ohne type liefert alle Kategorien', async () => {
  const calls = installFetchMock(() => jsonResponse({
    data: [
      { key: 'housing', type: 'expense', subcategories: [] },
      { key: 'Erwerbseinkommen', type: 'income', subcategories: [] },
    ],
    lang: 'en',
  }));
  try {
    const res = await toolCallWithHeaders('list_budget_categories', {}, { authorization: 'Bearer test-token' });
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].url, 'http://mcp.test/api/v1/budget/categories');
    assert.equal(parseContent(res).data.length, 2);
  } finally {
    global.fetch = realFetch;
  }
});

test('tools/call list_budget_categories: type=expense filtert client-seitig', async () => {
  installFetchMock(() => jsonResponse({
    data: [
      { key: 'housing', type: 'expense', subcategories: [] },
      { key: 'Erwerbseinkommen', type: 'income', subcategories: [] },
    ],
    lang: 'en',
  }));
  try {
    const res = await toolCallWithHeaders('list_budget_categories', { type: 'expense' }, { authorization: 'Bearer test-token' });
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.deepEqual(parseContent(res).data.map((c) => c.key), ['housing']);
  } finally {
    global.fetch = realFetch;
  }
});

test('tools/call get_budget_summary: leitet month als Query weiter', async () => {
  const calls = installFetchMock(() => jsonResponse({ data: { month: '2026-07', income: 2000, expenses: -800, balance: 1200, byCategory: [] } }));
  try {
    const res = await toolCallWithHeaders('get_budget_summary', { month: '2026-07' }, { authorization: 'Bearer test-token' });
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].url, 'http://mcp.test/api/v1/budget/summary?month=2026-07');
  } finally {
    global.fetch = realFetch;
  }
});

// ── Meals ────────────────────────────────────────────────────────────────────

test('tools/call list_meals: leitet week als Query weiter', async () => {
  const calls = installFetchMock(() => jsonResponse({
    data: [{ id: 1, title: 'Pasta', meal_type: 'dinner' }],
    weekStart: '2026-07-27', weekEnd: '2026-08-02',
  }));
  try {
    const res = await toolCallWithHeaders('list_meals', { week: '2026-07-28' }, { authorization: 'Bearer test-token' });
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].url, 'http://mcp.test/api/v1/meals?week=2026-07-28');
    assert.equal(calls[0].options.method, 'GET');
  } finally {
    global.fetch = realFetch;
  }
});

test('tools/call create_meal: sendet Pflichtfelder und optionale Zutaten', async () => {
  const calls = installFetchMock(() => jsonResponse({ data: { id: 9, title: 'Pasta', meal_type: 'dinner' } }, { status: 201 }));
  try {
    const res = await toolCallWithHeaders(
      'create_meal',
      { date: '2026-07-28', meal_type: 'dinner', title: 'Pasta', ingredients: [{ name: 'Nudeln', quantity: '500g' }] },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].url, 'http://mcp.test/api/v1/meals');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.title, 'Pasta');
    assert.equal(body.meal_type, 'dinner');
    assert.deepEqual(body.ingredients, [{ name: 'Nudeln', quantity: '500g' }]);
  } finally {
    global.fetch = realFetch;
  }
});

test('tools/call create_meal: fehlender meal_type → isError (kein fetch)', async () => {
  const calls = installFetchMock(() => jsonResponse({}));
  try {
    const res = await toolCallWithHeaders(
      'create_meal',
      { date: '2026-07-28', title: 'Pasta' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, true);
    assert.equal(calls.length, 0, 'guard in the handler blocks the call before fetch (schema required is not runtime-enforced)');
  } finally {
    global.fetch = realFetch;
  }
});

test('tools/call update_meal: sendet nur gesetzte Felder', async () => {
  const calls = installFetchMock(() => jsonResponse({ data: { id: 9, title: 'Pasta Bolognese' } }));
  try {
    const res = await toolCallWithHeaders('update_meal', { id: 9, title: 'Pasta Bolognese' }, { authorization: 'Bearer test-token' });
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].options.method, 'PUT');
    assert.equal(calls[0].url, 'http://mcp.test/api/v1/meals/9');
    assert.deepEqual(JSON.parse(calls[0].options.body), { title: 'Pasta Bolognese' });
  } finally {
    global.fetch = realFetch;
  }
});

test('tools/call delete_meal: DELETE auf /meals/:id', async () => {
  const calls = installFetchMock(() => emptyResponse());
  try {
    const res = await toolCallWithHeaders('delete_meal', { id: 9 }, { authorization: 'Bearer test-token' });
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].url, 'http://mcp.test/api/v1/meals/9');
    assert.equal(calls[0].options.method, 'DELETE');
  } finally {
    global.fetch = realFetch;
  }
});

test('tools/call delete_meal: Upstream-Fehler wird durchgereicht', async () => {
  installFetchMock(() => jsonResponse({ error: 'Mahlzeit nicht gefunden', code: 404 }, { ok: false, status: 404 }));
  try {
    const res = await toolCallWithHeaders('delete_meal', { id: 999 }, { authorization: 'Bearer test-token' });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /nicht gefunden/);
  } finally {
    global.fetch = realFetch;
  }
});

// ── OpenAPI-Brücke: Metadaten (list/get) ─────────────────────────────────────

test('list_api_operations / get_api_operation: spiegeln die Live-OpenAPI-Spec', async () => {
  const listed = await toolCall('list_api_operations', { search: 'dashboard' });
  assert.equal(listed.result.isError, false);
  const payload = parseContent(listed);
  assert.ok(payload.count >= 1, 'Dashboard-Operation muss auffindbar sein');
  const dashboard = payload.operations.find((op) => op.operation_key === 'get_dashboard');
  assert.ok(dashboard, 'get_dashboard muss gelistet sein');
  assert.equal(dashboard.method, 'GET');
  assert.equal(dashboard.path, '/api/v1/dashboard');

  const described = await toolCall('get_api_operation', { operation_key: 'get_tasks_by_id' });
  assert.equal(described.result.isError, false);
  const operation = parseContent(described);
  assert.equal(operation.method, 'GET');
  assert.equal(operation.path, '/api/v1/tasks/{id}');
  assert.deepEqual(operation.path_parameters, ['id']);
});

test('get_api_operation: unbekannter operation_key → isError', async () => {
  const res = await toolCall('get_api_operation', { operation_key: 'does_not_exist' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Unknown operation_key/i);
});

// ── OpenAPI-Brücke: call_api_operation (Loopback via gemocktem fetch) ─────────

test('call_api_operation GET: baut URL, leitet Auth-Header weiter, gibt Body zurück', async () => {
  const calls = installFetchMock(() => jsonResponse({ data: { open_tasks: 3 } }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'get_dashboard' },
      { authorization: 'Bearer test-token', cookie: 'sid=abc' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.deepEqual(parseContent(res), { data: { open_tasks: 3 } });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://mcp.test/api/v1/dashboard');
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
    assert.equal(calls[0].options.headers.Cookie, 'sid=abc');
    assert.equal(calls[0].options.body, undefined, 'GET darf keinen Body senden');
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation: rendert Path-Params und Query in die URL', async () => {
  const calls = installFetchMock(() => jsonResponse({ data: { id: 42 } }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'get_tasks_by_id', path_params: { id: 42 }, query: { expand: 'subtasks' } },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].url, 'http://mcp.test/api/v1/tasks/42?expand=subtasks');
    assert.equal(calls[0].options.method, 'GET');
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation POST: sendet JSON-Payload mit Content-Type', async () => {
  const calls = installFetchMock(() => jsonResponse({ data: { id: 7, title: 'Neu' } }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'post_tasks', payload: { title: 'Neu' } },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].options.body), { title: 'Neu' });
  } finally {
    global.fetch = realFetch;
  }
});

// Issue #599: Clients, die Tool-Argumente typkoerzieren, schicken das Payload als
// JSON-String. Ohne Durchreichen entstünde ein doppelt kodiertes String-Primitive,
// das `express.json({ strict: true })` mit „Invalid JSON in request body" ablehnt.
test('call_api_operation POST: string-serialisiertes Payload wird nicht doppelt kodiert', async () => {
  const calls = installFetchMock(() => jsonResponse({ data: { id: 8, title: 'Neu' } }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'post_tasks', payload: '{"title":"Neu"}' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].options.body), { title: 'Neu' });
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation POST: unparsbares String-Payload → isError (kein fetch)', async () => {
  const calls = installFetchMock(() => jsonResponse({}));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'post_tasks', payload: 'Neu' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /payload must be a JSON object/i);
    assert.equal(calls.length, 0, 'ungültiges Payload darf keinen Request auslösen');
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation: fehlender Path-Parameter → isError (kein fetch)', async () => {
  const calls = installFetchMock(() => jsonResponse({}));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'get_tasks_by_id' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Missing path parameter/i);
    assert.equal(calls.length, 0, 'ohne Path-Parameter darf kein Request abgehen');
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation: Upstream-Fehler wird als isError durchgereicht', async () => {
  installFetchMock(() => jsonResponse({ error: 'Task not found' }, { ok: false, status: 404 }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'get_tasks_by_id', path_params: { id: 999 } },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Task not found/);
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation: kleine Binärantwort wird als base64 durchgereicht', async () => {
  installFetchMock(() => binaryResponse(Buffer.from('PDFDATA'), { contentLength: 7 }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'get_dashboard' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
    const payload = parseContent(res);
    assert.equal(payload.content_type, 'application/octet-stream');
    assert.equal(Buffer.from(payload.content_base64, 'base64').toString(), 'PDFDATA');
  } finally {
    global.fetch = realFetch;
  }
});

test('call_api_operation: übergroße Binärantwort wird per Content-Length abgelehnt', async () => {
  const huge = 50 * 1024 * 1024; // 50 MiB > 5-MiB-Deckel
  const calls = installFetchMock(() => binaryResponse(Buffer.alloc(0), { contentLength: huge }));
  try {
    const res = await toolCallWithHeaders(
      'call_api_operation',
      { operation_key: 'get_dashboard' },
      { authorization: 'Bearer test-token' },
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /too large/i);
    // Abweisung vor dem Puffern — arrayBuffer darf nicht angefasst werden.
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = realFetch;
  }
});

// ── Protokoll-Fehlerpfade ────────────────────────────────────────────────────

test('unbekannte Methode → JSON-RPC-Fehler -32601', async () => {
  const res = await rpc('foo/bar');
  assert.equal(res.error.code, -32601);
});

test('tools/call mit unbekanntem Tool → isError', async () => {
  const res = await toolCall('teleport', {});
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Unknown tool/i);
});

test('tools/call ohne Tool-Name → -32602', async () => {
  const res = await rpc('tools/call', {});
  assert.equal(res.error.code, -32602);
});

test('Notification (ohne id) liefert keine Antwort', async () => {
  const res = await rpc('notifications/initialized', undefined, null);
  assert.equal(res, null);
});

test('ungültiger Body → -32600', async () => {
  const res = await handleMcpRequest(db, actor, { jsonrpc: '1.0', method: 'x' });
  assert.equal(res.error.code, -32600);
});

test('callTool direkt: list_upcoming_events liefert ein Array', async () => {
  const events = await callTool({ db, actor }, 'list_upcoming_events', {});
  assert.ok(Array.isArray(events));
});

test('keine internen Fehler während der Testläufe', () => {
  assert.equal(internalErrors.length, 0, `unerwartete interne Fehler: ${internalErrors.map((e) => e.message).join('; ')}`);
});
