/**
 * Modul: Budget-Statistik-View
 * Zweck: Statistik-Tab (Zeitraum-Filter, Summary-Cards, Trendlinie, Donut, CSV-Export).
 */
import { CATEGORY_SERIES_COLORS, CATEGORY_OTHER_COLOR, categoryColorIndex, categoryColor, categoryTexture } from '/utils/budget-category-colors.js';
import { api } from '/api.js';
import { t, getLocale } from '/i18n.js';
import { dateRangeText, dateText } from '/utils/date-format.js';
import { renderSkeletonChart, renderSkeletonList } from '/utils/skeleton.js';
import { growBars, drawChartOnce } from '/utils/ux.js';
import { mountEmptyState, mountLoadError } from '/utils/empty-state.js';
import { CHART, chartX, chartY, chartGridMarkup, chartXLabelsMarkup, calmDomain } from '/utils/chart.js';
import { formatMoneyAxis, formatSignedAmount, sharePercent, roundToCurrency } from '/utils/money.js';
import { addLocalDays, todayKey } from '/utils/date.js';
import { trendMarkup } from '/utils/metric-card.js';

// Zeitraum und Anker gehören dem Modul (budget.js) und kommen über ctx herein.
// Vorher hielt dieser View beides selbst - damit gab es zwei Zeitachsen im selben
// Modul, die nie synchron waren (Critique 2026-07-30, P1).
const view = {
  range: 'month', anchor: null, data: null, prev: null, error: false, ctx: null, root: null,
  // Drilldown wie auf der Monatsseite: Kategorie -> Unterkategorie -> Buchungen.
  // Das Objekt gehört budget.js (ctx.filter) und wird hier direkt mutiert, damit
  // der Filter den Wechsel Woche/Monat/Jahr und den Tabwechsel überlebt.
  filter: { category: null, subcategory: null, type: null },
  entries: null, entriesError: false, entriesSeq: 0,
  // Für welchen Filter `entries` geladen wurde - der Verlauf rechnet daraus
  // und darf keine Zeilen des vorherigen Filters zeigen.
  entriesKey: null,
};

const RANGE_LABEL_KEYS = { week: 'budget.statsRangeWeek', month: 'budget.statsRangeMonth', year: 'budget.statsRangeYear' };


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

// Letzter Tag, den die Auswertung zaehlt (Server: statsCutoff) - aeltere
// Antworten ohne das Feld zaehlten bis zum Zeitraumende.
function statsUntil() { return view.data?.until ?? view.data?.to; }

// Ansichts-Scope (#476/#505): im personal-Modus folgen Statistik und Export dem
// Mein/Haushalt-Umschalter, sonst ignoriert der Server den Parameter.
function scopeQuery() {
  return view.ctx?.budgetMode === 'personal' ? `&scope=${view.ctx.scope}` : '';
}

/* DIE LETZTE ANFRAGE GEWINNT, NICHT DIE LETZTE ANTWORT (#1775, Review). `view`
 * ist EIN geteilter Zustand, und jeder Schritt am Stepper (Pfeil oder Wisch)
 * startet eine neue Ladung, ohne auf die vorige zu warten: kam die aeltere
 * Antwort spaeter an, schrieb sie ihren Zeitraum ueber den neueren - der Kopf
 * zeigte April, die Auswertung Maerz. Jede Ladung zieht deshalb eine Nummer
 * und schreibt nur, wenn sie noch die juengste ist. Liefert `false` fuer eine
 * ueberholte Ladung; die zeichnet dann auch nichts. */
let loadSeq = 0;
async function fetchStats() {
  const seq = ++loadSeq;
  let data = null;
  let prev = null;
  let error = false;
  try {
    const res = await api.get(`/budget/stats?range=${view.range}&anchor=${view.anchor}${scopeQuery()}`);
    data = res.data;
    prev = await loadPrevious(res.data);
  } catch (err) {
    console.error('[Budget] stats load error:', err);
    data = null;
    // Das Fehlerobjekt selbst, nicht nur `true`: `mountLoadError` liest daraus
    // den Statuscode - die einzige Angabe, die dem Selbsthoster hier weiterhilft.
    error = err;
  }
  if (seq !== loadSeq) return false;
  view.data = data;
  view.prev = prev;
  view.error = error;
  return true;
}

async function loadStats() {
  const body = view.root.querySelector('#budget-stats-body');
  // Ladezustand statt leerer Fläche — der Budget-Tab zeigt beim Monatswechsel
  // ebenfalls ein Skelett; hier blieb das Panel bis zur Antwort einfach leer.
  if (body) {
    body.replaceChildren();
    // Diagrammfoermig, nicht als Liste: danach stehen hier Verlauf und Anteile.
    body.insertAdjacentHTML('beforeend', renderSkeletonChart({ charts: 2 }));
  }
  if (!(await fetchStats())) return;
  renderBodyContent(body);
}

/* DER VORZEITRAUM FUER DEN KATEGORIEVERGLEICH. Die Antwort traegt nur seine
 * Summen (`comparison`), nicht seine Kategorien - der Client fragt denselben
 * Endpunkt deshalb ein zweites Mal, verankert am Tag vor dem Zeitraum: das ist
 * die Vorwoche, der Vormonat oder das Vorjahr, je nach Aufloesung, und die
 * Grenzen dafuer zieht der Server wie beim ersten Aufruf. Scheitert nur dieser
 * Aufruf, fehlt der Vergleich - die Auswertung selbst bleibt stehen. */
