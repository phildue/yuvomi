# UX/UI-Audit Yuvomi - Phase 1 (read-only)

Stand: 2026-07-19 · v1.38.0 · Methode: Code-Analyse (alle `public/`-Flächen) + Live-Prüfung (Dev-Server, Demo-Seed, Light+Dark, Desktop 1280 + Mobile 375). Messwerte stammen aus dem laufenden Browser (getComputedStyle/getBoundingClientRect).

Gesamtbild vorweg: Die Basis ist ungewöhnlich reif - vollständiges Token-System inkl. Liquid-Glass-Schicht mit A11y-Fallbacks, geteilte Pattern-Bibliothek mit fast allen Interaktions-Zuständen, konsistentes Undo-Toast-Muster, automatisierte Kontrast-/Typo-/i18n-Guards. Die Befunde unten sind überwiegend Drift an den Rändern (einzelne Module, die geteilte Muster nicht übernommen haben) und Dichte-/Overflow-Probleme, kein strukturelles Versagen. **Kein P0-Befund.**

## Findings

Format: `ID | Dimension | Ort | Problem | Impact | Empfehlung | Severity | Aufwand`

### P1 - klare Usability-/Konsistenz-Schwächen

**F-01 | IA & Navigation | `public/styles/layout.css:1004-1017` (`.nav-sidebar__items` `overflow-y:auto` + `scrollbar-width:none`), Messung live: `scrollHeight 788` vs. `clientHeight 498`, `activeOffsetTop 599` bei `scrollTop 0`**
Problem: Bei Fensterhöhen unter ~1000px (üblich: 1280x800, 1440x900) überläuft die Desktop-Sidebar. Budget, Gesundheit und Einstellungen liegen unterhalb der Falte; der Scrollbalken ist ausgeblendet, es gibt keinerlei Scroll-Affordanz (kein Fade, kein Rand-Anriss). Zusätzlich wird das aktive Item beim Routenwechsel nicht in den Sichtbereich gescrollt - auf `/health` ist weder das Item noch die Indikator-Pille sichtbar (beide bei y=599-643, Viewport endet bei 498).
Impact: Module sind auf verbreiteten Laptop-Auflösungen faktisch unauffindbar; der Wo-bin-ich-Anker der Navigation verschwindet komplett.
Empfehlung: (a) `scrollIntoView({block:'nearest'})` auf das aktive Item bei Routenwechsel; (b) Scroll-Affordanz (Fade-Masken oben/unten wie `budget.js:469-473`); (c) Dichte reduzieren, damit 17 Einträge + 4 Sektionslabels bei 800px Höhe passen (Item-Höhe 44→40, Sektions-Padding), und/oder Einstellungen in die nicht scrollende Footer-Region übernehmen.
Severity: P1 | Aufwand: M

**F-02 | Interaktive Zustände / A11y-Kontrast | `public/styles/shopping.css:482-499` (`.item-delete`: `color: var(--color-text-disabled)`, `opacity: 0`), `:535-558` (`.item-details`: `color: var(--color-text-disabled)`, `opacity: 0.55`)**
Problem: Die Zeilen-Aktionen der Einkaufsliste nutzen die Disabled-Textfarbe plus Opazität. Gemessen (Dark): `rgb(61,61,58)` bei `opacity .55` auf `#1A1A18` ≈ 1.2:1; Light analog ≈ 1.4:1. Der Kommentar in `:533` sagt selbst, dass Details auf Touch ohne Hover erreichbar bleiben muss - sichtbar ist er dort praktisch nicht. WCAG 1.4.11 verlangt ≥3:1 für UI-Komponenten. Die exakt hierfür gebaute geteilte Grammatik `.row-action` (`layout.css:2016-2079`, "EIN Stil für Bearbeiten/Löschen ... Ersetzt die zuvor pro Modul gestreuten Stile") wurde im Shopping-Modul nie übernommen (Tasks, Kontakte, Dokumente nutzen sie).
Impact: Detail-/Löschfunktionen sind für Touch-Nutzer unsichtbar, für Sehbeeinträchtigte in jedem Modus unzugänglich; Komponenten-Drift gegen das erklärte kanonische Muster.
Empfehlung: `.item-details`/`.item-delete` auf `.row-action`-Grammatik umstellen (Farbe `--color-text-tertiary`, kein Ruhe-Opacity < 1; Hover-Reveal nur als Verstärkung, nie als einzige Sichtbarkeit).
Severity: P1 | Aufwand: S

