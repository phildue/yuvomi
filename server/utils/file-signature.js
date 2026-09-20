/**
 * Modul: Dateisignaturen (Magic Bytes)
 * Zweck: Prueft, ob der Inhalt eines Uploads zu dem Typ passt, als der er
 *        deklariert wurde.
 *
 * WARUM DAS NOETIG IST. Jeder Upload-Pfad in Yuvomi nimmt eine data-URL entgegen
 * und glaubt bisher deren Praefix: `data:application/pdf;base64,...` galt als PDF,
 * weil dort "application/pdf" steht. Diese Angabe kommt aus dem Browser des
 * Absenders und laesst sich mit einem einzigen HTTP-Request frei setzen.
 *
 * Der Auslieferungspfad ist gegen die Folgen bereits gut gesichert - fester
 * Content-Type, `nosniff` und eine enge CSP verhindern, dass ein falsch
 * deklarierter Inhalt je als HTML oder Skript ausgefuehrt wird. Was er nicht
 * verhindert, ist der stille Fall: Ein Familienplaner ist ein Ablageort auf
 * Jahre. Eine Datei, die als "Versicherungsschein.pdf" abgelegt wird und keins
 * ist, faellt erst auf, wenn jemand sie braucht. Eine Pruefung beim Hochladen
 * kostet ein paar Bytes Vergleich und meldet den Fehler dem, der ihn noch
 * beheben kann.
 *
 * WAS HIER BEWUSST NICHT PASSIERT. Fuer `text/plain` und `text/csv` gibt es
 * keine Signatur - Text faengt mit dem an, was drinsteht. Ein Heuristik-Versuch
 * ("faengt es mit < an, ist es HTML") wuerde eine CSV ablehnen, deren erste
 * Zelle spitze Klammern enthaelt. Diese Typen passieren deshalb ungeprueft; sie
 * traegt die Auslieferungsseite.
 *
 * Abhaengigkeiten: keine.
 */

// Ein Praefix-Vergleich. `offset` fuer Formate, deren Kennung nicht am Anfang steht.
const prefix = (bytes, offset = 0) => (buf) =>
  buf.length >= offset + bytes.length
  && bytes.every((b, i) => buf[offset + i] === b);

const ascii = (text, offset = 0) => prefix([...text].map((c) => c.charCodeAt(0)), offset);

// Ein PDF darf laut Adobes eigener Auslegung bis zu 1024 Bytes Vorlauf haben
// (Mailer und Scanner haengen gern etwas davor). Wer strikt auf Byte 0 prueft,
// lehnt reale, in jedem Reader funktionierende Dateien ab.
//
// Das Fenster ist um die Markerlaenge groesser als der erlaubte Versatz und der
// Fund wird danach separat begrenzt. Ein Schnitt bei genau 1024 haette einen
// Marker, der bei Byte 1020 beginnt, mitten durchtrennt - also ausgerechnet die
// Dateien abgelehnt, fuer die die Toleranz da ist.
const PDF_MARKER = '%PDF-';
const PDF_MAX_OFFSET = 1024;
const pdfHeader = (buf) => {
  const at = buf.subarray(0, PDF_MAX_OFFSET + PDF_MARKER.length).indexOf(PDF_MARKER);
  return at >= 0 && at <= PDF_MAX_OFFSET;
};

// ZIP-Container. Office-Formate ab 2007 sind ZIPs; `PK\x03\x04` ist der Anfang
// des ersten Eintrags und bei einem Dokument mit Inhalt immer der Start.
const zipHeader = prefix([0x50, 0x4b, 0x03, 0x04]);

