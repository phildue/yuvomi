/**
 * Test: Einstellungen "Sync erforderlich" - der Abschnitt des Haushalts (Fork)
 * Zweck: Der Admin sieht den Schalter und zwei Standardziel-Felder (Termine,
 *        Aufgaben). Das Terminfeld bietet Google, CalDAV und Outlook, das
 *        Aufgabenfeld nur CalDAV-Listen; "kein Standard" ist die leere Option.
 *        Ein gespeichertes, nicht mehr angebotenes Ziel bleibt als Option
 *        sichtbar. Jede Aenderung speichert genau ihr Feld (PUT /preferences);
 *        scheitert das Speichern, springt das Feld zurueck.
 * Ausführen: npm run test:sync-required-settings-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window ?? {};
/** @type {Array<[string, string]>} */
const toasts = [];
globalThis.window.yuvomi = /** @type {any} */ ({ showToast: (/** @type {string} */ text, /** @type {string} */ kind) => toasts.push([text, kind]) });

const { syncRequiredSectionHtml, bindSyncRequiredSection } = await import('../public/settings/pages/sync-required.js');

const CALENDAR_TARGETS = {
  google: [{ id: 'fam@group.calendar.google.com', summary: 'Familie' }],
  caldav: [{ accountId: 1, accountName: 'Nextcloud', calendarUrl: 'https://dav.example.org/cal/home/', calendarName: 'Zuhause' }],
  outlook: [],
};
const TASK_LISTS = [{ accountId: 1, accountName: 'Nextcloud', listUrl: 'https://dav.example.org/lists/home/', listName: 'Haushalt' }];
const OFF = { sync_required: false, calendar_household_target: '', tasks_household_target: '' };

const html = (preferences = OFF, extra = {}) => syncRequiredSectionHtml({
  preferences, calendarTargets: CALENDAR_TARGETS, taskLists: TASK_LISTS, ...extra,
});
/**
 * Die <option>-Werte des Feldes mit dieser id.
 * @param {string} markup
 * @param {string} id
 */
const optionValues = (markup, id) => {
  const select = new RegExp(`<select[^>]*id="${id}"[\\s\\S]*?</select>`).exec(markup)?.[0] ?? '';
  return [...select.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
};
/**
 * @param {string} markup
 * @param {string} id
 */
const selectedValue = (markup, id) => {
  const select = new RegExp(`<select[^>]*id="${id}"[\\s\\S]*?</select>`).exec(markup)?.[0] ?? '';
  return /<option value="([^"]*)"[^>]*selected/.exec(select)?.[1];
};

/** @param {string} markup */
const switchTag = (markup) => /<input[^>]*id="sync-required-switch"[^>]*>/.exec(markup)?.[0] ?? '';

test('Schalter: aus ohne Haken, an mit Haken', () => {
  const off = html();
  assert.match(off, /id="sync-required-switch"/);
  assert.doesNotMatch(switchTag(off), /\schecked/);
  assert.match(switchTag(html({ ...OFF, sync_required: true })), /\schecked/);
});

test('Terminfeld: kein Standard, Google und CalDAV; das gespeicherte Ziel ist gewaehlt', () => {
  const markup = html({ ...OFF, calendar_household_target: 'caldav:1|https://dav.example.org/cal/home/' });
  assert.deepEqual(optionValues(markup, 'sync-required-calendar-target'),
    ['', 'google:fam@group.calendar.google.com', 'caldav:1|https://dav.example.org/cal/home/']);
  assert.equal(selectedValue(markup, 'sync-required-calendar-target'), 'caldav:1|https://dav.example.org/cal/home/');
});

test('Aufgabenfeld: nur CalDAV-Listen, kein Google', () => {
  const markup = html({ ...OFF, tasks_household_target: 'caldav:1|https://dav.example.org/lists/home/' });
  assert.deepEqual(optionValues(markup, 'sync-required-tasks-target'),
    ['', 'caldav:1|https://dav.example.org/lists/home/']);
  assert.equal(selectedValue(markup, 'sync-required-tasks-target'), 'caldav:1|https://dav.example.org/lists/home/');
});

test('ein gespeichertes, nicht mehr angebotenes Ziel bleibt als Option sichtbar', () => {
  const gone = 'caldav:7|https://gone.example.org/cal/';
  const markup = html({ ...OFF, calendar_household_target: gone });
  assert.ok(optionValues(markup, 'sync-required-calendar-target').includes(gone));
  assert.equal(selectedValue(markup, 'sync-required-calendar-target'), gone);
});

test('Werte und Namen aus dem Haushalt werden maskiert', () => {
  const markup = html(OFF, { taskLists: [{ accountId: 1, accountName: 'N"<b>', listUrl: 'https://x/"><i>/', listName: '<script>' }] });
  assert.doesNotMatch(markup, /<script>/);
  assert.doesNotMatch(markup, /<b>|<i>/);
});

// ── Speichern ────────────────────────────────────────────────────────────────

/** @param {Record<string, any>} props */
function fakeControl(props) {
  /** @type {Record<string, any>} */
  const listeners = {};
  return {
    listeners, isConnected: true, disabled: false,
    addEventListener(/** @type {string} */ type, /** @type {Function} */ fn) { listeners[type] = fn; },
    ...props,
  };
}
function wired() {
  const controls = /** @type {Record<string, any>} */ ({
    '#sync-required-switch': fakeControl({ checked: false }),
    '#sync-required-calendar-target': fakeControl({ value: '' }),
    '#sync-required-tasks-target': fakeControl({ value: '' }),
  });
  bindSyncRequiredSection({ querySelector: (/** @type {string} */ selector) => controls[selector] ?? null });
  return controls;
}
/** @type {Array<[string, unknown]>} */
const puts = [];
let putOutcome = 'ok';
/** @type {any} */ (globalThis).__apiStub = {
  put: async (/** @type {string} */ path, /** @type {unknown} */ body) => {
    puts.push([path, body]);
    if (putOutcome === 'fail') throw new Error('nope');
    return { data: {} };
  },
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('der Schalter speichert genau sync_required', async () => {
  puts.length = 0; putOutcome = 'ok';
  const controls = wired();
  controls['#sync-required-switch'].checked = true;
  await controls['#sync-required-switch'].listeners.change();
  assert.deepEqual(puts, [['/preferences', { sync_required: true }]]);
});

test('jedes Standardziel speichert genau sein Feld', async () => {
  puts.length = 0; putOutcome = 'ok';
  const controls = wired();
  controls['#sync-required-calendar-target'].value = 'google:fam@group.calendar.google.com';
  await controls['#sync-required-calendar-target'].listeners.change();
  controls['#sync-required-tasks-target'].value = 'caldav:1|https://dav.example.org/lists/home/';
  await controls['#sync-required-tasks-target'].listeners.change();
  assert.deepEqual(puts, [
    ['/preferences', { calendar_household_target: 'google:fam@group.calendar.google.com' }],
    ['/preferences', { tasks_household_target: 'caldav:1|https://dav.example.org/lists/home/' }],
  ]);
});

test('scheitert das Speichern, springt das Feld zurueck und eine Warnung erscheint', async () => {
  puts.length = 0; putOutcome = 'fail'; toasts.length = 0;
  const controls = wired();
  controls['#sync-required-switch'].checked = true;
  await controls['#sync-required-switch'].listeners.change();
  await settle();
  assert.equal(controls['#sync-required-switch'].checked, false, 'der Schalter steht wieder auf dem alten Wert');
  assert.equal(toasts.at(-1)?.[1], 'danger');
  assert.equal(controls['#sync-required-switch'].disabled, false);
});
