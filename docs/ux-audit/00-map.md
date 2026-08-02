# UX-Audit Phase 0 - Grounding & Inventar

Stand: 2026-07-19 · Version 1.38.0 · Branch `audit/ux-ui-full-2026-07`

## 1. Stack (aus dem Repo ermittelt)

| Ebene | Befund | Beleg |
|---|---|---|
| Framework | Keins - Vanilla JS, ES-Module, kein Build-Step | `package.json` (keine Frontend-Deps), `public/index.html:88-90` |
| Router | Eigener SPA-Router (History API, Auth-Guard, Lazy-Import pro Seite, per-Route-CSS) | `public/router.js:33-70,121-130` |
| Styling | Plain CSS, Token-System via Custom Properties; 1 globales Basis-Set + 1 Page-CSS pro Modul (Router lädt/entlädt) | `public/index.html:44-58`, `public/router.js:121` |
| Design-Tokens | `public/styles/tokens.css` (993 Z.): Neutral-Skala 50-950, Modul-Akzente, Semantik, Glass-Layer, Dark-Mode via private `--_*`-Tokens | `tokens.css:49-623` |
| Component-Library | Keine externe. Eigene Web Components (`oikos-`/`yuvomi-`-Prefix) + CSS-Klassen-Patterns in `layout.css` | `public/components/*` |
| Icons | Lucide, self-hosted (`public/lucide.min.js`, v0.469.0) | `index.html:61` |
| Font | Plus Jakarta Sans, self-hosted Variable Font | `tokens.css:33-47` |
| i18n | Eigenes `t('key')`-System, 23 Locales, de = Referenz; RTL-Support (ar/fa) | `public/i18n.js`, Guard `test/test-frontend-audit.js:221` |
| Theming | Light/Dark: `@media (prefers-color-scheme)` + `[data-theme]`-Override; Flash-Prevention via `theme-init.js` | `tokens.css:637-932`, `index.html:38` |
| Ziel-Designsprache | "Liquid Glass" ist bereits das etablierte System (Glass-Token-Layer §16/17, `glass.css` 1027 Z., lebender Backdrop) | `tokens.css:516-622`, `public/styles/glass.css` |

**Anmerkung zur Vorgabe:** Der Auftrag nennt als Ziel-Designsprache einen Platzhalter ("Apple Liquid Glass - anpassen"). Befund: Die Codebase HAT eine dokumentierte Liquid-Glass-Schicht (additiv, mit `@supports`-Gates, `prefers-reduced-transparency`- und `prefers-contrast`-Fallbacks, `tokens.css:938-992`). Das Audit bewertet daher Konsistenz GEGEN dieses vorhandene System, nicht die Einführung eines neuen.

## 2. Route-/Page-Map

### Öffentlich (kein Auth)
| Route | Seite |
|---|---|
| `/login`, `/setup`, `/forgot-password`, `/reset-password` | je eigenes Page-Modul (`router.js:34-37`) |

### Module (Auth, `router.js:38-50`)
| Route | Modul | Nav-Sektion (`router.js:1902-1921`) |
|---|---|---|
| `/` | Dashboard | overview |
| `/calendar`, `/tasks`, `/notes` | Planung | plan |
| `/meals`, `/recipes`, `/shopping` | Küchen-Cluster (geteilte kitchen-tabs) | household |
| `/housekeeping`, `/documents`, `/rewards` | Haushalt | household |
| `/contacts`, `/birthdays` | Menschen | people |
| `/health` + 5 Sub-Routen (`/health/vitals|cycle|meds|labs|activity`) | Gesundheit (Routen-Cluster, `utils/health-tabs.js:8-14`) | people |
| `/budget` (In-Page-Tabs: Einträge, Konten, Plan, Statistik, Abos, Split) | Finanzen | finance |
| `/settings` + 24 Leaf-Routen (`settings/registry.js`: personal 5, modules 8, sync 3, documents 2, admin 6) | Einstellungen | - |
| Third-Party-Module (dynamisch registriert) | `router.js:716-720` | - |

`budget-plans.js`, `budget-stats.js`, `subscriptions.js`, `split-expenses.js` rendern als Tab-Inhalte in der Budget-Shell (kein eigener Route-Eintrag).

### Navigation
- **Mobile (<1024px):** Bottom-Bar (5 Slots + Mehr-Sheet als App-Launcher-Grid, `layout.css:169-478`), Such-Overlay, gleitender Tab-Indikator.
- **Desktop (≥1024px):** Sidebar 220px, einklappbar auf 56px mit Hover/Fokus-Flyout (`layout.css:912-1286`), morphende Aktiv-Pille + Hover-Vorschau (`layout.css:3422-3456`), Sektions-Labels mit `role="group"`.

