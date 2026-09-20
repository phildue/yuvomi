/**
 * Local-date helpers for YYYY-MM-DD values sent to the API.
 * These deliberately use local calendar fields instead of UTC ISO strings.
 */
// Relativ, nicht browser-absolut: test-date-utils.js laedt diese Datei ohne den
// Loader aus test-browser-loader.mjs, und '/utils/...' waere dort das
// Dateisystem-Root. Innerhalb von public/utils/ ist das der uebliche Weg
// (vgl. './ux.js' in bulk-pill.js).
import { todayKey as zonedTodayKey } from './timezone.js';

/**
 * Welcher Kalendertag ist gerade „heute" (#829 Teil 3).
 *
 * Bewusst NICHT dasselbe wie `toLocalDateKey()` ohne Argument, obwohl beide
 * heute denselben Wert liefern, solange keine Haushaltszone gesetzt ist:
 *
 *   - `toLocalDateKey(date)` ist ein KONVERTER. Er liest die Wanduhrfelder eines
 *     `Date`, und die Gegenrichtung `parseLocalDateKey` baut sie in der Zone des
 *     Browsers wieder auf. Die beiden bilden ein Paar, das seinen Schlüssel
 *     unverändert zurückgeben muss - das tut es nur, wenn beide Seiten dieselbe
 *     Uhr lesen. Er bleibt deshalb bei der Browser-Zone.
 *   - `todayKey()` ist eine FRAGE AN DIE UHR. Nur sie darf der Haushaltszone
 *     folgen, sonst zeigt ein Gerät, das auf Reisen in einer anderen Zone steht,
 *     den Nachbartag als heute an.
 *
 * Das Gegenstück auf dem Server heißt genauso: `todayKey(database)` in
 * server/utils/timezone.js.
 * @returns {string} YYYY-MM-DD
 */
export function todayKey() {
  return zonedTodayKey();
}

