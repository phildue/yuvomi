/**
 * Modul: Budget-Statistik-View
 * Zweck: Statistik-Tab (Zeitraum-Filter, Summary-Cards, Trendlinie, Donut, CSV-Export).
 */
import { api } from '/api.js';
import { t, formatDate, getLocale } from '/i18n.js';
import { wireTablist } from '/utils/tablist.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { mountEmptyState, mountLoadError } from '/utils/empty-state.js';
import { CHART, chartX, chartY, chartGridMarkup, chartXLabelsMarkup } from '/utils/chart.js';
import { formatMoneyAxis } from '/utils/money.js';

// Zeitraum und Anker gehören dem Modul (budget.js) und kommen über ctx herein.
// Vorher hielt dieser View beides selbst - damit gab es zwei Zeitachsen im selben
// Modul, die nie synchron waren (Critique 2026-07-30, P1).
const view = {
  range: 'month', anchor: null, data: null, error: false, ctx: null, root: null,
  // Drilldown wie auf der Monatsseite: Kategorie -> Unterkategorie -> Buchungen.
  // Das Objekt gehört budget.js (ctx.filter) und wird hier direkt mutiert, damit
  // der Filter den Wechsel Woche/Monat/Jahr und den Tabwechsel überlebt.
  filter: { category: null, subcategory: null, type: null },
  entries: null, entriesError: false, entriesSeq: 0,
};

const RANGE_LABELS = {
  week: 'budget.statsRangeWeek',
  month: 'budget.statsRangeMonth',
  year: 'budget.statsRangeYear',
};

export async function renderStats(panel, ctx) {
  view.ctx = ctx;
  view.root = panel;
  view.range = ctx.range;
  view.anchor = ctx.anchor;
  view.filter = ctx.filter ?? view.filter;
  view.entries = null;
  renderShell();
  await loadStats();
}

function fmtAmount(v) { return view.ctx.formatAmount(v); }

// Ansichts-Scope (#476/#505): im personal-Modus folgen Statistik und Export dem
// Mein/Haushalt-Umschalter, sonst ignoriert der Server den Parameter.
function scopeQuery() {
  return view.ctx?.budgetMode === 'personal' ? `&scope=${view.ctx.scope}` : '';
}

async function loadStats() {
  const body = view.root.querySelector('#budget-stats-body');
  // Ladezustand statt leerer Fläche — der Budget-Tab zeigt beim Monatswechsel
  // ebenfalls ein Skelett; hier blieb das Panel bis zur Antwort einfach leer.
  if (body) {
    body.replaceChildren();
    body.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 4, lines: 2 }));
  }
  try {
    const res = await api.get(`/budget/stats?range=${view.range}&anchor=${view.anchor}${scopeQuery()}`);
    view.data = res.data;
    view.error = false;
  } catch (err) {
    console.error('[Budget] stats load error:', err);
    view.data = null;
    // Das Fehlerobjekt selbst, nicht nur `true`: `mountLoadError` liest daraus
    // den Statuscode - die einzige Angabe, die dem Selbsthoster hier weiterhilft.
    view.error = err;
  }
  renderBodyContent(body);
}

function renderShell() {
  view.root.replaceChildren();
  view.root.insertAdjacentHTML('beforeend', `
    <!-- reading, wie die Budget-Seite, in der dieses Panel steckt: dashboard
         hier setzte --page-measure fuer den Unterbaum auf --layout-wide, und das
         Kennzahlenband der Berichte lief auf 1200px, waehrend der Budget-Kopf
         und jeder andere Reiter bei 720px enden (auf main war es 720). Ein
         eigener Modus je Reiter hiesse, auch den Kopf je Reiter umzuschalten -
         das ist Welle C in docs/PAGE-COMPOSITION.md, keine Nebenwirkung. -->
    <div class="budget-stats app-page app-page--reading page-measure--narrow" data-composition="reading">
      <!-- Nur noch die Auflösung: der Zeitraum selbst wird über den geteilten
           Kopf-Stepper des Moduls gewählt. Optik aus dem geteilten
           .segmented-Baustein. -->
      <div class="budget-stats__controls">
        <div class="segmented budget-stats__ranges" role="tablist" aria-label="${t('budget.statsRangeLabel')}">
          ${['week', 'month', 'year'].map((r) => {
            const on = r === view.range;
            return `
            <button type="button" role="tab" class="segmented__item${on ? ' is-active' : ''}"
              data-tab-id="${r}" aria-selected="${on}" tabindex="${on ? '0' : '-1'}"
              aria-controls="budget-stats-body">${t(RANGE_LABELS[r])}</button>`;
          }).join('')}
        </div>
      </div>
      <div id="budget-stats-body" role="tabpanel" tabindex="0"></div>
    </div>
  `);
  if (window.lucide) lucide.createIcons({ el: view.root });
  wire();
}

