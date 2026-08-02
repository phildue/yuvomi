/**
 * Shared sticky sub-tab bar (pill-style).
 * Used by kitchen modules and settings; extend to any future sub-module nav.
 *
 * @param {HTMLElement} anchorEl  - element relative to which the bar is inserted
 * @param {object}      opts
 * @param {Array<{id: string, label: string, icon?: string, separatorBefore?: boolean}>} opts.tabs
 * @param {string}      opts.activeId          - initially active tab id
 * @param {Function}    opts.onChange          - called with new id on tab switch
 * @param {string}      [opts.storageKey]      - sessionStorage key for persistence
 * @param {string}      [opts.extraClass]      - additional CSS class on bar element
 * @param {string}      [opts.ariaLabel]
 * @param {string}      [opts.title]           - optional visible module title (left of the tabs).
 *                                               Decorative (aria-hidden): the tablist's ariaLabel
 *                                               already names the cluster for assistive tech.
 * @param {InsertPosition} [opts.insertPosition='afterbegin']
 * @returns {HTMLElement} the rendered bar element
 */
import { wireScrollFade } from '/utils/ux.js';

let subTabsCounter = 0;

export function renderSubTabs(anchorEl, {
  tabs,
  activeId,
  onChange,
  storageKey,
  extraClass,
  ariaLabel,
  title,
  insertPosition = 'afterbegin',
}) {
  let current = activeId;

  if (storageKey) {
    try { sessionStorage.setItem(storageKey, current); } catch { /* ignore */ }
  }

  const bar = document.createElement('div');
  const barId = `sub-tabs-${++subTabsCounter}`;
  bar.className = 'sub-tabs-bar' + (extraClass ? ' ' + extraClass : '');
  bar.setAttribute('role', 'tablist');
  if (ariaLabel) bar.setAttribute('aria-label', ariaLabel);

  // Optionaler Modul-Titel links der Tabs (Canonical Page Head). Dekorativ:
  // aria-hidden, da die Tablist via aria-label denselben Namen bereits trägt;
  // role="tablist" exponiert dadurch weiterhin nur die Tabs.
  if (title) {
    const titleEl = document.createElement('span');
    titleEl.className = 'sub-tabs-bar__title u-toolbar-title';
    titleEl.setAttribute('aria-hidden', 'true');
    titleEl.textContent = title;
    bar.appendChild(titleEl);
  }

  for (const { id, label, icon, separatorBefore } of tabs) {
    if (separatorBefore) {
      const sep = document.createElement('span');
      sep.className = 'sub-tabs-separator';
      sep.setAttribute('aria-hidden', 'true');
      bar.appendChild(sep);
    }

    const btn = document.createElement('button');
    const safeId = safeDomId(id);
    const tabId = `${barId}-tab-${safeId}`;
    const panelId = `${barId}-panel-${safeId}`;
    btn.type = 'button';
    btn.id = tabId;
    btn.className = 'sub-tab' + (id === current ? ' sub-tab--active' : '');
    btn.dataset.tabId = id;
    btn.dataset.panelId = panelId;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', id === current ? 'true' : 'false');
    btn.setAttribute('aria-controls', panelId);
    btn.tabIndex = id === current ? 0 : -1;

    if (icon) {
      const i = document.createElement('i');
      i.dataset.lucide = icon;
      i.className = 'sub-tab__icon';
      i.setAttribute('aria-hidden', 'true');
      btn.appendChild(i);
    }

    const span = document.createElement('span');
    span.className = 'sub-tab__label';
    span.textContent = label;
    btn.appendChild(span);

    // Zustands-Slot. Immer angelegt, auch leer: die Zahl kommt asynchron nachgeladen
    // (siehe setSubTabBadge), und ein Slot, der erst dann entsteht, würde die Leiste
    // nachträglich verbreitern und den aktiven Tab wegschieben.
    const badge = document.createElement('span');
    badge.className = 'sub-tab__badge';
    badge.hidden = true;
    btn.appendChild(badge);

    bar.appendChild(btn);
  }

  // Auf schmalen Viewports überläuft die Leiste; der aktive Tab muss dann
  // sichtbar sein, sonst wirkt die Seite tab-los (Audit A2-18). block:'nearest'
  // hält den vertikalen Seiten-Scroll unangetastet.
  const scrollActiveIntoView = () => {
    bar.querySelector('.sub-tab--active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  };

  const activateTab = (tabId, { focus = false } = {}) => {
    if (!tabId || tabId === current) return;

    current = tabId;

    if (storageKey) {
      try { sessionStorage.setItem(storageKey, current); } catch { /* ignore */ }
    }

    bar.querySelectorAll('[data-tab-id]').forEach((b) => {
      const active = b.dataset.tabId === current;
      b.classList.toggle('sub-tab--active', active);
      b.setAttribute('aria-selected', String(active));
      b.tabIndex = active ? 0 : -1;
      if (active && focus) b.focus();
    });
    scrollActiveIntoView();
    syncTabPanels(anchorEl, bar, current);

    onChange(current);
  };

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab-id]');
    if (!btn) return;

    activateTab(btn.dataset.tabId);
  });

  bar.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;

    const buttons = [...bar.querySelectorAll('[data-tab-id]')];
    const focusedIndex = buttons.indexOf(document.activeElement);
    const currentIndex = Math.max(0, buttons.findIndex((btn) => btn.dataset.tabId === current));
    const index = focusedIndex >= 0 ? focusedIndex : currentIndex;
    let nextIndex = index;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIndex = (index + 1) % buttons.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIndex = (index - 1 + buttons.length) % buttons.length;
    if (e.key === 'Home') nextIndex = 0;
    if (e.key === 'End') nextIndex = buttons.length - 1;

    e.preventDefault();
    activateTab(buttons[nextIndex]?.dataset.tabId, { focus: true });
  });

  anchorEl.insertAdjacentElement(insertPosition, bar);
  syncTabPanels(anchorEl, bar, current);
  // Scroll-Affordanz (geteilte has-fade-Masken, filter-chip.css) + der via
  // storageKey restaurierte Tab kann jenseits des sichtbaren Bereichs liegen.
  wireScrollFade(bar);
  scrollActiveIntoView();

  if (window.lucide) window.lucide.createIcons({ el: bar });

  return bar;
}

