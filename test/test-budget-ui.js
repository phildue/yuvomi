/**
 * Budget-UI-Verträge (UX/UI-Audit Budget-Modul).
 *
 * Pinnt die Invarianten der Audit-Fixes fest, damit sie nicht stillschweigend
 * zurückfallen: eine Quelle für Monatsnavigation/Neu-Aktion je Untertab, das
 * Datum neuer Einträge folgt dem angezeigten Monat, Tab-Leisten tragen echtes
 * ARIA, Charts haben Textalternativen, keine Farb- oder Textliterale im JS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r/g, '');

const budget = read('../public/pages/budget.js');
const stats = read('../public/pages/budget-stats.js');
const plans = read('../public/pages/budget-plans.js');
const subscriptions = read('../public/pages/subscriptions.js');
const splitExpenses = read('../public/pages/split-expenses.js');
const money = read('../public/utils/money.js');
const layoutCss = read('../public/styles/layout.css');
const tokensCss = read('../public/styles/tokens.css');
const budgetCss = read('../public/styles/budget.css');
const subscriptionsCss = read('../public/styles/subscriptions.css');
const splitCss = read('../public/styles/split-expenses.css');

// --------------------------------------------------------
// Monatsnavigation und Neu-Aktion je Untertab
// --------------------------------------------------------

test('TAB_CAPS ist die einzige Quelle für Monatsnavigation und Neu-Aktion', () => {
  const table = budget.match(/const TAB_CAPS = \{[\s\S]*?\n\};/);
  assert.ok(table, 'TAB_CAPS-Tabelle fehlt');

  // Jeder Tab der Leiste muss einen Eintrag haben, sonst fällt er auf den
  // Budget-Default zurück und bekommt stillschweigend fremde Bedienelemente.
  for (const id of ['budget', 'accounts', 'plan', 'subscriptions', 'loans', 'reports', 'split-expenses']) {
    assert.match(table[0], new RegExp(`'${id}':`), `TAB_CAPS ohne Eintrag für '${id}'`);
  }

  // Zeitbezug nur dort, wo der Zeitraum den Inhalt bestimmt. Berichte tragen ihn
  // seit der Zusammenführung mit — sie hatten vorher einen eigenen Stepper.
  for (const id of ['budget', 'plan', 'reports']) {
    assert.match(table[0], new RegExp(`'${id}':\\s*\\{ month: true`), `'${id}' braucht den Kopf-Stepper`);
  }
  for (const id of ['accounts', 'subscriptions', 'loans', 'split-expenses']) {
    assert.match(table[0], new RegExp(`'${id}':\\s*\\{ month: false`), `'${id}' darf keine Monatsnavigation zeigen`);
  }

  // Berichte kennt keine Neu-Aktion — dort bleiben Toolbar-Button und FAB weg.
  assert.match(table[0], /'reports':\s*\{ month: true,\s*range: true,\s*add: null/);
});

test('der Kopf-Slot bleibt auf jedem Tab besetzt', () => {
  // Eine Lücke im Kopf las sich als „der zuletzt gewählte Monat gilt weiter".
  // Regel statt Aufzählung: jeder Tab ohne Stepper braucht einen Kontexttext.
  const table = budget.match(/const TAB_CAPS = \{[\s\S]*?\n\};/);
  for (const entry of table[0].matchAll(/'([a-z-]+)':\s*\{([^}]*)\}/g)) {
    const [, id, caps] = entry;
    if (/month:\s*true/.test(caps)) continue;
    assert.match(caps, /note:\s*'budget\.periodNote/, `'${id}' hat weder Stepper noch Kontexttext`);
  }
  // Und der Kontexttext wird auch wirklich geschaltet.
  assert.match(budget, /note\.hidden = !caps\.note/);
  assert.match(budget, /note\.textContent = t\(caps\.note\)/);
});

test('Monats-Bedienelemente werden als Block geschaltet, nicht einzeln', () => {
  // Der frühere Bug: prev/next versteckt, Label und "Aktuell" blieben stehen.
  const block = budget.match(/\['#budget-prev', '#budget-next', '#budget-today', '#budget-label'\][\s\S]{0,220}/);
  assert.ok(block, 'Monats-Bedienelemente werden nicht gemeinsam geschaltet');
  assert.match(block[0], /el\.hidden = !caps\.month/);
});

test('das Modul führt genau eine Zeitachse', () => {
  // Vorher hielt budget-stats.js einen eigenen anchor: Budget auf März gestellt,
  // Wechsel auf Berichte zeigte Juli. Der Anker lebt jetzt im Modul-State und
  // wird beim Tabwechsel in beide Richtungen angeglichen.
  assert.match(budget, /reportAnchor:\s*toLocalDateKey\(new Date\(\)\)/);
  assert.match(budget, /state\.reportAnchor = anchorForMonth\(state\.month\)/, 'Hinweg Budget → Berichte fehlt');
  assert.match(budget, /const ym = state\.reportAnchor\.slice\(0, 7\)/, 'Rückweg Berichte → Budget fehlt');

  // Das Panel darf keinen eigenen Zeitraumwähler mehr aufbauen.
  assert.doesNotMatch(stats, /data-step=/, 'budget-stats.js baut wieder einen zweiten Stepper');
  assert.doesNotMatch(stats, /budget-stats__period/, 'der Zeitraum gehört in den geteilten Kopf');
  assert.match(stats, /view\.anchor = ctx\.anchor/, 'der Anker muss vom Modul kommen');
  assert.match(stats, /view\.ctx\.onRangeChange\(id\)/, 'die Auflösung muss ans Modul zurückgemeldet werden');
});

test('Toolbar-Aktion und FAB teilen sich Sichtbarkeit und Label', () => {
  assert.match(budget, /const addLabel = caps\.add \? t\(caps\.add\) : ''/);
  assert.match(budget, /addBtn\.hidden = !caps\.add/);
  assert.match(budget, /fab\.hidden = !caps\.add/);
  // Kein Rückfall auf die alten Ausschluss-Listen.
  assert.doesNotMatch(budget, /splitActive \|\| subscriptionsActive/);
});

test('hidden greift bei geteilten Bedienelementen trotz display-Klasse', () => {
  // `.page-fab { display:flex }` bzw. `.btn { display:inline-flex }` schlagen
  // das UA-`[hidden]` bei gleicher Spezifität — ohne Guard bleibt der FAB auf
  // dem Berichte-Tab sichtbar. Seit UX-Audit R2 deckt der Guard auch
  // `.form-group` ab (RRULE-Endefelder, Audit A1-10).
  //
  // `[^{}]*\{` statt eines Zeichenabstands: geprüft werden soll, dass Selektor
  // und Deklaration im SELBEN Regelblock stehen - kein `}` und kein zweites `{`
  // dazwischen. Das frühere `[\s\S]{0,120}` maß stattdessen die Länge der
  // Selektorliste und schlug damit bei jeder legitimen Ergänzung an; die Liste ist
  // aber ausdrücklich zum Wachsen gedacht (bei `.kitchen-bulkbar` war sie 141
  // Zeichen lang und der Guard rot, obwohl die Struktur korrekt war).
  const sameBlock = (selector) => new RegExp(`${selector}[^{}]*\\{\\s*display:\\s*none\\s*!important`);
  for (const selector of ['\\.page-fab\\[hidden\\]', '\\.btn\\[hidden\\]', '\\.form-group\\[hidden\\]', '\\.kitchen-bulkbar\\[hidden\\]']) {
    assert.match(layoutCss, sameBlock(selector), `${selector} steht nicht im Durchsetzungsblock`);
  }
});

// --------------------------------------------------------
// Datum neuer Einträge
// --------------------------------------------------------

test('neue Einträge landen im angezeigten Monat, nicht im heutigen', () => {
  assert.match(budget, /const defaultDate = state\.month === todayMonth \? today : `\$\{state\.month\}-01`/);
  // Das Datumsfeld muss den abgeleiteten Wert nutzen, nicht mehr `today`.
  assert.match(budget, /id="bm-date"\s*\n?\s*value="\$\{isEdit \? entry\.date : defaultDate\}"/);
  assert.doesNotMatch(budget, /id="bm-date"[\s\S]{0,80}entry\.date : today\}/);
});

// --------------------------------------------------------
// Tab-Leisten und Filter-ARIA
// --------------------------------------------------------

test('keine Umschalter-Leiste im Modul versteckt sich hinter role="group"', () => {
  // REGEL statt Allowlist. Die Vorgängerfassung nannte drei Selektoren
  // (.budget-tabs, .budget-scope, .budget-stats__ranges) und übersah damit genau
  // die beiden Leisten, die role="group" trugen und ohne Pfeiltasten-Navigation
  // dastanden - Darlehensstatus und Gruppenstatus. Eine Allowlist deckt N
  // Dateien ab, nicht die Regel.
  //
  // Die Regel: wer eine Auswahl anbietet, benennt sie auch so. role="group" ist
  // ein Sammelbehälter ohne Auswahlsemantik; Leisten gehören auf role="tablist"
  // (Sichtwechsel) oder role="radiogroup" (Einfachauswahl) - und landen damit
  // automatisch im Guard darunter.
  for (const [file, src] of BUDGET_PAGES) {
    for (const bar of withoutComments(src).matchAll(/role="group"[\s\S]{0,900}?<\/div>/g)) {
      assert.doesNotMatch(
        bar[0],
        /aria-selected=|aria-pressed=|aria-checked=/,
        `${file}: eine Leiste mit role="group" meldet einen Auswahlzustand - `
        + 'role="tablist" (Sicht) oder role="radiogroup" (Wert) benennt das richtig',
      );
    }
  }
});

test('jede Umschalter-Leiste des Moduls läuft durch die geteilte Verhaltensschicht', () => {
  // Ohne wireTablist gibt es Roving-Tabindex ohne Pfeiltasten — eine Falle, aus
  // der Tastaturnutzer nicht mehr herauskommen. Der Guard leitet die Leisten aus
  // dem Markup ab, statt sie aufzuzählen: eine neue Leiste ist automatisch erfasst.
  const wired = BUDGET_PAGES.flatMap(([, src]) =>
    [...src.matchAll(/wireTablist\(\s*[^)]*?querySelector\('([^']+)'\)/g)].map((m) => m[1]));

  for (const [file, src] of BUDGET_PAGES) {
    for (const bar of src.matchAll(/<div class="([^"]+)"([^>]*)role="(tablist|radiogroup)"/g)) {
      const [, classes, attrs] = bar;
      const id = attrs.match(/id="([^"]+)"/)?.[1];
      const selectors = [...classes.trim().split(/\s+/).map((c) => `.${c}`), ...(id ? [`#${id}`] : [])];
      assert.ok(
        selectors.some((s) => wired.includes(s)),
        `${file}: Leiste "${classes}" ist an keinem wireTablist verdrahtet (${selectors.join(' / ')})`,
      );
    }
  }
  // Der Scope-Umschalter muss dafür data-tab-id tragen (nicht mehr data-scope).
  assert.doesNotMatch(budget, /data-scope=/);
});

test('es gibt genau eine Umschalter-Optik im Modul', () => {
  // Vier Optiken für dieselbe Frage - getönte Kapsel, eckig gefülltes Rechteck,
  // weiße Kachel, umrandete Pille - hießen, dass derselbe Zustand pro Tab anders
  // aussah. .budget-segmented ist der Baustein; wer eine Leiste baut, greift ihn.
  assert.ok(/\n\.budget-segmented\s*\{/.test(budgetCss), '.budget-segmented fehlt in budget.css');
  assert.ok(/\n\.budget-segmented__item\s*\{/.test(budgetCss), '.budget-segmented__item fehlt');

  for (const [file, src] of BUDGET_PAGES) {
    for (const bar of src.matchAll(/<div class="([^"]+)"([^>]*)role="(tablist|radiogroup)"/g)) {
      const [, classes] = bar;
      // Die Haupt-Tabs und der Scope-Umschalter tragen die app-weite Pillen-
      // Grammatik (sub-tabs.css) - sie sitzen in der Toolbar, nicht im Panel.
      if (/budget-tabs|budget-scope|budget-color-picker/.test(classes)) continue;
      assert.match(
        classes,
        /budget-segmented/,
        `${file}: Leiste "${classes}" baut eine eigene Optik statt .budget-segmented`,
      );
    }
  }

  // Und die abgelösten Optiken kommen nicht zurück.
  const liveCss = withoutComments(budgetCss);
  for (const dead of ['budget-loans__filter\\b', 'budget-stats__range\\b']) {
    assert.doesNotMatch(liveCss, new RegExp(`\\.${dead}`), `.${dead} ist durch .budget-segmented ersetzt`);
  }
});

test('das Touch-Maß der Umschalter kommt aus dem Token, nicht aus der Leiste', () => {
  // Die abgelösten Leisten lagen bei 40px (Zeitraum) und 28px (Nur-Ausgaben).
  const item = budgetCss.match(/\n\.budget-segmented__item\s*\{([^}]*)\}/);
  assert.ok(item, '.budget-segmented__item fehlt');
  assert.match(item[1], /min-height:\s*var\(--target-base\)/);
});

test('Auflösungs-Umschalter der Berichte trägt echtes Tab-ARIA', () => {
  const bar = stats.match(/class="[^"]*budget-stats__ranges"[\s\S]*?<\/div>/);
  assert.ok(bar, 'Auflösungs-Leiste nicht gefunden');
  assert.match(bar[0], /role="tablist"/);
  assert.match(bar[0], /aria-label=/);
  assert.match(stats, /role="tab"[\s\S]{0,140}aria-selected="\$\{on\}"/);
  assert.match(stats, /tabindex="\$\{on \? '0' : '-1'\}"/);
});

test('Einfachauswahl-Leisten melden ihren Zustand über aria-checked', () => {
  // Darlehensstatus, Gruppenstatus und Kontofarbe wählen EINEN Wert, sie
  // wechseln keine Sicht: aria-checked in einer radiogroup, nicht aria-pressed
  // in einem role="group". Der Zustand muss angesagt werden - reine Einfärbung
  // ist für Screenreader kein Kanal.
  assert.match(budget, /role="radio" data-tab-id="\$\{id\}" aria-checked="\$\{on\}"/, 'Darlehensstatus');
  assert.match(splitExpenses, /role="radio" data-tab-id="\$\{id\}" aria-checked="\$\{on\}"/, 'Gruppenstatus');
  assert.match(budget, /role="radio"[\s\S]{0,200}aria-checked="\$\{on\}"/, 'Kontofarbe');
  // Der Filter-Trichter je Darlehenszeile bleibt ein einzelner Toggle-Button.
  assert.match(budget, /data-action="loan-filter"[\s\S]{0,160}aria-pressed=/);
});

// --------------------------------------------------------
// Charts: Textalternative, Palette, Achsen
// --------------------------------------------------------

test('Trendkurve und Donut haben eine Textalternative mit Werten', () => {
  // Rein visuelle Diagramme ohne sr-only-Zusammenfassung sind für
  // Screenreader-Nutzer leer — der Budget-Tab macht es mit chartSummary vor.
  assert.match(budget, /class="sr-only">\$\{esc\(chartSummary/);
  assert.match(stats, /statsTrendSummary/);
  assert.match(stats, /statsDonutSummary/);
  assert.match(stats, /<p class="sr-only">\$\{view\.ctx\.esc\(summary\)\}<\/p>/);
  // Die SVGs selbst sind dann dekorativ und dürfen nicht doppelt angesagt werden.
  assert.match(stats, /class="budget-stats__trend"[\s\S]{0,120}aria-hidden="true"/);
  assert.match(stats, /class="budget-stats__donut" aria-hidden="true"/);
});

test('Donut-Palette wiederholt keine Farbe und borgt keine Modul-Akzente', () => {
  const palette = stats.match(/const DONUT_COLORS = \[[\s\S]*?\];/);
  assert.ok(palette, 'DONUT_COLORS fehlt');
  assert.doesNotMatch(palette[0], /--module-/, 'Modul-Akzente tragen eine andere Bedeutung');
  const colors = [...palette[0].matchAll(/--chart-series-\d/g)].map((m) => m[0]);
  assert.equal(new Set(colors).size, colors.length, 'doppelte Farbe in der Palette');
  // Segmente über die Palettengröße hinaus werden gebündelt statt eingefärbt.
  assert.match(stats, /const DONUT_SEGMENTS = DONUT_COLORS\.length/);
  assert.match(stats, /statsOtherCategories/);
  assert.match(stats, /stroke="\$\{DONUT_COLORS\[i\]\}"/, 'kein Modulo-Recycling mehr');
});

test('die Datenreihen-Tokens existieren in beiden Themes', () => {
  for (let i = 1; i <= 7; i++) {
    assert.match(tokensCss, new RegExp(`--chart-series-${i}:\\s*var\\(--_chart-series-${i}\\)`));
  }
  // Basis + zwei Dark-Blöcke (@media und [data-theme="dark"]).
  const defs = [...tokensCss.matchAll(/--_chart-series-1:/g)];
  assert.equal(defs.length, 3, 'Dark-Mode-Variante fehlt in einem der beiden Dark-Blöcke');
});

test('die Trendkurve beschriftet Skala und Zeitraum', () => {
  assert.match(stats, /class="budget-stats__axis-max"/);
  assert.match(stats, /class="budget-stats__axis-x"/);
});

test('die Trendkurve macht Einzelwerte ohne Zeigegerät ablesbar', () => {
  // Eine Kurve ohne Werte sagt nur "irgendwann war es viel". Der Wert muss im
  // aria-label des Punktes stehen, nicht bloß in einem Hover-Tooltip.
  assert.match(stats, /class="budget-stats__point"/);
  assert.match(stats, /aria-label="\$\{view\.ctx\.esc\(label\)\}"/);
  assert.match(stats, /statsPointLabel/);
  assert.match(stats, /role="group" aria-label="\$\{t\('budget\.statsPointsLabel'\)\}"/);
  // Ein Tabstopp für die ganze Kurve statt einem pro Tag: Roving-Tabindex.
  assert.match(stats, /tabindex="\$\{i === s\.length - 1 \? '0' : '-1'\}"/);
  const wiring = stats.match(/function wireTrendPoints[\s\S]*?\n\}/);
  assert.ok(wiring, 'wireTrendPoints fehlt');
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.match(wiring[0], new RegExp(key), `Tastaturnavigation ohne ${key}`);
  }
  // Zeigen und Fokus führen beide zur selben Anzeige (Maus, Touch, Tastatur).
  assert.match(wiring[0], /addEventListener\('focusin'/);
  assert.match(wiring[0], /addEventListener\('pointerover'/);
});

test('die Datenreihen-Farben tragen ≥3:1 gegen den Seitengrund (WCAG 1.4.11)', () => {
  const hex = (value) => value.match(/[\da-f]{2}/gi).map((p) => parseInt(p, 16));
  const luminance = ([r, g, b]) => {
    const channel = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  // Erste Definition = Light, alle weiteren = die beiden Dark-Blöcke.
  const backgrounds = [...tokensCss.matchAll(/--_neutral-100:\s*(#[\da-fA-F]{6})/g)].map((m) => m[1]);
  assert.ok(backgrounds.length >= 2, 'Hintergrund-Token für beide Themes erwartet');

  const seriesFor = (themeIndex) => {
    const values = [];
    for (let i = 1; i <= 7; i++) {
      const all = [...tokensCss.matchAll(new RegExp(`--_chart-series-${i}:\\s*(#[\\da-fA-F]{6})`, 'g'))].map((m) => m[1]);
      assert.ok(all[themeIndex], `--_chart-series-${i} fehlt für Theme ${themeIndex}`);
      values.push(all[themeIndex]);
    }
    return values;
  };

  for (const [themeIndex, theme] of [[0, 'light'], [1, 'dark']]) {
    const bg = hex(backgrounds[themeIndex]);
    seriesFor(themeIndex).forEach((color, i) => {
      const ratio = contrast(hex(color), bg);
      assert.ok(ratio >= 3, `${theme}: --chart-series-${i + 1} (${color}) nur ${ratio.toFixed(2)}:1 gegen ${backgrounds[themeIndex]}`);
    });
  }
});

// --------------------------------------------------------
// Hard Constraints: keine Literale
// --------------------------------------------------------

test('keine hartkodierten Anzeigetexte in den Budget-Views', () => {
  assert.doesNotMatch(budget, /Loan repayment:/);
  assert.doesNotMatch(budget, /'Geschenke & Transfers'/);
  // Das Vergleichswort der Trendzeile gehört in den Locale-Key, nicht ins Template.
  assert.doesNotMatch(budget, /\}\s*vs\.\s*\$\{prevLabel\}/);
  assert.match(budget, /t\('budget\.trendDelta'/);
});

// --------------------------------------------------------
// Geteilte Bausteine des Moduls (Critique 2026-07-30, P0)
//
// Diese Guards sind bewusst als REGEL über alle Dateien des Moduls formuliert,
// nicht als Allowlist einzelner Selektoren: eine Allowlist deckt N Dateien ab,
// aber nicht die Regel - genau daran sind hier fünf Kartenbauarten und drei
// Währungsformatierer vorbeigewachsen.
// --------------------------------------------------------

// Jede Page-Datei, die unter /budget rendert. Neue Untertabs kommen hierher.
const BUDGET_PAGES = [
  ['budget.js', budget],
  ['budget-stats.js', stats],
  ['budget-plans.js', plans],
  ['subscriptions.js', subscriptions],
  ['split-expenses.js', splitExpenses],
];

const BUDGET_STYLESHEETS = [
  ['budget.css', budgetCss],
  ['subscriptions.css', subscriptionsCss],
  ['split-expenses.css', splitCss],
];

// Einmaliges Ersetzen genuegt nicht: ein Rest wie `<!<!-- x -->->` setzt sich
// nach dem Schnitt zu einem neuen Kommentar-Delimiter zusammen. Darum bis zum
// Fixpunkt laufen (CodeQL js/incomplete-multi-character-sanitization).
// Die Schleife muss den Aufruf direkt umschliessen: CodeQL erkennt den Fixpunkt
// nur, wenn das Ergebnis des `replace` zu seinem eigenen Receiver zurueckfliesst.
// In einer `.replace().replace()`-Kette gilt das nur fuer das letzte Glied - der
// Schnitt gehoert deshalb hierher und nicht zurueck in die Kette unten.
const withoutHtmlComments = (src) => {
  let out = src;
  let previous;
  do {
    previous = out;
    out = out.replace(/<!--[\s\S]*?-->/g, '');
  } while (out !== previous);
  return out;
};

// Guards, die auf Markup- oder Selektor-Muster prüfen, müssen an Kommentaren
// vorbeisehen: sonst schlägt jede Erklärung an, die das verbotene Muster nennt -
// und der Weg aus dem roten Test wäre, die Begründung zu löschen.
// Auch die Muster untereinander koennen sich gegenseitig freilegen (ein Blockkommentar
// verdeckt einen HTML-Kommentar), darum laeuft auch die Kombination bis zum Fixpunkt.
const withoutComments = (src) => {
  let out = src;
  let previous;
  do {
    previous = out;
    out = out.replace(/\/\*[\s\S]*?\*\//g, '');
    out = withoutHtmlComments(out);
    out = out.replace(/^\s*\/\/.*$/gm, '');
  } while (out !== previous);
  return out;
};

test('Geldbeträge laufen über den Modul-Formatierer, nicht über eigene', () => {
  // Drei eigene Formatierer bedeuteten vier Vorzeichenkonventionen: dieselbe
  // Zahl konnte in zwei Untertabs verschieden geschrieben sein. Bei Geld ist
  // das kein Stilproblem, sondern ein Vertrauensproblem.
  for (const [file, src] of BUDGET_PAGES) {
    assert.doesNotMatch(
      src,
      /getNumberFormat\(\{[^}]*style:\s*'currency'/,
      `${file}: Währungsformat gehört in utils/money.js, nicht in die Page`,
    );
  }
  assert.match(money, /export function formatSignedAmount/);
  assert.match(money, /export function formatMoney/);
});

test('jede Rolle des Geld-Vokabulars ist in money.js dokumentiert und behandelt', () => {
  // Das Vokabular ist der eigentliche Baustein: wer einen neuen Betrag rendert,
  // wählt eine Rolle statt eine fünfte Schreibweise zu erfinden.
  const roles = money.match(/export const MONEY_ROLES = \[([^\]]*)\]/);
  assert.ok(roles, 'MONEY_ROLES fehlt in utils/money.js');
  for (const role of ['flow', 'total', 'balance', 'plain']) {
    assert.ok(roles[1].includes(`'${role}'`), `Rolle '${role}' fehlt in MONEY_ROLES`);
    assert.ok(
      new RegExp(`\\|\\s*\`${role}\``).test(money),
      `Rolle '${role}' ist in der Rollentabelle von money.js nicht dokumentiert`,
    );
  }
  // Nur diese vier Rollen dürfen aufgerufen werden.
  for (const [file, src] of BUDGET_PAGES) {
    for (const call of src.matchAll(/formatSignedAmount\([^)]*role:\s*'([a-z]+)'/g)) {
      assert.ok(roles[1].includes(`'${call[1]}'`), `${file}: unbekannte Geld-Rolle '${call[1]}'`);
    }
    for (const call of src.matchAll(/amountByRole\([^,]+,\s*'([a-z]+)'/g)) {
      assert.ok(roles[1].includes(`'${call[1]}'`), `${file}: unbekannte Geld-Rolle '${call[1]}'`);
    }
  }
});

test('es gibt genau eine Kennzahlkarte im Modul', () => {
  // Fünf Bauarten hießen fünfmal neu lernen, wo die Zahl steht. Wer eine neue
  // Kennzahl zeigt, nimmt .budget-summary-card - oder dieser Guard schlägt an.
  for (const [file, css] of BUDGET_STYLESHEETS) {
    for (const match of css.matchAll(/^\.([a-z-]*summary-card[a-z_-]*)/gm)) {
      assert.ok(
        match[1].startsWith('budget-summary-card'),
        `${file}: .${match[1]} ist eine zweite Kennzahlkarte - .budget-summary-card ist der Baustein`,
      );
    }
  }
  for (const [file, src] of BUDGET_PAGES) {
    for (const match of src.matchAll(/class="([^"]*summary-card[^"]*)"/g)) {
      assert.ok(
        /budget-summary-card/.test(match[1]),
        `${file}: Kennzahlkarte "${match[1]}" nutzt nicht .budget-summary-card`,
      );
    }
  }
});

test('Arbeitsflächen des Moduls sind opak, Glass bleibt den Overlays', () => {
  // budget.css begründet die Regel an .budget-summary-card. Sie galt nur dort,
  // während subscriptions.css und split-expenses.css im selben Modul Glass auf
  // Karten, Panels und sogar auf einem Eingabefeld setzten.
  // Overlay-Rollen tragen ihr Rollenwort im Selektor; alles andere ist
  // Arbeitsfläche. Neue Arbeitsflächen fallen damit automatisch durch.
  const OVERLAY_ROLES = /modal|dialog|popover|overlay|picker-panel|form__section|tooltip|menu/;
  for (const [file, css] of BUDGET_STYLESHEETS) {
    // Regelblöcke grob zerlegen: Selektorliste bis '{', Body bis '}'.
    for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = rule[1].split('*/').pop().trim();
      if (!/--glass-bg-card|--glass-shadow/.test(rule[2])) continue;
      assert.match(
        selector,
        OVERLAY_ROLES,
        `${file}: "${selector}" ist eine Arbeitsfläche und darf kein Glass tragen`,
      );
    }
  }
});