function wire() {
  // Geteilte Tablist-Grammatik (Klick + Pfeiltasten/Home/End + Roving-Tabindex)
  // wie die Budget-Haupttabs — vorher trug der Container role="tablist", ohne
  // dass ein Kind role="tab" hatte, und Pfeiltasten taten nichts.
  //
  // Die Auflösung meldet das Modul zurück (onRangeChange), damit sie den
  // Tabwechsel überlebt und der Kopf-Stepper in derselben Schrittweite läuft.
  wireTablist(view.root.querySelector('.budget-stats__ranges'), {
    activeId: view.range,
    activeClass: 'is-active',
    onChange: (id) => view.ctx.onRangeChange(id),
  });

  // Filter-Klicks per Delegation: der Körper wird bei jeder Filteränderung neu
  // gezeichnet, direkte Listener gingen dabei verloren.
  view.root.querySelector('#budget-stats-body').addEventListener('click', (e) => {
    const typeBtn = e.target.closest('[data-type-filter]');
    if (typeBtn) {
      const type = typeBtn.dataset.typeFilter;
      view.filter.type = view.filter.type === type ? null : type;
      // Eine Kategorie der anderen Art bliebe sonst als unsichtbarer Filter stehen.
      if (view.filter.type && !categoryMatchesType(view.filter.category)) clearCategory();
      return applyFilter(`[data-type-filter="${type}"]`);
    }
    const subBtn = e.target.closest('[data-subcategory]');
    if (subBtn) {
      const key = subBtn.dataset.subcategory;
      view.filter.subcategory = view.filter.subcategory === key ? null : key;
      return applyFilter(`[data-subcategory="${CSS.escape(key)}"]`);
    }
    const catBtn = e.target.closest('[data-category]');
    if (catBtn) {
      const key = catBtn.dataset.category;
      view.filter.category = view.filter.category === key ? null : key;
      // Die Unterkategorie gehört zur vorher aktiven Kategorie.
      view.filter.subcategory = null;
      return applyFilter(`[data-category="${CSS.escape(key)}"]`);
    }
    if (e.target.closest('#budget-stats-clear-category')) {
      clearCategory();
      return applyFilter();
    }
    if (e.target.closest('#budget-stats-clear-type')) {
      view.filter.type = null;
      return applyFilter();
    }
  });
}

function clearCategory() {
  view.filter.category = null;
  view.filter.subcategory = null;
}

function categoryMatchesType(category) {
  if (!category || !view.filter.type) return true;
  const row = view.data?.byCategory.find((c) => c.category === category);
  if (!row) return false;
  return view.filter.type === 'income' ? row.income > 0 : row.expenses < 0;
}

function filterActive() {
  const f = view.filter;
  return !!(f.category || f.subcategory || f.type);
}

// Neu zeichnen aus den schon geladenen Statistikdaten (kein Neuabruf); nur die
// Buchungsliste holt sich ihre Zeilen vom Server. Der Fokus geht zum
// angeklickten Element zurück, sonst verliert die Tastatur ihre Stelle.
function applyFilter(focusSelector) {
  const body = view.root.querySelector('#budget-stats-body');
  renderBodyContent(body);
  if (focusSelector) body.querySelector(focusSelector)?.focus();
}