async function loadPrevious(data) {
  if (!data?.from) return null;
  try {
    // Dieselbe Strecke wie der laufende Zeitraum (Jan-Sep gegen Jan-Sep): der
    // Server meldet ihr Ende als prevUntil.
    const until = data.prevUntil ? `&until=${data.prevUntil}` : '';
    const res = await api.get(`/budget/stats?range=${view.range}&anchor=${addLocalDays(data.from, -1)}${until}${scopeQuery()}`);
    return res.data;
  } catch (err) {
    console.error('[Budget] stats comparison load error:', err);
    return null;
  }
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
      <!-- Zeitraum UND Aufloesung stehen seit R24 (Critique G4-Budget-P2-5)
           im geteilten Kopf: der Bereich ist eine Wahl am Wert des Steppers
           (budget.js statsRangeHtml), kein Segment hier. Am Telefon ist die
           Kopfzeile voll; dort oeffnet dieser zweite Ausloeser dasselbe Menue
           (je Breite steht genau einer, budget.css). -->
      <div class="budget-stats__resolution">
        <button type="button" class="btn btn--secondary btn--sm budget-nav__range-trigger budget-stats__resolution-trigger popover-menu__trigger"
                popovertarget="budget-range-menu" aria-haspopup="menu" aria-expanded="false"
                aria-label="${t('budget.statsRangeLabel')}: ${t(RANGE_LABEL_KEYS[view.range] ?? RANGE_LABEL_KEYS.month)}">
          <span class="budget-range-value">${t(RANGE_LABEL_KEYS[view.range] ?? RANGE_LABEL_KEYS.month)}</span>
          <i data-lucide="chevron-down" class="icon-sm" aria-hidden="true"></i>
        </button>
      </div>
      <div id="budget-stats-body" tabindex="-1"></div>
    </div>
  `);
  if (window.lucide) lucide.createIcons({ el: view.root });
  wire();
}

function wire() {
  // Die Aufloesung waehlt der Kopf (budget.js), hier nur die Drilldown-Filter.

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
    // EIN LEERZUSTAND MIT HANDLUNG (Critique R17): „Keine Daten im Zeitraum"
    // endete in einer Sackgasse - der Reiter hat keinen Anlege-Knopf im Kopf.
    // Wer schreiben darf, legt von hier den Eintrag an, der die Statistik
    // fuellt (derselbe Dialog und dasselbe Wort wie im Leerzustand der
    // Uebersicht); bei `read` bleibt die Auskunft.
    const box = mountEmptyState(body, {
      icon: 'chart-column',
      title: t('budget.statsEmptyTitle'),
      description: t('budget.statsEmptyDescription'),
      action: typeof view.ctx.onAddEntry === 'function'
        ? { label: t('budget.emptyAction'), icon: 'plus', attrs: { id: 'budget-stats-empty-add' } }
        : undefined,
    });
    box?.querySelector('#budget-stats-empty-add')?.addEventListener('click', () => view.ctx.onAddEntry?.(
      // Der Zeitraum, den der Server fuer DIESE Ansicht gemeldet hat (#1775).
      view.data ? { from: view.data.from, to: view.data.to } : null,
    ));
    return;
  }
  /* KEINE ZWEITE UEBERSICHT (Critique 2026-09-25). Hier standen dieselben
   * drei Kennzahl-Karten und dieselbe Kategorieliste wie auf dem Reiter
   * „Uebersicht" - fuer den Monat 1:1 dieselben Zahlen. Die Statistik
   * beantwortet jetzt, was die Uebersicht nicht kann: wie sich der Zeitraum
   * aufbaut (kumulierter Verlauf) und was sich gegenueber dem Vorzeitraum
   * je Kategorie veraendert hat. Die Summen stehen in der Legende des
   * Verlaufs, samt Veraenderung. */
  /* EINE BAHN WIE DIE UEBRIGEN REITER (Critique 2026-09-26, A5 P2-5). Die
   * drei Diagramme standen untereinander auf dem Lesemass und endeten 404px
   * vor der Bahn, an der Uebersicht, Konten, Abos, Darlehen und Aufteilung
   * enden. Ab 960px Modulflaeche steht die Statistik in derselben Zweispalte
   * wie die Uebersicht (budget.css, Container der Budget-Seite): links Verlauf und
   * Kategorievergleich auf dem Lesemass, rechts die Ausgaben-Anteile als
   * Seitenleiste. Der Verlauf bleibt links, weil sein SVG mit der Breite auch
   * in der Hoehe und in der Schrift waechst. */
  body.replaceChildren();
  // Laufender Zeitraum: sagen, bis wohin gezaehlt ist - sonst fehlt der
  // angebrochene Monat ohne Erklaerung.
  const untilNote = d.until && d.until < d.to && d.until >= d.from
    ? `<p class="budget-stats__note budget-stats__until">${view.ctx.esc(t('budget.statsUntilNote', { date: dateText(d.until) }))}</p>`
    : '';
  body.insertAdjacentHTML('beforeend', `
    ${untilNote}
    ${/* DER RING IST DER KOPF DER KATEGORIELISTE (R16 Schritt 2b). Er stand im
        * Markup HINTER den Balken: mobil 874px von ihnen entfernt, am Desktop in
        * einer Seitenleiste, die unter ihm leer blieb, waehrend links 700px
        * Balken liefen. Jetzt: Verlauf und Ring teilen die erste Zeile (Ring
        * rechts), die Balken nehmen darunter die ganze Bahn; einspaltig steht
        * der Ring zwischen Verlauf und Balken. Keine leere Leiste, kein
        * Anheften. */ ''}
    <div class="budget-stats__grid">
      <div id="budget-stats-trend" class="budget-stats__main"></div>
      <div id="budget-stats-donut" class="budget-stats__aside"></div>
      <div id="budget-stats-cat" class="budget-stats__main budget-stats__main--wide"></div>
      <div id="budget-stats-entries" class="budget-stats__main budget-stats__main--wide"></div>
    </div>
    <div class="budget-stats__export"></div>
  `);
  renderTrendChart();
  watchTrendBreakpoint(view.root);
  renderCatBars();
  renderDonut();
  renderEntries();
  renderExport();
}

// Eigene Datenreihen-Palette (tokens.css) statt geborgter Fremdmodul-Akzente:
// --module-shopping/--module-meals tragen eine andere Bedeutung und garantieren
// keinen Kontrast gegen die Kartenfläche. Die Zahl der Segmente ist auf
// DONUT_SEGMENTS begrenzt, damit sich keine zwei Segmente dieselbe Farbe teilen.
// Die Palette steht seit der Critique 2026-10-16 an EINER Stelle
// (utils/budget-category-colors.js): Uebersicht und Plan faerben mit ihr.
const DONUT_COLORS = CATEGORY_SERIES_COLORS;
const DONUT_SEGMENTS = DONUT_COLORS.length;

function signed(n) {
  return formatSignedAmount(n, { currency: view.ctx.currency, role: 'flow' }).text;
}

// Je Kategorie die Summe EINER Richtung (Einnahmen oder Ausgaben) - dieselbe
// Trennung wie im Monats-Diagramm (budget.js `categoryBlocks`).
function categoryAmounts(byCategory, kind) {
  const map = new Map();
  for (const c of byCategory ?? []) {
    const value = Number(kind === 'expenses' ? c.expenses : c.income) || 0;
    if (value !== 0) map.set(c.category, value);
  }
  return map;
}

// Der Vorzeitraum als Text: „August 2026", „2025" oder „01.09. - 07.09.".
function previousPeriodLabel(prev) {
  if (!prev?.from) return '';
  // Gekuerzter Vorzeitraum (nur abgeschlossene Einheiten): die echte Strecke.
  if (prev.until && prev.until < prev.to) return dateRangeText(prev.from, prev.until);
  if (view.range === 'year') return prev.from.slice(0, 4);
  if (view.range === 'month') {
    const [y, m] = prev.from.split('-').map(Number);
    return new Intl.DateTimeFormat(getLocale(), { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
  }
  return dateRangeText(prev.from, prev.to);
}

/* VERGLEICH JE KATEGORIE STATT EINER ZWEITEN KATEGORIELISTE (Critique
 * 2026-09-25). Zwei Bloecke wie im Monats-Diagramm, jeder nach seinem eigenen
 * Maximum; neben jedem Betrag die Veraenderung gegenueber dem Vorzeitraum,
 * mit Pfeil (Richtung) und Farbe (Bewertung: mehr Ausgaben sind schlechter,
 * mehr Einnahmen besser) - dieselbe Trend-Sprache wie die Kennzahl-Karten.
 * Eine Kategorie, die nur im Vorzeitraum vorkam, steht mit null da: ihr
 * Wegfall ist genau die Veraenderung, nach der man hier sucht. */
/* EINE FARBE JE KATEGORIE IN BEIDEN DIAGRAMMEN (R14 P8, A5 P2-8) - und seit
 * der Critique 2026-10-16 in jeder Budget-Ansicht: `categoryColorIndex` kommt
 * aus utils/budget-category-colors.js, dieselbe Zuordnung wie Uebersicht und
 * Plan (groesste Ausgabe zuerst, jenseits der Palette die Sammelscheibe). */

/* DIE RICHTUNG STEHT IM BLOCK, NICHT IM VORZEICHEN (Critique R24
 * G4-Budget-P3-5, R23 "Minus doppelt"): unter "Ausgaben" stand "-1.620,99 €",
 * dieselbe Kategorie in der Uebersicht "1.620,99 €". Betraege und Summe eines
 * Blocks stehen ohne Vorzeichen wie in der Uebersicht; nur die Veraenderung
 * gegenueber dem Vorzeitraum traegt eins - sie IST eine Richtung. */
function renderCatBars() {
  const host = view.root.querySelector('#budget-stats-cat');
  if (!host) return;
  const hasPrev = !!view.prev;
  // Budgetplan-Ziele nur im Monatsbereich einblenden — dort deckt sich der
  // Zeitraum exakt mit dem stetigen Monatsplan (kein irreführendes Hochskalieren).
  const plans = view.data.range === 'month' ? (view.data.plans || {}) : {};
  const blocks = [
    { kind: 'expenses', labelKey: 'budget.statsExpenses' },
    { kind: 'income', labelKey: 'budget.statsIncome' },
  ].filter((b) => !view.filter.type || view.filter.type === b.kind).map((b) => {
    const now = categoryAmounts(view.data.byCategory, b.kind);
    const before = categoryAmounts(view.prev?.byCategory, b.kind);
    const rows = [...new Set([...now.keys(), ...before.keys()])]
      .map((category) => ({ category, amount: now.get(category) ?? 0, prev: before.get(category) ?? 0 }))
      .sort((x, y) => (Math.abs(y.amount) - Math.abs(x.amount)) || (Math.abs(y.prev) - Math.abs(x.prev)));
    return { ...b, rows };
  }).filter((b) => b.rows.some((r) => r.amount !== 0));
  if (!blocks.length) return;

  const colors = categoryColorIndex(view.data.byCategory, view.ctx.expenseCategoryKeys);
  const html = blocks.map(({ kind, labelKey, rows }) => {
    // DAS EIGENE MAXIMUM DES BLOCKS, wie im Monats-Diagramm - samt der Ziele
    // (Critique R19): eine Zielmarke ueber dem groessten Betrag klemmte vorher
    // per Math.min an der Kante und sagte damit "Ziel erreicht", wo noch Luft war.
    const targetOf = (r) => (kind === 'expenses' && plans[r.category] != null ? Number(plans[r.category]) : null);
    const max = Math.max(...rows.map((r) => Math.abs(r.amount)), ...rows.map((r) => targetOf(r) ?? 0), 1);
    const total = rows.reduce((sum, r) => sum + r.amount, 0);
    const absTotal = rows.reduce((sum, r) => sum + Math.abs(r.amount), 0);
    const titleId = `budget-stats-${kind}-title`;
    const body = rows.map((r) => {
      // Der Anteil ist der Anteil: kein Boden (Critique 2026-08-13, Guard in
      // test:frontend-audit) - der Mindeststummel steht als Laenge im CSS.
      const scale = Math.abs(r.amount) / max;
      const target = targetOf(r);
      // Die Marke ist nur noch Bild: was sie sagt, steht als Text unter dem
      // Betrag ("von 1.700 €") und fuer Screenreader samt Ausschoepfung.
      const targetMarker = target != null
        ? `<div class="budget-bar-row__target" style="--target-pos:${(target / max).toFixed(4)}" aria-hidden="true"></div>`
        : '';
      // ROT ERST AM UEBERSCHRITTENEN PLAN (Critique R21, D8): das "von 80 €"
      // traegt die Warnung, nicht das Delta daneben. Der Text sagt es mit
      // (95 € von 80 €, im Screenreader samt Prozent) - nie die Farbe allein.
      const over = target != null && target > 0 && Math.abs(r.amount) > target;
      const targetText = target != null
        ? `<span class="budget-bar-row__of${over ? ' budget-bar-row__of--over' : ''}"><span aria-hidden="true">${view.ctx.esc(t('budget.planTargetOf', { amount: view.ctx.formatAmount(target) }))}</span><span class="sr-only">${view.ctx.esc(t('budget.planTargetSr', {
          amount: view.ctx.formatAmount(target),
          percent: target > 0 ? sharePercent(Math.abs(r.amount), target) : '-',
        }))}</span></span>`
        : '';
      const catLabel = view.ctx.esc(view.ctx.categoryLabel(r.category));
      // Betragsraum wie auf den Karten: Ausgaben als Betrag, damit „+" mehr
      // ausgegeben heisst und nicht weniger.
      // Auf die Waehrung gerundet (Critique R19): sonst trug eine Differenz
      // von 2e-14 einen roten Pfeil neben "0,00 €".
      const delta = roundToCurrency(Math.abs(r.amount) - Math.abs(r.prev), view.ctx.currency);
      // KEINE VALENZFARBE (Critique R21, D8): "+25,00 €" bei 25 von 80 € Plan
      // stand rot - siebenmal auf einer Seite. Das Delta ist Sekundaerfarbe mit
      // Vorzeichen und Pfeil; Rot traegt der ueberschrittene Plan (oben).
      const deltaHtml = (hasPrev
        ? trendMarkup({ delta, text: view.ctx.esc(signed(delta)) })
        : '');
      // Ausgaben: Farbe des Donut-Segments und der Anteil als Text - die Farbe
      // ist Zuordnung, der Anteil die Aussage (auch ohne Farbsehen lesbar).
      // Die Farbe steht am Track, damit der Stummel sie mitliest (#2084).
      const color = kind === 'expenses' ? categoryColor(colors, r.category) : null;
      const fillColor = color ? `;--bar-fill:${color}` : '';
      const texture = kind === 'expenses' ? categoryTexture(colors, r.category) : null;
      const share = kind === 'expenses' && absTotal > 0 && r.amount !== 0
        ? ` <span class="budget-bar-row__share">${view.ctx.esc(sharePercent(r.amount, absTotal))}</span>`
        : '';
      const isActive = view.filter.category === r.category;
      // Unterkategorien klappen nur unter der aktiven Kategorie auf, wie auf der
      // Monatsseite.
      const subs = isActive
        ? (view.data.bySubcategory ?? []).filter((sub) => sub.category === r.category && sub.total !== 0)
        : [];
      return `
        <button type="button" class="budget-bar-row budget-bar-row--compare${isActive ? ' is-category-selected' : ''}"
                data-category="${view.ctx.esc(r.category)}" aria-pressed="${isActive}"
                aria-label="${view.ctx.esc(t('budget.viewCategoryTransactions', { name: view.ctx.categoryLabel(r.category) }))}">
          <div class="budget-bar-row__label" title="${catLabel}">${catLabel}</div>
          <div class="budget-bar-row__track" style="--bar-visible:${r.amount !== 0 ? 1 : 0}${fillColor}">
            <div class="budget-bar-row__fill budget-bar-row__fill--${kind}" style="--bar-scale:${scale.toFixed(4)}"${texture ? ` data-texture="${texture}"` : ''} data-bar-key="${kind}:${view.ctx.esc(String(r.category))}"></div>
            ${targetMarker}
          </div>
          <div class="budget-bar-row__amount">${view.ctx.esc(fmtAmount(Math.abs(r.amount)))}${share}</div>
          ${deltaHtml || targetText ? `<div class="budget-bar-row__delta">${targetText}${deltaHtml}</div>` : ''}
        </button>
        ${subs.length ? renderSubBars(subs) : ''}`;
    }).join('');
    return `
      <section class="budget-chart-block budget-chart-block--${kind}" aria-labelledby="${titleId}">
        <h3 class="budget-chart-block__title" id="${titleId}">
          <span>${t(labelKey)}</span>
          <span class="budget-chart-block__total">${view.ctx.esc(fmtAmount(Math.abs(total)))}</span>
        </h3>
        <div class="budget-chart-block__rows">${body}</div>
      </section>`;
  }).join('');

  const note = hasPrev
    ? `<p class="budget-stats__compare-note">${view.ctx.esc(t('budget.statsCompareNote', { period: previousPeriodLabel(view.prev) }))}</p>`
    : '';
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="budget-chart-section">
      <h2 class="budget-chart-section__title">${t('budget.statsCategoryTitle')}</h2>
      ${note}
      <div class="budget-chart">${html}</div>
    </div>`);
  if (window.lucide) lucide.createIcons({ el: host });
  growBars(host, { selector: '.budget-bar-row__fill', memo: 'budget-stats-categories' });
}

