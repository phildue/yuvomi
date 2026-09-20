/**
 * Modul: DMS-Adapter-Test
 * Zweck: Validiert den Paperless-ngx-Adapter (search/fetchContent/upload/testConnection)
 *        gegen ein gemocktes fetch — keine echte Netzwerkverbindung.
 * Ausführen: node --test test/test-dms-adapter.js
 */
import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import { PaperlessAdapter, parseAsnQuery } from '../server/services/dms/paperless.js';
import { getAdapter } from '../server/services/dms/index.js';

const account = { provider: 'paperless', base_url: 'https://dms.example.com/', api_token: 'tok123' };

let calls;
const realFetch = globalThis.fetch;
beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(handler) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('search: baut Query-URL, setzt Token-Header, mappt Treffer', async () => {
  mockFetch(() => jsonResponse({
    count: 1,
    results: [{
      id: 42, title: 'Stromrechnung', created: '2026-01-02T00:00:00Z',
      correspondent: 7, tags: [3, 4],
      archived_file_name: 'stromrechnung.pdf', original_file_name: 'scan.pdf',
    }],
  }));
  const adapter = new PaperlessAdapter(account);
  const results = await adapter.search('strom', { limit: 10 });

  assert.equal(calls[0].url, 'https://dms.example.com/api/documents/?page_size=10&query=strom');
  assert.equal(calls[0].opts.headers.Authorization, 'Token tok123');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    id: '42', title: 'Stromrechnung', created: '2026-01-02T00:00:00Z',
    filename: 'stromrechnung.pdf',
    url: 'https://dms.example.com/documents/42',
  });
});

test('search: leerer Query listet alle Dokumente (ohne query-Param)', async () => {
  mockFetch(() => jsonResponse({
    count: 1,
    results: [{ id: 42, title: 'A', original_file_name: 'a.pdf', created: null }],
  }));
  const adapter = new PaperlessAdapter(account);
  const results = await adapter.search('   ', { limit: 20 });

  assert.equal(calls[0].url, 'https://dms.example.com/api/documents/?page_size=20');
  assert.equal(results.length, 1);
});

test('parseAsnQuery: Präfix ist exklusiv, reine Zahl mehrdeutig, Text keine ASN (#511, #763)', () => {
  assert.deepEqual(parseAsnQuery('asn:123'), { asn: 123, exclusive: true });
  assert.deepEqual(parseAsnQuery('ASN 456'), { asn: 456, exclusive: true });
  assert.deepEqual(parseAsnQuery('asn#789'), { asn: 789, exclusive: true });
  // Nackte Zahl bleibt eine ASN-Kandidatin, beansprucht die Suche aber nicht allein.
  assert.deepEqual(parseAsnQuery('  42 '), { asn: 42, exclusive: false });
  assert.deepEqual(parseAsnQuery('Stromrechnung'), { asn: null, exclusive: false });
  assert.deepEqual(parseAsnQuery('asn:'), { asn: null, exclusive: false });
  assert.deepEqual(parseAsnQuery('2026 Vertrag'), { asn: null, exclusive: false });
  assert.deepEqual(parseAsnQuery(''), { asn: null, exclusive: false });
});

test('search: asn:-Präfix filtert ausschließlich per archive_serial_number (#511)', async () => {
  mockFetch(() => jsonResponse({ count: 0, results: [] }));
  const adapter = new PaperlessAdapter(account);
  await adapter.search('asn:42', { limit: 20 });

  assert.equal(calls.length, 1, 'expliziter ASN-Query darf keine Volltextsuche auslösen');
  assert.equal(calls[0].url, 'https://dms.example.com/api/documents/?page_size=20&archive_serial_number=42');
});

test('search: reine Zahl sucht ASN UND Volltext, ASN-Treffer zuerst (#763)', async () => {
  mockFetch((url) => {
    if (url.includes('archive_serial_number=1728')) {
      return jsonResponse({ count: 1, results: [{ id: 9, title: 'Gestempeltes Dokument', original_file_name: 'a.pdf', created: null }] });
    }
    return jsonResponse({ count: 1, results: [{ id: 5, title: '1728 Pest receipt', original_file_name: 'b.pdf', created: null }] });
  });
  const adapter = new PaperlessAdapter(account);
  const results = await adapter.search('1728', { limit: 20 });

  const urls = calls.map((c) => c.url).sort();
  assert.deepEqual(urls, [
    'https://dms.example.com/api/documents/?page_size=20&archive_serial_number=1728',
    'https://dms.example.com/api/documents/?page_size=20&query=1728',
  ]);
  assert.deepEqual(results.map((r) => r.id), ['9', '5'], 'ASN-Treffer steht vor den Volltexttreffern');
});

