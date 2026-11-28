/**
 * Test: "Sync erforderlich" im Aufgaben-Dialog (Fork)
 * Zweck: Mit dem Schalter AN bietet eine neue Aufgabe "nur lokal" nicht mehr an
 *        und waehlt das eigene Standardziel, sonst das des Haushalts, sonst die
 *        erste Liste (die Auswahl bleibt nicht leer). Eine schon lokale Aufgabe
 *        behaelt "nur lokal". Mit dem Schalter AUS bleibt alles wie bisher.
 *        Gemessen an `wireSyncTarget`, dem Aufrufer, mit einem Auswahlfeld-Doppel
 *        (kein jsdom, siehe test/mini-dom.js).
 * Ausführen: npm run test:sync-required-tasks-form
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Die Seite haengt an Webkomponenten und Browser-Globals; dieselben Doppel wie die
// uebrigen Aufgaben-Seitentests (test-tasks-errors.js).
globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
/** @type {any} */ (globalThis.document.documentElement).classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
globalThis.CSS = globalThis.CSS ?? { escape: (v) => String(v) };
globalThis.window.yuvomi = /** @type {any} */ ({ ...globalThis.window.yuvomi, showToast: () => {} });
Object.defineProperty(globalThis, 'navigator', { value: { ...globalThis.navigator, onLine: true }, configurable: true, writable: true });

class Option {
  /** @param {string} [value] */
  constructor(value = '') {
    this.value = value;
    this.textContent = '';
    this.selected = false;
    /** @type {Group | null} */
    this.parent = null;
  }
  remove() { this.parent?.detach(this); }
}
class Group {
  constructor() {
    /** @type {Array<Option | Group>} */
    this.children = [];
    this.label = '';
    /** @type {Group | null} */
    this.parent = null;
  }
  /**
   * @template {Option | Group} T
   * @param {T} node
   * @returns {T}
   */
  appendChild(node) { node.parent = this; this.children.push(node); return node; }
  /** @param {Option | Group} node */
  detach(node) { this.children = this.children.filter((child) => child !== node); }
  /** @returns {Option[]} */
  get flat() { return this.children.flatMap((child) => (child instanceof Group ? child.flat : [child])); }
}
class Select extends Group {
  get options() { return this.flat; }
  /** @param {string} selector */
  querySelector(selector) {
    const value = /^option\[value="(.*)"\]$/.exec(selector)?.[1];
    return value === undefined ? null : this.options.find((o) => o.value === value) ?? null;
  }
  get selectedIndex() { return this.options.findIndex((o) => o.selected); }
  set selectedIndex(index) { this.options.forEach((o, i) => { o.selected = i === index; }); }
  get value() { return (this.options.find((o) => o.selected) ?? this.options[0])?.value ?? ''; }
  set value(next) {
    const hit = this.options.find((o) => o.value === next);
    this.options.forEach((o) => { o.selected = o === hit; });
  }
}
// Nur die zwei Knoten, die wireSyncTarget baut: ein Doppel, das Optionen fuehrt.
/** @type {any} */ (globalThis.document).createElement = (/** @type {string} */ tag) => (tag === 'optgroup' ? new Group() : new Option());

const { __test: tasks } = await import('../public/pages/tasks.js');

const LIST_A = 'caldav:1|https://dav.example.org/lists/a/';
const LIST_B = 'caldav:1|https://dav.example.org/lists/b/';
const LISTS = {
  caldav: [
    { accountId: 1, accountName: 'Nextcloud', listUrl: 'https://dav.example.org/lists/a/', listName: 'A' },
    { accountId: 1, accountName: 'Nextcloud', listUrl: 'https://dav.example.org/lists/b/', listName: 'B' },
  ],
};

/**
 * Das Formular, wie wireSyncTarget es findet: ein Feld mit der Option "nur lokal".
 * @param {{ task?: object, own?: string, household?: string, requireSync?: boolean }} options
 */
async function wire({ task, own = '', household = '', requireSync = true }) {
  tasks.state.defaultSyncTarget = own;
  tasks.state.householdSyncTarget = household;
  tasks.state.requireSync = requireSync;
  const select = new Select();
  select.appendChild(new Option(''));
  /** @type {any} */ (globalThis).__apiStub = { get: async () => ({ data: LISTS }) };
  await tasks.wireSyncTarget({ querySelector: (/** @type {string} */ selector) => (selector === '#task-sync-target' ? select : null) }, task);
  delete (/** @type {any} */ (globalThis)).__apiStub;
  tasks.state.requireSync = false;
  tasks.state.householdSyncTarget = '';
  return select;
}
/** @param {Select} select */
const values = (select) => select.options.map((o) => o.value);

test('Sync erforderlich: eine neue Aufgabe bietet "nur lokal" nicht an und waehlt den eigenen Standard', async () => {
  const select = await wire({ own: LIST_B, household: LIST_A });
  assert.ok(!values(select).includes(''), 'keine Option "nur lokal"');
  assert.equal(select.value, LIST_B);
});

test('Sync erforderlich: ohne eigenen Standard gilt das Haushaltsziel', async () => {
  assert.equal((await wire({ household: LIST_B })).value, LIST_B);
});

test('Sync erforderlich: ein nicht angebotener eigener Standard wird uebersprungen', async () => {
  assert.equal((await wire({ own: 'caldav:9|https://gone.example.org/', household: LIST_A })).value, LIST_A);
});

test('Sync erforderlich: ohne jeden Standard steht die erste Liste da', async () => {
  assert.equal((await wire({})).value, LIST_A);
});

test('Sync erforderlich: eine schon lokale Aufgabe behaelt "nur lokal"', async () => {
  const select = await wire({ task: { id: 5, title: 'Alt' }, own: LIST_B });
  assert.ok(values(select).includes(''));
  assert.equal(select.value, '');
});

test('Sync erforderlich: eine Aufgabe mit Liste bietet "nur lokal" nicht mehr an', async () => {
  const task = { id: 6, title: 'Synchron', target_caldav_account_id: 1, target_caldav_list_url: 'https://dav.example.org/lists/b/' };
  const select = await wire({ task });
  assert.ok(!values(select).includes(''));
  assert.equal(select.value, LIST_B);
});

test('Schalter AUS: wie bisher - "nur lokal" bleibt, der eigene Standard wird vorgewaehlt', async () => {
  const select = await wire({ requireSync: false, own: LIST_B, household: LIST_A });
  assert.ok(values(select).includes(''));
  assert.equal(select.value, LIST_B);
  const none = await wire({ requireSync: false, household: LIST_A });
  assert.equal(none.value, '', 'das Haushaltsziel gilt nur mit dem Schalter');
});