export function toLocalDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseLocalDateKey(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function addLocalDays(dateKey, days) {
  const date = parseLocalDateKey(dateKey);
  date.setDate(date.getDate() + days);
  return toLocalDateKey(date);
}

export function startOfLocalWeekKey(dateKey, weekStartsOn = 1) {
  const date = parseLocalDateKey(dateKey);
  const day = date.getDay();
  const diff = (day - weekStartsOn + 7) % 7;
  date.setDate(date.getDate() - diff);
  return toLocalDateKey(date);
}

/**
 * Erster und letzter Tag des Kalendermonats, in dem `dateKey` liegt.
 * Nimmt 'YYYY-MM' wie 'YYYY-MM-DD'. Bewusst der Monat und nicht das
 * Anzeigeraster eines Monatskalenders: dessen sechs Wochen beginnen im
 * Vormonat, und als Zeitraum für einen neuen Eintrag gelesen ergäbe das
 * für September den 31. August.
 */
export function monthPeriodKeys(dateKey) {
  const from = `${String(dateKey).slice(0, 7)}-01`;
  const date = parseLocalDateKey(from);
  date.setMonth(date.getMonth() + 1);
  date.setDate(0);                       // Tag 0 des Folgemonats = letzter des eigenen
  return { from, to: toLocalDateKey(date) };
}

/**
 * Vorbelegtes Datum für einen neuen Eintrag in dem Zeitraum, den der Nutzer
 * gerade ansieht: heute, solange der Zeitraum heute enthält, sonst dessen
 * erster Tag.
 *
 * Die Regel gibt es im Haus seit v1.37.0 (Budget: ein Eintrag, angelegt beim
 * Blättern im März, gehört nicht stillschweigend in den Juli) und seit v2.10.1
 * im Kalender über alle vier Ansichten (#737). Sie steht hier, weil sie zweimal
 * getrennt geschrieben stand und das zweite Modul sie erst nach einem Bugreport
 * bekam - der nächste Zeitraum-Rahmen soll sie erben statt sie neu zu erfinden.
 *
 * Der Aufrufer bestimmt den Zeitraum; was „sichtbar" heißt, weiß nur er. Ohne
 * Zeitraum (kein `from`) bleibt es bei heute, und ein Zeitraum ohne Ende gilt
 * als der eine Tag `from`.
 */
export function defaultDateInPeriod(from, to, today = todayKey()) {
  if (!from) return today;
  return (today >= from && today <= (to || from)) ? today : from;
}

/**
 * Wochenstart-Präferenz (haushaltweit) → JS-getDay()-Index (0=So … 6=Sa).
 * Unbekannte Werte fallen auf Montag (1) zurück, den bisherigen Fixwert.
 */
export const WEEK_START_INDEX = { monday: 1, sunday: 0, saturday: 6 };

export function weekStartIndex(value) {
  return WEEK_START_INDEX[value] ?? 1;
}

/**
 * Wochenende (Samstag/Sonntag) für einen Datums-Key, unabhängig davon, an
 * welcher Stelle der Tag in einem Anzeigeraster landet. Das Monatsgitter hat
 * das früher über die Spaltenposition gelöst (`:nth-child(7n)`/`7n-1`), was nur
 * bei Wochenstart Montag stimmte: bei Sonntag- oder Samstag-Start tönte es die
 * letzten beiden Spalten und damit die falschen Tage (#780).
 */
export function isWeekendKey(dateKey) {
  const day = parseLocalDateKey(dateKey).getDay();
  return day === 0 || day === 6;
}

/**
 * Liefert die sieben getDay()-Indizes in Anzeigereihenfolge für einen gegebenen
 * Wochenstart. `weekStart` darf ein Index (0/1/6) oder eine Präferenz ('monday'
 * …) sein. Beispiel: weekStart='sunday' → [0,1,2,3,4,5,6].
 */
export function weekdayOrder(weekStart = 1) {
  const start = typeof weekStart === 'number' ? weekStart : weekStartIndex(weekStart);
  return Array.from({ length: 7 }, (_, i) => (start + i) % 7);
}

/**
 * Verschiebt einen End-Datums-Key um dieselbe Tagesdifferenz, um die der Start
 * gewandert ist – so bleibt die Dauer eines Termins erhalten, wenn der Nutzer
 * das Startdatum ändert (analog zum Verhalten von Google Calendar).
 * @param {string} oldStartKey - vorheriges Startdatum (YYYY-MM-DD)
 * @param {string} newStartKey - neues Startdatum (YYYY-MM-DD)
 * @param {string} endKey      - aktuelles Enddatum (YYYY-MM-DD)
 * @returns {string} neues Enddatum (YYYY-MM-DD)
 */
export function shiftEndDateKey(oldStartKey, newStartKey, endKey) {
  const from = parseLocalDateKey(oldStartKey);
  const to = parseLocalDateKey(newStartKey);
  const deltaDays = Math.round((to.getTime() - from.getTime()) / 86400000);
  return addLocalDays(endKey, deltaDays);
}

/**
 * Prüft, ob ein Endzeitpunkt vor dem Startzeitpunkt liegt. Akzeptiert Werte im
 * Format "YYYY-MM-DD" oder "YYYY-MM-DDTHH:MM", wie sie der Termin-Dialog
 * erzeugt – auch gemischt (getimter Start, datumsreines Ende). Das Datum zählt
 * zuerst; die Uhrzeit nur bei gleichem Tag und nur, wenn beide eine Uhrzeit
 * tragen. Ein fehlendes Ende gilt nie als ungültig.
 * @param {string} startDatetime
 * @param {string|null|undefined} endDatetime
 * @returns {boolean}
 */
export function isEndBeforeStart(startDatetime, endDatetime) {
  if (!endDatetime) return false;
  const [startDay, startTime] = String(startDatetime).split('T');
  const [endDay, endTime] = String(endDatetime).split('T');
  if (endDay !== startDay) return endDay < startDay;
  if (startTime && endTime) return endTime < startTime;
  return false;
}