test('search: reine Zahl entdoppelt ein Dokument, das beide Wege liefern (#763)', async () => {
  mockFetch(() => jsonResponse({
    count: 1,
    results: [{ id: 7, title: 'Rechnung 1728', original_file_name: 'r.pdf', created: null }],
  }));
  const adapter = new PaperlessAdapter(account);
  const results = await adapter.search('1728', { limit: 20 });

  assert.equal(results.length, 1);
  assert.equal(results[0].id, '7');
});

test('search: reine Zahl liefert Volltexttreffer, auch wenn die ASN-Abfrage scheitert (#763)', async () => {
  mockFetch((url) => {
    if (url.includes('archive_serial_number')) return jsonResponse({}, 400);
    return jsonResponse({ count: 1, results: [{ id: 5, title: '1728 Pest receipt', original_file_name: 'b.pdf', created: null }] });
  });
  const adapter = new PaperlessAdapter(account);
  const results = await adapter.search('1728', { limit: 20 });

  assert.deepEqual(results.map((r) => r.id), ['5']);
});

test('search: reine Zahl kürzt die zusammengeführte Liste auf das Limit (#763)', async () => {
  mockFetch((url) => {
    if (url.includes('archive_serial_number')) {
      return jsonResponse({ count: 1, results: [{ id: 99, title: 'ASN-Treffer', original_file_name: 'a.pdf', created: null }] });
    }
    return jsonResponse({
      count: 3,
      results: [1, 2, 3].map((id) => ({ id, title: `Text ${id}`, original_file_name: `${id}.pdf`, created: null })),
    });
  });
  const adapter = new PaperlessAdapter(account);
  const results = await adapter.search('1728', { limit: 3 });

  assert.deepEqual(results.map((r) => r.id), ['99', '1', '2']);
});

test('search: HTTP-Fehler wirft mit Statuscode', async () => {
  mockFetch(() => jsonResponse({}, 401));
  const adapter = new PaperlessAdapter(account);
  await assert.rejects(() => adapter.search('x'), /DMS request failed \(401\)/);
});

function binaryResponse(buffer, mime, status = 200) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? mime : null) },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

test('getDocument: liefert normalisierte Metadaten (id, title, filename, url, tags)', async () => {
  mockFetch(() => jsonResponse({
    id: 42, title: 'Stromrechnung', created: '2026-01-02T00:00:00Z',
    correspondent: 7, tags: [3], archived_file_name: 'strom.pdf',
    original_file_name: 'scan.pdf', archive_serial_number: null,
  }));
  const adapter = new PaperlessAdapter(account);
  const doc = await adapter.getDocument('42');
  assert.equal(calls[0].url, 'https://dms.example.com/api/documents/42/');
  assert.equal(doc.id, '42');
  assert.equal(doc.title, 'Stromrechnung');
  assert.equal(doc.filename, 'strom.pdf');
  assert.equal(doc.url, 'https://dms.example.com/documents/42');
});

test('fetchContent: lädt Binärdaten herunter, gibt buffer + mime zurück', async () => {
  const buf = Buffer.from('%PDF-1.4 fake');
  mockFetch(() => binaryResponse(buf, 'application/pdf'));
  const adapter = new PaperlessAdapter(account);
  const out = await adapter.fetchContent('42');
  assert.equal(calls[0].url, 'https://dms.example.com/api/documents/42/download/');
  assert.equal(out.mime, 'application/pdf');
  assert.ok(Buffer.isBuffer(out.buffer));
  assert.equal(out.buffer.toString(), '%PDF-1.4 fake');
});

test('fetchThumbnail: lädt Vorschaubild von /thumb/, gibt buffer + mime zurück (#533)', async () => {
  const buf = Buffer.from('89504e470d0a1a0a', 'hex');
  mockFetch(() => binaryResponse(buf, 'image/webp'));
  const adapter = new PaperlessAdapter(account);
  const out = await adapter.fetchThumbnail('42');
  assert.equal(calls[0].url, 'https://dms.example.com/api/documents/42/thumb/');
  assert.equal(calls[0].opts.headers.Authorization, 'Token tok123');
  assert.equal(out.mime, 'image/webp');
  assert.ok(Buffer.isBuffer(out.buffer));
  assert.deepEqual(out.buffer, buf);
});