function renderSubBars(subs) {
  const maxAbs = Math.max(...subs.map((s) => Math.abs(s.total)), 1);
  // Dieselbe Farbe wie das Segment im Donut, der unter der aktiven Kategorie
  // ihre Unterkategorien zeigt (donutSource).
  const colors = subcategoryColorIndex(subs.filter((s) => s.expenses < 0));
  const rows = subs.map((s) => {
    const isExp = s.total < 0;
    const label = view.ctx.subcategoryLabel(s.subcategory);
    const isActive = view.filter.subcategory === s.subcategory;
    const scale = Math.abs(s.total) / maxAbs;
    const color = categoryColor(colors, s.subcategory);
    const fillColor = color ? `;--bar-fill:${color}` : '';
    const texture = categoryTexture(colors, s.subcategory);
    return `
      <button type="button" class="budget-bar-row budget-bar-row--sub${isActive ? ' is-category-selected' : ''}"
              data-subcategory="${view.ctx.esc(s.subcategory)}" aria-pressed="${isActive}"
              aria-label="${view.ctx.esc(t('budget.viewSubcategoryTransactions', { name: label }))}">
        <div class="budget-bar-row__label" title="${view.ctx.esc(label)}">${view.ctx.esc(label)}</div>
        <div class="budget-bar-row__track">
          <div class="budget-bar-row__fill ${isExp ? 'budget-bar-row__fill--expenses' : 'budget-bar-row__fill--income'}"
               style="--bar-scale:${scale.toFixed(4)}${fillColor}"${texture ? ` data-texture="${texture}"` : ''}></div>
        </div>
        <div class="budget-bar-row__amount">${view.ctx.esc(signed(s.total))}</div>
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
              aria-label="${view.ctx.esc(t('budget.clearCategoryFilter', { name: view.ctx.categoryLabel(f.category) }))}">
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
      <h2 class="budget-chart-section__title">${t('budget.transactions')} ${chips.join(' ')}</h2>
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
  // Dieselben Tage wie die Summen darueber: bis zum letzten gezaehlten.
  const { from } = view.data;
  const to = statsUntil();
  const f = view.filter;
  const cat = f.category ? `&category=${encodeURIComponent(f.category)}` : '';
  const sub = f.subcategory ? `&subcategory=${encodeURIComponent(f.subcategory)}` : '';
  try {
    const res = to < from
      ? { data: [] }
      : await api.get(`/budget?from=${from}&to=${to}&booked_only=1${cat}${sub}${scopeQuery()}`);
    // Ein späterer Klick hat die Anfrage überholt: seine Antwort gilt, nicht diese.
    if (seq !== view.entriesSeq) return;
    view.entries = res.data;
    view.entriesError = false;
    view.entriesKey = entriesKey();
  } catch (err) {
    if (seq !== view.entriesSeq) return;
    console.error('[Budget] stats entries load error:', err);
    view.entries = null;
    view.entriesError = true;
    view.entriesKey = null;
  }
  renderEntryRows();
  // Der Verlauf einer Kategorie rechnet aus genau diesen Zeilen.
  if (view.filter.category) renderTrendChart();
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
          <div class="list-row__meta budget-entry__meta">${view.ctx.esc(dateText(e.date))} · ${view.ctx.esc(view.ctx.categoryLabel(e.category))}${view.ctx.esc(sub)}</div>
        </div>
        <div class="budget-entry__amount ${isIncome ? 'budget-entry__amount--income' : 'budget-entry__amount--expenses'}">${view.ctx.formatFlow(e.amount)}</div>
      </div>`;
  }).join(''));
}