// OLE2 Compound File - die Huelle der Office-Formate vor 2007.
const oleHeader = prefix([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const webpHeader = (buf) => ascii('RIFF')(buf) && ascii('WEBP', 8)(buf);

// SVG ist Text und hat keine Magic Bytes - aber es hat eine Form. Ein Dokument
// beginnt (nach BOM und Leerraum) mit der XML-Deklaration, einem Kommentar,
// einem SVG-Doctype oder direkt mit `<svg`, und irgendwo im Kopf steht dieses
// `<svg`.
//
// Die Pruefung steht hier, weil das Abo-Logo SVG ausdruecklich anbietet
// (`accept="...image/svg+xml"`). Sie einfach von der Allowlist zu nehmen waere
// die bequeme Loesung und ein Funktionsverlust: Firmenlogos sind oft SVG. Ohne
// sie passierte dagegen jeder Inhalt, der sich als SVG ausgab - `contentMatchesMime`
// laesst unbekannte Typen absichtlich durch, und "unbekannt" hiess fuer SVG
// bisher "ungeprueft".
const SVG_HEAD_BYTES = 1024;
const svgHeader = (buf) => {
  const head = buf.subarray(0, SVG_HEAD_BYTES).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (!/^(<\?xml|<!--|<!DOCTYPE\s+svg|<svg)/i.test(head)) return false;
  return /<svg[\s>]/i.test(head);
};

const gifHeader = (buf) => ascii('GIF87a')(buf) || ascii('GIF89a')(buf);

/**
 * MIME-Typ → Pruefung seiner Signatur. Ein Typ, der hier fehlt, hat keine
 * (Text) oder wird nirgends akzeptiert.
 */
const SIGNATURES = new Map([
  ['application/pdf', pdfHeader],
  ['image/png', prefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  // Alle JPEG-Varianten (JFIF, Exif, roh) beginnen mit SOI + dem naechsten Marker.
  ['image/jpeg', prefix([0xff, 0xd8, 0xff])],
  ['image/webp', webpHeader],
  ['image/gif', gifHeader],
  ['image/svg+xml', svgHeader],
  ['application/msword', oleHeader],
  ['application/vnd.ms-excel', oleHeader],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', zipHeader],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zipHeader],
]);

// `image/jpg` ist kein registrierter Typ, kommt aus aelteren Clients aber vor und
// wird an mehreren Stellen akzeptiert - dieselbe Signatur wie image/jpeg.
SIGNATURES.set('image/jpg', SIGNATURES.get('image/jpeg'));

/**
 * Passt der Inhalt zum deklarierten Typ?
 *
 * Liefert `true` auch fuer Typen ohne bekannte Signatur - "nicht widerlegt" ist
 * hier die richtige Antwort, nicht "abgelehnt": Diese Funktion entscheidet nicht,
 * WELCHE Typen erlaubt sind (das tun die Allowlists der Aufrufer), sondern nur,
 * ob ein erlaubter Typ haelt, was er verspricht.
 *
 * @param {Buffer|Uint8Array} buffer Roher Dateiinhalt
 * @param {string} mime              Deklarierter MIME-Typ (klein geschrieben)
 * @returns {boolean}
 */
export function contentMatchesMime(buffer, mime) {
  const check = SIGNATURES.get(String(mime || '').toLowerCase());
  // `typeof` statt eines blossen Wahrheitstests: `mime` kommt vom Absender, und
  // eine Nachschlagetabelle, die mit einem fremden Schluessel etwas anderes als
  // die eigenen Werte herausgibt, ist die Wurzel der Prototype-Pollution. Eine
  // `Map` hat dieses Loch nicht - `SIGNATURES.get('toString')` ist `undefined`,
  // wo ein Objektliteral `Object.prototype.toString` geliefert haette, und genau
  // deshalb steht hier eine. Die Pruefung ist damit redundant; sie bleibt, weil
  // sie die Zusicherung an der Stelle festhaelt, an der sie gilt, statt in der
  // Wahl der Datenstruktur zu verschwinden - und weil CodeQL den Unterschied
  // zwischen Map und Objekt nicht sieht und den Aufruf sonst als
  // `js/unvalidated-dynamic-method-call` meldet.
  if (typeof check !== 'function') return true;
  if (!buffer || !buffer.length) return false;
  return check(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
}

/** Kennt dieses Modul eine Signatur fuer den Typ? Fuer Tests und Diagnose. */
export function hasSignature(mime) {
  return SIGNATURES.has(String(mime || '').toLowerCase());
}

// Zum Pruefen reicht der Anfang der Datei. 2048 Base64-Zeichen sind 1536 Bytes -
// mehr als die 1024, die der laengste Test (PDF) durchsucht, und unabhaengig
// davon, ob die Datei 4 KB oder 5 MB gross ist.
const HEAD_B64_CHARS = 2048;

/**
 * Passt der Inhalt einer Base64-data-URL zu ihrem eigenen MIME-Praefix?
 *
 * Fuer die Bild-Uploads (Geburtstagsfoto, Haushaltshilfe, Schnellzugriff-Icon,
 * Abo-Logo), die die data-URL als String behalten und sie nie ganz dekodieren.
 * Dekodiert nur den Kopf, nicht die ganze Datei.
 *
 * @param {unknown} dataUrl
 * @returns {boolean} false nur, wenn eine bekannte Signatur widerlegt wurde
 */
export function dataUrlContentMatches(dataUrl) {
  // `;base64,` case-insensitiv: ein data-URL-Leser dekodiert `;BASE64,` genauso,
  // also darf die Pruefung dort nicht aussteigen und den Wert unbesehen passieren
  // lassen.
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(String(dataUrl || ''));
  if (!match) return false;
  const mime = match[1].toLowerCase();
  if (!hasSignature(mime)) return true;
  // Base64 dekodiert in 4er-Gruppen; ein angeschnittener Rest ergaebe Fuellbytes.
  const b64 = match[2].replace(/\s/g, '').slice(0, HEAD_B64_CHARS);
  const head = Buffer.from(b64.slice(0, b64.length - (b64.length % 4)), 'base64');
  return contentMatchesMime(head, mime);
}