function renderBodyContent(body) {
  // Zuerst der Zeitraum: er gehört in den Kopf und muss auch dann stimmen, wenn
  // der Zeitraum leer ist - sonst zeigte der Kopf beim Wochenwechsel in eine
  // buchungsfreie Woche weiter den alten Bereich.
  updatePeriodLabel();
  // Fehler beim Laden klar von „keine Daten" trennen: ein Netzwerk-/Serverfehler
  // darf der Familie nicht vortäuschen, ihre Finanzhistorie sei leer.
  if (view.error) {
    body.replaceChildren();
    mountLoadError(body, {
      title: t('budget.statsError'),
      description: t('budget.statsErrorDescription'),
      error: view.error,
      retryLabel: t('budget.statsRetry'),
      onRetry: () => loadStats(),
    });
    return;
  }
  const d = view.data;
  if (!d || (d.totals.income === 0 && d.totals.expenses === 0 && !d.series.some((s) => s.income || s.expenses))) {
    body.replaceChildren();
    mountEmptyState(body, {
      icon: 'chart-column',
      title: t('budget.statsEmptyTitle'),
      description: t('budget.statsEmptyDescription'),
    });
    return;
  }
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    <div class="metric-grid">
      <button type="button" class="metric-card metric-card--income budget-summary-card--clickable${view.filter.type === 'income' ? ' is-active' : ''}"
              data-type-filter="income" aria-pressed="${view.filter.type === 'income'}"
              aria-label="${view.ctx.esc(t('budget.filterIncomeLabel'))}">
        <div class="metric-card__label">${t('budget.statsIncome')}</div>
        <div class="metric-card__value">${fmtAmount(d.totals.income)}</div>
      </button>
      <button type="button" class="metric-card metric-card--expenses budget-summary-card--clickable${view.filter.type === 'expenses' ? ' is-active' : ''}"
              data-type-filter="expenses" aria-pressed="${view.filter.type === 'expenses'}"
              aria-label="${view.ctx.esc(t('budget.filterExpensesLabel'))}">
        <div class="metric-card__label">${t('budget.statsExpenses')}</div>
        <div class="metric-card__value">${fmtAmount(Math.abs(d.totals.expenses))}</div>
      </button>
      <div class="metric-card ${d.totals.balance >= 0 ? 'metric-card--balance-positive' : 'metric-card--balance-negative'}">
        <div class="metric-card__label">${t('budget.statsBalance')}</div>
        <div class="metric-card__value">${fmtAmount(d.totals.balance)}</div>
      </div>
    </div>
    <div id="budget-stats-trend"></div>
    <div id="budget-stats-cat"></div>
    <div id="budget-stats-donut"></div>
    <div id="budget-stats-entries"></div>
    <div class="budget-stats__export"></div>
  `);
  renderTrendChart();
  renderCatBars();
  renderDonut();
  renderEntries();
  renderExport();
}

// Eigene Datenreihen-Palette (tokens.css) statt geborgter Fremdmodul-Akzente:
// --module-shopping/--module-meals tragen eine andere Bedeutung und garantieren
// keinen Kontrast gegen die Kartenfläche. Die Zahl der Segmente ist auf
// DONUT_SEGMENTS begrenzt, damit sich keine zwei Segmente dieselbe Farbe teilen.
const DONUT_COLORS = [
  'var(--chart-series-1)', 'var(--chart-series-2)', 'var(--chart-series-3)',
  'var(--chart-series-4)', 'var(--chart-series-5)', 'var(--chart-series-6)',
  'var(--chart-series-7)',
];
const DONUT_SEGMENTS = DONUT_COLORS.length;

function renderCatBars() {
  const host = view.root.querySelector('#budget-stats-cat');
  const type = view.filter.type;
  const cats = view.data.byCategory.filter((c) => {
    if (c.total === 0) return false;
    if (type === 'income') return c.income > 0;
    if (type === 'expenses') return c.expenses < 0;
    return true;
  });
  if (!host || !cats.length) return;
  const maxAbs = Math.max(...cats.map((c) => Math.abs(c.total)), 1);
  // Budgetplan-Ziele nur im Monatsbereich einblenden — dort deckt sich der
  // Zeitraum exakt mit dem stetigen Monatsplan (kein irreführendes Hochskalieren).
  const plans = view.data.range === 'month' ? (view.data.plans || {}) : {};
  const rows = cats.map((c) => {
    const isExp = c.total < 0;
    // Der Anteil ist der Anteil, wie im Monats-Chart: gleiche Bauart, gleiche
    // Regel. Der frühere 6-%-Boden zeichnete vier Kategorien mit dem
    // 9,4-Fachen Abstand gleich lang; der Mindestbalken steht jetzt als Länge
    // im CSS (--bar-visible). Begründung ausführlich in budget.js.
    const scale = Math.abs(c.total) / maxAbs;
    const target = isExp ? plans[c.category] : undefined;
    const targetPos = target != null ? Math.min(1, target / maxAbs) : null;
    const targetMarker = targetPos != null
      ? `<div class="budget-bar-row__target" style="--target-pos:${targetPos.toFixed(4)}"
             title="${t('budget.planTarget', { amount: view.ctx.formatAmount(target) })}"></div>`
      : '';
    const catLabel = view.ctx.esc(view.ctx.categoryLabel(c.category));
    const isActive = view.filter.category === c.category;
    // Unterkategorien klappen nur unter der aktiven Kategorie auf, wie auf der
    // Monatsseite.
    const subs = isActive
      ? (view.data.bySubcategory ?? []).filter((s) => s.category === c.category)
      : [];
    // --mirrored: gemeinsame Mittelachse wie im Monats-Chart (Critique
    // 2026-08-10, P0); der Budgetplan-Zielmarker rechnet im CSS mit.
    return `
      <button type="button" class="budget-bar-row budget-bar-row--mirrored budget-bar-row--clickable${isActive ? ' is-active' : ''}"
              data-category="${view.ctx.esc(c.category)}" aria-pressed="${isActive}"
              aria-label="${view.ctx.esc(t('budget.viewCategoryTransactions', { name: view.ctx.categoryLabel(c.category) }))}">
        <div class="budget-bar-row__label" title="${catLabel}">${catLabel}</div>
        <div class="budget-bar-row__track">
          <div class="budget-bar-row__fill ${isExp ? 'budget-bar-row__fill--expenses' : 'budget-bar-row__fill--income'}"
               style="--bar-scale:${scale.toFixed(4)};--bar-visible:${c.total !== 0 ? 1 : 0}"></div>
          ${targetMarker}
        </div>
        <div class="budget-bar-row__amount" style="color:${isExp ? 'var(--color-danger)' : 'var(--color-success)'};">
          ${isExp ? '' : '+'}${view.ctx.formatAmount(c.total)}
        </div>
      </button>
      ${subs.length ? renderSubBars(subs) : ''}`;
  }).join('');
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="budget-chart-section">
      <div class="budget-chart-section__title">${t('budget.statsCategoryTitle')}</div>
      <div class="budget-chart">${rows}</div>
    </div>`);
}

