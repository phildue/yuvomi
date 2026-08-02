import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { toggleRowHtml } from '/settings/components.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';

/**
 * Standardwerte, die nur für die eigenen neuen Termine gelten. `preferences.js`
 * schreibt beide Keys per `cfgUserSet` ausdrücklich pro Nutzer, das Blatt lag
 * aber im adminOnly-`modules-calendar` - 5 von 6 Familienmitgliedern kamen nie
 * an ihre eigenen Vorgaben (Critique 2026-07-27). Haushaltweites (Wochenstart,
 * Standarddauer, Feiertage) bleibt drüben.
 */

// Offsets in Minuten; Labels aus dem bestehenden reminders.offset*-Wortschatz.
const DEFAULT_REMINDER_OPTIONS = [
  { value: 0,     labelKey: 'reminders.offsetAtTime' },
  { value: 15,    labelKey: 'reminders.offset15min' },
  { value: 60,    labelKey: 'reminders.offset1hour' },
  { value: 1440,  labelKey: 'reminders.offset1day' },
  { value: 2880,  labelKey: 'reminders.offset2days' },
  { value: 10080, labelKey: 'reminders.offset1week' },
  { value: 20160, labelKey: 'reminders.offset2weeks' },
];
const MAX_DEFAULT_REMINDERS = 5;

// Kleiner lokaler Debounce (kein geteilter Util im Projekt): koaleziert schnelle
// Mehrfach-Auswahl zu einem einzigen Speichern + einem Toast.
function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function collectDefaultReminders(box) {
  return [...box.querySelectorAll('.js-default-reminder')]
    .filter((el) => el.checked)
    .map((el) => Number(el.value))
    .sort((a, b) => a - b);
}

function renderPage(container, preferences) {
  const selected = new Set(
    Array.isArray(preferences.calendar_default_reminders)
      ? preferences.calendar_default_reminders.map(Number)
      : [],
  );
  const assignMe = !!preferences.calendar_default_assign_me;
  const checkboxes = DEFAULT_REMINDER_OPTIONS.map((option) => `
    <label class="reminder-preset">
      <input type="checkbox" class="js-default-reminder" value="${option.value}"${selected.has(option.value) ? ' checked' : ''}>
      <span>${esc(t(option.labelKey))}</span>
    </label>`).join('');

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.calendarSectionEvents')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.calendarDefaultsTitle')}</h3>
        <p class="settings-card-description">${t('settings.calendarDefaultsDescription')}</p>

        <div class="form-group">
          ${toggleRowHtml({
            label: t('settings.calendarAssignMeLabel'),
            checked: assignMe,
            attrs: { id: 'calendar-default-assign-me' },
          })}
        </div>

        <div class="form-group">
          <span class="form-label" id="calendar-default-reminders-label">${t('settings.calendarDefaultRemindersLabel')}</span>
          <p class="settings-card-description">${t('settings.calendarDefaultRemindersHint')}</p>
          <div id="calendar-default-reminders" class="reminder-preset-group" role="group" aria-labelledby="calendar-default-reminders-label">
            ${checkboxes}
          </div>
        </div>

        <p class="form-hint">${t('settings.calendarDefaultsScopeHint')}</p>
      </div>
    </section>
  `);
}

// Instant-Save: ein einzelner Wert braucht keinen separaten Speichern-Button.
function bindEvents(container) {
  const assignMe = container.querySelector('#calendar-default-assign-me');
  assignMe?.addEventListener('change', async () => {
    const value = assignMe.checked;
    assignMe.disabled = true;
    try {
      await savePreferences({ calendar_default_assign_me: value });
      window.yuvomi?.showToast(t('settings.calendarDefaultsSaved'), 'success');
    } catch (error) {
      assignMe.checked = !value; // Rollback
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      if (assignMe.isConnected) assignMe.disabled = false;
    }
  });

  const remindersBox = container.querySelector('#calendar-default-reminders');
  if (!remindersBox) return;
  let persisted = collectDefaultReminders(remindersBox);

  // Debounced: schnelle Mehrfach-Auswahl erzeugt EIN Speichern + EINEN Toast,
  // statt einen pro Klick. Rollback auf den letzten persistierten Stand bei Fehler.
  const persistReminders = debounce(async () => {
    const selected = collectDefaultReminders(remindersBox);
    try {
      await savePreferences({ calendar_default_reminders: selected });
      persisted = selected;
      if (remindersBox.isConnected) window.yuvomi?.showToast(t('settings.calendarDefaultsSaved'), 'success');
    } catch (error) {
      const keep = new Set(persisted);
      remindersBox.querySelectorAll('.js-default-reminder').forEach((el) => {
        el.checked = keep.has(Number(el.value));
      });
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    }
  }, 500);

  remindersBox.addEventListener('change', (event) => {
    const box = event.target.closest('.js-default-reminder');
    if (!box) return;
    if (collectDefaultReminders(remindersBox).length > MAX_DEFAULT_REMINDERS) {
      box.checked = false; // Cap: die gerade gesetzte Auswahl zurücknehmen
      window.yuvomi?.showToast(t('settings.calendarDefaultRemindersMax', { count: MAX_DEFAULT_REMINDERS }), 'warning');
      return;
    }
    persistReminders();
  });
}

export async function render(container, { user }) {
  void user;
  const preferences = await getPreferences();
  renderPage(container, preferences);
  bindEvents(container);
}
