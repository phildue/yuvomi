/**
 * Modul: Countdown-Formulierung (#647)
 * Zweck: Aus „so viele Tage sind es noch" die Formulierung machen, die man
 *        einem Menschen hinschreibt - grob, solange es weit weg ist, exakt,
 *        sobald es nah ist.
 * Abhängigkeiten: keine
 *
 * WARUM GROB UND EXAKT UND NICHT NUR TAGE. @Kyrodan hat es im Thread
 * ausformuliert: „1.247 Tage bis der Mobilfunkvertrag ausläuft" ist eine Zahl,
 * die niemand liest - „ca. 3 Jahre" ist die Antwort auf dieselbe Frage. Er hat
 * dazu Schwellwerte als Einstellung vorgeschlagen; die gibt es hier bewusst
 * nicht. Eine Frage, die man beim Einrichten stellt, damit die Anzeige nachher
 * stimmt, ist eine Frage, die niemand beantworten will.
 *
 * WARUM DIE UMSCHALTUNG BEI 30 TAGEN LIEGT UND NICHT SPAETER. Der Maintainer
 * hat im Thread die Grenze benannt, die das Ganze tragen muss: „10 Tage bis der
 * Führerschein abläuft" MUSS zehn Tage bleiben und darf nicht zu „ca. 2 Wochen"
 * werden - in dem Moment ist die genaue Zahl der ganze Zweck. Alles bis
 * einschliesslich 30 Tage bleibt deshalb exakt; erst darüber wird gerundet.
 *
 * Diese Datei hat keine Importe und kein `t()`: sie liefert den Locale-Schlüssel
 * und die Zahl, die Formulierung selbst liegt in den Locales. So ist die Regel
 * in node testbar (test/test-countdown.js), ohne i18n zu laden.
 */

// Bis hierher wird nicht gerundet. Siehe Kopf.
export const COUNTDOWN_EXACT_DAYS = 30;

/**
 * Der Dringlichkeitsrang einer Tagesdifferenz - der Kanal, den die Farbe
 * bekommt.
 *
 * WARUM DIE FARBE HIER UND NICHT AN DER HERKUNFT HAENGT. Bis zur Critique vom
 * 2026-08-17 faerbte die Kachel ihre Zahl mit der Farbe des TERMINS. Damit
 * kodierte der lauteste Kanal die Herkunft, die das Zeichen daneben ohnehin
 * traegt, und der Zweck der Kachel - „wie bald" - lag auf dem leisesten. In
 * einer Messung las die Kachel „Heute / Heute / Heute / Morgen / Morgen": fuenf
 * Zeilen, zwei Werte, keine Rangfolge, und die lauteste Zeile war die mit der
 * dunkelsten Kalenderfarbe. Die Herkunftsfarbe bleibt, wo sie hingehoert - auf
 * der Zeichenscheibe links.
 *
 * Vier Raenge und nicht mehr: `overdue` (vorbei, in der Nachfrist), `now`
 * (heute/morgen), `soon` (bis 30 Tage, also der exakt gezaehlte Bereich) und
 * `later`. Die Grenze bei 30 ist keine zweite Zahl, sondern dieselbe, an der
 * auch die Formulierung von exakt auf grob schaltet - eine Kachel mit zwei
 * verschiedenen Vorstellungen von „nah" haette zwei Wahrheiten.
 *
 * @param {number} days
 * @returns {'overdue'|'now'|'soon'|'later'}
 */
export function countdownRank(days) {
  const d = Math.trunc(Number(days) || 0);
  if (d < 0) return 'overdue';
  if (d <= 1) return 'now';
  if (d <= COUNTDOWN_EXACT_DAYS) return 'soon';
  return 'later';
}
// Ab hier ist „ca. N Wochen" gröber als nötig: 61 Tage sind zwei Monate.
export const COUNTDOWN_WEEKS_UNTIL = 60;
// Ab einem Jahr zählt niemand mehr Monate.
export const COUNTDOWN_MONTHS_UNTIL = 364;

// Mittlere Längen, nicht 30 und 365: bei „ca." ist die Rundung sowieso die
// Aussage, aber über drei Jahre summiert sich ein 30-Tage-Monat auf gut einen
// Monat Fehler - und das fällt genau in der Sorte Countdown auf, die über Jahre
// läuft (Vertrag, Führerschein).
const DAYS_PER_MONTH = 30.44;
const DAYS_PER_YEAR = 365.25;

/**
 * Ganze Tage zwischen zwei lokalen Datumsschlüsseln (YYYY-MM-DD).
 *
 * Über Date.UTC gerechnet und NICHT über lokale Date-Objekte: die Differenz
 * zweier lokaler Mitternachten ist an einer Zeitumstellung 23 oder 25 Stunden
 * lang, und `/86400000` macht daraus 0,96 bzw. 1,04 Tage. Gerundet fiele das
 * nicht auf - bis eine Sommerzeitgrenze im Zeitraum liegt und der Countdown
 * einen Tag springt. Dieselbe Rechnung wie in services/birthdays.js.
 *
 * @param {string} fromKey  YYYY-MM-DD (heute)
 * @param {string} toKey    YYYY-MM-DD (das Ziel)
 * @returns {number|null}   Ganze Tage; negativ, wenn das Ziel vorbei ist
 */
export function daysBetweenDateKeys(fromKey, toKey) {
  const from = parseKey(fromKey);
  const to = parseKey(toKey);
  if (from === null || to === null) return null;
  return Math.round((to - from) / 86400000);
}

function parseKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? '').slice(0, 10));
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * Der Locale-Schlüssel samt Zahl für eine Tagesdifferenz.
 *
 * Heute und morgen bekommen ihre eigenen Wörter, weil „in 0 Tagen" keine
 * Formulierung ist. Sie tragen kein `count`: `common.today`/`common.tomorrow`
 * sind fertige Wörter, keine Zählformen.
 *
 * @param {number} days  Ganze Tage bis zum Ziel; negativ, wenn es vorbei ist
 *                       (der Server liefert das eine Nachfrist lang mit)
 * @returns {{key: string, count?: number}}
 */
export function countdownPhrase(days) {
  const raw = Math.trunc(Number(days) || 0);
  // Vorbei, aber noch in der Nachfrist (#647, Critique 2026-08-17): der Fall,
  // fuer den das Feature gebaut wurde, verlor bis hierher seine Anzeige genau in
  // dem Moment, in dem die Konsequenz beginnt. „Seit 3 Tagen abgelaufen" ist
  // dieselbe Frage wie „noch 3 Tage", nur auf der anderen Seite des Stichtags.
  if (raw < 0) return { key: 'dashboard.countdownOverdue', count: -raw };
  const d = Math.max(0, raw);
  if (d === 0) return { key: 'common.today' };
  if (d === 1) return { key: 'common.tomorrow' };
  if (d <= COUNTDOWN_EXACT_DAYS) return { key: 'dashboard.daysLeft', count: d };
  if (d <= COUNTDOWN_WEEKS_UNTIL) return { key: 'dashboard.countdownWeeks', count: Math.round(d / 7) };
  if (d <= COUNTDOWN_MONTHS_UNTIL) {
    return { key: 'dashboard.countdownMonths', count: Math.round(d / DAYS_PER_MONTH) };
  }
  // Math.max(1, …) für den Rand: 365 Tage sind 0,999 Jahre und dürfen nicht als
  // „ca. 0 Jahre" herauskommen.
  return { key: 'dashboard.countdownYears', count: Math.max(1, Math.round(d / DAYS_PER_YEAR)) };
}