function renderSubBars(subs) {
  const maxAbs = Math.max(...subs.map((s) => Math.abs(s.total)), 1);
  const rows = subs.map((s) => {
    const isExp = s.total < 0;
    const label = view.ctx.subcategoryLabel(s.subcategory);
    const isActive = view.filter.subcategory === s.subcategory;
    const scale = Math.abs(s.total) / maxAbs;
    return `
      <button type="button" class="budget-bar-row budget-bar-row--sub budget-bar-row--clickable${isActive ? ' is-active' : ''}"
              data-subcategory="${view.ctx.esc(s.subcategory)}" aria-pressed="${isActive}"
              aria-label="${view.ctx.esc(t('budget.viewSubcategoryTransactions', { name: label }))}">
        <div class="budget-bar-row__label" title="${view.ctx.esc(label)}">${view.ctx.esc(label)}</div>
        <div class="budget-bar-row__track">
          <div class="budget-bar-row__fill ${isExp ? 'budget-bar-row__fill--expenses' : 'budget-bar-row__fill--income'}"
               style="--bar-scale:${scale.toFixed(4)}"></div>
        </div>
        <div class="budget-bar-row__amount" style="color:${isExp ? 'var(--color-danger)' : 'var(--color-success)'};">
          ${isExp ? '' : '+'}${view.ctx.formatAmount(s.total)}
        </div>
      </button>`;
  }).join('');
  return `<div class="budget-subchart">${rows}</div>`;
}