test('kein Kontrast im Modul hängt an der Datenlage', () => {
  // Das Abo-Monogramm zog Schrift UND Fläche aus derselben Markenfarbe. Damit
  // war das Kontrastverhältnis reine Datenlage: gemessen 10 AA-Verstöße über 7
  // Marken im Seed, bis hinunter auf 1.83:1, und kein Nutzer konnte das umgehen.
  // Dieselbe Mechanik saß unbemerkt in der Konto-Kachel (--account-accent).
  //
  // REGEL: Datenfarben (die per style="--x:…" aus dem JS kommen, im Gegensatz zu
  // den Tokens aus tokens.css) dürfen in einer Fläche nicht gleichzeitig
  // Vordergrund und Hintergrund stellen. Eine von beiden Seiten muss aus einem
  // Token kommen, sonst ist das Verhältnis nicht garantierbar.
  const DATA_COLORS = new Set(
    BUDGET_PAGES.flatMap(([, src]) =>
      [...src.matchAll(/style="[^"]*?(--[a-z][a-z0-9-]*)\s*:/g)].map((m) => m[1])),
  );
  assert.ok(DATA_COLORS.size > 0, 'keine Datenfarben gefunden - der Guard misst nichts');

  const varsIn = (decls) => [...decls.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]);
  for (const [file, css] of BUDGET_STYLESHEETS) {
    for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const body = rule[2];
      const fg = [...body.matchAll(/(?:^|;)\s*color\s*:([^;]*)/g)].map((m) => m[1]).join(' ');
      const bg = [...body.matchAll(/(?:^|;)\s*background(?:-color)?\s*:([^;]*)/g)].map((m) => m[1]).join(' ');
      if (!fg.trim() || !bg.trim()) continue;
      const shared = varsIn(fg).filter((v) => DATA_COLORS.has(v) && varsIn(bg).includes(v));
      assert.equal(
        shared.length, 0,
        `${file}: "${rule[1].split('*/').pop().trim()}" zieht ${shared.join(', ')} `
        + 'für Schrift UND Fläche - der Kontrast hängt damit an den Nutzerdaten',
      );
    }
  }
});