**F-03 | Responsiveness | `public/styles/shopping.css:173-188` (`.list-header` Mobile-Wrap) + Live-Screenshot 375px**
Problem: Auf Mobile bricht der Listen-Kopf in zwei ausgefranste Zeilen: "Abgehakt löschen (3)" + zwei Icon-Buttons rechts, darunter ein verwaister Papierkorb allein rechtsbündig, dazwischen/darüber Totraum (der ausgeblendete Listenname hinterlässt Leerfläche). Wirkt defekt, kostet ~140px Höhe über der Quick-Add-Zeile.
Impact: Erster Eindruck des meistgenutzten Mobile-Moduls (Einkaufen im Laden) ist unaufgeräumt; Aktionen ohne Label (Import-Button verliert per `:185-187` seinen Text) sind schwer deutbar.
Empfehlung: Kopf auf eine einzeilige, konsistente Icon-Aktionsleiste reduzieren (alle Aktionen als `.row-action` mit `aria-label`), Totraum entfernen; alternativ Sekundär-Aktionen in ein Kebab-Menü (Muster: Dokumente-Popover).
Severity: P1 | Aufwand: M

**F-04 | Responsiveness / Typografie | `public/styles/meals.css:640-647` (`.week-grid: repeat(7, minmax(0,1fr))`) + `:633-638` (Rezept-Sidebar fix 320px) + `:124-147` (`.day-header` name+date nebeneinander)**
Problem: Bei 1280px Viewport bleiben ~850px für 7 Tagesspalten ≈ 121px pro Spalte. Folge (live verifiziert): Tages-Header kollidieren ("MO13.07.202‹" ohne Trennung, Datum geclippt), Slot-Labels ("MITTAGES‹") und Einträge ("Scra…", "Tom…") sind nach 3-5 Zeichen abgeschnitten. Die Wochenplan-Kernansicht ist auf Standard-Desktops kaum lesbar.
Impact: Kernfunktion Essensplanung verliert auf 1024-1439px (häufigste Desktop-Klasse) massiv an Lesbarkeit und wirkt fehlerhaft.
Empfehlung: Unter 1440px (a) Datum kompakt formatieren ("Mo 13."), Typ-Label durch Farb-Dot + Tooltip ersetzen oder abkürzen; (b) Spalten-Mindestbreite (~150px) mit horizontalem Scroll + Fade-Affordanz; (c) Rezept-Sidebar unter 1440px einklappbar/als Drawer. Kombination aus (a) und (c) empfohlen.
Severity: P1 | Aufwand: M

### P2 - Konsistenz & Politur

**F-05 | Design Tokens / Komponenten-Konsistenz | `public/styles/shopping.css:284-300` (`.quick-add__btn: background var(--color-accent)`)**
Problem: Der Quick-Add-Bestätigungsbutton ist app-akzent-violett, während Modul-Akzent (Pink), FAB (`--module-accent`, `layout.css:765`) und Fokus-Ringe der Nachbarfelder (`--module-accent`) pink sind. Zwei Akzentfarben für dieselbe Handlung auf einem Screen (live in beiden Themes sichtbar).
Empfehlung: `var(--module-accent, var(--color-accent))` wie beim FAB.
Severity: P2 | Aufwand: S

**F-06 | Feedback & Affordances | Budget-Tabs: `public/styles/budget.css:85-103,133-140` + `public/pages/budget.js:469-473`; Dokumente-Facetten: `public/styles/documents.css` Kategorie-Chipzeile; Kontakte: `public/styles/contacts.css` Kategorien-Zeile (live: "Aufteilen" bei 1280 halb geclippt, Dokumente-Chip "🏠 2" angeschnitten, Kontakte "Ser‹")**
Problem: Drei Module haben horizontal scrollende Chip-/Tab-Leisten mit verstecktem Scrollbalken. Budget besitzt bereits eine Fade-Affordanz (`has-fade-end`), die aber bei 1280px Desktop nicht aktiv war (Fade fehlte trotz Clip); Dokumente und Kontakte haben gar keine Affordanz.
Empfehlung: Die Budget-Fade-Logik als geteiltes Utility extrahieren (z. B. `wireScrollFade(el)` in `utils/ux.js` + Klassen in `filter-chip.css`) und auf alle horizontalen Leisten anwenden; Ursache prüfen, warum `has-fade-end` beim Budget-Desktop-Clip nicht gesetzt war (vermutlich fehlender Resize-/Initial-Aufruf).
Severity: P2 | Aufwand: M