// Segmente auf die Palettengröße begrenzen: alles jenseits davon fließt in eine
// „Sonstige"-Sammelscheibe. Ein Donut mit 15 Kategorien ist ohnehin nicht mehr
// ablesbar, und ohne Deckel bekämen Segment 1 und 8 dieselbe Farbe.
//
// Jedes Segment traegt die Farbe SEINER Kategorie (R19: nach Katalogstelle,
// nicht nach Rang - categoryColorIndex), die Sammelscheibe die neutrale.
//
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
      const colors = subcategoryColorIndex(subs);
      return {
        drilledCategory: cat,
        slices: subs.map((s) => ({
          label: view.ctx.subcategoryLabel(s.subcategory),
          value: Math.abs(s.expenses),
          color: categoryColor(colors, s.subcategory),
          texture: categoryTexture(colors, s.subcategory),
        })),
      };
    }
  }
  const byCategory = view.data.byCategory;
  const colors = categoryColorIndex(byCategory, view.ctx.expenseCategoryKeys);
  return {
    drilledCategory: null,
    slices: byCategory
      .filter((c) => c.expenses < 0)
      .map((c) => ({
        label: view.ctx.categoryLabel(c.category),
        value: Math.abs(c.expenses),
        color: categoryColor(colors, c.category),
        texture: categoryTexture(colors, c.category),
      })),
  };
}

/* Farben der Unterkategorien: dieselbe Zuordnung wie fuer Kategorien, nur ohne
 * Katalog - die Stelle folgt dem Schluessel, bleibt also ueber Zeitraeume
 * stabil, und Schraffur (Tritanopie) und Farbe laufen nie auseinander. Donut
 * und Unterkategorie-Balken lesen beide hier. */
function subcategoryColorIndex(subs) {
  return categoryColorIndex(subs.map((s) => ({ category: s.subcategory, expenses: s.expenses })));
}

function donutSlices(src) {
  const exp = [...src.slices]
    .sort((a, b) => b.value - a.value);
  if (exp.length <= DONUT_SEGMENTS) return exp;
  const head = exp.slice(0, DONUT_SEGMENTS - 1);
  const restValue = exp.slice(DONUT_SEGMENTS - 1).reduce((s, e) => s + e.value, 0);
  return [...head, { label: t('budget.statsOtherCategories'), value: restValue, color: CATEGORY_OTHER_COLOR }];
}

/* FUGEN ZWISCHEN DEN SEGMENTEN (R19, Critique 2026-10-16): Segmente stiessen
 * ohne Abstand aneinander, und zwei Toene, die eine Farbfehlsicht angleicht,
 * flossen ineinander. 2 Einheiten (bei 160 Einheiten Breite rund 2px) bleiben
 * zwischen je zwei Segmenten frei; ein einziges Segment schliesst den Ring. */
