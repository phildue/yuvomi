/**
 * Modul: Zwei-Faktor-Anmeldung, Rechenkern (#672)
 * Zweck: TOTP und die Wiederherstellungscodes sind ohne Abhaengigkeit gebaut.
 *        Damit haengt ihre Richtigkeit an dieser Datei und nicht an einem
 *        Upstream - deshalb steht hier der volle Testvektorsatz aus RFC 4226
 *        und RFC 6238, nicht nur ein Rundlauf durch die eigene Implementierung.
 *
 *        Deckt ab:
 *          - HOTP gegen alle zehn Vektoren aus RFC 4226 Anhang D
 *          - TOTP gegen die Vektoren aus RFC 6238 Anhang B (SHA-1-Zeilen)
 *          - Base32 hin und zurueck, samt Padding und Kleinschreibung
 *          - das Zeitfenster nimmt den vorherigen und den naechsten Schritt an,
 *            aber keinen weiter entfernten
 *          - REPLAY-SPERRE: ein bereits eingeloester Schritt wird abgelehnt.
 *            Ohne sie bliebe ein abgefangener Code seine vollen 90 Sekunden
 *            gueltig, und genau davor warnt RFC 6238 Abschnitt 5.2
 *          - Muell (leer, Buchstaben, falsche Laenge) faellt ab, ohne zu werfen
 *          - Wiederherstellungscodes: Form, Alphabet ohne verwechselbare
 *            Zeichen, Eindeutigkeit, und dass die Normalisierung die
 *            Schreibweise des Nutzers ueberlebt
 * Ausfuehren: node --test test/test-totp.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Encode, base32Decode, hotp, generateCode, verifyCode, generateSecret,
  otpauthUri, generateRecoveryCodes, normalizeRecoveryCode, hashRecoveryCode,
  timeStep, TOTP_PERIOD, RECOVERY_CODE_COUNT,
} from '../server/utils/totp.js';

// RFC 4226 Anhang D: Secret ist der ASCII-String '12345678901234567890'.
const RFC4226_KEY = Buffer.from('12345678901234567890', 'utf8');
const RFC4226_CODES = [
  '755224', '287082', '359152', '969429', '338314',
  '254676', '287922', '162583', '399871', '520489',
];

test('HOTP trifft alle Vektoren aus RFC 4226', () => {
  RFC4226_CODES.forEach((expected, counter) => {
    assert.equal(hotp(RFC4226_KEY, counter), expected, `Zaehler ${counter}`);
  });
});

test('TOTP trifft die SHA-1-Vektoren aus RFC 6238', () => {
  const secret = base32Encode(RFC4226_KEY);
  // [Unixzeit in Sekunden, erwarteter achtstelliger Code aus dem RFC].
  // Der RFC zeigt acht Stellen; Yuvomi nutzt sechs, also die letzten sechs.
  const vectors = [
    [59,          '94287082'],
    [1111111109,  '07081804'],
    [1111111111,  '14050471'],
    [1234567890,  '89005924'],
    [2000000000,  '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [seconds, eightDigits] of vectors) {
    const expected = eightDigits.slice(-6);
    assert.equal(generateCode(secret, seconds * 1000), expected, `t=${seconds}`);
  }
});

test('Base32 laeuft hin und zurueck, auch mit Padding und klein geschrieben', () => {
  for (const sample of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', '12345678901234567890']) {
    const encoded = base32Encode(Buffer.from(sample, 'utf8'));
    assert.equal(base32Decode(encoded).toString('utf8'), sample, sample);
    assert.equal(base32Decode(`${encoded}======`).toString('utf8'), sample, 'Padding');
    assert.equal(base32Decode(encoded.toLowerCase()).toString('utf8'), sample, 'klein');
  }
  assert.throws(() => base32Decode('!!!'), /Invalid base32/);
});

test('generateSecret liefert 160 Bit, verschieden je Aufruf', () => {
  const a = generateSecret();
  const b = generateSecret();
  assert.equal(a.length, 32);            // 20 Byte -> 32 Base32-Zeichen
  assert.equal(base32Decode(a).length, 20);
  assert.notEqual(a, b);
});

test('das Zeitfenster reicht genau einen Schritt in jede Richtung', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  const step = TOTP_PERIOD * 1000;

  assert.equal(verifyCode(secret, generateCode(secret, now), { nowMs: now }).valid, true, 'jetzt');
  assert.equal(verifyCode(secret, generateCode(secret, now - step), { nowMs: now }).valid, true, 'ein Schritt zurueck');
  assert.equal(verifyCode(secret, generateCode(secret, now + step), { nowMs: now }).valid, true, 'ein Schritt vor');
  assert.equal(verifyCode(secret, generateCode(secret, now - 2 * step), { nowMs: now }).valid, false, 'zwei zurueck');
  assert.equal(verifyCode(secret, generateCode(secret, now + 2 * step), { nowMs: now }).valid, false, 'zwei vor');
});

test('ein eingeloester Schritt wird kein zweites Mal angenommen', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  const code = generateCode(secret, now);

  const first = verifyCode(secret, code, { nowMs: now });
  assert.equal(first.valid, true);
  assert.equal(first.step, timeStep(now));

  // Derselbe Code, mit dem gemerkten Schritt: abgelehnt.
  assert.equal(verifyCode(secret, code, { nowMs: now, afterStep: first.step }).valid, false);

  // Der naechste Schritt bleibt moeglich - die Sperre gilt nur rueckwaerts.
  const later = now + TOTP_PERIOD * 1000;
  assert.equal(verifyCode(secret, generateCode(secret, later), { nowMs: later, afterStep: first.step }).valid, true);
});

test('unbrauchbare Eingaben werden abgelehnt, ohne zu werfen', () => {
  const secret = generateSecret();
  for (const bad of [undefined, null, '', '12345', '1234567', 'abcdef', '12 34 56', {}, []]) {
    assert.equal(verifyCode(secret, bad).valid, false, JSON.stringify(bad));
  }
  // Leerzeichen und Bindestriche innerhalb eines sonst gueltigen Codes sind ok:
  // Authenticator-Apps zeigen '123 456'.
  const now = 1_700_000_000_000;
  const code = generateCode(secret, now);
  assert.equal(verifyCode(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { nowMs: now }).valid, true);

  // Ein kaputtes Geheimnis darf keinen Fehler nach oben durchreichen.
  assert.equal(verifyCode('nicht base32 !!!', code).valid, false);
  assert.equal(verifyCode('', code).valid, false);
});

test('die otpauth-URI traegt Aussteller, Konto und die Parameter', () => {
  const uri = otpauthUri({ secret: 'ABCDEFGH', account: 'anna müller' });
  assert.match(uri, /^otpauth:\/\/totp\/Yuvomi:/);
  const url = new URL(uri);
  assert.equal(url.searchParams.get('secret'), 'ABCDEFGH');
  assert.equal(url.searchParams.get('issuer'), 'Yuvomi');
  assert.equal(url.searchParams.get('algorithm'), 'SHA1');
  assert.equal(url.searchParams.get('digits'), '6');
  assert.equal(url.searchParams.get('period'), '30');
  // Der Kontoname ist kodiert, sonst zerlegt das Leerzeichen die URI.
  assert.ok(!uri.includes('anna müller'));
  assert.ok(decodeURIComponent(uri).includes('anna müller'));
});

test('Wiederherstellungscodes: Form, Alphabet, Eindeutigkeit', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, RECOVERY_CODE_COUNT);
  assert.equal(new Set(codes).size, codes.length, 'keine Dublette');
  for (const code of codes) {
    assert.match(code, /^[2-9A-Z]{5}-[2-9A-Z]{5}$/, code);
    // Kein Zeichen, das handschriftlich mit einem anderen zusammenfaellt.
    assert.ok(!/[01ILOSB]/.test(code), `verwechselbares Zeichen in ${code}`);
  }
});

test('die Normalisierung ueberlebt die Schreibweise des Nutzers', () => {
  const [code] = generateRecoveryCodes(1);
  const hash = hashRecoveryCode(code);
  for (const typed of [code, code.toLowerCase(), code.replace('-', ''), ` ${code} `, code.replace('-', ' ')]) {
    assert.equal(hashRecoveryCode(typed), hash, typed);
  }
  assert.equal(normalizeRecoveryCode(code).length, 10);
  // Ein anderer Code ergibt einen anderen Hash.
  const [other] = generateRecoveryCodes(1);
  assert.notEqual(hashRecoveryCode(other), hash);
});
