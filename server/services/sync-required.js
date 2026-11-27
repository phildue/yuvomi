/**
 * Modul: "Sync erforderlich" - Schalter und Standardziele (Fork)
 * Zweck: Ein Haushalt, der alles in einen externen Kalender spiegelt (Nextcloud,
 *        Google, Outlook), will keinen Termin und keine Aufgabe nur lokal
 *        anlegen - auch nicht aus Versehen. Die Erstellrouten fragen hier, ob der
 *        Schalter an ist und welche Ziele sie einsetzen koennen. Gewaehlt wird
 *        mit der Pruefung der Route selbst (angeboten, schreibbar), nicht hier.
 * Abhaengigkeiten: sync_config (Schluessel/Wert, wie die Einstellungs-Registry)
 */

/** Antwort der Erstellrouten, wenn kein Ziel zu finden ist (Fallcode, #1909). */
export const SYNC_TARGET_REQUIRED = Object.freeze({
  error: 'A sync target is required: choose a calendar or list, or set a default in the settings.',
  code: 400,
  reason: 'sync_target_required',
});

/**
 * @param {{ prepare: (sql: string) => { get: (...args: unknown[]) => unknown } }} database
 * @param {string} key
 * @returns {string}
 */
function read(database, key) {
  const row = /** @type {{ value?: string } | undefined} */ (
    database.prepare('SELECT value FROM sync_config WHERE key = ?').get(key));
  return (row?.value ?? '').trim();
}

/**
 * Ist der Haushalt auf "Sync erforderlich" gestellt?
 * @param {{ prepare: (sql: string) => { get: (...args: unknown[]) => unknown } }} database
 * @returns {boolean}
 */
export function isSyncRequired(database) {
  return read(database, 'sync_required') === '1';
}

/**
 * Die Ziele, die eine Erstellroute der Reihe nach versucht: das eigene
 * Standardziel des Nutzers, dann das des Haushalts. Leere Werte entfallen, ein
 * Wert steht nur einmal.
 * @param {{ prepare: (sql: string) => { get: (...args: unknown[]) => unknown } }} database
 * @param {'calendar' | 'tasks'} kind
 * @param {number} userId
 * @returns {string[]}
 */
export function targetCandidates(database, kind, userId) {
  const own = read(database, `${kind}_default_target:user:${userId}`);
  const household = read(database, `${kind}_household_target`);
  return [...new Set([own, household].filter(Boolean))];
}