const DONUT_GAP = 2;

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
  const gap = exp.length > 1 ? DONUT_GAP : 0;
  const segs = exp.map((e) => {
    const frac = e.value / total;
    const dash = `stroke-dasharray="${Math.max(frac * C - gap, 0.5).toFixed(2)} ${C.toFixed(2)}"
        stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 80 80)"`;
    // Die Schraffur liegt als zweiter Strich auf dem Segment (categoryTexture,
    // Tritanopie): derselbe Bogen, gemalt mit dem Muster aus <defs>.
    const seg = `
      <circle r="60" cx="80" cy="80" fill="none" stroke="${e.color}" stroke-width="16" ${dash} />${e.texture ? `
      <circle r="60" cx="80" cy="80" fill="none" stroke="url(#budget-donut-${e.texture})" stroke-width="16" ${dash} class="budget-stats__donut-texture" />` : ''}`;
    offset += frac * C;
    return seg;
  }).join('');
  const hatch = exp.some((e) => e.texture === 'hatch') ? `
          <defs>
            <pattern id="budget-donut-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="1.5" height="4" class="budget-stats__hatch-line" />
            </pattern>
          </defs>` : '';
  // KEINE ZWEITE LEGENDE (R14 P8): Betrag und Anteil je Kategorie stehen an
  // den Balken, die dieselbe Farbe tragen (categoryColorIndex). Die
  // Donut-Legende zaehlte alles ein zweites Mal auf. Die Zusammenfassung
  // (Zahl der Segmente, groesstes, Summe) stand seit R16 SICHTBAR neben dem
  // Ring: sie war nur fuer Screenreader da, und der Ring stand ohne ein Wort
  // neben 198px Leere.
  //
  // DIE SUMME STEHT IN DER RINGMITTE (Critique R18, 2026-10-07). Der Satz
  // "7 Segmente · Groesstes: ..." war Fliesstext neben einem leeren Ring - das
  // eine Wort, das der Ring braucht, ist seine Summe, und die gehoert in seine
  // Mitte. Was R16 schuetzte, bleibt: der Ring steht nicht stumm da (er nennt
  // jetzt sichtbar, WAS er teilt und wie viel), und er steht nicht neben Leere
  // (er sitzt mittig auf seinem Traeger). Der Satz geht zurueck in die
  // zugaengliche Beschreibung - mit der genauen Summe; die Mitte rundet auf
  // ganze Einheiten, damit auch sechsstellige Betraege in 104px passen.
  const summary = t('budget.statsDonutSummary', {
    count: exp.length,
    top: exp[0].label,
    pct: pctOf(exp[0].value),
    total: fmtAmount(total),
  });

  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="budget-chart-section">
      <h2 class="budget-chart-section__title">${t('budget.statsDonutTitle')}${titleSuffix}</h2>
      <p class="sr-only">${view.ctx.esc(summary)}</p>
      <div class="budget-stats__card budget-stats__donut-wrap">
        <svg viewBox="0 0 160 160" class="budget-stats__donut" aria-hidden="true">${hatch}
          <g class="budget-stats__donut-arcs">${segs}</g>
          <text class="budget-stats__donut-total" x="80" y="77" text-anchor="middle">${view.ctx.esc(formatMoneyAxis(total, view.ctx.currency))}</text>
          <text class="budget-stats__donut-label" x="80" y="77" dy="1.5em" text-anchor="middle">${view.ctx.esc(t('budget.statsExpenses'))}</text>
        </svg>
      </div>
    </div>`);
  // Der Ring fuellt sich einmal, beim ersten Erscheinen (ux.js, drawChartOnce).
  drawChartOnce('budget-stats-donut', { arcs: host.querySelectorAll('.budget-stats__donut circle') });
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

function entriesKey() {
  const f = view.filter;
  return [view.data?.from, view.data?.until ?? view.data?.to, f.category ?? '', f.subcategory ?? ''].join('|');
}

/**
 * Verteilt Buchungen auf die Abschnitte einer Serie (Tage oder Monate).
 * Rein, damit es ohne DOM prüfbar ist.
 *
 * @param {{period: string}[]} base     Serie des Zeitraums, liefert die Abschnitte
 * @param {{date: string, amount: number}[]} entries
 */
export function bucketEntries(base, entries) {
  const len = base[0]?.period.length ?? 10;
  const byPeriod = new Map(base.map((p) => [p.period, { period: p.period, income: 0, expenses: 0, balance: 0 }]));
  for (const e of entries) {
    const bucket = byPeriod.get(String(e.date).slice(0, len));
    if (!bucket) continue;
    if (e.amount > 0) bucket.income += e.amount; else bucket.expenses += e.amount;
    bucket.balance += e.amount;
  }
  return [...byPeriod.values()];
}

/**
 * Durchschnitt und Median über die Abschnitte einer Kurve.
 *
 * NUR GEZAEHLTE ABSCHNITTE: im laufenden Jahr stehen der laufende Monat und
 * die folgenden als Nullen in der Serie (der Server zaehlt nur abgeschlossene
 * Monate), und mit ihnen laege der Durchschnitt im Oktober um ein Viertel zu
 * tief. Ein vergangener Abschnitt ohne Buchung zaehlt dagegen als 0 - ein
 * Monat ohne Ausgabe ist eine Auskunft, keine Luecke.
 *
 * @param {number[]} values
 * @param {string[]} periods  'YYYY-MM' oder 'YYYY-MM-DD', parallel zu values
 * @param {string} until      'YYYY-MM-DD', letzter gezaehlter Tag (Antwort `until`)
 * @returns {{average: number, median: number, count: number}}
 */
export function seriesStats(values, periods, until) {
  const past = values.filter((_, i) => periods[i] <= until.slice(0, periods[i].length));
  const used = past.length ? past : values;
  if (!used.length) return { average: 0, median: 0, count: 0 };
  const sorted = [...used].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const average = used.reduce((sum, v) => sum + v, 0) / used.length;
  return { average, median, count: used.length };
}

// Unter einer Kategorie zeigt der Verlauf nur sie. Die Zeilen dafür lädt die
// Buchungsliste ohnehin; bis sie da sind, steht das leere Raster in voller
// Höhe, damit die Seite unter dem Klick nicht springt - ohne die Gesamtkurve,
// die unter dem Kategorie-Titel eine falsche Auskunft wäre.
function trendSeries() {
  const base = view.data.series;
  if (!view.filter.category) return { series: base, filtered: false, pending: false };
  if (view.entriesKey !== entriesKey() || !view.entries) return { series: base, filtered: false, pending: true };
  return { series: bucketEntries(base, view.entries), filtered: true, pending: false };
}

function trendTitleSuffix() {
  const f = view.filter;
  if (!f.category) return '';
  const sub = f.subcategory ? ` · ${view.ctx.esc(view.ctx.subcategoryLabel(f.subcategory))}` : '';
  return ` · ${view.ctx.esc(view.ctx.categoryLabel(f.category))}${sub}`;
}

function renderTrendChart() {
  const host = view.root.querySelector('#budget-stats-trend');
  if (!host) return;
  if (view.filter.category && view.entriesError) {
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', `
      <div class="budget-chart-section">
        <h2 class="budget-chart-section__title">${t('budget.statsTrendTitle')}${trendTitleSuffix()}</h2>
        <p class="budget-stats__note">${view.ctx.esc(t('budget.statsError'))}</p>
      </div>`);
    return;
  }
  const { series: s, filtered, pending } = trendSeries();
  // Der Vergleich mit dem Vorzeitraum gilt dem ganzen Haushalt - unter einer
  // Kategorie waere er eine falsche Auskunft.
  const comparison = filtered || pending ? null : view.data.comparison;
  const rawIncomes  = s.map((p) => p.income);
  const rawExpenses = s.map((p) => Math.abs(p.expenses));
  // Welche Kurven stehen: der Einnahmen/Ausgaben-Filter blendet die andere
  // Seite aus, und unter einer Kategorie entfällt die Seite, die sie nicht hat -
  // eine Ausgabenkategorie zöge sonst eine Einnahmenlinie auf der Null mit.
  const type = view.filter.type;
  let showIncome   = type !== 'expenses' && (!filtered || rawIncomes.some((v) => v));
  let showExpenses = type !== 'income' && (!filtered || rawExpenses.some((v) => v));
  if (!showIncome && !showExpenses) { showExpenses = type !== 'income'; showIncome = !showExpenses; }
  /* AUFSUMMIERT, SOLANGE DIE PUNKTE TAGE SIND (Critique 2026-09-25). Als
   * Tageswerte war der Monat eine flache Linie mit zwei Zacken (Gehalt, Miete)
   * - wie der Monat verlaeuft, ob die Ausgaben die Einnahmen einholen, sah man
   * nicht. Aufsummiert endet jede Kurve bei der Summe des Zeitraums, und der
   * Abstand zwischen beiden ist der Saldo bis zu diesem Tag. Das Jahr bleibt
   * je Monat: zwoelf Monatswerte vergleicht man nebeneinander. */
  const cumulative = s.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(s[0].period);
  const running = (arr) => { let acc = 0; return arr.map((v) => (acc += v)); };
  const incomes  = cumulative ? running(rawIncomes) : rawIncomes;
  const expenses = cumulative ? running(rawExpenses) : rawExpenses;
  const shown = s.map((p, i) => ({ period: p.period, income: incomes[i], expenses: expenses[i] }));
  const max = Math.max(1, ...(showIncome ? incomes : []), ...(showExpenses ? expenses : []));
  // Ruhige Achse (R18): drei Linien - 0 / 3.000 / 6.000. `max` bleibt der echte
  // Spitzenwert fuer die Zusammenfassung, die Kurve misst gegen die Obergrenze.
  const axis = calmAxis(max);
  // MOBIL EINE HOEHERE FLAECHE (Critique R17). Die Geometrie skaliert mit der
  // Breite: 600x200 wurden bei 390px Fenster 324x108 - eine Kurve, die zwischen
  // zwei Gitterlinien kaum Hub hat. Unter 640px rechnet das Diagramm auf
  // 600x300 (dieselben Raender, utils/chart.js `geo`) und steht damit bei
  // mindestens 160px. Entschieden beim Zeichnen, wie die uebrigen Flaechen.
  const geo = trendGeometry();
  // HEUTE TEILT DIE KURVE (Critique R17). Aufsummiert lief sie durchgezogen bis
  // zum Monatsende - ab heute eine waagerechte Linie, die behauptet, es sei
  // schon gebucht. EIN Strichprinzip (R18): was war, ist durchgezogen, was
  // kommt, punktiert - fuer beide Serien. Die Serien selbst trennt die Farbe,
  // die Flaeche unter den Einnahmen und der beschriftete Punkt am heutigen Tag;
  // die Ausgaben trugen bis dahin zusaetzlich eine Strichelung, und mit der
  // punktierten Zukunft standen drei Strichmuster in einem Bild.
  const todayIndex = cumulative ? futureStartIndex(s.map((p) => p.period), todayKey()) : -1;
  // Im Jahr endet die Linie am letzten abgeschlossenen Monat: danach stehen
  // nur Nullen, weil der Server noch nicht zaehlt - kein Absturz auf die Null.
  const until = statsUntil();
  const lastCounted = s.reduce((acc, p, i) => (p.period <= until.slice(0, p.period.length) ? i : acc), 0);
  const lastPast = todayIndex >= 0 ? todayIndex : cumulative ? s.length - 1 : lastCounted;
  const points = (arr, from = 0, to = arr.length - 1) => arr
    .map((v, i) => (i < from || i > to ? null : `${chartX(i, s.length, geo).toFixed(1)},${chartY(v, 0, axis.max, geo).toFixed(1)}`))
    .filter(Boolean).join(' ');
  // Die Flaeche unter den Einnahmen reicht bis heute: die Linie, unten
  // geschlossen auf der Grundlinie (Bauart der Abo-Prognose, subscriptions.js).
  const baseY = chartY(0, 0, axis.max, geo).toFixed(1);
  // Eine ausgeblendete Serie (oder alle, solange die Kategorie laedt) behaelt
  // ihr Element mit leeren Punkten: die Gruppe zeichnet sich als Ganzes ein.
  const incomeOn = showIncome && !pending;
  const expensesOn = showExpenses && !pending;
  const areaPoints = !incomeOn ? '' : `${chartX(0, s.length, geo).toFixed(1)},${baseY} ${points(incomes, 0, lastPast)} ${chartX(lastPast, s.length, geo).toFixed(1)},${baseY}`;
  // DER PUNKT MIT WERT (R18): am heutigen Tag, ohne Zukunft am letzten Tag mit
  // Daten. Er traegt, was die Kurve sonst nur ueber die Achse hergab.
  let markIndex = lastPast;
  if (todayIndex < 0 && !cumulative) while (markIndex > 0 && !rawIncomes[markIndex] && !rawExpenses[markIndex]) markIndex -= 1;
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);

  // Durchschnitt und Median gelten EINER Kurve - vier Hilfslinien über zwei
  // Kurven läse niemand mehr. Es ist die der Ausgaben, solange sie steht.
  // Gerechnet je Abschnitt (Tag oder Monat), aus den Rohwerten: aufsummiert
  // waere ein Mittelwert der Laufsumme keine Auskunft. Als waagerechte Linie
  // steht er deshalb nur im Monatsraster (Jahr), wo die Kurve die Rohwerte
  // zeigt; aufsummiert nennt ihn die Legende.
  const stats = seriesStats(showExpenses ? rawExpenses : rawIncomes, s.map((p) => p.period), until);
  const avgText = `${t('budget.statsAverage')} ${fmtAmount(stats.average)}`;
  const medText = `${t('budget.statsMedian')} ${fmtAmount(stats.median)}`;
  const drawRefs = stats.count > 0 && !cumulative && !pending;
  // Beschriftung über der einen, unter der anderen Linie: liegen beide Werte
  // gleich, stehen die Zahlen trotzdem nicht aufeinander.
  const refLine = (value, cls, label, above) => {
    const y = chartY(value, 0, axis.max, geo);
    const ty = above ? Math.max(geo.PAD_T + 8, y - 4) : y + 11;
    const right = geo.W - geo.PAD_R;
    return `
            <line class="budget-stats__ref ${cls}" x1="${geo.PAD_L}" y1="${y.toFixed(1)}" x2="${right}" y2="${y.toFixed(1)}"
                  vector-effect="non-scaling-stroke" />
            <text class="chart__axis budget-stats__ref-label" x="${right}" y="${ty.toFixed(1)}" text-anchor="end">${view.ctx.esc(label)}</text>`;
  };
  const averageAbove = stats.average >= stats.median;
  const refLines = drawRefs
    ? refLine(stats.average, 'budget-stats__ref--average', avgText, averageAbove)
      + refLine(stats.median, 'budget-stats__ref--median', medText, !averageAbove)
    : '';

  const pointKey = cumulative ? 'budget.statsPointLabelCumulative' : 'budget.statsPointLabel';

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
  // Zweiter Kanal neben der Farbe (Critique P2, seit R18 ohne Strichelung): die
  // Einnahmen tragen die Flaeche, beide Serien einen beschrifteten Punkt, die
  // Legende nennt sie - so trennen sie sich auch bei Rot-Grün-Schwäche. Der
  // Screenreader-Zugang liegt in der sr-only-Summary + den Punkt-Buttons; das
  // rein visuelle SVG bleibt daher bewusst aria-hidden.
  const summary = `${t('budget.statsTrendSummary', {
    periods: s.length,
    income: fmtAmount(sum(rawIncomes)),
    expenses: fmtAmount(sum(rawExpenses)),
    peak: fmtAmount(max),
  })}${stats.count ? ` · ${avgText} · ${medText}` : ''}`;

  // Ablesbare Einzelwerte: die Kurve allein sagt nur "irgendwann im Mai war es
  // viel". Je Datenpunkt eine unsichtbare Schaltfläche über dem Diagramm — der
  // Wert steht in ihrem aria-label (also auch ohne Maus erreichbar, nicht als
  // Hover-only-Tooltip) und erscheint sichtbar in der Ableselinie darunter.
  const hotspots = shown.map((p, i) => {
    const label = t(pointKey, {
      period: periodLabel(p.period),
      income: fmtAmount(p.income),
      expenses: fmtAmount(p.expenses),
    });
    const frac = chartX(i, s.length, geo) / geo.W;
    return `<button type="button" class="budget-stats__point" data-index="${i}"
              style="--point-x:${frac.toFixed(4)};--point-slots:${s.length}"
              tabindex="${i === s.length - 1 ? '0' : '-1'}"
              aria-label="${view.ctx.esc(label)}"></button>`;
  }).join('');

  // `.chart` traegt 600 / 200 als Seitenverhaeltnis (panel.css); die hoehere
  // Flaeche sagt ihres selbst an (wie die Gesundheits-Diagramme).
  const { W, H } = geo;
  const ratio = H === CHART.H ? '' : ` style="aspect-ratio: ${W} / ${H}"`;
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="budget-chart-section">
      <h2 class="budget-chart-section__title">${t(cumulative ? 'budget.statsTrendTitleCumulative' : 'budget.statsTrendTitle')}${trendTitleSuffix()}</h2>
      <p class="sr-only">${view.ctx.esc(summary)}</p>
      <div class="budget-stats__card">
      <div class="budget-stats__trend-wrap">
        <div class="budget-stats__plot"${pending ? ' aria-busy="true"' : ''}>
          <svg class="chart budget-stats__trend" viewBox="0 0 ${W} ${H}"${ratio} aria-hidden="true">
            <defs>
              <linearGradient id="budget-stats-area" x1="0" y1="0" x2="0" y2="1">
                <stop class="budget-stats__area-from" offset="0" />
                <stop class="budget-stats__area-to" offset="1" />
              </linearGradient>
            </defs>
            ${chartGridMarkup(0, axis.max, (val) => formatMoneyAxis(val, view.ctx.currency), geo, axis.steps)}
            ${chartXLabelsMarkup(axisLabels(s.map((p) => p.period)), geo)}
            ${todayIndex >= 0 ? todayMarkerMarkup(chartX(todayIndex, s.length, geo), geo) : ''}
            ${refLines}
            <g class="budget-stats__lines">
              <polygon class="budget-stats__area" fill="url(#budget-stats-area)" points="${areaPoints}" />
              <polyline class="budget-stats__line budget-stats__line--income" fill="none" stroke-width="2"
                        vector-effect="non-scaling-stroke" points="${incomeOn ? points(incomes, 0, lastPast) : ''}" />
              <polyline class="budget-stats__line budget-stats__line--expense" fill="none" stroke-width="2"
                        vector-effect="non-scaling-stroke" points="${expensesOn ? points(expenses, 0, lastPast) : ''}" />
              ${todayIndex >= 0 ? `
              <polyline class="budget-stats__line budget-stats__line--income budget-stats__future" fill="none" stroke-width="2"
                        vector-effect="non-scaling-stroke" points="${incomeOn ? points(incomes, todayIndex) : ''}" />
              <polyline class="budget-stats__line budget-stats__line--expense budget-stats__future" fill="none" stroke-width="2"
                        vector-effect="non-scaling-stroke" points="${expensesOn ? points(expenses, todayIndex) : ''}" />` : ''}
              ${markMarkup({ x: chartX(markIndex, s.length, geo), income: incomeOn ? incomes[markIndex] : null, expenses: expensesOn ? expenses[markIndex] : null, axisMax: axis.max, geo })}
            </g>
          </svg>
          <div class="budget-stats__points" role="group" aria-label="${t('budget.statsPointsLabel')}">${pending ? '' : hotspots}</div>
        </div>
      </div>
      <div class="budget-stats__readout" id="budget-stats-readout" aria-hidden="true"></div>
      <div class="budget-stats__legend">${pending ? '' : legendMarkup({
        showIncome, showExpenses, stats, drawRefs, comparison,
        income: trendLegendFigures(incomes, rawIncomes, markIndex, todayIndex >= 0),
        expenses: trendLegendFigures(expenses, rawExpenses, markIndex, todayIndex >= 0),
      })}</div>
      </div>
    </div>`);
  // Der Gutter folgt dem breitesten Achsenwert (#1607): "₩6,000,000" ist breiter
  // als die Mindestbreite, die an "5.550 €" bemessen ist. Gemessen wird ohne
  // Aufruf von hier: `watchChartGutters()` (utils/chart.js) sieht das SVG, sobald
  // es im Dokument steht (#1722).
  if (window.lucide) lucide.createIcons({ el: host });
  // Die Ableselinie startet am beschrifteten Punkt, solange der Zeitraum
  // laeuft: sonst nannte sie den letzten Tag MIT Eintrag (auch einen geplanten
  // nach heute), und unter Punkt und Legende stand eine dritte Zahl.
  wireTrendPoints(host, shown, pointKey, s, todayIndex >= 0 ? markIndex : null);
  // Die Kurven zeichnen sich einmal ein, beim ersten Erscheinen - nicht bei
  // jedem Zeitraum (ux.js, drawChartOnce). Raster und Achse stehen.
  drawChartOnce('budget-stats-trend', { lines: host.querySelector('.budget-stats__lines') });
}