// Die einzelnen Buchungen zum gewählten Filter. Ohne Filter bleibt die Fläche
// leer: ein Jahr voller Buchungen ist keine Statistik mehr, und die Kategorien
// darüber sind der Einstieg.
function renderEntries() {
  const host = view.root.querySelector('#budget-stats-entries');
  if (!host) return;
  host.replaceChildren();
  if (!filterActive()) { view.entries = null; return; }

  const f = view.filter;
  const chips = [];
  if (f.category) {
    chips.push(`
      <button class="budget-account-chip" id="budget-stats-clear-category" type="button"
              aria-label="${view.ctx.esc(t('budget.clearCategoryFilter'))}">
        <i data-lucide="tag" class="icon-xs" aria-hidden="true"></i>
        <span>${view.ctx.esc(view.ctx.categoryLabel(f.category))}${f.subcategory ? ` · ${view.ctx.esc(view.ctx.subcategoryLabel(f.subcategory))}` : ''}</span>
        <i data-lucide="x" class="icon-xs" aria-hidden="true"></i>
      </button>`);
  }
  if (f.type) {
    chips.push(`
      <button class="budget-account-chip" id="budget-stats-clear-type" type="button"
              aria-label="${view.ctx.esc(t('budget.clearTypeFilter'))}">
        <i data-lucide="filter" class="icon-xs" aria-hidden="true"></i>
        <span>${view.ctx.esc(t(f.type === 'income' ? 'budget.income' : 'budget.expenses'))}</span>
        <i data-lucide="x" class="icon-xs" aria-hidden="true"></i>
      </button>`);
  }
  host.insertAdjacentHTML('beforeend', `
    <div class="budget-chart-section">
      <div class="budget-chart-section__title">${t('budget.transactions')} ${chips.join(' ')}</div>
      <div id="budget-stats-entries-list" aria-live="polite"></div>
    </div>`);
  if (window.lucide) lucide.createIcons({ el: host });
  loadEntries();
}

async function loadEntries() {
  const seq = ++view.entriesSeq;
  const list = view.root.querySelector('#budget-stats-entries-list');
  if (!list) return;
  list.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 3, lines: 1 }));
  const { from, to } = view.data;
  const f = view.filter;
  const cat = f.category ? `&category=${encodeURIComponent(f.category)}` : '';
  const sub = f.subcategory ? `&subcategory=${encodeURIComponent(f.subcategory)}` : '';
  try {
    const res = await api.get(`/budget?from=${from}&to=${to}&booked_only=1${cat}${sub}${scopeQuery()}`);
    // Ein späterer Klick hat die Anfrage überholt: seine Antwort gilt, nicht diese.
    if (seq !== view.entriesSeq) return;
    view.entries = res.data;
    view.entriesError = false;
  } catch (err) {
    if (seq !== view.entriesSeq) return;
    console.error('[Budget] stats entries load error:', err);
    view.entries = null;
    view.entriesError = true;
  }
  renderEntryRows();
}

function renderEntryRows() {
  const list = view.root.querySelector('#budget-stats-entries-list');
  if (!list) return;
  list.replaceChildren();
  if (view.entriesError) {
    list.insertAdjacentHTML('beforeend', `<p class="budget-stats__note">${view.ctx.esc(t('budget.statsError'))}</p>`);
    return;
  }
  const type = view.filter.type;
  const rows = (view.entries ?? []).filter((e) => !type || (e.amount > 0) === (type === 'income'));
  if (!rows.length) {
    list.insertAdjacentHTML('beforeend', `<p class="budget-stats__note">${view.ctx.esc(t('budget.statsEmptyDescription'))}</p>`);
    return;
  }
  list.insertAdjacentHTML('beforeend', rows.map((e) => {
    const isIncome = e.amount > 0;
    const masked = !!e.details_hidden;
    const title = masked ? t('budget.maskedEntryTitle') : e.title;
    const sub = !masked && e.subcategory ? ` / ${view.ctx.subcategoryLabel(e.subcategory)}` : '';
    return `
      <div class="list-row budget-entry${masked ? ' budget-entry--masked' : ''}">
        <div class="budget-entry__indicator ${isIncome ? 'budget-entry__indicator--income' : 'budget-entry__indicator--expenses'}"></div>
        <div class="list-row__main">
          <div class="list-row__name budget-entry__title">${view.ctx.esc(title)}</div>
          <div class="list-row__meta budget-entry__meta">${view.ctx.esc(formatDate(e.date))} · ${view.ctx.esc(view.ctx.categoryLabel(e.category))}${view.ctx.esc(sub)}</div>
        </div>
        <div class="budget-entry__amount ${isIncome ? 'budget-entry__amount--income' : 'budget-entry__amount--expenses'}">${view.ctx.formatFlow(e.amount)}</div>
      </div>`;
  }).join(''));
}