## 3. Shared-UI-Inventar

### Web Components (`public/components/`)
| Komponente | Zweck | Anmerkung |
|---|---|---|
| `modal.js` | `openModal`/`confirmModal`, Dirty-Guard, Fokus-Trap, Required-Validierung (`form-field--error`, Pulse bei Wiederholung `modal.js:597-634`) | zentral, konsistent genutzt |
| `datepicker.js` | `yuvomi-datepicker`, ISO-Kontrakt, Popover primär | eigener Test |
| `category-manager.js` | generisch (Budget, Tasks, Kontakte) | **Duplikat-Kandidat** zu `shopping-category-manager.js` (eigene Implementierung nur für Einkauf) |
| `user-multi-select.js`, `yuvomi-install-prompt.js`, `yuvomi-locale-picker.js` | Mehrfach-Zuweisung, PWA-Prompt, Sprachwahl | - |

### Utils mit UI-Anteil (`public/utils/`)
`sub-tabs.js` (Routen-Cluster-Leiste), `tablist.js` (In-Page-Tabs, ARIA), `kitchen-tabs.js`, `health-tabs.js`, `fab.js`, `page-search.js`, `skeleton.js` (`renderSkeletonList`), `ux.js` (stagger, vibrate, debounce, Fokus-Trap), `ingredient-row.js`, `recurrence-scope.js`.

### CSS-Pattern-Bibliothek (`layout.css`, 3629 Z.)
| Pattern | Varianten | Zustände |
|---|---|---|
| `.btn` (`layout.css:1888-2013`) | primary, secondary, danger, danger-outline, ghost, active, icon, icon-sm | hover, active, focus-visible, disabled, `aria-disabled`, `--loading` (Spinner), `--success`, `--shaking`/`--error-static` |
| `.card` (`:1346-1418`) | padded, compact, flat, interactive | hover-Lift, active, focus-visible |
| `.modal-*` (`:1430-1883`) | sm/md/lg/xl; Mobile = Bottom-Sheet mit Drag-Handle | Container-Query für Formular-Grids (`:1539,1573`) |
| `.page-toolbar` (`:817-885`) | `--wrap`, Center-Slot | Canonical Page Head; 3px-Modul-Akzent oben |
| `.row-action(s)` (`:2024-2079`) | danger, success | geteilte Zeilen-Aktions-Grammatik (Audit F1) |
| `.toggle` (`:2285-2351`) | iOS-Switch | checked, focus-visible, disabled |
| `.input/.form-input` + `.form-field--error/--valid` (`:2108-2210`) | Inline-Validierung + Fehler-Pulse | zentral via modal.js |
| `.toast` (`:2724-2815`) | default (neutral-dunkel), success, danger, warning; Undo-Slot | `showToast(msg, type, duration, onUndo)` `router.js:2577` |
| `.skeleton`, `.skeleton-list/card/line` (`:2372-2426`) | title/short/medium/full | theme-sicher via color-mix |
| `.empty-state` (`:2431-2537`) | icon/title/description/hint/cta/details(pre), `--compact` | Fehlerdetails aufklappbar |
| `.swipe-row/.swipe-reveal` (`:2998-3106`) | done/edit/delete | Chevron-Affordanz, Nudge-Hint |
| `.list-stagger` (`:3036-3049`) | 10-Stufen-Kaskade | PRM-gedeckelt |
| Layout-Primitives (`:2576-2690`) | master-detail, content-aside, center, wide, prose | - |
| Sonstige | `.nav-badge`, `.meal-type-badge`, `.shortcut-kbd`, `.offline-banner`, `.module-readonly-banner`, Skip-Link | - |