/* DIE LEGENDE IST DER TYPFILTER. Die Kennzahl-Karten, auf denen der Filter
 * Einnahmen/Ausgaben sass, stehen seit der Critique 2026-09-25 nur noch auf der
 * Uebersicht; ihre Summen nennt hier die Legende - also schaltet sie auch. */
function legendMarkup({ showIncome, showExpenses, stats, drawRefs, income, expenses, comparison }) {
  // Zahlen aus trendLegendFigures: der Wert am beschrifteten Punkt, der Rest
  // als "geplant", der Vergleich auf die Summe.
  const typeItem = (type, label, { total, value, planned }, previous) => {
    const on = view.filter.type === type;
    const plannedHtml = planned > 0
      ? ` <span class="budget-stats__legend-planned">${view.ctx.esc(t('budget.statsPlannedRest', { amount: fmtAmount(planned) }))}</span>`
      : '';
    return `<button type="button" class="budget-stats__legend-item budget-stats__legend-toggle${on ? ' is-active' : ''}"
              data-type-filter="${type}" aria-pressed="${on}"
              aria-label="${view.ctx.esc(t(type === 'income' ? 'budget.filterIncomeLabel' : 'budget.filterExpensesLabel'))}"><i class="budget-stats__swatch budget-stats__swatch--${type === 'income' ? 'income' : 'expense'}"></i>${label} · ${fmtAmount(value)}${plannedHtml}${totalTrend(total, previous)}</button>`;
  };
  const refItem = (kind, labelKey, value) => `<span class="budget-stats__legend-item">${drawRefs ? `<i class="budget-stats__swatch budget-stats__swatch--${kind}"></i>` : ''}${view.ctx.esc(t(labelKey))} · ${fmtAmount(value)}</span>`;
  return [
    showIncome ? typeItem('income', t('budget.statsIncome'), income, comparison?.income) : '',
    showExpenses ? typeItem('expenses', t('budget.statsExpenses'), expenses, comparison && Math.abs(comparison.expenses)) : '',
    stats.count ? refItem('average', 'budget.statsAverage', stats.average) : '',
    stats.count ? refItem('median', 'budget.statsMedian', stats.median) : '',
  ].join('');
}

