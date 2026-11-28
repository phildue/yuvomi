/**
 * Modul: Einstellungen "Sync erforderlich" (Fork)
 * Zweck: Die Zeilen des Abschnitts "Sync erforderlich" auf dem Sync-Blatt (die
 *        Ueberschrift steht statisch im Blatt, damit die Suche sie findet): ein Schalter, der kein
 *        Termin- und kein Aufgabenanlegen mehr nur lokal zulaesst, und die zwei
 *        Standardziele, die der Server einsetzt, wenn jemand keines gewaehlt hat
 *        (server/services/sync-required.js). Das Blatt ist adminOnly; die
 *        Felder stehen in der Registry als Haushaltswerte (nur ein Admin schreibt).
 * Abhaengigkeiten: utils/sync-target.js (Kennungsformat), settings/preferences-cache.js
 */

import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { buildSyncTargetOptions, caldavTargetValue, SYNC_TARGET_LOCAL } from '/utils/sync-target.js';
import { settingRowHtml, settingSwitchRowHtml } from '/settings/components.js';
import { savePreferences } from '/settings/preferences-cache.js';
import { errorSentence } from '/utils/friendly-error.js';

/**
 * <option>/<optgroup>-Markup einer Optionsliste (`{value, label, group}`).
 * @param {Array<{value: string, label: string, group: string | null}>} options
 * @param {string} current
 * @returns {string}
 */
function optionsHtml(options, current) {
  let html = '';
  let openGroup = null;
  for (const option of options) {
    if (option.group !== openGroup) {
      if (openGroup) html += '</optgroup>';
      openGroup = option.group;
      if (openGroup) html += `<optgroup label="${esc(openGroup)}">`;
    }
    const selected = option.value === current ? ' selected' : '';
    html += `<option value="${esc(option.value)}"${selected}>${esc(option.label)}</option>`;
  }
  if (openGroup) html += '</optgroup>';
  return html;
}

/**
 * Optionen des Aufgabenfeldes: die Erinnerungslisten (nur CalDAV), "kein
 * Standard" als leere Option, ein gespeichertes, nicht mehr angebotenes Ziel
 * nachgetragen. Bewusst nicht aus pages/personal-tasks.js importiert: ein
 * statischer Import machte dieses Blatt zu einem geteilten Chunk, und es fiele
 * aus der Precache-Liste des Service Workers (test:sw-precache).
 * @param {any[]} lists
 * @param {{local: string, unavailable: string}} labels
 * @param {string} current
 * @returns {Array<{value: string, label: string, group: string | null}>}
 */
function taskListOptions(lists, labels, current) {
  const options = [{ value: SYNC_TARGET_LOCAL, label: labels.local, group: null }];
  for (const list of lists) {
    options.push({ value: caldavTargetValue(list.accountId, list.listUrl), label: list.listName || list.listUrl, group: list.accountName });
  }
  if (current && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: labels.unavailable, group: null });
  }
  return options;
}

/**
 * @param {{
 *   preferences: Record<string, any>,
 *   calendarTargets: {google?: any[], caldav?: any[], outlook?: any[]} | null,
 *   taskLists: any[] | null,
 * }} data  `calendarTargets`/`taskLists` aus GET /calendar/sync-targets und /tasks/sync-targets
 * @returns {string}
 */
export function syncRequiredSectionHtml({ preferences, calendarTargets, taskLists }) {
  const calendarCurrent = preferences.calendar_household_target || '';
  const tasksCurrent = preferences.tasks_household_target || '';
  const noDefault = t('settings.syncRequiredNoDefault');
  const unavailable = t('settings.calendarDefaultTargetUnavailable');

  const calendarOptions = buildSyncTargetOptions(calendarTargets ?? {}, {
    outlook: t('calendar.syncTargetOutlookGroup'),
    local: noDefault,
    google: t('calendar.syncTargetGoogleGroup'),
    caldav: t('calendar.syncTargetCaldavGroup'),
    unavailable,
  }, calendarCurrent);
  const taskOptions = taskListOptions(taskLists ?? [], { local: noDefault, unavailable }, tasksCurrent);

  return `
      <div class="row-carrier settings-group">
        ${settingSwitchRowHtml({
          label: t('settings.syncRequiredLabel'),
          checked: preferences.sync_required === true,
          description: t('settings.syncRequiredHint'),
          descriptionId: /** @type {any} */ ('sync-required-hint'),
          attrs: { id: 'sync-required-switch' },
        })}
        ${settingRowHtml({
          label: t('settings.syncRequiredCalendarTargetLabel'),
          labelFor: 'sync-required-calendar-target',
          description: t('settings.syncRequiredTargetHint'),
          control: `<select id="sync-required-calendar-target" class="form-input">${optionsHtml(calendarOptions, calendarCurrent)}</select>`,
        })}
        ${settingRowHtml({
          label: t('settings.syncRequiredTasksTargetLabel'),
          labelFor: 'sync-required-tasks-target',
          description: t('settings.syncRequiredTargetHint'),
          control: `<select id="sync-required-tasks-target" class="form-input">${optionsHtml(taskOptions, tasksCurrent)}</select>`,
        })}
      </div>`;
}

/**
 * Jede Aenderung speichert genau ihr Feld; scheitert das Speichern, springt das
 * Feld auf den zuletzt gespeicherten Wert zurueck.
 * @param {any} control  Schalter oder Auswahlfeld (oder null, wenn es fehlt)
 * @param {string} field  das Feld von PUT /preferences
 * @param {(control: any) => unknown} read
 * @param {(control: any, value: any) => void} restore
 */
function bindControl(control, field, read, restore) {
  if (!control) return;
  let persisted = read(control);
  control.addEventListener('change', async () => {
    const value = read(control);
    control.disabled = true;
    try {
      await savePreferences({ [field]: value });
      persisted = value;
      window.yuvomi?.showToast(t('settings.calendarDefaultsSaved'), 'success');
    } catch (error) {
      restore(control, persisted);
      window.yuvomi?.showToast(errorSentence(error, 'settings.preferenceSaveFailed'), 'danger');
    } finally {
      if (control.isConnected) control.disabled = false;
    }
  });
}

/** @param {{ querySelector: (selector: string) => any }} container */
export function bindSyncRequiredSection(container) {
  const setValue = (/** @type {any} */ control, /** @type {string} */ value) => { control.value = value; };
  const readValue = (/** @type {any} */ control) => control.value;
  bindControl(container.querySelector('#sync-required-switch'), 'sync_required',
    (/** @type {any} */ control) => control.checked, (/** @type {any} */ control, /** @type {boolean} */ value) => { control.checked = value; });
  bindControl(container.querySelector('#sync-required-calendar-target'), 'calendar_household_target', readValue, setValue);
  bindControl(container.querySelector('#sync-required-tasks-target'), 'tasks_household_target', readValue, setValue);
}