// Segmente auf die Palettengröße begrenzen: alles jenseits davon fließt in eine
// „Sonstige"-Sammelscheibe. Ein Donut mit 15 Kategorien ist ohnehin nicht mehr
// ablesbar, und ohne Deckel bekämen Segment 1 und 8 dieselbe Farbe.
// Ausgangsdaten des Donuts: normalerweise die Kategorien, aber unter einer
// aktiven Kategorie (Drilldown) deren Unterkategorien — derselbe Wechsel, den
// die Balken schon zeigen. Nur Ausgaben haben Unterkategorien; eine gewählte
// Einnahmenkategorie hat keine Zeilen dafür und fällt auf die Kategorien
// zurück, statt einen leeren Donut zu zeigen.
function donutSource() {
  const cat = view.filter.category;
  if (cat) {
    const subs = (view.data.bySubcategory ?? []).filter((s) => s.category === cat && s.expenses < 0);
    if (subs.length) {
      return { rows: subs, label: (s) => view.ctx.subcategoryLabel(s.subcategory), value: (s) => Math.abs(s.expenses), drilledCategory: cat };
    }
  }
  return {
    rows: view.data.byCategory.filter((c) => c.expenses < 0),
    label: (c) => view.ctx.categoryLabel(c.category),
    value: (c) => Math.abs(c.expenses),
    drilledCategory: null,
  };
}

function donutSlices(src) {
  const exp = src.rows
    .map((r) => ({ label: src.label(r), value: src.value(r) }))
    .sort((a, b) => b.value - a.value);
  if (exp.length <= DONUT_SEGMENTS) return exp;
  const head = exp.slice(0, DONUT_SEGMENTS - 1);
  const restValue = exp.slice(DONUT_SEGMENTS - 1).reduce((s, e) => s + e.value, 0);
  return [...head, { label: t('budget.statsOtherCategories'), value: restValue }];
}

function renderDonut() {
  const host = view.root.querySelector('#budget-stats-donut');
  const src = donutSource();
  const exp = donutSlices(src);
  const total = exp.reduce((s, e) => s + e.value, 0);
  if (!host || total === 0) return;
  // Unter einer Kategorie zeigt der Donut ihre Unterkategorien — derselbe Titel
  // waere dann irrefuehrend ("Ausgabenanteile" klingt nach dem ganzen Haushalt),
  // der Kategoriename dahinter sagt, wovon die Rede ist.
  const titleSuffix = src.drilledCategory ? ` · ${view.ctx.esc(view.ctx.categoryLabel(src.drilledCategory))}` : '';

  const pctOf = (value) => Math.round((value / total) * 100);
  const C = 2 * Math.PI * 60; // r=60
  let offset = 0;
  const segs = exp.map((e, i) => {
    const frac = e.value / total;
    const seg = `
      <circle r="60" cx="80" cy="80" fill="none" stroke="${DONUT_COLORS[i]}"
        stroke-width="22" stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}"
        stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 80 80)" />`;
    offset += frac * C;
    return seg;
  }).join('');
  // Die Legende trägt Betrag und Anteil als Text — die Farbe ist Beiwerk, nicht
  // der einzige Träger der Information (gilt auch für Farbfehlsichtigkeit).
  const legend = exp.map((e, i) => `
    <span class="budget-stats__legend-item">
      <i class="budget-stats__swatch" style="background:${DONUT_COLORS[i]};"></i>
      ${view.ctx.esc(e.label)} · ${fmtAmount(e.value)} · ${pctOf(e.value)}%
    </span>`).join('');
  const summary = t('budget.statsDonutSummary', {
    count: exp.length,
    top: exp[0].label,
    pct: pctOf(exp[0].value),
    total: fmtAmount(total),
  });

  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="budget-chart-section">
      <div class="budget-chart-section__title">${t('budget.statsDonutTitle')}${titleSuffix}</div>
      <p class="sr-only">${view.ctx.esc(summary)}</p>
      <div class="budget-stats__donut-wrap">
        <svg viewBox="0 0 160 160" class="budget-stats__donut" aria-hidden="true">${segs}</svg>
        <div class="budget-stats__legend budget-stats__legend--wrap">${legend}</div>
      </div>
    </div>`);
}

function renderExport() {
  const host = view.root.querySelector('.budget-stats__export');
  if (!host) return;
  const { from, to } = view.data;
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <a class="btn btn--secondary" href="/api/v1/budget/export?from=${from}&to=${to}${scopeQuery()}">
      <i data-lucide="download" class="icon-md" aria-hidden="true"></i> ${t('budget.statsExport')}
    </a>`);
  if (window.lucide) lucide.createIcons({ el: host });
}

