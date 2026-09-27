/**
 * Modul: DMS-Ziel-Guard-Test
 * Zweck: Prüft den SSRF-Vorabcheck der DMS-Anbindung (#809) - inklusive des
 *        INVERSEN Defaults, der ihn von den drei anderen
 *        *_ALLOW_PRIVATE_NETWORK-Schaltern unterscheidet, und der Frage, ob
 *        wirklich JEDE Adapter-Methode durch ihn läuft.
 * Ausführen: node --test test/test-dms-guard.js
 */
import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import {
  assertDmsTargetAllowed, isPrivateNetworkAllowed, DmsTargetError,
  ENV_ALLOW_PRIVATE_NETWORK, _setHostnameLookup,
} from '../server/services/dms/guard.js';
import { PaperlessAdapter } from '../server/services/dms/paperless.js';
import { PapraAdapter } from '../server/services/dms/papra.js';

const realFetch = globalThis.fetch;
const realFlag = process.env[ENV_ALLOW_PRIVATE_NETWORK];

// Kein Test darf echtes DNS anfassen (netzfreie Suite): der Lookup wird immer
// injiziert. `lookups` zählt mit, damit ein Test auch beweisen kann, dass gar
// nicht aufgelöst WURDE - das ist die Zusicherung des Default-Pfads.
let lookups;
function mockLookup(map) {
  _setHostnameLookup(async (hostname) => {
    lookups.push(hostname);
    const entry = map[hostname];
    if (!entry) throw new Error(`ENOTFOUND ${hostname}`);
    return entry;
  });
}

beforeEach(() => {
  lookups = [];
  delete process.env[ENV_ALLOW_PRIVATE_NETWORK];
  mockLookup({});
});
afterEach(() => {
  _setHostnameLookup(null);
  globalThis.fetch = realFetch;
  if (realFlag === undefined) delete process.env[ENV_ALLOW_PRIVATE_NETWORK];
  else process.env[ENV_ALLOW_PRIVATE_NETWORK] = realFlag;
});

// ── Der inverse Default ──────────────────────────────────────────────────────
//
// Die anderen drei Schalter sind Opt-INs: nicht gesetzt heißt geschützt. Dieser
// ist umgekehrt, und das ist der ganze Grund, warum das Update keine bestehende
// Paperless-Anbindung kappt. Ein späteres "Vereinheitlichen" auf das Hausmuster
// wäre genau der stille Bruch, den dieser Test verhindern soll.
test('ohne gesetzte Variable sind private Ziele erlaubt - inverser Default', async () => {
  assert.equal(isPrivateNetworkAllowed(), true);
  await assertDmsTargetAllowed('http://paperless.local:8000');
  assert.deepEqual(lookups, [], 'im erlaubten Fall darf gar nicht erst aufgelöst werden');
});

test('nur ein ausdrückliches false oder 0 schaltet den Schutz ein', () => {
  const cases = {
    false: false, FALSE: false, ' false ': false, 0: false,
    true: true, TRUE: true, 1: true,
    // Ein Tippfehler darf keine laufende Anbindung kappen: der Default ist
    // ohnehin offen, ein verschriebener Wert ändert also nichts.
    yes: true, no: true, '': true,
  };
  for (const [raw, expected] of Object.entries(cases)) {
    process.env[ENV_ALLOW_PRIVATE_NETWORK] = raw;
    assert.equal(isPrivateNetworkAllowed(), expected, `Wert "${raw}"`);
  }
});

// ── Der eingeschaltete Guard ────────────────────────────────────────────────

test('eingeschaltet: localhost wird ohne DNS abgewiesen', async () => {
  process.env[ENV_ALLOW_PRIVATE_NETWORK] = 'false';
  await assert.rejects(
    () => assertDmsTargetAllowed('http://localhost:8000'),
    (err) => err instanceof DmsTargetError && /local host/.test(err.message),
  );
  assert.deepEqual(lookups, [], 'die Namensprüfung greift vor der Auflösung');
});

test('eingeschaltet: ein Name, der auf eine private Adresse zeigt, wird abgewiesen', async () => {
  process.env[ENV_ALLOW_PRIVATE_NETWORK] = 'false';
  mockLookup({ 'dms.example.com': [{ address: '192.168.1.10', family: 4 }] });
  await assert.rejects(
    () => assertDmsTargetAllowed('https://dms.example.com'),
    (err) => err instanceof DmsTargetError && /private address: 192\.168\.1\.10/.test(err.message),
  );
});

test('eingeschaltet: ein öffentliches Ziel kommt durch', async () => {
  process.env[ENV_ALLOW_PRIVATE_NETWORK] = 'false';
  mockLookup({ 'dms.example.com': [{ address: '93.184.216.34', family: 4 }] });
  await assertDmsTargetAllowed('https://dms.example.com/');
  assert.deepEqual(lookups, ['dms.example.com']);
});

// Der Fall, an dem eine Prüfung "nur die erste Adresse" scheitern würde: ein
// Angreifer-DNS liefert eine öffentliche Adresse zuerst und die eigentliche
// interne dahinter. Geprüft wird deshalb JEDE zurückgegebene Adresse.
test('eingeschaltet: eine private Adresse neben einer öffentlichen genügt zum Abweisen', async () => {
  process.env[ENV_ALLOW_PRIVATE_NETWORK] = 'false';
  mockLookup({
    'mixed.example.com': [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ],
  });
  await assert.rejects(
    () => assertDmsTargetAllowed('https://mixed.example.com'),
    (err) => /private address: 10\.0\.0\.5/.test(err.message),
  );
});

