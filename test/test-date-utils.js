/**
 * Tests: Local-date helpers (public/utils/date.js)
 * Fokus: shiftEndDateKey (Enddatum folgt dem Start, Dauer erhalten) und
 *        isEndBeforeStart (Ende-vor-Start-Guard).
 * Läuft rein im Node-Kontext — date.js hat keine DOM-/i18n-Abhängigkeiten.
 * Ausführen: node test/test-date-utils.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

const { shiftEndDateKey, isEndBeforeStart, weekStartIndex, weekdayOrder,
        monthPeriodKeys, defaultDateInPeriod, isWeekendKey } = await import('../public/utils/date.js');

// --- weekStartIndex: Präferenz → getDay()-Index ---

test('weekStartIndex: monday/sunday/saturday → 1/0/6', () => {
  assert.equal(weekStartIndex('monday'), 1);
  assert.equal(weekStartIndex('sunday'), 0);
  assert.equal(weekStartIndex('saturday'), 6);
});

test('weekStartIndex: unbekannter/leerer Wert fällt auf Montag (1) zurück', () => {
  assert.equal(weekStartIndex('friday'), 1);
  assert.equal(weekStartIndex(undefined), 1);
  assert.equal(weekStartIndex(null), 1);
});

// --- weekdayOrder: 7 Indizes in Anzeigereihenfolge ---

test('weekdayOrder: Montag-Start → [1,2,3,4,5,6,0]', () => {
  assert.deepEqual(weekdayOrder('monday'), [1, 2, 3, 4, 5, 6, 0]);
});

test('weekdayOrder: Sonntag-Start → [0,1,2,3,4,5,6]', () => {
  assert.deepEqual(weekdayOrder('sunday'), [0, 1, 2, 3, 4, 5, 6]);
});

test('weekdayOrder: Samstag-Start → [6,0,1,2,3,4,5]', () => {
  assert.deepEqual(weekdayOrder('saturday'), [6, 0, 1, 2, 3, 4, 5]);
});

test('weekdayOrder: akzeptiert auch einen Index und ist immer eine Permutation von 0–6', () => {
  assert.deepEqual(weekdayOrder(6), [6, 0, 1, 2, 3, 4, 5]);
  assert.deepEqual([...weekdayOrder('monday')].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
});

test('weekdayOrder: Default (kein Argument) ist Montag', () => {
  assert.deepEqual(weekdayOrder(), [1, 2, 3, 4, 5, 6, 0]);
});

// --- isWeekendKey: Sa/So aus dem Tag selbst, nicht aus seiner Rasterspalte ---

test('isWeekendKey: Samstag und Sonntag sind Wochenende, Mo-Fr nicht', () => {
  // 2026-08-15 ist ein Samstag, 2026-08-16 ein Sonntag.
  assert.equal(isWeekendKey('2026-08-15'), true);
  assert.equal(isWeekendKey('2026-08-16'), true);
  for (const key of ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']) {
    assert.equal(isWeekendKey(key), false, `${key} ist ein Werktag`);
  }
});

test('isWeekendKey: liest lokale Kalenderfelder, kippt also nicht westlich von UTC', () => {
  // Der Sonntag bleibt ein Sonntag, egal wie die Zeitzone zum UTC-Tag steht:
  // parseLocalDateKey baut das Datum aus Jahr/Monat/Tag, nicht aus einem
  // UTC-Instant (siehe toLocalDateKey-Falle in CLAUDE.md).
  assert.equal(isWeekendKey('2026-01-04'), true);   // Sonntag
  assert.equal(isWeekendKey('2026-01-05'), false);  // Montag
});

test('isWeekendKey: über ein ganzes Jahr sind es genau die getDay()-Tage 0 und 6', () => {
  const date = new Date(2026, 0, 1);
  let weekendDays = 0;
  for (let i = 0; i < 365; i++) {
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const expected = date.getDay() === 0 || date.getDay() === 6;
    assert.equal(isWeekendKey(key), expected, `${key} (getDay ${date.getDay()})`);
    if (expected) weekendDays++;
    date.setDate(date.getDate() + 1);
  }
  assert.equal(weekendDays, 104, '2026 hat 104 Wochenendtage - sonst zählt die Schleife nicht, was sie soll');
});

// --- shiftEndDateKey: Enddatum zieht um dieselbe Tagesdifferenz mit ---

test('shiftEndDateKey: Start +1 Tag → Ende +1 Tag (eintägig bleibt eintägig)', () => {
  assert.equal(shiftEndDateKey('2026-06-05', '2026-06-06', '2026-06-05'), '2026-06-06');
});

test('shiftEndDateKey: erhält eine mehrtägige Dauer beim Vorwärtsschieben', () => {
  // Start 05→10 (+5 Tage), Ende 07 muss auf 12 (+5 Tage) wandern
  assert.equal(shiftEndDateKey('2026-06-05', '2026-06-10', '2026-06-07'), '2026-06-12');
});

test('shiftEndDateKey: schiebt das Ende beim Zurückdatieren mit', () => {
  assert.equal(shiftEndDateKey('2026-06-10', '2026-06-08', '2026-06-12'), '2026-06-10');
});

test('shiftEndDateKey: kein Versatz, wenn der Start gleich bleibt', () => {
  assert.equal(shiftEndDateKey('2026-06-06', '2026-06-06', '2026-06-08'), '2026-06-08');
});

test('shiftEndDateKey: funktioniert über einen Monatswechsel', () => {
  // Start 30.06→01.07 (+1), Ende 30.06 → 01.07
  assert.equal(shiftEndDateKey('2026-06-30', '2026-07-01', '2026-06-30'), '2026-07-01');
});

// --- isEndBeforeStart: Guard ---

test('isEndBeforeStart: getimtes Ende vor Start → true', () => {
  assert.equal(isEndBeforeStart('2026-06-06T09:00', '2026-06-05T10:00'), true);
});

test('isEndBeforeStart: gültiger Bereich → false', () => {
  assert.equal(isEndBeforeStart('2026-06-06T09:00', '2026-06-06T10:00'), false);
});

test('isEndBeforeStart: gleicher Zeitpunkt → false', () => {
  assert.equal(isEndBeforeStart('2026-06-06T09:00', '2026-06-06T09:00'), false);
});

test('isEndBeforeStart: fehlendes Ende (null) → false', () => {
  assert.equal(isEndBeforeStart('2026-06-06T09:00', null), false);
});

test('isEndBeforeStart: ganztägig, gleicher Tag → false', () => {
  assert.equal(isEndBeforeStart('2026-06-06', '2026-06-06'), false);
});

test('isEndBeforeStart: ganztägig, Ende vor Start → true', () => {
  assert.equal(isEndBeforeStart('2026-06-06', '2026-06-05'), true);
});

test('isEndBeforeStart: gleicher Tag, getimter Start + datumsreines Ende → false', () => {
  // Endzeit leer gelassen: nicht als "Ende vor Start" werten (kein False Positive)
  assert.equal(isEndBeforeStart('2026-06-06T09:00', '2026-06-06'), false);
});

test('isEndBeforeStart: späterer Tag mit früherer Uhrzeit → false', () => {
  // Ende am nächsten Tag, aber früherer Uhrzeit – Datum zählt zuerst
  assert.equal(isEndBeforeStart('2026-06-06T22:00', '2026-06-07T08:00'), false);
});

// --- monthPeriodKeys: der Kalendermonat, nicht das Anzeigeraster ---

test('monthPeriodKeys: erster und letzter Tag, aus Tages- wie aus Monatsschlüssel', () => {
  assert.deepEqual(monthPeriodKeys('2026-09-20'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(monthPeriodKeys('2026-09'),    { from: '2026-09-01', to: '2026-09-30' });
});

test('monthPeriodKeys: Monatslängen inklusive Schaltjahr', () => {
  assert.equal(monthPeriodKeys('2026-02-10').to, '2026-02-28');
  assert.equal(monthPeriodKeys('2024-02-10').to, '2024-02-29', 'Schaltjahr');
  assert.equal(monthPeriodKeys('2026-12-31').to, '2026-12-31', 'Jahreswechsel bleibt im Dezember');
  assert.equal(monthPeriodKeys('2026-01-01').from, '2026-01-01');
});

// --- defaultDateInPeriod: die hausweite Regel ---
//
// Beide Richtungen gehören in den Test. Eine Prüfung nur auf „heute liegt
// draußen" ließe ein `return from` grün durch, und das ist genau die Fassung,
// die einen Eintrag im laufenden Monat auf den Monatsersten legen würde.

test('defaultDateInPeriod: heute gewinnt, solange der Zeitraum heute enthält', () => {
  assert.equal(defaultDateInPeriod('2026-08-01', '2026-08-31', '2026-08-14'), '2026-08-14');
  assert.equal(defaultDateInPeriod('2026-08-14', '2026-08-14', '2026-08-14'), '2026-08-14', 'Rand: einziger Tag');
  assert.equal(defaultDateInPeriod('2026-08-14', '2026-08-20', '2026-08-14'), '2026-08-14', 'Rand: erster Tag');
  assert.equal(defaultDateInPeriod('2026-08-01', '2026-08-14', '2026-08-14'), '2026-08-14', 'Rand: letzter Tag');
});

test('defaultDateInPeriod: sonst der erste Tag des Zeitraums', () => {
  assert.equal(defaultDateInPeriod('2026-09-01', '2026-09-30', '2026-08-14'), '2026-09-01', 'vorwärts geblättert');
  assert.equal(defaultDateInPeriod('2026-02-01', '2026-02-28', '2026-08-14'), '2026-02-01', 'rückwärts geblättert');
  assert.equal(defaultDateInPeriod('2026-08-15', '2026-08-21', '2026-08-14'), '2026-08-15', 'einen Tag zu früh');
});

test('defaultDateInPeriod: ohne Zeitraum bleibt es bei heute', () => {
  assert.equal(defaultDateInPeriod(null, null, '2026-08-14'), '2026-08-14');
  assert.equal(defaultDateInPeriod('', '2026-08-31', '2026-08-14'), '2026-08-14');
});

test('defaultDateInPeriod: ein Zeitraum ohne Ende gilt als der eine Tag', () => {
  assert.equal(defaultDateInPeriod('2026-09-20', null, '2026-08-14'), '2026-09-20');
  assert.equal(defaultDateInPeriod('2026-08-14', null, '2026-08-14'), '2026-08-14');
});

// --- Die Regel steht einmal, nicht je Modul neu ---

test('kein Modul schreibt die Zeitraum-Entscheidung selbst noch einmal', () => {
  // Regel über ALLE Seiten, nicht über eine Liste der zwei bekannten Fundstellen:
  // Budget trug sie seit v1.37.0, der Kalender bekam sie erst nach einem
  // Bugreport (#737), und der nächste Zeitraum-Rahmen soll sie erben.
  const pages = new URL('../public/pages/', import.meta.url);
  const files = ['budget.js', 'calendar.js', 'health.js', 'dashboard.js', 'tasks.js',
                 'notes.js', 'shopping.js', 'meals.js', 'contacts.js'];
  const offenders = [];
  for (const name of files) {
    let src;
    try { src = readFileSync(new URL(name, pages), 'utf8'); } catch { continue; }
    src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Die beiden Schreibweisen, in denen die Regel bisher von Hand stand:
    // der Monatsvergleich (Budget) und der Zeitraum-Vergleich (Kalender).
    for (const re of [/===\s*todayMonth\s*\?/, /today\s*>=\s*\w+\s*&&\s*today\s*<=/]) {
      const hit = src.match(re);
      if (hit) offenders.push(`${name}: ${hit[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    'diese Stellen entscheiden selbst, ob heute im sichtbaren Zeitraum liegt - '
    + 'defaultDateInPeriod() aus utils/date.js nehmen');
});

test('die Module, die ein Zeitraum-Standarddatum brauchen, importieren es auch', () => {
  // Gegenstück zur Verbotsregel oben: die verbietet die Kopie, diese hier hält
  // fest, dass die beiden bekannten Aufrufer den geteilten Weg wirklich gehen.
  // Ohne sie wäre die Regel auch dann grün, wenn beide die Vorbelegung stillschweigend
  // ganz verlören.
  for (const name of ['budget.js', 'calendar.js']) {
    const src = readFileSync(new URL(`../public/pages/${name}`, import.meta.url), 'utf8');
    assert.ok(/defaultDateInPeriod/.test(src), `${name} ruft defaultDateInPeriod() nicht mehr`);
    assert.ok(/from '\/utils\/date\.js'/.test(src), `${name} importiert nicht aus utils/date.js`);
  }
});