test('eingebettete Untertabs bringen kein eigenes Seiten-Chrome mit', () => {
  // Ein eigener Seiten-Gradient im Sub-Page-Wrapper lief als getönte
  // Vollbreiten-Bahn innerhalb der Budget-Seite und brach an deren Container-
  // Kante ab. Fläche und Rand gehören dem Panel.
  for (const [file, css, selector] of [
    ['subscriptions.css', subscriptionsCss, '.budget-page .subscriptions-page'],
    ['split-expenses.css', splitCss, '.budget-page .split-page'],
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(rule, `${file}: ${selector}-Override fehlt`);
    assert.match(rule[1], /background:\s*none/, `${file}: ${selector} muss den eigenen Gradient ablegen`);
    assert.match(rule[1], /padding-block:\s*0/, `${file}: ${selector} muss den eigenen Rand ablegen`);
  }
});

test('Panel-Fläche und Kopfleiste sind geteilt, nicht pro Tab gebaut', () => {
  // Drei Padding-Werte und drei Scroll-Achsen über sieben Tabs waren drei
  // Gelegenheiten, die Fläche unterschiedlich zu bauen.
  const panel = budgetCss.match(/\n\.budget-tab-panel\s*\{([^}]*)\}/);
  assert.ok(panel, '.budget-tab-panel fehlt in budget.css');
  assert.match(panel[1], /overflow-y:\s*auto/);
  assert.match(panel[1], /padding-block-start:\s*var\(--space/);

  assert.ok(/\n\.budget-panel-head\s*\{/.test(budgetCss), '.budget-panel-head fehlt in budget.css');
  assert.ok(/\n\.budget-panel-head__title\s*\{/.test(budgetCss), '.budget-panel-head__title fehlt');

  // Kein Tab setzt Scroll-Achse oder Panel-Padding noch selbst. Ausnahmen sind
  // benannte Modifier (--budget hält seine eigene innere Scroll-Region).
  const ALLOWED_PANEL_OVERRIDES = /budget-tab-panel--budget/;
  for (const rule of budgetCss.matchAll(/(\.budget-tab-panel--[a-z-]+)(?:[^{}]*)\{([^}]*)\}/g)) {
    if (!/overflow-y|padding-block-start|padding-top/.test(rule[2])) continue;
    assert.match(
      rule[1],
      ALLOWED_PANEL_OVERRIDES,
      `${rule[1]} setzt Scroll-Achse oder Padding selbst - beides gehört .budget-tab-panel`,
    );
  }
});

test('Trendpfeile sind Icons, keine Textglyphen', () => {
  assert.doesNotMatch(budget, /'▲'/);
  assert.doesNotMatch(budget, /'▼'/);
  assert.match(budget, /trending-up/);
  assert.match(budget, /trending-down/);
});

test('Konto-Farben kommen aus Tokens und tragen sprechende Labels', () => {
  const palette = budget.match(/const ACCOUNT_COLORS = \[[\s\S]*?\];/);
  assert.ok(palette, 'ACCOUNT_COLORS fehlt');
  assert.doesNotMatch(palette[0], /#[0-9a-fA-F]{6}/, 'Hex-Literale gehören in tokens.css');
  assert.match(palette[0], /nameKey: 'budget\.color/);
  // Screenreader lasen vorher den Hexcode vor.
  assert.match(budget, /t\(c\.nameKey\)/);
});

test('kein toter Toast-Typ: nur gestylte Varianten werden verwendet', () => {
  const styled = new Set(['success', 'danger', 'warning', 'default']);
  for (const [file, src] of [['budget.js', budget], ['budget-stats.js', stats], ['budget-plans.js', plans], ['subscriptions.js', subscriptions]]) {
    for (const match of src.matchAll(/showToast\([^)]*?,\s*'([a-z]+)'/g)) {
      assert.ok(styled.has(match[1]), `${file}: showToast-Typ '${match[1]}' hat keine Styles`);
    }
  }
});

// --------------------------------------------------------
// Saldo entdramatisieren bei reinem Ausgaben-Tracking (#504)
// --------------------------------------------------------

test('Saldo wird neutral, wenn keine Einnahmen erfasst sind', () => {
  // Ohne Einnahmen ist balance = -Ausgaben eine Tautologie; die rote Zahl liest
  // sich fälschlich als „im Minus". Bedingung: income === 0 && balance < 0.
  assert.match(budget, /const balanceNeutral = s\.income === 0 && s\.balance < 0;/);
  assert.match(budget, /balanceNeutral[\s\S]{0,80}budget-summary-card--balance-neutral/);
  // Echte Einnahmen behalten die Farbsemantik (grün Überschuss / rot Mehrausgabe).
  assert.match(budget, /budget-summary-card--balance-positive/);
  assert.match(budget, /budget-summary-card--balance-negative/);
});

test('der Saldo-Trend entfällt im neutralen Ausgaben-Fall', () => {
  // Ein farbiger Trendpfeil unter der bewusst neutralisierten Zahl wäre widersprüchlich
  // und ohne echten Saldo ohne Aussage.
  assert.match(budget, /p && !balanceNeutral \? renderTrend\(s\.balance/);
});

test('die neutrale Saldo-Farbe kommt aus einem Token, nicht als Literal', () => {
  const rule = budgetCss.match(/\.budget-summary-card--balance-neutral[^\n]*\{[^}]*\}/);
  assert.ok(rule, '.budget-summary-card--balance-neutral fehlt in budget.css');
  assert.match(rule[0], /var\(--color-text-primary\)/);
  assert.doesNotMatch(rule[0], /var\(--color-danger\)|var\(--color-success\)/);
});

// --------------------------------------------------------
// „Nur Ausgaben"-Umschalter (#504)
// --------------------------------------------------------

test('„Nur Ausgaben" reduziert die Zusammenfassung auf die Ausgaben-Karte', () => {
  // Reines Ausgaben-Tracking soll weder einen (neutralen) Saldo noch eine Dauer-Null
  // bei den Einnahmen zeigen - der Umschalter blendet beide Karten aus.
  assert.match(budget, /expensesOnly \? expensesCard : incomeCard \+ expensesCard \+ balanceCard/);
});

test('der „Nur Ausgaben"-Umschalter meldet seinen Zustand als echter Switch', () => {
  assert.match(budget, /id="budget-expenses-only"[\s\S]{0,120}role="switch"/);
  assert.match(budget, /aria-checked="\$\{expensesOnly \? 'true' : 'false'\}"/);
});

test('der „Nur Ausgaben"-Zustand ist client-persistent und geräte-lokal', () => {
  // Reine Anzeige-Präferenz über localStorage (yuvomi-*), kein Server-Roundtrip -
  // Liste, Diagramm und CSV-Export bleiben unberührt.
  assert.match(budget, /const EXPENSES_ONLY_KEY = 'yuvomi-budget-expenses-only';/);
  assert.match(budget, /state\.expensesOnly = localStorage\.getItem\(EXPENSES_ONLY_KEY\) === '1';/);
  assert.match(budget, /localStorage\.setItem\(EXPENSES_ONLY_KEY, state\.expensesOnly \? '1' : '0'\)/);
});

test('die Ausgaben-Karte trägt im „Nur Ausgaben"-Modus die volle Breite', () => {
  // Die Spaltenzahl der geteilten Kennzahl-Zeile kommt seit der Baustein-
  // Extraktion aus --summary-cards; geprüft wird die Invariante (eine Spalte),
  // nicht mehr die grid-template-columns-Schreibweise.
  const rule = budgetCss.match(/\.budget-summary--expenses-only[^\n]*\{[^}]*\}/);
  assert.ok(rule, '.budget-summary--expenses-only fehlt in budget.css');
  assert.match(rule[0], /--summary-cards:\s*1/);

  const base = budgetCss.match(/\n\.budget-summary\s*\{[^}]*\}/);
  assert.ok(base, '.budget-summary fehlt in budget.css');
  assert.match(base[0], /grid-template-columns:\s*repeat\(var\(--summary-cards[^)]*\)/);
});

test('der „Nur Ausgaben"-Umschalter nutzt Tokens, keine Farbliterale', () => {
  const rule = budgetCss.match(/\.budget-expenses-toggle\s*\{[^}]*\}/);
  assert.ok(rule, '.budget-expenses-toggle fehlt in budget.css');
  assert.doesNotMatch(rule[0], /#[0-9a-fA-F]{3,8}\b/);
});

// --------------------------------------------------------
// Zustand, Fokus, Ladewahrnehmung
// --------------------------------------------------------

test('Filterzustand überlebt den Modulwechsel nicht', () => {
  // `state` ist ein Modul-Singleton: ohne Reset zeigt das Budget beim nächsten
  // Besuch noch den Kontoauszug von damals.
  const enter = budget.match(/export async function render\([\s\S]*?renderBody\(\);/);
  assert.ok(enter);
  for (const field of ['accountFilterId', 'loanFilterId', 'loanStatusFilter', 'accountsShowArchived']) {
    assert.match(enter[0], new RegExp(`state\\.${field} = `), `${field} wird beim Betreten nicht zurückgesetzt`);
  }
});

test('der Konto-Drilldown verliert den Fokus nicht', () => {
  assert.match(budget, /_container\.querySelector\('#budget-body'\)\?\.focus\(\)/);
});

test('das Inline-Kategorie-Overlay ist ein vollwertiger Dialog', () => {
  const overlay = budget.match(/function requestNameInPanel[\s\S]*?\n\}/);
  assert.ok(overlay);
  assert.match(overlay[0], /e\.key === 'Escape'/);
  assert.match(overlay[0], /e\.key !== 'Tab'/, 'Fokus-Trap fehlt');
  assert.match(overlay[0], /opener\?\.isConnected/, 'Fokus kehrt nicht zum Auslöser zurück');
});

test('Berichte und Plan zeigen beim Laden ein Skelett', () => {
  assert.match(stats, /renderSkeletonList/);
  assert.match(plans, /renderSkeletonList/);
});

// --------------------------------------------------------
// Abo-Filterleiste
// --------------------------------------------------------

test('Abo-Filter tragen sichtbare Labels und lassen sich zurücksetzen', () => {
  for (const key of ['filterLabelCategory', 'filterLabelMethod', 'filterLabelStatus', 'filterLabelSort']) {
    assert.match(subscriptions, new RegExp(`subscriptions\\.${key}`), `sichtbares Label ${key} fehlt`);
  }
  assert.match(subscriptions, /function hasActiveFilters/);
  assert.match(subscriptions, /async function resetFilters/);
  // Leere Liste durch Filter ist ein anderer Zustand als "noch keine Abos".
  assert.match(subscriptions, /subscriptions\.noMatchesTitle/);
});

// --------------------------------------------------------
// i18n
// --------------------------------------------------------

test('alle neuen Keys existieren in jeder Locale', () => {
  const keys = [
    'budget.trendDelta', 'budget.statsRangeLabel', 'budget.statsOtherCategories',
    'budget.statsTrendSummary', 'budget.statsDonutSummary',
    'budget.colorTeal', 'budget.colorBlue', 'budget.colorViolet', 'budget.colorMagenta',
    'budget.colorOrange', 'budget.colorGreen', 'budget.colorOcher',
    'budget.statsPointLabel', 'budget.statsPointsLabel',
    'budget.expensesOnly', 'budget.expensesOnlyHint',
    'subscriptions.resetFilters', 'subscriptions.noMatchesTitle', 'subscriptions.noMatchesDescription',
    'subscriptions.filterLabelCategory', 'subscriptions.filterLabelMethod',
    'subscriptions.filterLabelStatus', 'subscriptions.filterLabelSort',
  ];
  const files = readdirSync(new URL('../public/locales/', import.meta.url)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 23, 'unerwartet wenige Locale-Dateien');
  for (const file of files) {
    const data = JSON.parse(read(`../public/locales/${file}`));
    for (const key of keys) {
      const value = key.split('.').reduce((v, part) => (v != null ? v[part] : undefined), data);
      assert.equal(typeof value, 'string', `${file}: ${key} fehlt`);
      assert.ok(value.trim().length > 0, `${file}: ${key} ist leer`);
    }
  }
});

test('die Platzhalter der neuen Sätze bleiben in jeder Locale erhalten', () => {
  const expected = {
    'budget.trendDelta': ['{{amount}}', '{{month}}'],
    'budget.statsTrendSummary': ['{{periods}}', '{{income}}', '{{expenses}}', '{{peak}}'],
    'budget.statsDonutSummary': ['{{count}}', '{{top}}', '{{pct}}', '{{total}}'],
    'budget.statsPointLabel': ['{{period}}', '{{income}}', '{{expenses}}'],
  };
  const files = readdirSync(new URL('../public/locales/', import.meta.url)).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const data = JSON.parse(read(`../public/locales/${file}`));
    for (const [key, placeholders] of Object.entries(expected)) {
      const value = key.split('.').reduce((v, part) => v[part], data);
      for (const placeholder of placeholders) {
        assert.ok(value.includes(placeholder), `${file}: ${key} ohne ${placeholder}`);
      }
    }
  }
});
