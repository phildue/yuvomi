/**
 * Modul: Gesundheit (Health) - CSV-Export (Übersicht)
 * Zweck: Je Bereich ein GET-Endpunkt, der text/csv als Download liefert. Scoping
 *        und Visibility greifen identisch zu den List-Routen (careAwareClause,
 *        also einschliesslich betreuter Personen - #584);
 *        der optionale ?from=&to=-Zeitraum filtert auf das jeweilige Datumsfeld.
 *        Die CSV-Serialisierung liegt im testbaren Helfer
 *        server/services/health-export.js. Der Zyklus-Export liegt bewusst bei
 *        seinem Cluster (./cycle.js).
 */

import express from 'express';
import * as db from '../../db.js';
import { vitalsToCsv, activitiesToCsv, labsToCsv, medLogsToCsv } from '../../services/health-export.js';
import {
  log, viewerId, careAwareClause, attachResults,
  exportFilename, sendCsv, exportRange,
} from './helpers.js';

const router = express.Router();

// GET /export/vitals?user_id=&from=&to=
router.get('/export/vitals', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = careAwareClause('v', viewer, personId);
    const { from, to } = exportRange(req);
    const params = [...clause.params];
    let sql = `SELECT v.* FROM health_vitals v WHERE ${clause.sql}`;
    if (from) { sql += ' AND v.measured_at >= ?'; params.push(`${from}T00:00`); }
    if (to)   { sql += ' AND v.measured_at <= ?'; params.push(`${to}T23:59`); }
    sql += ' ORDER BY v.measured_at ASC, v.id ASC';

    const rows = db.get().prepare(sql).all(...params);
    sendCsv(res, exportFilename('vitals', from, to), vitalsToCsv(rows));
  } catch (err) {
    log.error('Error exporting vitals:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// GET /export/activities?user_id=&from=&to=
router.get('/export/activities', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = careAwareClause('a', viewer, personId);
    const { from, to } = exportRange(req);
    const params = [...clause.params];
    let sql = `SELECT a.* FROM health_activities a WHERE ${clause.sql}`;
    if (from) { sql += ' AND a.performed_at >= ?'; params.push(`${from}T00:00`); }
    if (to)   { sql += ' AND a.performed_at <= ?'; params.push(`${to}T23:59`); }
    sql += ' ORDER BY a.performed_at ASC, a.id ASC';

    const rows = db.get().prepare(sql).all(...params);
    sendCsv(res, exportFilename('activities', from, to), activitiesToCsv(rows));
  } catch (err) {
    log.error('Error exporting activities:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// GET /export/labs?user_id=&from=&to=
router.get('/export/labs', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = careAwareClause('r', viewer, personId);
    const { from, to } = exportRange(req);
    const params = [...clause.params];
    let sql = `SELECT r.* FROM health_lab_reports r WHERE ${clause.sql}`;
    if (from) { sql += ' AND r.report_date >= ?'; params.push(from); }
    if (to)   { sql += ' AND r.report_date <= ?'; params.push(to); }
    sql += ' ORDER BY r.report_date ASC, r.id ASC';

    const reports = db.get().prepare(sql).all(...params).map(attachResults);
    sendCsv(res, exportFilename('labs', from, to), labsToCsv(reports));
  } catch (err) {
    log.error('Error exporting labs:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// GET /export/meds-logs?user_id=&from=&to=
router.get('/export/meds-logs', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = careAwareClause('m', viewer, personId);
    const { from, to } = exportRange(req);
    const params = [...clause.params];
    let sql = `
      SELECT l.*, m.name AS medication_name FROM medication_logs l
      JOIN medications m ON m.id = l.medication_id
      WHERE ${clause.sql}`;
    // Gefiltert wird nach demselben Ausdruck, nach dem sortiert wird - und auf
    // Minuten zugeschnitten, weil `scheduled_at` Wanduhrzeit fuehrt und
    // `created_at` auf 'Z' endet. Eine Bedarfsdosis hat keinen Zeitplan; ueber
    // `l.scheduled_at` allein fiel sie aus jedem Zeitraum und stand damit in
    // keinem Auszug, den jemand seiner Aerztin hinlegt (#700).
    const WHEN = 'COALESCE(l.scheduled_at, l.taken_at, l.created_at)';
    if (from) { sql += ` AND substr(${WHEN}, 1, 16) >= ?`; params.push(`${from}T00:00`); }
    if (to)   { sql += ` AND substr(${WHEN}, 1, 16) <= ?`; params.push(`${to}T23:59`); }
    sql += ` ORDER BY ${WHEN} ASC, l.id ASC`;

    const rows = db.get().prepare(sql).all(...params);
    sendCsv(res, exportFilename('meds-logs', from, to), medLogsToCsv(rows));
  } catch (err) {
    log.error('Error exporting medication logs:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export default router;
