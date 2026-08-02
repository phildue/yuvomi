/**
 * Geldbeträge im Budget-Modul: EINE Quelle für Format, Vorzeichen und Farbe.
 *
 * Vorher gab es drei Formatierer (budget.js, subscriptions.js, split-expenses.js)
 * und vier Vorzeichenkonventionen. Dieselbe Zahl konnte dadurch in zwei Untertabs
 * verschieden geschrieben sein - bei Geld ist das kein Stilproblem, sondern ein
 * Vertrauensproblem (Critique 2026-07-30, P0).
 *
 * Der Kern ist nicht der Formatierer, sondern das ROLLEN-Vokabular: jeder Betrag
 * im Modul gehört zu genau einer der vier Rollen, und die Rolle entscheidet
 * Vorzeichen und Farbe gemeinsam. Wer einen neuen Betrag rendert, wählt eine
 * Rolle - er erfindet keine fünfte Schreibweise.
 *
 * | Rolle       | Vorzeichen        | Farbe            | Wofür |
 * |-------------|-------------------|------------------|-------|
 * | `flow`      | immer (+ und -)   | nach Vorzeichen  | eine einzelne Kontobewegung: Buchung, Darlehensrate |
 * | `total`     | nie               | vom Aufrufer     | eine Summe, deren Richtung schon im Label steht („Ausgaben") |
 * | `balance`   | nur bei negativ   | nach Vorzeichen  | Saldo, Nettovermögen, „Du schuldest" |
 * | `plain`     | nie               | keine            | ein Rechnungsbetrag ohne Kontorichtung: Abo-Preis, Darlehenshöhe |
 *
 * Warum `plain` für geteilte Ausgaben und `flow` für Budget-Einträge: eine
 * geteilte Ausgabe ist ein Rechnungsposten der Gruppe, keine Bewegung auf dem
 * Konto des Betrachters - wer sie ausgelegt hat, hat eine Forderung, kein Minus.
 * Die Unterscheidung ist damit eine benannte Entscheidung statt eines Zufalls.
 */

import { getNumberFormat } from '/i18n.js';

/** Erlaubte Rollen. Wird vom Guard in test-budget-ui.js gegen die Aufrufe geprüft. */
export const MONEY_ROLES = ['flow', 'total', 'balance', 'plain'];

/**
 * Reiner Betrag ohne Rollenlogik. Nur benutzen, wenn wirklich kein Vorzeichen
 * und keine Farbe im Spiel sind (Achsenbeschriftung, Tooltip, CSV).
 */
export function formatMoney(amount, currency) {
  return getNumberFormat({ style: 'currency', currency }).format(Number(amount) || 0);
}

/**
 * Betrag nach Rolle. Liefert Text, Ton und die passende Modifier-Klasse
 * gemeinsam, damit Vorzeichen und Farbe nie auseinanderlaufen können.
 *
 * @param {number} amount
 * @param {object} options
 * @param {string} options.currency  ISO-Code, z. B. 'EUR'
 * @param {'flow'|'total'|'balance'|'plain'} options.role
 * @param {'positive'|'negative'|'neutral'} [options.tone]  nur bei role 'total':
 *        die Richtung steht dort im Label, nicht im Vorzeichen.
 * @param {string} [options.block]  BEM-Block für die Modifier-Klasse,
 *        z. B. 'budget-entry__amount' -> 'budget-entry__amount--income'
 * @returns {{ text: string, tone: 'positive'|'negative'|'neutral', className: string }}
 */
export function formatSignedAmount(amount, { currency, role, tone, block } = {}) {
  const value = Number(amount) || 0;

  // `exceptZero` statt manuellem '+'-Prefix: das Vorzeichen gehört ins
  // Zahlformat, sonst steht es in RTL-Locales auf der falschen Seite.
  const signDisplay = role === 'flow'
    ? 'exceptZero'
    : 'auto';

  const magnitude = (role === 'total' || role === 'plain') ? Math.abs(value) : value;
  const text = getNumberFormat({ style: 'currency', currency, signDisplay }).format(magnitude);

  const resolvedTone = resolveTone(value, role, tone);
  return { text, tone: resolvedTone, className: block ? `${block}--${resolvedTone}` : '' };
}

function resolveTone(value, role, tone) {
  if (role === 'plain') return 'neutral';
  if (role === 'total') return tone || 'neutral';
  // flow und balance: die Zahl selbst trägt die Richtung.
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}