test('eingeschaltet: ein nicht auflösbarer Name wird abgewiesen, nicht durchgelassen', async () => {
  process.env[ENV_ALLOW_PRIVATE_NETWORK] = 'false';
  await assert.rejects(
    () => assertDmsTargetAllowed('https://nope.example.com'),
    (err) => err instanceof DmsTargetError && /could not be resolved/.test(err.message),
  );
});

// ── Formprüfung, unabhängig vom Schalter ────────────────────────────────────
//
// Diese beiden greifen auch im erlaubten Default: eine unbrauchbare base_url ist
// kein Netzwerk-, sondern ein Konfigurationsfehler und soll früh auffallen.

test('eine unbrauchbare URL fällt in beiden Zuständen auf', async () => {
  for (const flag of [undefined, 'false']) {
    if (flag === undefined) delete process.env[ENV_ALLOW_PRIVATE_NETWORK];
    else process.env[ENV_ALLOW_PRIVATE_NETWORK] = flag;
    await assert.rejects(() => assertDmsTargetAllowed('not-a-url'),
      (err) => err instanceof DmsTargetError && /not a valid URL/.test(err.message));
    await assert.rejects(() => assertDmsTargetAllowed('file:///etc/passwd'),
      (err) => err instanceof DmsTargetError && /http or https/.test(err.message));
  }
});

// ── Die Strukturfrage: läuft wirklich jede Methode durch den Guard? ──────────
//
// Das ist die Klasse, an der so ein Guard normalerweise scheitert - eine Methode
// baut ihren Request selbst und umgeht ihn. Bei Papra ist testConnection() genau
// so gebaut, deshalb wird sie hier einzeln nachgewiesen und nicht mitgemeint.

function denyingFetch() {
  globalThis.fetch = async () => {
    throw new Error('fetch must not be reached when the guard rejects');
  };
}

test('Paperless: jede Methode fragt den Guard, bevor ein Request rausgeht', async () => {
  process.env[ENV_ALLOW_PRIVATE_NETWORK] = 'false';
  denyingFetch();
  const adapter = new PaperlessAdapter({
    provider: 'paperless', base_url: 'http://paperless.local:8000', api_token: 't',
  });
  for (const [name, call] of [
    ['search', () => adapter.search('x', { limit: 5 })],
    ['fetchContent', () => adapter.fetchContent('1')],
    ['fetchThumbnail', () => adapter.fetchThumbnail('1')],
    ['getDocument', () => adapter.getDocument('1')],
    ['upload', () => adapter.upload({ buffer: Buffer.from('x'), filename: 'a.pdf', mime: 'application/pdf' })],
  ]) {
    await assert.rejects(call, (err) => /local host/.test(err.message), `${name} umgeht den Guard`);
  }
});

// testConnection() fängt bei Paperless intern und meldet ok:false, statt zu
// werfen - der Nachweis ist deshalb, dass fetch nie erreicht wurde.
test('Paperless testConnection meldet den geblockten Host, statt ihn anzufragen', async () => {
  process.env[ENV_ALLOW_PRIVATE_NETWORK] = 'false';
  let reached = false;
  globalThis.fetch = async () => { reached = true; return { ok: true, status: 200 }; };
  const adapter = new PaperlessAdapter({
    provider: 'paperless', base_url: 'http://paperless.local:8000', api_token: 't',
  });
  const result = await adapter.testConnection().catch((err) => ({ ok: false, error: err.message }));
  assert.equal(reached, false, 'der Request darf den blockierten Host nie erreichen');
  assert.equal(result.ok, false);
});

test('Papra: auch das selbstgebaute testConnection läuft durch den Guard', async () => {
  process.env[ENV_ALLOW_PRIVATE_NETWORK] = 'false';
  let reached = false;
  globalThis.fetch = async () => { reached = true; return { ok: true, status: 200 }; };
  const adapter = new PapraAdapter({
    provider: 'papra', base_url: 'http://papra.local:1221', api_token: 't', org_id: 'org1',
  });
  const result = await adapter.testConnection();
  assert.equal(reached, false, 'testConnection baut ihren Request selbst - sie darf kein Loch sein');
  assert.equal(result.ok, false);
  assert.match(result.error, /local host/);
});

test('Papra: die übrigen Methoden ebenso', async () => {
  process.env[ENV_ALLOW_PRIVATE_NETWORK] = 'false';
  denyingFetch();
  const adapter = new PapraAdapter({
    provider: 'papra', base_url: 'http://papra.local:1221', api_token: 't', org_id: 'org1',
  });
  for (const [name, call] of [
    ['search', () => adapter.search('x', { limit: 5 })],
    ['fetchContent', () => adapter.fetchContent('1')],
    ['upload', () => adapter.upload({ buffer: Buffer.from('x'), filename: 'a.pdf', mime: 'application/pdf' })],
  ]) {
    await assert.rejects(call, (err) => /local host/.test(err.message), `${name} umgeht den Guard`);
  }
});

// Der Bestandsschutz als Zusicherung: im Default-Zustand kommt derselbe private
// Host durch. Ohne diesen Test wäre "der Guard blockt" trivial erfüllbar, indem
// er immer blockt - und genau das wäre der Bruch, den der Default verhindert.
test('im Default erreicht derselbe private Host sein Ziel', async () => {
  delete process.env[ENV_ALLOW_PRIVATE_NETWORK];
  let reached = false;
  globalThis.fetch = async () => { reached = true; return { ok: true, status: 200 }; };
  const adapter = new PapraAdapter({
    provider: 'papra', base_url: 'http://papra.local:1221', api_token: 't', org_id: 'org1',
  });
  const result = await adapter.testConnection();
  assert.equal(reached, true, 'ohne gesetzte Variable muss die LAN-Anbindung weiter funktionieren');
  assert.equal(result.ok, true);
});
