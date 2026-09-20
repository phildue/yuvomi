// --------------------------------------------------------
// TOTP (RFC 6238) und Wiederherstellungscodes fuer die Zwei-Faktor-Anmeldung.
//
// Bewusst ohne Dependency: der Kern ist ein HMAC ueber einen Zaehler, und den
// kann `node:crypto`. Eine Bibliothek dafuer waere mehr Angriffsflaeche als
// Ersparnis - dieser Datei stehen dafuer Testvektoren aus dem RFC gegenueber.
//
// Die Parameter sind die, die jede Authenticator-App ohne Nachfrage annimmt:
// SHA-1, sechs Stellen, 30 Sekunden. Abweichungen davon kann man in der
// otpauth-URI zwar notieren, aber Google Authenticator ignoriert sie stillschweigend
// - eine "staerkere" Wahl wuerde also nur bei manchen Apps passen.
// --------------------------------------------------------

import crypto from 'node:crypto';

export const TOTP_DIGITS  = 6;
export const TOTP_PERIOD  = 30;
export const TOTP_ALGO    = 'sha1';

// Ein Schritt Toleranz in jede Richtung. Deckt eine Uhr, die um bis zu 30
// Sekunden abweicht, und den Nutzer, der den Code beim Ablaufen abtippt.
export const TOTP_WINDOW  = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Wiederherstellungscodes ohne je einen Partner der Paare, die handschriftlich
// zusammenfallen (0/O, 1/I/L, 5/S, 8/B). Wer abschreibt, soll wieder eintippen koennen.
const RECOVERY_ALPHABET = '23456789ACDEFGHJKMNPQRTUVWXYZ';
const RECOVERY_GROUP    = 5;
const RECOVERY_GROUPS   = 2;
export const RECOVERY_CODE_COUNT = 10;

/**
 * Base32 nach RFC 4648, ohne Padding - so erwarten es die otpauth-URIs.
 * @param {Buffer} buffer
 * @returns {string}
 */
export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Gegenstueck zu base32Encode. Padding und Kleinschreibung werden geschluckt,
 * weil Nutzer das Geheimnis auch von Hand eintragen koennen.
 * @param {string} input
 * @returns {Buffer}
 */
export function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('Invalid base32 character.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Neues TOTP-Geheimnis. 20 Byte ist die Laenge, die RFC 4226 fuer SHA-1
 * empfiehlt, und zugleich die, die Authenticator-Apps erwarten.
 * @returns {string} Base32
 */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * HOTP nach RFC 4226: HMAC ueber den 8-Byte-Zaehler, dynamische Trunkierung,
 * die letzten `digits` Dezimalstellen.
 * @param {Buffer} key
 * @param {number} counter
 * @param {number} [digits]
 * @returns {string} linksseitig mit Nullen aufgefuellt
 */
export function hotp(key, counter, digits = TOTP_DIGITS) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(TOTP_ALGO, key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
               | ((digest[offset + 1] & 0xff) << 16)
               | ((digest[offset + 2] & 0xff) << 8)
               | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Zeitschritt zu einem Zeitpunkt.
 * @param {number} [nowMs]
 * @returns {number}
 */
export function timeStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD);
}

/**
 * Der Code, den eine App zu diesem Zeitpunkt anzeigt.
 * @param {string} secret Base32
 * @param {number} [nowMs]
 * @returns {string}
 */
export function generateCode(secret, nowMs = Date.now()) {
  return hotp(base32Decode(secret), timeStep(nowMs));
}

/**
 * Prueft einen eingegebenen Code gegen das Geheimnis.
 *
 * Der zurueckgegebene Zeitschritt ist nicht Zierde: der Aufrufer muss ihn
 * speichern und beim naechsten Mal als `afterStep` mitgeben. Ohne das bleibt
 * ein abgefangener Code seine vollen 90 Sekunden lang gueltig und laesst sich
 * ein zweites Mal einloesen - RFC 6238 Abschnitt 5.2 verlangt genau diese Sperre.
 *
 * @param {string} secret Base32
 * @param {string} token Eingabe des Nutzers
 * @param {{ nowMs?: number, window?: number, afterStep?: number|null }} [opts]
 * @returns {{ valid: boolean, step: number|null }}
 */
export function verifyCode(secret, token, { nowMs = Date.now(), window = TOTP_WINDOW, afterStep = null } = {}) {
  const clean = String(token || '').replace(/[\s-]/g, '');
  if (!/^\d+$/.test(clean) || clean.length !== TOTP_DIGITS) return { valid: false, step: null };

  let key;
  try {
    key = base32Decode(secret);
  } catch {
    return { valid: false, step: null };
  }
  if (key.length === 0) return { valid: false, step: null };

  const current = timeStep(nowMs);
  const expected = Buffer.from(clean, 'utf8');

  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (step < 0) continue;
    if (afterStep !== null && afterStep !== undefined && step <= afterStep) continue;
    const candidate = Buffer.from(hotp(key, step), 'utf8');
    // Gleiche Laenge per Konstruktion (beides `TOTP_DIGITS`), deshalb ist
    // timingSafeEqual hier ohne Vorpruefung sicher.
    if (crypto.timingSafeEqual(candidate, expected)) return { valid: true, step };
  }
  return { valid: false, step: null };
}

/**
 * otpauth-URI fuer den QR-Code. Der Kontoname traegt den Haushalt als
 * Aussteller, damit in der App nicht drei Eintraege namens "anna" stehen.
 * @param {{ secret: string, account: string, issuer?: string }} params
 * @returns {string}
 */
export function otpauthUri({ secret, account, issuer = 'Yuvomi' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: TOTP_ALGO.toUpperCase(),
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/**
 * Ein Satz Wiederherstellungscodes im Klartext. Sie werden genau einmal
 * gezeigt; gespeichert wird nur der Hash.
 * @param {number} [count]
 * @returns {string[]} Form `ABCDE-FGHJK`
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const groups = [];
    for (let g = 0; g < RECOVERY_GROUPS; g += 1) {
      let group = '';
      // rejection sampling: `% alphabet.length` auf ein rohes Byte bevorzugt
      // die vorderen Zeichen des Alphabets und kostet Entropie.
      while (group.length < RECOVERY_GROUP) {
        for (const byte of crypto.randomBytes(RECOVERY_GROUP)) {
          if (byte >= 256 - (256 % RECOVERY_ALPHABET.length)) continue;
          group += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
          if (group.length === RECOVERY_GROUP) break;
        }
      }
      groups.push(group);
    }
    codes.push(groups.join('-'));
  }
  return codes;
}

/**
 * Bringt eine Nutzereingabe auf die Form, in der ein Code gehasht wurde.
 * Bindestriche und Leerzeichen fallen weg, Kleinschreibung wird gehoben.
 * @param {string} code
 * @returns {string}
 */
export function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Hash eines Wiederherstellungscodes.
 *
 * Bewusst SHA-256 und nicht bcrypt: der Code ist kein Passwort, sondern ein
 * Zufallswert mit rund 49 Bit aus dem Generator oben. Key-Stretching schuetzt
 * schwache Geheimnisse vor dem Durchprobieren - hier gibt es nichts zu
 * schwaechen, waehrend zehn bcrypt-Laeufe pro Anmeldeversuch die Anmeldung
 * selbst zum Angriffsziel machten.
 *
 * @param {string} code
 * @returns {string} hex
 */
export function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(code), 'utf8').digest('hex');
}
