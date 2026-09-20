/**
 * Modul: QR-Encoder fuer die Zwei-Faktor-Einrichtung (#672)
 * Zweck: Der Encoder ist ohne Abhaengigkeit gebaut, also traegt dieser Test die
 *        Beweislast. Er tut das nicht ueber eingefrorene Bilder, sondern ueber
 *        einen ZWEITEN, hier unabhaengig geschriebenen Decoder: er sucht die
 *        Funktionsmuster selbst, liest die Formatinformation, nimmt die Maske
 *        heraus, sammelt die Codewoerter im Zickzack ein und entschraenkt die
 *        Bloecke. Kommt der Ausgangstext heraus, stimmen Platzierung,
 *        Maskierung, Formatbits und Verschraenkung zusammen.
 *
 *        Warum diese Form: waehrend der Entwicklung lagen BEIDE Kopien der
 *        Formatinformation an Zeile und Spalte vertauscht. Ein Bild-Decoder
 *        las den Code trotzdem - die zweite Kopie und die Fehlerkorrektur der
 *        Formatbits fingen es auf. Ein gruener Test ueber einem echten Fehler.
 *        Deshalb prueft dieser Test die erste Kopie ausdruecklich einzeln.
 *
 *        Deckt ab:
 *          - Rundlauf ueber alle Versionen 1 bis 10, jeweils an der Grenze
 *            der Kapazitaet und knapp darunter
 *          - UTF-8 im Byte-Modus (Umlaute duerfen nicht zerfallen)
 *          - die Funktionsmuster stehen, wo der Standard sie verlangt
 *          - JEDE der beiden Kopien der Formatinformation ist fuer sich gueltig
 *          - die gewaehlte Maske ist wirklich die guenstigste der acht
 *          - Ueberlaenge wirft, statt still etwas Unlesbares zu liefern
 *          - das SVG traegt die Ruhezone von vier Modulen
 * Ausfuehren: node --test test/test-qrcode.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr, qrToSvg, qrToDataUrl, penalty } from '../server/utils/qrcode.js';

// --------------------------------------------------------
// Ein unabhaengig geschriebener Decoder. Er kennt den Encoder nicht und leitet
// alles aus der Matrix ab.
// --------------------------------------------------------

const ALIGNMENT = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// Je Version fuer Level M: [Bloecke1, Groesse1, Bloecke2, Groesse2, EC je Block].
const BLOCKS_M = [
  [1, 16, 0, 0, 10], [1, 28, 0, 0, 16], [1, 44, 0, 0, 26], [2, 32, 0, 0, 18], [2, 43, 0, 0, 24],
  [4, 27, 0, 0, 16], [4, 31, 0, 0, 18], [2, 38, 2, 39, 22], [3, 36, 2, 37, 22], [4, 43, 1, 44, 26],
];

// GF(256) mit dem QR-Polynom 0x11D - hier nur, um die Syndrome nachzurechnen.
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

/** Welche Positionen tragen Funktionsmuster und keine Daten. */
function functionMap(size, version) {
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) fn[r][c] = true; };

  for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) mark(br + r, bc + c);
  }
  for (let i = 0; i < size; i += 1) { mark(6, i); mark(i, 6); }
  const pos = ALIGNMENT[version - 1];
  for (const r of pos) for (const c of pos) {
    const nearFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
    if (nearFinder) continue;
    for (let dr = -2; dr <= 2; dr += 1) for (let dc = -2; dc <= 2; dc += 1) mark(r + dr, c + dc);
  }
  for (let i = 0; i < 9; i += 1) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i += 1) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      mark(Math.floor(i / 3), size - 11 + (i % 3));
      mark(size - 11 + (i % 3), Math.floor(i / 3));
    }
  }
  return fn;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * Liest die 15 Formatbits einer der beiden Kopien und prueft sie gegen den
 * BCH-Code. Liefert `{ level, mask }` oder wirft.
 */
