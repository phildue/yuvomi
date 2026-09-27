/**
 * Modul: Test-Infrastruktur - der Browser-Loader stubt nur, was gestubbt gehört
 * Zweck: `test/test-browser-loader.mjs` leitet browser-absolute Pfade (/foo.js)
 *        entweder auf einen handgeschriebenen Stub um oder, wenn keiner
 *        eingetragen ist, auf die echte Datei unter public/. Ein Stub für ein
 *        Modul, das im Node-Kontext ohnehin läuft, ist eine zweite Kopie, die
 *        nur auseinanderlaufen kann.
 *
 *        Anlass (2026-08-14): der Stub für /utils/date.js war ein Nachbau der
 *        echten Datei, kannte zwei neue Exporte nicht und ließ die
 *        Kalender-Suite mit "does not provide an export named ..." sterben -
 *        an einer Stelle, die mit der Ursache nichts zu tun hatte. Er war schon
 *        vorher gedriftet (kein Default-Parameter bei toLocalDateKey). 16
 *        Suiten laufen über diesen Loader. Der Stub ist ersatzlos entfallen.
 *
 *        WAS HIER NICHT STEHT, UND WARUM. Die erste Fassung wollte allgemein
 *        prüfen, dass kein Stub einen Namen verschweigt, den jemand importiert.
 *        Sie meldete 18 Stellen, von denen keine je jemandem im Weg stand: die
 *        importierenden Module werden nie über den Loader geladen, und das kann
 *        nur ein Import-Graph ab den 16 Suiten entscheiden. Ein Guard, der
 *        Rauschen meldet, wird abgeschaltet statt befolgt - und den Fall, den
 *        er hätte fangen sollen, fängt die betroffene Suite ohnehin sofort,
 *        weil der Import bricht.
 *
 *        Eine zweite Fassung wollte prüfen, dass jeder Stub überhaupt nötig ist
 *        (das Original berührt ein Browser-Global). Sie meldete vier weitere
 *        Einträge, und dabei irrte sie mindestens teilweise: die Liste der
 *        Globals war unvollständig (kein HTMLElement), und ob ein Modul im
 *        Node-Kontext läuft, entscheidet auch, was es selbst importiert. Beide
 *        Fassungen sind an derselben Stelle gescheitert - ein Guard kann die
 *        Absicht nicht lesen, nur die Schreibweise. Der Hinweis bleibt als
 *        Hinweis: /rrule-ui.js, /utils/html.js, /utils/shopping-categories.js
 *        und /components/user-multi-select.js sind Kandidaten, deren Stub
 *        entbehrlich sein könnte - zu prüfen einzeln und mit laufender Suite,
 *        nicht per Regel.
 *
 *        Geblieben ist die Aussage, die trägt: der Rückweg für date.js bleibt
 *        zu, und der Pfad-Fallback lebt.
 * Ausführen: node --test test/test-browser-loader-stubs.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const loaderSrc = readFileSync(new URL('./test-browser-loader.mjs', import.meta.url), 'utf8');

/** Namen der Stub-Schlüssel, z. B. '/api.js'. */
function stubKeys(src) {
  const body = src.slice(src.indexOf('const STUBS'));
  return [...body.matchAll(/^\s{2}'(\/[^']+)':\s*`/gm)].map((m) => m[1]);
}

/** Der Quelltext genau eines Stubs (zwischen seinem Backtick-Paar). */
function stubBody(src, key) {
  const start = src.indexOf(`'${key}': \``);
  if (start < 0) return '';
  const from = src.indexOf('`', start) + 1;
  return src.slice(from, src.indexOf('`', from));
}

const KEYS = stubKeys(loaderSrc);

test('die Stub-Tabelle ist lesbar und jeder Eintrag exportiert etwas', () => {
  // Ohne diese Zeile wäre die Regel unten eine Aussage über eine leere Liste -
  // grün, weil sie nichts prüft.
  assert.ok(KEYS.length >= 5, `nur ${KEYS.length} Stubs gefunden - das Muster greift nicht mehr`);
  for (const key of KEYS) {
    assert.ok(stubBody(loaderSrc, key).includes('export'),
      `Stub ${key} enthält keinen einzigen export - das Auslesen ist kaputt`);
  }
});

test('/utils/date.js wird echt geladen, nicht nachgebaut', () => {
  assert.ok(!KEYS.includes('/utils/date.js'),
    '/utils/date.js ist wieder als Stub eingetragen - die Datei hat keine DOM- oder '
    + 'i18n-Abhängigkeit, läuft im Node-Kontext und war als Nachbau schon einmal gedriftet');
});

test('der Pfad-Fallback auf public/ steht - ohne ihn ist jeder ungestubbte Pfad tot', () => {
  assert.ok(/specifier\.startsWith\('\/'\)/.test(loaderSrc),
    'der Fallback, der /foo.js auf public/foo.js abbildet, fehlt');
  assert.ok(/'\.\.\/public' \+ specifier/.test(loaderSrc),
    'der Fallback zeigt nicht mehr auf public/');
});
