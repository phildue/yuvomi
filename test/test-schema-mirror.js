/**
 * Modul: Schema-Spiegel für Tests (server/db-schema-test.js)
 * Zweck: Die Frage, die weder db.js noch die Testsuiten stellen - trägt jeder
 *        Eintrag in `MIGRATIONS_SQL` wirklich die Migration, deren Nummer er
 *        führt?
 *
 *        Sieben taten es nicht. Die Schlüssel 15 bis 21 trugen den Inhalt der
 *        Migrationen 22 bis 28, ein durchgehender Versatz von sieben. Niemand
 *        fuhr sie, deshalb ist nie etwas rot geworden; wer einen davon
 *        aufgegriffen hätte, wäre mit einem Schema dagestanden, das er nicht
 *        bestellt hat. Aufgefallen sind sie erst, als für #825 ein neuer
 *        Eintrag (v41) von Hand nachgetragen werden musste - der Anlass, sich
 *        zu fragen, ob die vorhandenen stimmen.
 *
 *        Der Spiegel ist ABSICHTLICH ein Auszug: er lässt Teile einer Migration
 *        weg, die eine Testdatenbank nicht braucht, und baut den einen
 *        Tabellen-Rebuild (v11) gleich in seiner Endform. Geprüft wird deshalb
 *        nicht Gleichheit, sondern die schwächere und tragfähige Zusicherung:
 *        ein Eintrag darf kein Objekt anfassen, das seine Migration nicht
 *        anfasst. Das fängt den vertauschten Schlüssel und lässt den Auszug in
 *        Ruhe.
 *
 * Ausführen: npm run test:schema-mirror
 */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'schema-mirror-test-secret';

const { MIGRATIONS } = await import('../server/db.js');
const { MIGRATIONS_SQL } = await import('../server/db-schema-test.js');

/** SQL ohne Kommentare - die trägt der Spiegel bewusst nicht mit. */
const stripComments = (sql) => String(sql)
  .replace(/--[^\n]*/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ');

/**
 * Welche Tabellen fasst ein SQL-Block an?
 *
 * `_new` wird abgeschnitten: ein Tabellen-Rebuild in db.js legt `x_new` an und
 * benennt um, der Spiegel baut gleich `x`. Beide meinen dieselbe Tabelle.
 */
function touchedTables(sql) {
  const s = stripComments(sql);
  const out = new Set();
  const patterns = [
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi,
    /CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi,
    /ALTER\s+TABLE\s+["`]?(\w+)/gi,
    // `UPDATE x` meint eine Tabelle, `AFTER UPDATE ON x` im Trigger-Kopf nicht -
    // ohne das ausgeschlossene ON stand `on` als vermeintliche Tabelle in jeder
    // Migration mit Trigger, und der Vergleich zweier Mengen wäre daran
    // hängengeblieben, sobald nur eine Seite einen Trigger führt.
    /UPDATE\s+(?!ON\b)["`]?(\w+)/gi,
    /INSERT\s+INTO\s+["`]?(\w+)/gi,
  ];
  for (const re of patterns) {
    for (const m of s.matchAll(re)) out.add(m[1].toLowerCase().replace(/_new$/, ''));
  }
  return out;
}

const mirrorKeys = Object.keys(MIGRATIONS_SQL).map(Number).sort((a, b) => a - b);

// --------------------------------------------------------------------------
// Vorbedingung. OHNE SIE IST DER TEST DARUNTER WERTLOS: prüfte er eine leere
// Schlüsselliste, wäre er grün, ohne je einen Eintrag angesehen zu haben
// (dasselbe Muster wie die Mindestmenge in test/css-rules.js).
// --------------------------------------------------------------------------
test('Vorbedingung: der Spiegel hat überhaupt Einträge, und sie sind vergleichbar', () => {
  assert.ok(mirrorKeys.length >= 20, `nur ${mirrorKeys.length} Einträge - stimmt der Import?`);
  assert.ok(MIGRATIONS.length >= 100, `nur ${MIGRATIONS.length} Migrationen - stimmt der Import?`);
  assert.ok(touchedTables(MIGRATIONS_SQL[1]).has('tasks'), 'Migration 1 muss tasks anlegen');
});

test('Jeder Eintrag trägt die Migration, deren Nummer er führt', () => {
  const wrong = [];

  for (const key of mirrorKeys) {
    // Schlüssel 1 ist die Ausnahme und bleibt es: er ist nicht die Migration
    // von damals, sondern das Grundschema mit einigen später ergänzten Spalten
    // (`locked`, `archived_at`, `visibility`) bereits eingearbeitet. Die Tests
    // bauen darauf auf und fahren einzelne spätere Migrationen dazu.
    if (key === 1) continue;

    const migration = MIGRATIONS.find((m) => m.version === key);
    assert.ok(migration, `MIGRATIONS_SQL[${key}] hat keine Migration ${key} in db.js`);
    // Eine Migration mit Funktions-`up` lässt sich nicht als Text vergleichen.
    // Der Spiegel führt heute keine solche; käme eine dazu, ist die Zusicherung
    // hier nicht mehr gegeben und der Test sagt das, statt still zu schweigen.
    assert.equal(
      typeof migration.up, 'string',
      `Migration ${key} hat ein Funktions-up und kann nicht gespiegelt werden`,
    );

    const real = touchedTables(migration.up);
    const alien = [...touchedTables(MIGRATIONS_SQL[key])].filter((t) => !real.has(t));
    if (alien.length) {
      wrong.push(`MIGRATIONS_SQL[${key}] fasst ${alien.join(', ')} an - `
        + `Migration ${key} ("${migration.description}") nicht`);
    }
  }

  assert.deepEqual(
    wrong, [],
    'Ein Eintrag des Schema-Spiegels gehoert nicht zu seiner Nummer.\n'
    + 'Ein Test, der ihn faehrt, bekommt ein anderes Schema als er bestellt:\n'
    + wrong.join('\n'),
  );
});

// --------------------------------------------------------------------------
// Die Gegenrichtung: ein Eintrag darf weglassen, aber nichts erfinden. Eine
// Spalte, die es in der echten Datenbank nicht (mehr) gibt, wuerde in einer
// Testdatenbank ein Verhalten stuetzen, das in Produktion nicht existiert.
// --------------------------------------------------------------------------
test('Der Spiegel erfindet keine Tabelle, die es im echten Schema nicht gibt', () => {
  const realTables = new Set();
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'string') for (const t of touchedTables(m.up)) realTables.add(t);
  }

  const invented = [];
  for (const key of mirrorKeys) {
    for (const t of touchedTables(MIGRATIONS_SQL[key])) {
      if (!realTables.has(t)) invented.push(`MIGRATIONS_SQL[${key}]: ${t}`);
    }
  }

  assert.deepEqual(invented, [], `Tabellen ohne Entsprechung in db.js:\n${invented.join('\n')}`);
});