**F-07 | Motion / A11y | `public/styles/tasks.css:412,633`, `public/styles/shopping.css:436` (`check-pop`), Guard-Block `layout.css:2353-2367` deckt nur toggle/fab/list-stagger/swipe-hint/btn-loading**
Problem: Die Checkbox-Pop-Animation (Scale 0.8→1.3) läuft auch unter `prefers-reduced-motion`.
Empfehlung: `check-pop`-Nutzer in den PRM-Block aufnehmen (Animation aus, Zustand bleibt).
Severity: P2 | Aufwand: S

**F-08 | Microcopy & i18n | `public/locales/de.json:1581` (`weatherLocateUnsupported`)**
Problem: "Geolokalisierung wird von Ihrem Browser nicht unterstützt." ist der einzige Sie-Form-Ausreißer; die gesamte App spricht Du ("Bitte prüfe dein Netzwerk", "sieht nur du", ...).
Empfehlung: "Geolokalisierung wird von deinem Browser nicht unterstützt." (+ ggf. Review der 22 anderen Locales auf denselben Ausreißer).
Severity: P2 | Aufwand: S

**F-09 | Typografie / Responsiveness | `public/styles/layout.css:400-408` (`.more-item__label: overflow-wrap:anywhere; hyphens:auto`), `:473-478` (`.more-action__label: overflow-wrap:anywhere`)**
Problem: Im Mobile-Mehr-Sheet brechen deutsche Labels an beliebigen Stellen: live "Haushaltshil-fe", "Einstellung-en", "Änderung-en". `overflow-wrap:anywhere` schlägt vor der Silbentrennung zu.
Empfehlung: `overflow-wrap` auf `normal` belassen und nur `hyphens:auto` (greift mit `lang`-Attribut, das `lang-init.js` setzt) + `hyphenate-limit-chars` wirken lassen; für die 4er-System-Zeile notfalls `--text-2xs` oder 3-Spalten-Fallback.
Severity: P2 | Aufwand: S

**F-10 | Interaktive Zustände / A11y | `public/styles/shopping.css:246-249,265-268` (`.quick-add__qty:focus`, `.quick-add__cat:focus`: nur Border-Farbwechsel), `public/styles/settings.css:830-836` (`.settings-avatar-button:focus-visible`: `outline:none`, nur Shadow+TranslateY)**
Problem: Schwache Fokus-Indikatoren abseits des App-Standards (Ring + Offset). Border-Farbwechsel 1.5px bzw. Schattenwechsel erfüllen die Sichtbarkeitsanforderung (WCAG 2.4.13-Niveau) nicht sicher.
Empfehlung: Standard-Fokusring ergänzen (wie `.quick-add__input:focus` mit Box-Shadow-Ring, `shopping.css:224-228`, bzw. globaler `:focus-visible` aus `reset.css:65-69`).
Severity: P2 | Aufwand: S

**F-11 | Responsiveness | `public/styles/health.css:1360-1364` (`.health-overview__vitals-grid: repeat(2, minmax(0,1fr))`) + Live-Screenshot 1280 (Label "Sauerstoffsättigung" läuft an den Kachelrand)**
Problem: Das längste Vitalwert-Label überläuft seine Kachel; kein Umbruch-/Ellipsis-Handling im Kachel-Kopf.
Empfehlung: Label `hyphens:auto` + `overflow-wrap` oder Kacheln per `auto-fit/minmax(160px,1fr)`; alternativ Kurzlabel "SpO₂" mit `title`/`aria-label`.
Severity: P2 | Aufwand: S

**F-12 | Feedback (destruktiv) | `public/pages/shopping.js:1074-1096` (delete-list nur Undo-Toast) vs. `confirmModal`-Nutzung für Vergleichbares (`documents.js`, `budget.js`, `subscriptions.js:` "Abo löschen? Alle zugehörigen Termine...")**
Problem: Das Löschen einer ganzen Einkaufsliste (inkl. aller Artikel) hat dieselbe niedrige Reibung wie das Löschen eines Einzel-Artikels: 5s-Undo, danach unwiederbringlich. Andere Container-Löschungen bestätigen per Dialog. Die Zuordnung Reibung↔Schwere ist inkonsistent.
Empfehlung: Container-Löschungen (Liste, Ordner, Konto) einheitlich über `confirmModal(danger)`; Undo-Toast bleibt Standard für Einzel-Items.
Severity: P2 | Aufwand: S

