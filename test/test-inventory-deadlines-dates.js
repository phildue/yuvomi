/**
 * Test: Garantie-Datumsrechnung (Stufe 4)
 * Zweck: Reine Funktionen, an denen Erinnerungs-Termin und ICS-Feed hängen -
 *        Monats-Addition mit Tages-Klemmung (wie server/services/subscriptions.js
 *        #addBillingCycle), Erinnerungs-Vorlauf.
 * Ausführen: node --test test/test-inventory-deadlines-dates.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { warrantyEndDate, reminderDateForWarranty } from '../server/services/inventory-deadlines.js';

test('warrantyEndDate addiert Monate exakt', () => {
  assert.equal(warrantyEndDate('2026-01-15', 24), '2028-01-15');
});

test('warrantyEndDate klemmt auf den letzten Tag eines kürzeren Zielmonats', () => {
  assert.equal(warrantyEndDate('2026-01-31', 1), '2026-02-28');
  assert.equal(warrantyEndDate('2024-01-31', 1), '2024-02-29'); // Schaltjahr
});

test('warrantyEndDate mit 0 Monaten gibt das Kaufdatum zurück', () => {
  assert.equal(warrantyEndDate('2026-03-01', 0), '2026-03-01');
});

test('warrantyEndDate wirft bei ungültigem Kaufdatum', () => {
  assert.throws(() => warrantyEndDate('not-a-date', 12));
});

test('reminderDateForWarranty zieht den Standard-Vorlauf von 30 Tagen ab', () => {
  assert.equal(reminderDateForWarranty('2026-06-30'), '2026-05-31T09:00');
});

test('reminderDateForWarranty erlaubt einen anderen Vorlauf', () => {
  assert.equal(reminderDateForWarranty('2026-06-30', 7), '2026-06-23T09:00');
});

test('reminderDateForWarranty rechnet über einen Jahreswechsel', () => {
  assert.equal(reminderDateForWarranty('2027-01-05', 30), '2026-12-06T09:00');
});