/** Die Flaeche des Verlaufs: mobil hoeher (siehe renderTrendChart). */
const TREND_CHART_NARROW = Object.freeze({ ...CHART, H: 300 });

/**
 * Die Geometrie haengt an der Breite, also zeichnet der Verlauf neu, wenn das
 * Fenster die Schwelle kreuzt (Telefon gedreht, Fenster geteilt): sonst blieb
 * die Flaeche der alten Breite stehen - 600x200 auf dem Telefon ist genau das
 * gedrungene Diagramm, das die hoehere Flaeche abloest. EIN Lauscher je
 * Modul; er meldet sich ab, sobald sein Panel aus dem Dokument ist.
 */
let trendWatch = null;
function watchTrendBreakpoint(panel) {
  const mql = globalThis.window?.matchMedia?.('(max-width: 639px)');
  if (!mql?.addEventListener) return;
  trendWatch?.mql.removeEventListener('change', trendWatch.onChange);
  const onChange = () => {
    if (!panel.isConnected) {
      mql.removeEventListener('change', onChange);
      if (trendWatch?.onChange === onChange) trendWatch = null;
      return;
    }
    renderTrendChart();
  };
  mql.addEventListener('change', onChange);
  trendWatch = { mql, onChange };
}

function trendGeometry() {
  return globalThis.window?.matchMedia?.('(max-width: 639px)')?.matches === true ? TREND_CHART_NARROW : CHART;
}

/**
 * Der Punkt, an dem die Zukunft beginnt: der Index des letzten Tages bis
 * heute. `-1`, wenn der Zeitraum keine Zukunft hat (heute ist der letzte Tag
 * oder liegt dahinter) oder ganz in ihr liegt (heute vor dem ersten Tag) -
 * dann gibt es nichts zu teilen. Tagesschluessel vergleichen sich als Text.
 * @param {string[]} periods  'YYYY-MM-DD', aufsteigend
 * @param {string} today      Tagesschluessel der Haushaltszone (todayKey())
 */
function futureStartIndex(periods, today) {
  if (!periods.length || today < periods[0] || today >= periods[periods.length - 1]) return -1;
  let index = -1;
  for (let i = 0; i < periods.length; i += 1) {
    if (periods[i] <= today) index = i;
    else break;
  }
  return index;
}

/**
 * Die ruhige Achse des Verlaufs: drei Linien, ganzzahlige Schritte (die
 * Geldachse beschriftet ohne Nachkommastellen). Regel und Begruendung stehen
 * an `calmDomain` (utils/chart.js) - die Aktivitaet der Gesundheit nutzt sie auch.
 * @param {number} max  groesster Datenwert
 * @returns {{ max: number, step: number, steps: 2 }}
 */
function calmAxis(max) {
  const { max: top, step, steps } = calmDomain(max, { integer: true });
  return { max: top, step, steps };
}

/**
 * Senkrechte Marke am heutigen Tag, das Wort UEBER der Flaeche.
 *
 * DAS WORT STEHT UEBER DER OBERSTEN LINIE, NICHT DARAUF (R18). Es hing an der
 * Oberkante des Plots (`dominant-baseline: hanging` bei PAD_T) - genau auf der
 * obersten Gitterlinie, und wo die Einnahmen am Monatsanfang schon oben
 * liefen, auch auf der Kurve: gemessen bei 390px war "Heute" durchgestrichen.
 * Jetzt sitzt es mittig ueber der Marke, eine halbe Schrifthoehe ueber der
 * Linie (`dy` in em, die Achsenschrift ist fest); das SVG zeigt seinen
 * Ueberlauf (`svg.chart`, panel.css), der Traeger haelt den Platz frei
 * (`.budget-stats__trend-wrap`, budget.css).
 */
function todayMarkerMarkup(x, geo) {
  const top = geo.PAD_T;
  const bottom = geo.H - geo.PAD_B;
  const anchor = todayAnchor(x, geo);
  return `
            <line class="budget-stats__today" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top}" y2="${bottom}" vector-effect="non-scaling-stroke" />
            <text class="chart__axis budget-stats__today-label" x="${x.toFixed(1)}" y="${top}" dy="-0.5em" text-anchor="${anchor}">${view.ctx.esc(t('common.today'))}</text>`;
}

/** An den Raendern steht das Wort buendig zur Marke, sonst liefe es aus dem Bild. */
function todayAnchor(x, geo) {
  if (x > geo.W - geo.PAD_R - 40) return 'end';
  if (x < geo.PAD_L + 40) return 'start';
  return 'middle';
}

/**
 * Wo die Werte der beiden Punkte stehen. Die hoehere Serie traegt ihren Wert
 * UEBER dem Punkt, die tiefere DARUNTER - so stossen die beiden nie aneinander.
 * Liegt die tiefere zu nah an der Grundlinie (unter 15 % der Achse), stuende
 * ihr Wert in der Zeile der X-Beschriftung: dann wandert er ueber den Punkt,
 * sofern zwischen beiden Punkten Platz ist (20 % der Achse), sonst entfaellt
 * er - Legende und Ableselinie nennen ihn weiter.
 * @returns {{ income: 'above'|'below'|null, expenses: 'above'|'below'|null }}
 */
function markLabelPlan(income, expenses, axisMax) {
  // Nur eine Serie sichtbar (Filter): ihr Wert steht ueber dem Punkt.
  if (income == null || expenses == null) {
    return { income: income == null ? null : 'above', expenses: expenses == null ? null : 'above' };
  }
  const hi = income >= expenses ? 'income' : 'expenses';
  const lo = hi === 'income' ? 'expenses' : 'income';
  const value = { income, expenses };
  const plan = { income: null, expenses: null };
  plan[hi] = 'above';
  if (value[lo] / axisMax >= 0.15) plan[lo] = 'below';
  else if ((value[hi] - value[lo]) / axisMax >= 0.2) plan[lo] = 'above';
  return plan;
}

/**
 * Die zwei Punkte am markierten Tag samt Wert. Jeder Punkt ist eine Linie der
 * Laenge null mit runder Kappe und `non-scaling-stroke`: so bleibt er bei jeder
 * Breite 8px gross (ein `<circle>` skalierte mit dem viewBox auf 4 bis 12px),
 * darunter derselbe in Flaechenfarbe als 2px-Ring, damit er sich von der Linie
 * loest. Die Werte tragen Textfarbe, nicht die der Serie, und einen Hof in
 * Flaechenfarbe (`paint-order`), damit keine Linie durch eine Ziffer laeuft.
 */
function markMarkup({ x, income, expenses, axisMax, geo }) {
  const plan = markLabelPlan(income, expenses, axisMax);
  // Am rechten Rand stehen die Werte links vom Punkt.
  const flip = x > geo.W - geo.PAD_R - 90;
  const dot = (series, value) => {
    const y = chartY(value, 0, axisMax, geo).toFixed(1);
    const at = `x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y}" y2="${y}" vector-effect="non-scaling-stroke"`;
    const where = plan[series];
    const label = where
      ? `<text class="chart__axis budget-stats__mark-value" x="${x.toFixed(1)}" y="${y}" dx="${flip ? '-0.7em' : '0.7em'}" dy="${where === 'above' ? '-0.6em' : '1.4em'}" text-anchor="${flip ? 'end' : 'start'}">${view.ctx.esc(formatMoneyAxis(value, view.ctx.currency))}</text>`
      : '';
    return `<line class="budget-stats__mark-ring" ${at} /><line class="budget-stats__mark budget-stats__mark--${series}" ${at} />${label}`;
  };
  return [['income', income], ['expenses', expenses]]
    .filter(([, value]) => value != null)
    .map(([series, value]) => dot(series, value)).join('');
}