function readFormat(modules, which) {
  const size = modules.length;
  const bit = [];
  if (which === 'first') {
    for (let i = 0; i <= 5; i += 1) bit[i] = modules[i][8];
    bit[6] = modules[7][8];
    bit[7] = modules[8][8];
    bit[8] = modules[8][7];
    for (let i = 9; i <= 14; i += 1) bit[i] = modules[8][14 - i];
  } else {
    for (let i = 0; i <= 7; i += 1) bit[i] = modules[8][size - 1 - i];
    for (let i = 8; i <= 14; i += 1) bit[i] = modules[size - 15 + i][8];
  }
  let value = 0;
  for (let i = 0; i < 15; i += 1) if (bit[i]) value |= 1 << i;
  value ^= 0b101010000010010;

  // BCH(15,5) nachrechnen: der Rest muss null sein.
  let rest = value;
  for (let i = 14; i >= 10; i -= 1) if ((rest >>> i) & 1) rest ^= 0b10100110111 << (i - 10);
  assert.equal(rest, 0, `Formatinformation (${which}) verletzt ihren BCH-Code`);

  return { level: (value >>> 13) & 0b11, mask: (value >>> 10) & 0b111 };
}

/**
 * Gegenstueck zu readFormat: schreibt die Formatbits beider Kopien fuer eine
 * Maske. Der Standard bewertet das FERTIGE Symbol, und die Formatbits gehoeren
 * dazu - wer sie beim Vergleich der acht Masken stehen laesst, bewertet acht
 * Symbole, von denen sieben so nie entstehen.
 */
function writeFormat(modules, mask) {
  const size = modules.length;
  const data = (0b00 << 3) | mask;
  let rest = data << 10;
  for (let i = 14; i >= 10; i -= 1) if ((rest >>> i) & 1) rest ^= 0b10100110111 << (i - 10);
  const value = ((data << 10) | rest) ^ 0b101010000010010;
  const bit = (i) => ((value >>> i) & 1) === 1;

  for (let i = 0; i <= 5; i += 1) modules[i][8] = bit(i);
  modules[7][8] = bit(6);
  modules[8][8] = bit(7);
  modules[8][7] = bit(8);
  for (let i = 9; i <= 14; i += 1) modules[8][14 - i] = bit(i);

  for (let i = 0; i <= 7; i += 1) modules[8][size - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i += 1) modules[size - 15 + i][8] = bit(i);
}

/** Nimmt die Maske heraus und liest die Codewoerter im Zickzack. */
function readCodewords(modules, version, mask) {
  const size = modules.length;
  const fn = functionMap(size, version);
  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    const pair = right <= 6 ? right - 1 : right;
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step;
      for (const c of [pair, pair - 1]) {
        if (fn[r][c]) continue;
        bits.push(modules[r][c] !== MASKS[mask](r, c));
      }
    }
    upward = !upward;
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) b = (b << 1) | (bits[i + j] ? 1 : 0);
    bytes.push(b);
  }
  return bytes;
}

/**
 * Macht die Blockverschraenkung rueckgaengig. Liefert die Datencodewoerter und
 * prueft dabei JEDEN Block gegen seine Fehlerkorrektur-Woerter.
 *
 * Die Syndromprobe ist der Grund, warum dieser Test einen falsch gelegten
 * Zickzack ueberhaupt sieht: die EC-Woerter liegen hinten im Symbol, also in
 * genau den Spalten, die eine falsche Sprungregel trifft. Wer nur die
 * Nutzdaten zurueckliest, bekommt sie richtig heraus und uebersieht, dass der
 * Code jede Beschaedigung ungeschuetzt an den Scanner weitergibt.
 */
function deinterleave(codewords, version) {
  const [n1, s1, n2, s2, ec] = BLOCKS_M[version - 1];
  const blocks = [];
  for (let i = 0; i < n1; i += 1) blocks.push({ size: s1, data: [], ec: [] });
  for (let i = 0; i < n2; i += 1) blocks.push({ size: s2, data: [], ec: [] });

  let idx = 0;
  for (let i = 0; i < Math.max(s1, s2); i += 1) {
    for (const block of blocks) if (i < block.size) block.data.push(codewords[idx++]);
  }
  for (let i = 0; i < ec; i += 1) {
    for (const block of blocks) block.ec.push(codewords[idx++]);
  }

  blocks.forEach((block, index) => {
    const full = [...block.data, ...block.ec];
    for (let i = 0; i < ec; i += 1) {
      let syndrome = 0;
      for (const byte of full) syndrome = gfMul(syndrome, GF_EXP[i]) ^ byte;
      assert.equal(syndrome, 0, `Block ${index}: Syndrom ${i} ist ${syndrome}, nicht 0`);
    }
  });

  return blocks.flatMap((b) => b.data);
}