### Weitere geteilte Stylesheets
`glass.css` (Glass-Komponenten + lebender Backdrop, Issue-#166-Disziplin), `filter-chip.css`, `sub-tabs.css`, `page-search.css`, `kitchen-tabs.css`, `category-manager.css`, `typography.css` (Rollen-Klassen, Breakpoint-Schicht), `reset.css` (globaler `:focus-visible`-Ring `reset.css:65-69`).

## 4. Token-Inventar (Kurzfassung, Vollreferenz `tokens.css`)

| Gruppe | Umfang |
|---|---|
| Farbe | Neutral 50-950 (warm), Akzent Violet + hover/active/deep, Semantik (success/warning/danger/info + light), 17 Modul-Akzente, Meal-Typen, Prioritäten (+bg), Chart-Serie 1-7, Zyklus-Phasen, Greeting-Gradienten (3 Tageszeiten), `--color-ink-on-vivid`-Mechanik |
| Flächen | surface/2/3, work/raised/glass, elevated/hover; Overlays (5 Stufen) |
| Glass | bg (4 Vibrancy-Stufen), border (3), highlight (3), inset-specular (7), shadow (3), Radien, `--ease-glass`, Backdrop-Blobs (`--lg-*`) |
| Schatten | xs-xl + drop-icon; Dark-Mode-Varianten |
| Radius | 2xs(2)-2xl(28) + full + glass-card(20)/inner(14) |
| Typo | Skala 2xs-4xl + semantische Rollen (`--type-*`), 4 Weights, 3 Trackings, 4 Line-Heights |
| Raum | 4px-Raster `--space-0..16`, `--page-gutter`, Touch-Targets 32/40/44/48 |
| Breakpoints | 640/768/1024/1440 als verbindlicher Kontrakt (`tokens.css:437-456`), Komponenten-Umbrüche via Container-Queries |
| Motion | fast 150/base 250/slow 400 + `--ease-out/in-out/glass` |
| Z-Index | 9-Stufen-Leiter (base→skip-link) |
| A11y-Modi | `prefers-reduced-transparency` (Glass→opak), `prefers-contrast: more`, `forced-colors` (`layout.css:3392-3400`), `prefers-reduced-motion` verteilt |

## 5. Bereits gepinnte Design-Verträge (nicht erneut flaggen)

1. **Zwei Modulkopf-Familien** sind bewusst: (1) In-Page-Tabs im `page-toolbar` (budget/housekeeping/rewards), (2) Routen-Cluster mit `sub-tabs-bar` + sr-only-h1 (health, kitchen-Trio). Guard: `test/test-frontend-audit.js:2723-2767`.
2. **Kontrast-Guards** rechnen WCAG-Ratios direkt aus Tokens (Priority-Badges, Meal-Labels u.a., `test-frontend-audit.js:2768ff`).
3. **Typo-Guard**: font-size/letter-spacing nur via Token (test:typography); Innen-HTML-Verbot (Hook); i18n-Platzhalter-Guard.
4. **Undo-Toast statt Confirm** ist das kanonische Muster für Einzel-Löschungen (tasks/notes/contacts/calendar/recipes/shopping, je 5s-Fenster, z.B. `pages/notes.js:739-766`); `confirmModal` für schwere/mehrstufige Fälle.
5. Notes-Grid bewusst CSS-Grid (kein Columns), zwei Toolbar-Familien-Grenze, `[hidden]`-Durchsetzung global (`layout.css:900-903`).
6. **Canonical Page Head: Breite und Bleed (#577).** Das Chrome des Modul-Kopfes (3px-Akzentstreifen, Trennlinie, Hintergrund, Sticky-Fläche) läuft full-bleed bis zur Shell-Kante; der Kopf-INHALT sitzt in derselben zentrierten Content-Spalte wie der Seiten-Body. Umgesetzt über `--page-inline-pad: max(var(--page-gutter), calc((100% - var(--content-max-width)) / 2))` (tokens.css). Kein Modul-Root trägt `max-width` — Dashboard und Settings sind die dokumentierten Ausnahmen (kein Canonical Page Head). Zwei bindende Bedingungen: (a) der Containing Block des Verwenders muss shell-breit sein (kein Vorfahre bis `.page-transition` mit Inline-Inset oder Breitenkappe), (b) genau einmal pro Ahnenkette, sonst addieren sich die Ränder. Guard: `test-frontend-audit.js` → `page-inline-pad contract holds across every stylesheet (#577)`; dessen bekannte Grenze (Verschachtelung unterhalb eines Trägers) ist dort dokumentiert.

## 6. Methode & Grenzen der visuellen Erfassung

- Dev-Server: `preview_start` (launch.json `yuvomi`, Port 3000, Temp-DB `${TMPDIR}/yuvomi-preview.db`).
- Daten: `scripts/seed-demo.js` (Familie Johnson, Login `alex`/`linda` + `demo1234`).
- Erfasst werden: Kern-Screens aller Module in Light + Dark, Desktop (1280) + Mobile (375), zentrale Zustände (leer/gefüllt/Modal). Nicht erfasst: echte iOS-Safari-Renderings (PWA-Standalone, Safe-Areas), Push/E-Mail-Flows, CalDAV-Sync-UIs mit echten Konten - diese Punkte sind im Audit als "codebasiert geprüft" markiert.
