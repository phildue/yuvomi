/**
 * Modul: Gesundheit (Health) - geteilte Helfer
 * Zweck: Sichtbarkeits-/Scoping-Bausteine, Validierungs-/Update-Helfer sowie die
 *        CSV-Export-Bausteine, die von mehreren Cluster-Routern (vitals,
 *        medications, labs, activities, export, cycle) gemeinsam genutzt werden.
 *
 * Scoping/Visibility-Modell:
 *   - Jede Zeile gehört einem Nutzer (`user_id`, "Eigentümer").
 *   - Lesen: erlaubt für den Eigentümer ODER wenn `visibility = 'family'`.
 *   - Schreiben/Ändern/Löschen: ausschließlich der Eigentümer.
 *   - Verschachtelte Entitäten (Schedules/Logs, Lab-Results) erben Scoping/Visibility
 *     von ihrem Eltern-Datensatz (Medikament bzw. Befund).
 */

import { createLogger } from '../../logger.js';
import * as db from '../../db.js';

export const log = createLogger('Health');

export const VISIBILITIES = ['private', 'family'];
export const LOG_STATUS   = ['taken', 'skipped', 'pending'];
export const FLOW_LEVELS  = ['spotting', 'light', 'medium', 'heavy'];
export const MAX_UNIT     = 30;
export const MAX_SYMPTOMS = 300;

export function viewerId(req) {
  return req.authUserId || req.session.userId;
}

/**
 * Baut eine WHERE-Teilbedingung für Sichtbarkeit/Personen-Filter.
 * @param {string} alias         - Tabellen-Alias mit user_id + visibility
 * @param {number} viewer        - eingeloggter Nutzer
 * @param {number|null} personId  - optionaler Personen-Filter (?user_id=)
 * @returns {{ sql: string, params: any[] }}
 */
export function visibilityClause(alias, viewer, personId) {
  if (personId) {
    if (personId === viewer) return { sql: `${alias}.user_id = ?`, params: [viewer] };
    return { sql: `${alias}.user_id = ? AND ${alias}.visibility = 'family'`, params: [personId] };
  }
  return { sql: `(${alias}.user_id = ? OR ${alias}.visibility = 'family')`, params: [viewer] };
}

/** Koerziert einen Boolean/0/1-Wert zu 0|1 oder undefined (= nicht gesetzt). */
export function toBit(val) {
  if (val === undefined || val === null || val === '') return undefined;
  if (val === true  || val === 1 || val === '1' || val === 'true')  return 1;
  if (val === false || val === 0 || val === '0' || val === 'false') return 0;
  return undefined;
}

/** Führt ein partielles UPDATE mit einer Whitelist bereits validierter Felder aus. */
export function applyUpdate(table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  db.get().prepare(`UPDATE ${table} SET ${setSql} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}

/** Leitet ein Referenz-Flag (low/normal/high) ab, sofern nicht explizit gesetzt. */
export function deriveFlag(value, refLow, refHigh, provided) {
  if (provided) return provided;
  if (value === null || value === undefined) return null;
  if (refLow !== null && refLow !== undefined && value < refLow)  return 'low';
  if (refHigh !== null && refHigh !== undefined && value > refHigh) return 'high';
  if ((refLow !== null && refLow !== undefined) || (refHigh !== null && refHigh !== undefined)) return 'normal';
  return null;
}

export function badRequest(res, errors) {
  return res.status(400).json({ error: errors.join(' '), code: 400 });
}

/** Hängt die Analyt-Zeilen an einen Laborbefund an (geteilt von labs + export). */
export function attachResults(report) {
  if (!report) return report;
  report.results = db.get().prepare(
    'SELECT * FROM health_lab_results WHERE report_id = ? ORDER BY analyte COLLATE NOCASE ASC, id ASC'
  ).all(report.id);
  return report;
}

// --------------------------------------------------------
// CSV-Export-Bausteine (geteilt von export + cycle)
// --------------------------------------------------------

/** Baut den Dateinamen aus Bereich + optionalem Zeitraum. */
export function exportFilename(area, from, to) {
  const range = from && to ? `-${from}_${to}` : '';
  return `health-${area}${range}.csv`;
}

/** Sendet eine CSV-Nutzlast als Download (BOM für Excel). */
export function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${csv}`);
}

/** Liest optionale from/to-Query als YYYY-MM-DD (nur wenn plausibel). */
export function exportRange(req) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')   ? req.query.to   : null;
  return { from, to };
}