/**
 * Liest die Versionsinformation beider Kopien (ab Version 7) und prueft sie
 * gegen ihren BCH-Code und gegen die Symbolgroesse.
 *
 * Der Test darf die Version NICHT nur aus der Matrixgroesse ableiten: genau so
 * blieb ein falsches Generatorpolynom hier unbemerkt, waehrend ein Scanner ab
 * Version 7 diese Bits wirklich liest.
 */
function readVersion(modules, expected) {
  const size = modules.length;
  for (const corner of ['topRight', 'bottomLeft']) {
    let value = 0;
    for (let i = 0; i < 18; i += 1) {
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      const dark = corner === 'topRight' ? modules[a][b] : modules[b][a];
      if (dark) value |= 1 << i;
    }
    let rest = value;
    for (let i = 17; i >= 12; i -= 1) if ((rest >>> i) & 1) rest ^= 0x1f25 << (i - 12);
    assert.equal(rest, 0, `Versionsinformation (${corner}) verletzt ihren BCH-Code`);
    assert.equal(value >>> 12, expected, `Versionsinformation (${corner}) nennt die falsche Version`);
  }
}

/** Voller Rundlauf: Matrix -> Text. */
function decodeQr(modules) {
  const size = modules.length;
  const version = (size - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 10, `unerwartete Groesse ${size}`);

  const first  = readFormat(modules, 'first');
  const second = readFormat(modules, 'second');
  assert.deepEqual(first, second, 'die beiden Kopien der Formatinformation widersprechen sich');
  assert.equal(first.level, 0b00, 'Fehlerkorrektur-Level ist nicht M');
  if (version >= 7) readVersion(modules, version);

  const data = deinterleave(readCodewords(modules, version, first.mask), version);

  // Kopf lesen: 4 Bit Modus, dann das Laengenfeld.
  const bits = [];
  for (const byte of data) for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
  const take = (n) => { let v = 0; for (let i = 0; i < n; i += 1) v = (v << 1) | bits.shift(); return v; };

  assert.equal(take(4), 0b0100, 'nicht der Byte-Modus');
  const length = take(version < 10 ? 8 : 16);
  const out = [];
  for (let i = 0; i < length; i += 1) out.push(take(8));
  return Buffer.from(out).toString('utf8');
}

// --------------------------------------------------------
// Tests
// --------------------------------------------------------

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:/?&=.-_~%';
function sample(length) {
  let text = '';
  for (let i = 0; i < length; i += 1) text += ALPHA[(i * 7 + length * 13) % ALPHA.length];
  return text;
}

// Groesste Byte-Zahl je Version bei Level M (Datencodewoerter minus zwei
// Kopfbytes; ab Version 10 kostet das Laengenfeld ein Byte mehr).
const CAPACITY = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

test('jede Version 1 bis 10 laeuft hin und zurueck', () => {
  CAPACITY.forEach((max, index) => {
    const version = index + 1;
    for (const length of [max, Math.max(1, max - 1)]) {
      const text = sample(length);
      const modules = encodeQr(text);
      assert.equal(modules.length, version * 4 + 17, `Version ${version} bei ${length} Bytes`);
      assert.equal(decodeQr(modules), text, `Version ${version} bei ${length} Bytes`);
    }
  });
});

test('jede Laenge von 1 bis zur Obergrenze laeuft hin und zurueck', () => {
  for (let length = 1; length <= 213; length += 1) {
    const text = sample(length);
    assert.equal(decodeQr(encodeQr(text)), text, `Laenge ${length}`);
  }
});

test('UTF-8 ueberlebt den Byte-Modus', () => {
  for (const text of ['Grüße aus München', 'ärgerlich: öäüß', '日本語のテスト', 'emoji 🔐 im Text']) {
    assert.equal(decodeQr(encodeQr(text)), text, text);
  }
});

