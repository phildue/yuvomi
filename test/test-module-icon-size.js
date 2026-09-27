/**
 * Modul: Guard - jedes Modulzeichen bringt sein Grundmass mit
 * Zweck: Ein SVG mit `viewBox`, aber ohne `width`/`height` hat KEIN eigenes
 *        Mass. Es nimmt dann die Breite seines Kastens - in einer Box mit
 *        fester Groesse (Leiste, Siegel, Modul-Scheibe) faellt das nie auf, in
 *        einer flexiblen Zeile ufert es aus.
 *
 *        Anlass (#949, 2026-08-30): Die vier Kuechen-Kinder in den
 *        Einstellungen standen in einer `.toggle-row` ohne Massregel und wurden
 *        gemessen 458-489px breit statt 24. Gemeldet wurden zwei Stellen, es
 *        waren drei (Aktive Module, Navigation, Einstellungs-Uebersicht) - eine
 *        Ursache, dreimal sichtbar.
 *
 *        Der Lucide-Rueckfall hatte das Mass die ganze Zeit, weil
 *        `lucide.createIcons()` width/height auf das erzeugte SVG setzt. Genau
 *        das ist der Punkt dieses Guards: DERSELBE NAME MUSS AUS BEIDEN HAENDEN
 *        DASSELBE ergeben. Ohne das Mass sagte er je nach Hand etwas anderes.
 *
 *        Geprueft wird die SACHE (traegt das erzeugte Zeichen ein Mass?), nicht
 *        die Schreibweise in nav-icons.js - und zwar auf BEIDEN Wegen, dem
 *        Zeichenketten-Weg (`moduleIconHTML`) und dem Element-Weg
 *        (`moduleIconEl`), weil nur ein gemeinsamer Beleg ausschliesst, dass
 *        einer der beiden wieder abdriftet.
 * Ausfuehren: node --test test/test-module-icon-size.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Das Mass, das Lucide auf jedes erzeugte Zeichen schreibt. Der eigene Satz
 * folgt ihm, damit ein Ort ohne CSS-Massregel nicht danach unterscheidet,
 * welche Hand gezeichnet hat.
 */
const LUCIDE_BASE_SIZE = '24';

/**
 * Ein DOM, klein genug fuer `moduleIconEl` und gross genug, um zu beweisen,
 * WAS es auf das Element schreibt. Ein Stub statt eines echten Browsers: der
 * Element-Weg besteht aus `createElementNS` + `setAttribute`, und genau das
 * wird hier mitgeschrieben.
 */
function installDomStub() {
  const made = [];
  const makeEl = (tagName) => {
    const attributes = new Map();
    const el = {
      tagName,
      attributes,
      children: [],
      classList: { add: (c) => el.classes.add(c) },
      classes: new Set(),
      dataset: {},
      setAttribute: (k, v) => attributes.set(k, String(v)),
      getAttribute: (k) => attributes.get(k) ?? null,
      appendChild: (child) => el.children.push(child),
    };
    made.push(el);
    return el;
  };
  globalThis.document = {
    createElementNS: (_ns, tagName) => makeEl(tagName),
    createElement: (tagName) => makeEl(tagName),
  };
  return () => { delete globalThis.document; return made; };
}

const restoreDom = installDomStub();
const { MODULE_ICON, moduleIconHTML, moduleIconEl } = await import('../public/nav-icons.js');
restoreDom();

/** Jeder Name, den der eigene Satz selbst zeichnet (kein Lucide-Rueckfall). */
function ownIconNames() {
  return [...new Set(Object.values(MODULE_ICON))]
    .filter((name) => moduleIconHTML(name).startsWith('<svg'));
}

test('der Satz zeichnet ueberhaupt selbst', () => {
  // Ohne diese Probe waere der Guard darunter gruen, sobald der Satz leer
  // laeuft oder alles auf Lucide faellt - er verglichen dann nichts mehr.
  const own = ownIconNames();
  assert.ok(own.length > 20, `nur ${own.length} eigene Zeichen erkannt - zeichnet der Satz noch selbst?`);
  for (const expected of ['calendar', 'utensils', 'shopping-cart', 'package']) {
    assert.ok(own.includes(expected), `${expected} muss aus dem eigenen Satz kommen`);
  }
});

test('jedes eigene Zeichen traegt ein Grundmass (Zeichenketten-Weg)', () => {
  const ohne = ownIconNames().filter((name) => {
    const markup = moduleIconHTML(name);
    return !markup.includes(`width="${LUCIDE_BASE_SIZE}"`) || !markup.includes(`height="${LUCIDE_BASE_SIZE}"`);
  });

  assert.deepEqual(ohne, [],
    'Diesen Zeichen fehlt width/height. Ein SVG ohne eigenes Mass nimmt die Breite seines\n'
    + 'Kastens - in einer flexiblen Zeile werden daraus mehrere hundert Pixel (#949), ohne\n'
    + 'dass etwas bricht. Das Mass gehoert in ROOT_ATTRS (public/nav-icons.js), nicht an die\n'
    + 'einzelne Fundstelle: als Praesentationsattribut unterliegt es jeder CSS-Regel, die\n'
    + 'einen Ort bemisst, und aendert deshalb nur die Orte ohne eigene Massregel.');
});

test('jedes eigene Zeichen traegt dasselbe Grundmass (Element-Weg)', () => {
  const restore = installDomStub();
  const ohne = ownIconNames().filter((name) => {
    const el = moduleIconEl(name);
    return el.getAttribute('width') !== LUCIDE_BASE_SIZE || el.getAttribute('height') !== LUCIDE_BASE_SIZE;
  });
  restore();

  assert.deepEqual(ohne, [],
    'Der Element-Weg (moduleIconEl) gibt Zeichen ohne Grundmass aus, der Zeichenketten-Weg\n'
    + 'aber mit. Beide bauen aus ROOT_ATTRS - laufen sie auseinander, heisst derselbe Name\n'
    + 'je nach Bau-Stelle etwas anderes.');
});

test('der Lucide-Rueckfall bleibt ein Platzhalter ohne eigenes Mass', () => {
  // `lucide.createIcons()` setzt width/height selbst auf das erzeugte SVG.
  // Traege der Platzhalter sie schon, stuende dieselbe Zahl an zwei Stellen.
  const markup = moduleIconHTML('image-plus');
  assert.ok(markup.startsWith('<i '), 'ein unbekannter Name muss der Lucide-Platzhalter bleiben');
  assert.ok(!markup.includes('width='), 'der Platzhalter darf sein Mass nicht selbst mitbringen');
});