/**
 * Holt den aktiven Tab ins Bild.
 *
 * Muss von außen aufrufbar sein, weil die Leiste NACH dem ersten Einscrollen noch
 * breiter werden kann: die Zustandszahlen kommen asynchron und kosten je 22px.
 * Gemessen bei 320px auf /pantry - der aktive Tab („Vorrat", der letzte) lag danach
 * teilweise außerhalb, obwohl beim Rendern korrekt gescrollt worden war.
 *
 * `block: 'nearest'` hält den vertikalen Seiten-Scroll unangetastet.
 *
 * @param {HTMLElement} bar
 */
export function scrollActiveSubTabIntoView(bar) {
  bar?.querySelector('.sub-tab--active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

/**
 * Setzt oder entfernt die Zustandszahl eines Tabs.
 *
 * WARUM EINE ZAHL UND EIN SEPARATES LABEL: „12" allein ist im Tab nicht
 * selbsterklärend („12 was?"), ein ausgeschriebenes „12 offene Artikel" sprengt
 * eine Leiste, die vier Tabs tragen muss. Die Zahl trägt also die Sichtbarkeit, das
 * `aria-label` des Tabs die Bedeutung - dasselbe Muster wie `.list-tab__count` in
 * der Einkaufsliste, nur dass dort der Kontext aus dem Chip selbst hervorgeht.
 *
 * Das Label wird an den TAB gehängt, nicht an das Badge: ein Screenreader liest den
 * Namen des Tabs, nicht den seiner Kinder. Ohne `aria-label` hörte man
 * „Einkaufen 12", was genau die Ambiguität ist, die das Badge visuell noch tragen
 * darf und akustisch nicht.
 *
 * @param {HTMLElement} bar     von renderSubTabs zurückgegebene Leiste
 * @param {string}      tabId
 * @param {object|null} state   { count, label, tone } - null/0 entfernt das Badge
 */
export function setSubTabBadge(bar, tabId, state) {
  const btn = bar?.querySelector(`[data-tab-id="${CSS.escape(tabId)}"]`);
  if (!btn) return;
  const badge = btn.querySelector('.sub-tab__badge');
  if (!badge) return;

  const count = Number(state?.count ?? 0);
  if (!Number.isFinite(count) || count <= 0) {
    badge.hidden = true;
    badge.textContent = '';
    badge.className = 'sub-tab__badge';
    btn.removeAttribute('aria-label');
    return;
  }

  badge.hidden = false;
  badge.textContent = String(count);
  badge.className = `sub-tab__badge${state.tone ? ` sub-tab__badge--${state.tone}` : ''}`;
  // Der Zähler ist für Screenreader redundant, sobald das Label ihn nennt.
  badge.setAttribute('aria-hidden', 'true');
  if (state.label) btn.setAttribute('aria-label', state.label);
}

function safeDomId(value) {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'tab';
}

function syncTabPanels(anchorEl, bar, current) {
  const root = anchorEl.closest('.page') ?? anchorEl.parentElement;
  if (!root) return;

  bar.querySelectorAll('[data-tab-id]').forEach((btn) => {
    const panel = Array.from(root.querySelectorAll('[data-panel]'))
      .find((candidate) => candidate.dataset.panel === btn.dataset.tabId);
    if (!panel) return;

    const active = btn.dataset.tabId === current;
    panel.id = btn.dataset.panelId;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', btn.id);
    panel.hidden = !active;
  });
}