test('eine otpauth-URI ergibt genau sich selbst', () => {
  const uri = 'otpauth://totp/Yuvomi:anna?secret=CG6TTILZUIZ5RWZ2VTK7TFEWGCTIHDVB'
            + '&issuer=Yuvomi&algorithm=SHA1&digits=6&period=30';
  assert.equal(decodeQr(encodeQr(uri)), uri);
});

test('die Funktionsmuster stehen, wo der Standard sie verlangt', () => {
  const modules = encodeQr(sample(50));
  const size = modules.length;

  // Suchmuster an drei Ecken, mit hellem Trennstreifen.
  for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const expected = r === 0 || r === 6 || c === 0 || c === 6
                       || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        assert.equal(modules[br + r][bc + c], expected, `Suchmuster (${br + r},${bc + c})`);
      }
    }
  }
  // Taktmuster.
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(modules[6][i], i % 2 === 0, `waagerechtes Taktmuster bei ${i}`);
    assert.equal(modules[i][6], i % 2 === 0, `senkrechtes Taktmuster bei ${i}`);
  }
  // Das immer dunkle Modul.
  assert.equal(modules[size - 8][8], true, 'dunkles Modul');
});

test('BEIDE Kopien der Formatinformation sind fuer sich gueltig', () => {
  // Der Fehler, den dieser Test faengt: eine Kopie an Zeile und Spalte
  // vertauscht. Bild-Decoder verzeihen das ueber die jeweils andere Kopie.
  for (const length of [1, 20, 50, 110, 160, 213]) {
    const modules = encodeQr(sample(length));
    const first  = readFormat(modules, 'first');
    const second = readFormat(modules, 'second');
    assert.deepEqual(first, second, `Laenge ${length}`);
    assert.equal(first.level, 0b00, `Laenge ${length}: Level M`);
    assert.ok(first.mask >= 0 && first.mask <= 7, `Laenge ${length}: Maske im Bereich`);
  }
});

test('die gewaehlte Maske ist die guenstigste der acht', () => {
  for (const length of [1, 46, 59, 60, 100, 213]) {
    const modules = encodeQr(sample(length));
    const chosen = readFormat(modules, 'first').mask;
    const size = modules.length;
    const version = (size - 17) / 4;
    const fn = functionMap(size, version);

    // Die Maske der Matrix herausnehmen, jede andere hineinrechnen, die zu ihr
    // gehoerenden Formatbits setzen, bewerten.
    const scores = MASKS.map((_, index) => {
      const candidate = modules.map((row, r) => row.map((value, c) => (
        fn[r][c] ? value : (value !== MASKS[chosen](r, c)) !== MASKS[index](r, c)
      )));
      writeFormat(candidate, index);
      return penalty(candidate);
    });
    const best = Math.min(...scores);
    assert.equal(scores[chosen], best, `Laenge ${length}: Maske ${chosen} hat ${scores[chosen]}, beste ist ${best}`);
  }
});

test('Ueberlaenge wirft, statt still etwas Unlesbares zu liefern', () => {
  assert.throws(() => encodeQr('x'.repeat(214)), /too long/i);
  // Ein Zeichen weniger geht noch.
  assert.doesNotThrow(() => encodeQr('x'.repeat(213)));
  // Mehrbyte-Zeichen zaehlen nach Bytes, nicht nach Zeichen.
  assert.throws(() => encodeQr('ä'.repeat(107)), /too long/i);
});

test('das SVG traegt die Ruhezone und faerbt nur die dunklen Module', () => {
  const modules = encodeQr('test');
  const svg = qrToSvg('test', { moduleSize: 4, quietZone: 4 });
  const expected = (modules.length + 8) * 4;

  assert.match(svg, new RegExp(`width="${expected}"`));
  assert.match(svg, new RegExp(`viewBox="0 0 ${expected} ${expected}"`));
  assert.match(svg, /shape-rendering="crispEdges"/);

  // Ein Pfadsegment je dunklem Modul.
  const dark = modules.flat().filter(Boolean).length;
  assert.equal((svg.match(/M\d+ \d+h4v4h-4z/g) || []).length, dark);

  // Die Data-URL laesst sich zurueckholen.
  const url = qrToDataUrl('test');
  assert.match(url, /^data:image\/svg\+xml;base64,/);
  assert.ok(Buffer.from(url.split(',')[1], 'base64').toString('utf8').startsWith('<svg'));
});
