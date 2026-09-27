/**
 * Modul: Inventar – geteilte Routen-Helfer
 * Zweck: Slug/Key-Erzeugung fuer Kategorien (Budget-Kategorien nutzen dasselbe
 *        Muster in server/routes/budget/helpers.js - hier lokal nachgebaut statt
 *        modulfremd importiert, damit Inventar nicht von Budgets Routen-Internas
 *        abhaengt).
 */

import * as db from '../../db.js';

export function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'category';
}

/**
 * Erzeugt einen eindeutigen Key aus einem Anzeigenamen (z. B. "Elektronik" ->
 * "elektronik"), haengt bei Kollision "_2", "_3" ... an. Gleiches Muster wie
 * server/routes/budget/helpers.js#uniqueKey, hier lokal statt modulfremd
 * importiert.
 */
export function uniqueKey(table, base) {
  const normalized = slugify(base);
  let key = normalized;
  let i = 2;
  const exists = db.get().prepare(`SELECT 1 FROM ${table} WHERE key = ?`);
  while (exists.get(key)) {
    key = `${normalized}_${i}`;
    i += 1;
  }
  return key;
}