/**
 * DIE ZEITACHSE SAGT NUR, WAS DER KOPF NICHT SAGT (R18). Unter einem Kopf, der
 * "Oktober 2026" nennt, stand dreimal das volle Datum ("01.10.2026"). Jetzt
 * der Tag allein ("1.", "16.", "31." - in der Schreibweise der Sprache); laeuft
 * der Zeitraum ueber eine Monatsgrenze (Woche), kommt der Monat dazu, im Jahr
 * steht der Monatsname und das Jahr nur, wenn die Reihe zwei Jahre beruehrt.
 * Ableselinie und Punkt-Labels nennen weiter das volle Datum (`periodLabel`).
 * @param {string[]} periods  'YYYY-MM-DD' oder 'YYYY-MM', aufsteigend
 */
function axisLabels(periods) {
  if (!periods.length) return [];
  const first = periods[0];
  const last = periods[periods.length - 1];
  const daily = /^\d{4}-\d{2}-\d{2}$/.test(first);
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  const options = daily
    ? (first.slice(0, 7) === last.slice(0, 7) ? { day: 'numeric' } : { day: 'numeric', month: 'numeric' })
    : (sameYear ? { month: 'short' } : { month: 'short', year: '2-digit' });
  // Mittags statt Mitternacht: der Schluessel ist ein Kalendertag, kein
  // Zeitpunkt - so kippt er in keiner Zone auf den Nachbartag.
  const fmt = new Intl.DateTimeFormat(getLocale(), options);
  // DER TAG ALLEIN TRAEGT DEN PUNKT SEINER SPRACHE. Intl schreibt den Tag ohne
  // Monat als nackte Zahl ("1"), auch wo die Sprache ihn als Ordnungszahl
  // setzt ("1." in de, fi, hu). Ob sie das tut, steht im Tag-Monat-Muster:
  // folgt dem Tag dort ein Punkt, gehoert er zum Tag. Sprachen mit eigenem
  // Zeichen ("1日", "1일") bringen es schon mit und bleiben unberuehrt.
  let suffix = '';
  if (daily && options.month === undefined) {
    const parts = new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'numeric' }).formatToParts(new Date(2026, 0, 2, 12));
    const at = parts.findIndex((part) => part.type === 'day');
    if (parts[at + 1]?.type === 'literal' && parts[at + 1].value.startsWith('.')) suffix = '.';
  }
  return periods.map((p) => {
    const [y, m, d = 1] = p.split('-').map(Number);
    const text = fmt.format(new Date(y, m - 1, d, 12));
    return /^\d+$/.test(text) ? `${text}${suffix}` : text;
  });
}

// Bucket-Schlüssel der Serie: 'YYYY-MM' (Monatsraster) oder 'YYYY-MM-DD' (Tage).
function periodLabel(period) {
  if (/^\d{4}-\d{2}$/.test(period)) {
    const [y, m] = period.split('-').map(Number);
    return new Intl.DateTimeFormat(getLocale(), { month: 'short', year: 'numeric' }).format(new Date(y, m - 1, 1));
  }
  return dateText(period);
}

// Ableselinie + Roving-Tabindex über den Datenpunkten. Ein Tabstopp für die
// ganze Kurve (nicht 31 bei einem Monatsraster), Pfeiltasten wandern, Zeigen
// und Antippen wählen direkt. Der Wert steht ohnehin im aria-label jedes
// Punktes — die sichtbare Zeile ist die Entsprechung für alle anderen.
/* Die Summe des Zeitraums gegen den Vorzeitraum, in der Trend-Sprache der
 * Kennzahl-Karten - die Karten selbst stehen auf der Uebersicht. */
/**
 * Was die Legende neben einer Serie nennt (Re-Critique 2026-10-17, P1).
 *
 * Sie las die Summe des GANZEN Zeitraums, der beschriftete Punkt der Kurve den
 * Stand am heutigen Tag: "Heute" 2.712 EUR neben "Einnahmen · 3.046,11 EUR",
 * zwei Zahlen fuer scheinbar dasselbe. Jetzt eine Quelle: Laeuft der Zeitraum
 * noch (aufsummiert, heute im Bild), nennt die Legende genau den Wert des
 * Punkts und das, was danach noch eingetragen ist, getrennt als "geplant".
 * Sonst bleibt es bei der Summe. Der Vergleich mit dem Vorzeitraum rechnet
 * weiter mit der Summe des ganzen Zeitraums - so ist er auch gebaut.
 *
 * @param {number[]} shownArr  die gezeichnete Serie (aufsummiert oder roh)
 * @param {number[]} rawArr    die Rohwerte je Abschnitt
 * @param {number} markIndex   der Abschnitt des beschrifteten Punkts
 * @param {boolean} running    aufsummiert und der Zeitraum enthaelt heute
 *                             (todayIndex gibt es nur aufsummiert)
 * @returns {{ total: number, value: number, planned: number }}
 */
function trendLegendFigures(shownArr, rawArr, markIndex, running) {
  const total = rawArr.reduce((a, b) => a + b, 0);
  if (!running) return { total, value: total, planned: 0 };
  const value = shownArr[markIndex] ?? total;
  const planned = roundToCurrency(total - value, view.ctx?.currency);
  return { total, value, planned: planned > 0 ? planned : 0 };
}

function totalTrend(current, previous) {
  if (previous == null) return '';
  const delta = roundToCurrency(current - previous, view.ctx.currency);
  // Sekundaerfarbe mit Vorzeichen und Pfeil, keine Valenz (Critique R21, D8).
  return ` ${trendMarkup({ delta, text: view.ctx.esc(signed(delta)) })}`;
}

function wireTrendPoints(host, series, labelKey, raw = series, startIndex = null) {
  const group = host.querySelector('.budget-stats__points');
  const readout = host.querySelector('#budget-stats-readout');
  if (!group || !readout) return;
  const buttons = [...group.querySelectorAll('.budget-stats__point')];
  if (!buttons.length) return;

  // `mark: false` fuer den Ausgangswert: die Ableselinie nennt ihn mit Datum,
  // aber die senkrechte Marke erscheint erst, wenn jemand zeigt, tippt oder
  // per Tastatur wandert. Ungefragt am letzten Datenpunkt stehend las sie sich
  // als "heute" (Critique 2026-10-05, R16).
  const show = (index, { focus = false, mark = true } = {}) => {
    const point = series[index];
    if (!point) return;
    buttons.forEach((b, i) => {
      b.classList.toggle('is-active', mark && i === index);
      b.tabIndex = i === index ? 0 : -1;
    });
    readout.textContent = t(labelKey, {
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
  /* DIE GANZE FLAECHE IST DAS ZIEL (Critique 2026-09-25). Ein Punkt war eine
   * Spalte von 100 % / Tage - 22-24px am Desktop, 10px am Telefon. Zeigen und
   * Wischen waehlen jetzt ueber die ganze Diagrammflaeche den naechsten Tag,
   * wie ein Regler; die Knoepfe bleiben fuer Tastatur und Screenreader. */
  group.addEventListener('pointermove', (e) => {
    const rect = group.getBoundingClientRect();
    if (!rect.width) return;
    const x = (e.clientX - rect.left) / rect.width;
    let best = 0;
    buttons.forEach((b, i) => {
      if (Math.abs(Number(b.style.getPropertyValue('--point-x')) - x)
        < Math.abs(Number(buttons[best].style.getPropertyValue('--point-x')) - x)) best = i;
    });
    show(best);
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
  // Aufsummiert ist kein Wert mehr null - gesucht wird am ROHEN Abschnitt.
  let initial = raw.length - 1;
  while (initial > 0 && !raw[initial].income && !raw[initial].expenses) initial--;
  if (startIndex != null && series[startIndex]) initial = startIndex;
  show(initial, { mark: false });
}

// Der Zeitraum steht im geteilten Kopf, nicht mehr im Panel. Gemeldet wird er
// erst nach dem Laden, weil der Server die Wochengrenzen festlegt.
function updatePeriodLabel() {
  if (view.data) view.ctx.onPeriod({ from: view.data.from, to: view.data.to });
}

// Nur fuer Tests: die Farbzuordnung von Balken und Donut (R14 P8).
export const __test = { trendLegendFigures, fetchStats, statsView: () => view, renderCatBars, categoryColorIndex, DONUT_SEGMENTS, futureStartIndex, TREND_CHART_NARROW, calmAxis, markLabelPlan, todayAnchor, axisLabels };