test('fetchThumbnail: HTTP-Fehler wirft mit Statuscode', async () => {
  mockFetch(() => binaryResponse(Buffer.alloc(0), null, 404));
  const adapter = new PaperlessAdapter(account);
  await assert.rejects(() => adapter.fetchThumbnail('9'), /DMS request failed \(404\)/);
});

test('testConnection: testet echten JSON-Endpunkt /api/documents/ statt /api/ (#527)', async () => {
  mockFetch(() => jsonResponse({ count: 1, results: [] }));
  const adapter = new PaperlessAdapter(account);
  const out = await adapter.testConnection();
  // /api/ leitet hinter Traefik auf die Swagger-HTML-View um (406); ein echter
  // JSON-Endpunkt vermeidet den Redirect und prüft zugleich den Token.
  assert.equal(calls[0].url, 'https://dms.example.com/api/documents/?page_size=1');
  assert.equal(calls[0].opts.headers.Authorization, 'Token tok123');
  assert.equal(out.ok, true);
});

test('testConnection: ok=false bei 403', async () => {
  mockFetch(() => jsonResponse({}, 403));
  const adapter = new PaperlessAdapter(account);
  const out = await adapter.testConnection();
  assert.equal(out.ok, false);
  assert.equal(out.status, 403);
});

test('testConnection: fordert explizite API-Version im Accept-Header an', async () => {
  mockFetch(() => jsonResponse({}));
  const adapter = new PaperlessAdapter(account);
  await adapter.testConnection();
  assert.match(calls[0].opts.headers.Accept, /application\/json; version=\d+/);
});

test('testConnection: 406 löst Fallback ohne Version aus (#438)', async () => {
  mockFetch((_url, opts) => {
    const hasVersion = /version=/.test(opts.headers.Accept);
    return jsonResponse(hasVersion ? { detail: 'Not Acceptable' } : { documents: 'x' }, hasVersion ? 406 : 200);
  });
  const adapter = new PaperlessAdapter(account);
  const out = await adapter.testConnection();
  assert.equal(calls.length, 2);
  assert.match(calls[0].opts.headers.Accept, /version=/);
  assert.equal(calls[1].opts.headers.Accept, 'application/json');
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
});

test('search: 406 auf versionierten Request fällt auf unversioniert zurück (#438)', async () => {
  mockFetch((_url, opts) => {
    if (/version=/.test(opts.headers.Accept)) return jsonResponse({ detail: 'Not Acceptable' }, 406);
    return jsonResponse({ results: [{ id: 5, title: 'Vertrag', original_file_name: 'v.pdf' }] });
  });
  const adapter = new PaperlessAdapter(account);
  const results = await adapter.search('vertrag');
  assert.equal(calls.length, 2);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, '5');
});

test('upload: POSTet multipart an post_document/, gibt taskId zurück', async () => {
  mockFetch(() => jsonResponse('b7c4-task-uuid'));
  const adapter = new PaperlessAdapter(account);
  const out = await adapter.upload({
    buffer: Buffer.from('hello'), filename: 'a.pdf', mime: 'application/pdf', title: 'Brief',
  });
  assert.equal(calls[0].url, 'https://dms.example.com/api/documents/post_document/');
  assert.equal(calls[0].opts.method, 'POST');
  assert.ok(calls[0].opts.body instanceof FormData);
  assert.equal(out.taskId, 'b7c4-task-uuid');
});

test('upload: übergibt tags als wiederholte Felder und erfordert filename', async () => {
  mockFetch(() => jsonResponse('uuid-abc'));
  const adapter = new PaperlessAdapter(account);
  const out = await adapter.upload({
    buffer: Buffer.from('x'), filename: 'b.pdf', mime: 'application/pdf', tags: [3, 7],
  });
  assert.equal(out.taskId, 'uuid-abc');
  assert.equal(calls[0].opts.method, 'POST');
  await assert.rejects(
    () => adapter.upload({ buffer: Buffer.from('x'), mime: 'application/pdf' }),
    /requires a filename/,
  );
});

test('getAdapter: liefert PaperlessAdapter für provider=paperless', () => {
  const a = getAdapter({ provider: 'paperless', base_url: 'https://x/', api_token: 't' });
  assert.equal(a.provider, 'paperless');
});

test('getAdapter: wirft bei unbekanntem Provider', () => {
  assert.throws(() => getAdapter({ provider: 'nope' }), /Unknown DMS provider/);
});