function renderTrendChart() {
  const host = view.root.querySelector('#budget-stats-trend');
  if (!host) return;
  const s = view.data.series;
  const incomes  = s.map((p) => p.income);
  const expenses = s.map((p) => Math.abs(p.expenses));
  const max = Math.max(1, ...incomes, ...expenses);
  const points = (arr) => arr.map((v, i) => `${chartX(i, s.length).toFixed(1)},${chartY(v, 0, max).toFixed(1)}`).join(' ');
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);

  // DIE ACHSE STEHT JETZT IM BILD (utils/chart.js).
  //
  // Hier stand: „Achsenbeschriftung liegt als HTML außerhalb des SVG, weil
  // preserveAspectRatio='none' jeden Text im SVG verzerren würde." Der Satz war
  // richtig und hat die Kausalität verkehrt herum gelesen - das `none` war die
  // URSACHE, nicht die Randbedingung. Ohne feste Ränder gibt es keinen Platz für
  // eine Achse im Bild, also musste sie nach draußen, und dort verschiebt sie
  // sich gegen ihre eigenen Gitterlinien, sobald das Diagramm skaliert (gemessen:
  // ein 600x180-viewBox auf 720x216 gestreckt). Die geteilte Geometrie bringt den
  // linken Gutter mit, damit fällt beides weg.
  //
  // Zweiter Kanal neben der Farbe (Critique P2): Einnahmen solide, Ausgaben
  // gestrichelt - so trennen sich die Serien auch bei Rot-Grün-Schwäche. Der
  // Screenreader-Zugang liegt in der sr-only-Summary + den Punkt-Buttons; das
  // rein visuelle SVG bleibt daher bewusst aria-hidden.
  const summary = t('budget.statsTrendSummary', {
    periods: s.length,
    income: fmtAmount(sum(incomes)),
    expenses: fmtAmount(sum(expenses)),
    peak: fmtAmount(max),
  });

  // Ablesbare Einzelwerte: die Kurve allein sagt nur "irgendwann im Mai war es
  // viel". Je Datenpunkt eine unsichtbare Schaltfläche über dem Diagramm — der
  // Wert steht in ihrem aria-label (also auch ohne Maus erreichbar, nicht als
  // Hover-only-Tooltip) und erscheint sichtbar in der Ableselinie darunter.
  const hotspots = s.map((p, i) => {
    const label = t('budget.statsPointLabel', {
      period: periodLabel(p.period),
      income: fmtAmount(p.income),
      expenses: fmtAmount(Math.abs(p.expenses)),
    });
    const frac = chartX(i, s.length) / CHART.W;
    return `<button type="button" class="budget-stats__point" data-index="${i}"
              style="--point-x:${frac.toFixed(4)};--point-slots:${s.length}"
              tabindex="${i === s.length - 1 ? '0' : '-1'}"
              aria-label="${view.ctx.esc(label)}"></button>`;
  }).join('');

  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="budget-chart-section">
      <div class="budget-chart-section__title">${t('budget.statsTrendTitle')}</div>
      <p class="sr-only">${view.ctx.esc(summary)}</p>
      <div class="budget-stats__trend-wrap">
        <div class="budget-stats__plot">
          <svg class="budget-stats__trend" viewBox="0 0 ${CHART.W} ${CHART.H}" aria-hidden="true">
            ${chartGridMarkup(0, max, (val) => formatMoneyAxis(val, view.ctx.currency))}
            ${chartXLabelsMarkup(s.map((p) => periodLabel(p.period)))}
            <polyline fill="none" stroke="var(--color-success)" stroke-width="2"
                      vector-effect="non-scaling-stroke" points="${points(incomes)}" />
            <polyline fill="none" stroke="var(--color-danger)" stroke-width="2" stroke-dasharray="6 4"
                      vector-effect="non-scaling-stroke" points="${points(expenses)}" />
          </svg>
          <div class="budget-stats__points" role="group" aria-label="${t('budget.statsPointsLabel')}">${hotspots}</div>
        </div>
      </div>
      <div class="budget-stats__readout" id="budget-stats-readout" aria-hidden="true"></div>
      <div class="budget-stats__legend">
        <span><i class="budget-stats__swatch budget-stats__swatch--income"></i>${t('budget.statsIncome')} · ${fmtAmount(sum(incomes))}</span>
        <span><i class="budget-stats__swatch budget-stats__swatch--expense"></i>${t('budget.statsExpenses')} · ${fmtAmount(sum(expenses))}</span>
      </div>
    </div>`);
  wireTrendPoints(host, s);
}

// Bucket-Schlüssel der Serie: 'YYYY-MM' (Monatsraster) oder 'YYYY-MM-DD' (Tage).
function periodLabel(period) {
  if (/^\d{4}-\d{2}$/.test(period)) {
    const [y, m] = period.split('-').map(Number);
    return new Intl.DateTimeFormat(getLocale(), { month: 'short', year: 'numeric' }).format(new Date(y, m - 1, 1));
  }
  return formatDate(period);
}

// Ableselinie + Roving-Tabindex über den Datenpunkten. Ein Tabstopp für die
// ganze Kurve (nicht 31 bei einem Monatsraster), Pfeiltasten wandern, Zeigen
// und Antippen wählen direkt. Der Wert steht ohnehin im aria-label jedes
// Punktes — die sichtbare Zeile ist die Entsprechung für alle anderen.
function wireTrendPoints(host, series) {
  const group = host.querySelector('.budget-stats__points');
  const readout = host.querySelector('#budget-stats-readout');
  if (!group || !readout) return;
  const buttons = [...group.querySelectorAll('.budget-stats__point')];
  if (!buttons.length) return;

  const show = (index, { focus = false } = {}) => {
    const point = series[index];
    if (!point) return;
    buttons.forEach((b, i) => {
      b.classList.toggle('is-active', i === index);
      b.tabIndex = i === index ? 0 : -1;
    });
    readout.textContent = t('budget.statsPointLabel', {
      period: periodLabel(point.period),
      income: fmtAmount(point.income),
      expenses: fmtAmount(Math.abs(point.expenses)),
    });
    if (focus) buttons[index].focus();
  };

  group.addEventListener('focusin', (e) => {
    const btn = e.target.closest('.budget-stats__point');
    if (btn) show(Number(btn.dataset.index));
  });
  group.addEventListener('pointerover', (e) => {
    const btn = e.target.closest('.budget-stats__point');
    if (btn) show(Number(btn.dataset.index));
  });
  group.addEventListener('keydown', (e) => {
    const current = buttons.findIndex((b) => b.tabIndex === 0);
    let next = current;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(buttons.length - 1, current + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, current - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else return;
    e.preventDefault();
    show(next, { focus: true });
  });

  // Jüngster Zeitabschnitt MIT Daten als Ausgangswert: der Monatsletzte ist
  // oft noch leer und "31.07. · 0,00" wäre ein nichtssagender Start
  // (Audit A2-05). Ganz ohne Daten bleibt der letzte Abschnitt.
  let initial = series.length - 1;
  while (initial > 0 && !series[initial].income && !series[initial].expenses) initial--;
  show(initial);
}

// Der Zeitraum steht im geteilten Kopf, nicht mehr im Panel. Gemeldet wird er
// erst nach dem Laden, weil der Server die Wochengrenzen festlegt.
function updatePeriodLabel() {
  if (view.data) view.ctx.onPeriod({ from: view.data.from, to: view.data.to });
}
