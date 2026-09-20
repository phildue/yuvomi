import { getLocale } from '/i18n.js';
import { CURRENCY_CODES } from '/utils/currency-codes.js';

export async function persistCurrencySelection(select, previousCurrency, save) {
  select.disabled = true;
  try {
    await save();
  } catch (error) {
    select.value = previousCurrency;
    throw error;
  } finally {
    select.disabled = false;
  }
}

export function appendCurrencyOptions(select, selectedCurrency) {
  let displayNames = null;
  try {
    displayNames = new Intl.DisplayNames([getLocale()], { type: 'currency' });
  } catch {
    // Currency codes remain usable when DisplayNames is unavailable.
  }

  for (const currency of CURRENCY_CODES) {
    const option = document.createElement('option');
    option.value = currency;
    const displayName = displayNames?.of(currency);
    option.textContent = displayName ? `${currency} - ${displayName}` : currency;
    option.selected = currency === selectedCurrency;
    select.appendChild(option);
  }
}