**F-13 | Feedback (Datenintegrität wahrgenommen) | Undo-Muster generell, z. B. `public/pages/notes.js:755-766`, `tasks.js:956-966`, `calendar.js:3178-3191` (`setTimeout(5000)` vor `api.delete`)**
Problem: Der Server-Delete passiert erst nach Ablauf des Undo-Fensters. Navigiert der Nutzer vorher weg (SPA-Route wechselt: Timer läuft weiter, ok) oder schließt/reloadet den Tab, wird nie gelöscht - der Eintrag "kommt zurück". Wirkt wie ein Bug.
Empfehlung: Muster invertieren: sofort löschen, Undo stellt wieder her (Server hat alle Daten im Response); oder minimal `pagehide`/`visibilitychange`-Flush der offenen Timer.
Severity: P2 | Aufwand: M (Muster an 6 Stellen)

### P3 - Nice-to-have

**F-14 | Motion | app-weit: >20 rohe Dauern (`0.12s`, `0.18s`, `120ms`, `140ms`, `0.28s`, `0.42s`, `0.45s` ... gezählt via Grep über `public/styles/*.css`) neben der Token-Skala `--transition-fast/base/slow` (`tokens.css:496-501`); Einheiten gemischt (ms/s)**
Problem: Die Motion-Skala deckt Mikro-Timings nicht ab, daher Streuung; keine einheitliche Notation.
Empfehlung: Skala erweitern (z. B. `--duration-2xs:80ms`, `--duration-xs:120ms`) und Streuwerte migrieren; Konvention "ms" festlegen. Kein visueller Umbau, reine Konsolidierung.
Severity: P3 | Aufwand: M

**F-15 | Komponenten-Konsistenz | `public/components/shopping-category-manager.js` vs. generischem `public/components/category-manager.js` (Budget/Tasks/Kontakte)**
Problem: Zwei Category-Manager-Implementierungen; der generische entstand später, Shopping blieb auf der eigenen.
Empfehlung: Shopping auf `oikos-category-manager` migrieren (API deckt Rename-Kaskade/Delete-Fallback ggf. noch nicht ab - vorher prüfen, Tests `test:shopping-routes` decken die Kaskaden).
Severity: P3 | Aufwand: M

**F-16 | Interaktive Zustände | `public/styles/subscriptions.css:602-608` (Combobox-Option Fokus nur Hintergrund), `public/styles/contacts.css:382-386` (Menü-Item Fokus nur Hintergrund)**
Problem: Fokus in Listbox/Menü nur über Flächenfarbe; akzeptables Muster, aber unter dem App-Standard.
Empfehlung: Zusätzlich Inset-Ring (2px) für beide.
Severity: P3 | Aufwand: S

**F-17 | Microcopy | Kategorien-Mischsprache in Listen (live: "ARZT", "SCHULE/KITA" [lokalisiert] neben Seed-/Nutzerkategorien "FAMILY", "Fruit & Veg")**
Problem: Kein App-Fehler (Nutzerdaten bleiben Nutzerdaten), aber die System-Kategorie-Keys sind lokalisiert, während Demo-Seed englische Namen anlegt - im DACH-Marketing-Kontext wirken Screenshots gemischt.
Empfehlung: Demo-Seed (`scripts/seed-demo.js`) auf deutsche Kategorien-/Listennamen umstellen (nur Seed, keine App-Änderung).
Severity: P3 | Aufwand: S

## Konsistenz-Matrix (gleicher Control-Typ über Module)

