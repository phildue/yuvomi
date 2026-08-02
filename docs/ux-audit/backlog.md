# UX-Audit Backlog (priorisiert)

Reihenfolge = empfohlene Umsetzungsreihenfolge innerhalb der Severity. Details je ID in `audit.md`.

## P0
Keine Befunde.

## P1

| # | ID | Titel | Aufwand | Abhängigkeit |
|---|----|-------|---------|--------------|
| 1 | F-02 | Shopping-Zeilenaktionen auf `.row-action`-Grammatik heben (Kontrast-Fail beheben) | S | - |
| 2 | F-01 | Sidebar: aktives Item in Sicht scrollen + Scroll-Affordanz + Dichte | M | - |
| 3 | F-03 | Shopping-Listenkopf Mobile aufräumen (einzeilige Aktionsleiste) | M | profitiert von F-02 |
| 4 | F-04 | Meals-Wochenraster 1024-1439px lesbar machen (kompakter Header, Sidebar-Drawer) | M | - |

## P2

| # | ID | Titel | Aufwand |
|---|----|-------|---------|
| 5 | F-05 | Quick-Add-Button auf `--module-accent` | S |
| 6 | F-10 | Fokus-Ringe quick-add qty/cat + settings-avatar | S |
| 7 | F-07 | `check-pop` unter prefers-reduced-motion deaktivieren | S |
| 8 | F-08 | Sie→Du in `weatherLocateUnsupported` (alle Locales prüfen) | S |
| 9 | F-09 | Mehr-Sheet-Labels: saubere Silbentrennung statt anywhere-Umbruch | S |
| 10 | F-11 | Health-Vitals-Kachel: Label-Overflow behandeln | S |
| 11 | F-12 | Container-Löschungen (Einkaufsliste) mit confirmModal | S |
| 12 | F-06 | Geteilte Scroll-Fade-Affordanz für Chip-/Tab-Leisten (Budget-Fix + Dokumente + Kontakte) | M |
| 13 | F-13 | Undo-Löschmuster: Server-Delete sofort + Restore (oder pagehide-Flush) | M |

## P3

| # | ID | Titel | Aufwand |
|---|----|-------|---------|
| 14 | F-16 | Inset-Fokusring Combobox/Kontakt-Menü | S |
| 15 | F-17 | Demo-Seed auf deutsche Namen (nur Screenshots/Marketing) | S |
| 16 | F-14 | Motion-Dauern-Skala konsolidieren | M |
| 17 | F-15 | Shopping-Category-Manager auf generische Komponente migrieren | M |

## Bewusst NICHT im Backlog (gepinnte Verträge / geprüft und in Ordnung)

- Zwei Modulkopf-Familien (page-toolbar vs. sub-tabs-Routen-Cluster) - Guard `test/test-frontend-audit.js:2723-2767`.
- Undo-Toast statt Confirm für Einzel-Items - bewusstes, konsistentes App-Muster.
- Meals ohne `.empty-state` - das Slot-Raster ist der Leerzustand.
- Kitchen-Tab-Label-Ellipsis auf Mobile - per Guard gepinnt (`test-frontend-audit.js:1549-1554`).
- `outline:none` an Region-Fokuszielen (`.app-content`, Settings-Leaf-Titel, Login-Fehlerbox) - dokumentiert korrekt.
- Heading-Struktur (h1 via DOM API in recipes/settings) - geprüft, vorhanden.
