/**
 * Modul: Einstellungen "Sync erforderlich" (Fork)
 * Zweck: Der Abschnitt des Haushalts auf dem Sync-Blatt: ein Schalter, der kein
 *        Termin- und kein Aufgabenanlegen mehr nur lokal zulaesst, und die zwei
 *        Standardziele, die der Server einsetzt, wenn jemand keines gewaehlt hat
 *        (server/services/sync-required.js). Das Blatt ist adminOnly; die
 *        Felder stehen in der Registry als Haushaltswerte (nur ein Admin schreibt).
 * Abhaengigkeiten: utils/sync-target.js (Kennungsformat), pages/personal-tasks.js
 *        (Optionen der Erinnerungslisten), settings/preferences-cache.js
 */

import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { buildSyncTargetOptions } from '/utils/sync-target.js';
import { reminderTargetOptions } from './personal-tasks.js';
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
  const taskOptions = reminderTargetOptions(taskLists ?? [], { local: noDefault, unavailable }, tasksCurrent);

  return `
    <section class="settings-section" id="sync-required-section">
      <h2 class="settings-section__title">${esc(t('settings.syncRequiredTitle'))}</h2>
      <div class="row-carrier settings-group">
        ${settingSwitchRowHtml({
          label: t('settings.syncRequiredLabel'),
          checked: preferences.sync_required === true,
          description: t('settings.syncRequiredHint'),
          descriptionId: 'sync-required-hint',
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
      </div>
    </section>`;
}

/**
 * Jede Aenderung speichert genau ihr Feld; scheitert das Speichern, springt das
 * Feld auf den zuletzt gespeicherten Wert zurueck.
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
  const setValue = (control, value) => { control.value = value; };
  bindControl(container.querySelector('#sync-required-switch'), 'sync_required',
    (control) => control.checked, (control, value) => { control.checked = value; });
  bindControl(container.querySelector('#sync-required-calendar-target'), 'calendar_household_target',
    (control) => control.value, setValue);
  bindControl(container.querySelector('#sync-required-tasks-target'), 'tasks_household_target',
    (control) => control.value, setValue);
}