| Control | Kanonisches Muster | Konsistent | Abweichler |
|---|---|---|---|
| Primäre Anlege-Aktion | `.page-fab` in `--module-accent` (`layout.css:758-806`) | Alle Module | Shopping-Quick-Add-Button in `--color-accent` (F-05) |
| Zeilen-Aktionen (Edit/Delete/Mehr) | `.row-action` 44px, tertiär, Hover-Fläche (`layout.css:2024-2079`) | Tasks, Kontakte, Dokumente, Birthdays, Health | Shopping `item-details`/`item-delete` mit Disabled-Farbe + Opacity (F-02); Budget-Transaktionen nur Trash, ohne Edit-Ikon (Zeile selbst öffnet Editor - ok, aber unbeschriftet) |
| Tabs (In-Page) | `.sub-tab`-Pillen + `wireTablist` (budget/housekeeping/rewards; Guard `test-frontend-audit.js:2737`) | ja | - (Familien-Split zu Routen-Clustern ist gepinnt) |
| Filter-Chips | Outline-Pille, aktive = Modul-Akzent (`filter-chip.css`) | Tasks, Kalender, Kontakte, Dokumente, Notizen, Health-Personen | Overflow-Verhalten uneinheitlich: nur Budget hat Fade-Affordanz (F-06) |
| Suche | `page-search`-Feld in Toolbar (tasks/notes/documents/contacts) bzw. Kalender-Inline-Suche (#471, gepinnt) | ja | - |
| Löschen einzelner Items | Undo-Toast 5s (`showToast(_,_,5000,undo)`) | tasks/notes/contacts/calendar/recipes/shopping-items | Container-Löschung Liste ohne Confirm (F-12) |
| Toast | `window.yuvomi.showToast` types default/success/danger/warning (`router.js:2577`) | app-weit | - |
| Modal | `openModal`/`confirmModal` mit Dirty-Guard, zentrale Pflichtfeld-Validierung (`modal.js:261,597-634`) | app-weit | Settings-Leaves rendern Inline-Formulare (eigene Familie, ok) |
| Fokus-Ring | 2px Ring + Offset, modul-akzentuiert (global `reset.css:65-69`) | überwiegend | F-10/F-16-Stellen |
| Leere Zustände | `.empty-state` mit Icon/Titel/Beschreibung/CTA | 17 Seiten | Meals bewusst ohne (Slot-Grid ist der Leerzustand - ok) |
| Skeletons | `renderSkeletonList` + `.skeleton-*` | alle Datenseiten | Auth-Seiten bewusst ohne (ok) |

## Dimensions-Kurzbewertung

1. **IA & Navigation:** stark (Sektionen, Kitchen-/Health-Cluster, Mehr-Sheet als App-Launcher, Suche überall) - ein P1 (F-01 Sidebar-Overflow).
2. **Komponenten-Konsistenz:** hohe Wiederverwendung; Drift konzentriert sich auf Shopping (F-02/03/05) + Duplikat F-15.
3. **Design Tokens:** vorbildlich; Hardcodes praktisch nur in Kommentaren/Print (`layout.css:3249-3255` bewusst; `settings.css:2443 color:#fff` einzige echte Roh-Farbe - auf vivider Fläche, sollte `--color-ink-on-vivid` nutzen). Motion-Rohwerte als einzige Lücke (F-14).
4. **Interaktive Zustände:** Shared-Layer vollständig (inkl. `aria-disabled`-Konzept `layout.css:1997-2013`); Lücken F-02/F-10/F-16.
5. **Forms & Validation:** zentrale Required-Validierung mit Fehler-Pulse und Wiederholungs-Feedback (`modal.js:597-634`, `layout.css:2167-2210`); Labels programmatisch verknüpft (stichprobenhaft tasks/calendar geprüft); Login-Fehlerregion mit Fokus-Management (`login.css:103-108`). Solide.
6. **Feedback & Affordances:** Undo-Toasts, Button-Loading/Success/Shake, Signature-Glow (`layout.css:3375-3387`) - Lücken F-06/F-12/F-13.
7. **Responsiveness & Touch:** Targets konsequent tokenisiert (44/48px); Container-Queries im Modal (`layout.css:1539`); Schwächen F-03/F-04/F-11 + Mehr-Sheet-Umbruch F-09.
8. **Accessibility:** überdurchschnittlich (Skip-Link, Fokus-Trap, `aria-current`, Tablist-Verdrahtung mit Guard, `forced-colors`, `prefers-contrast`, Kontrast-Guards in Tests, RTL); Kernlücken F-01 (Orientierung), F-02 (1.4.11), F-07 (PRM), F-10.
9. **Microcopy & i18n:** 23 Locales, Du-Form konsequent bis auf F-08; Terminologie Löschen/Entfernen sauber getrennt (entfernen = Verknüpfung lösen).
10. **Motion:** durchdacht (ease-glass, Stagger-Kaskade, PRM-Alternativen als Fades) - F-07 + Skalen-Streuung F-14.
11. **Theming:** Private-Token-Architektur macht Dark vollständig; live geprüft, keine Kontrast-Ausfälle gefunden außer F-02 (themenübergreifend).
12. **Perceived Performance:** modulepreload, Route-CSS on demand, Skeletons flächig, App-Loading-Puls; keine spürbaren Latenz-Fallen im Test.

## Grenzen

Nicht geprüft: echtes iOS-Safari/PWA-Standalone (Safe-Areas, Home-Indicator), Screenreader-Durchlauf (nur Baum/Attribute), E-Mail-/Push-Flows, Sync-Setups mit echten Konten, Installer-Wizard (eigene Oberfläche mit eigenem Audit `docs/installer-audit.md`).
