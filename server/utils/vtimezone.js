/**
 * Modul: VTIMEZONE-Erzeugung
 * Zweck: Baut aus einer IANA-Zone den VTIMEZONE-Block, den RFC 5545 verlangt,
 *        sobald ein DTSTART/DTEND einen TZID-Parameter traegt - samt der
 *        DST-Uebergaenge als RRULE, damit ein Empfaenger offene Serien selbst
 *        weiterrechnen kann.
 *
 * WARUM ALS EIGENES MODUL. Der Generator entstand fuer den ICS-Feed (#549/#818)
 * und lag dort als privater Abschnitt. Der ausgehende CalDAV-Pfad brauchte
 * dieselbe Rechnung (#938) - und eine zweite Kopie waere die teuerste Art, sie
 * zu haben: DST-Uebergaenge sind der Teil, den man einmal richtig macht und
 * danach nie wieder anfasst.
 *
 * Der Rest von ics-export.js bleibt, wo er ist; hier steht nur, was beide
 * Aufrufer teilen.
 *
 * Abhaengigkeiten: server/utils/timezone.js
 */

import { utcToWall } from './timezone.js';

function pad(n) { return String(n).padStart(2, '0'); }

// Synchronisierte Serien speichern start_datetime als UTC-Instant + tzid. Würde
// der Feed sie UTC-verankert (mit RRULE, ohne TZID) exportieren, expandierte die
// App des Abonnenten jede Instanz mit fixer UTC-Zeit → dieselbe Sommer-/Winterzeit-
// Drift wie beim Import. Deshalb: DTSTART;TZID=<zone> mit lokaler Wanduhrzeit + ein
// generiertes VTIMEZONE, damit der Abonnent pro Vorkommen korrekt lokal → UTC rechnet.

// UTC-Instant (…Z) → ICS-Basic-Format der lokalen Wanduhrzeit ('YYYYMMDDTHHMMSS').
export function formatWall(iso, tzid) {
  const w = utcToWall(iso, tzid);
  if (!w) return null;
  return w.date.replace(/-/g, '') + 'T' + w.time.replace(/:/g, '');
}

// Offset (Minuten) einer Zone zum gegebenen UTC-Zeitpunkt.
function tzOffsetMinutes(utcMs, tzid) {
  const w = utcToWall(new Date(utcMs).toISOString(), tzid);
  if (!w) return 0;
  const [Y, Mo, D] = w.date.split('-').map(Number);
  const [H, Mi, S] = w.time.split(':').map(Number);
  return Math.round((Date.UTC(Y, Mo - 1, D, H, Mi, S) - utcMs) / 60000);
}

function fmtOffset(min) {
  const a = Math.abs(min);
  return (min < 0 ? '-' : '+') + pad(Math.floor(a / 60)) + pad(a % 60);
}

function tzNameAt(utcMs, tzid) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tzid, timeZoneName: 'short', hour12: false })
      .formatToParts(new Date(utcMs));
    const p = parts.find((x) => x.type === 'timeZoneName');
    // Reine Offset-Namen (z.B. 'GMT+2') sind als TZNAME wenig hilfreich → weglassen.
    return p && !/^GMT|^UTC/.test(p.value) ? p.value : null;
  } catch { return null; }
}

// Alle DST-Übergänge eines Jahres (minutengenau per Binärsuche über den Offset-Sprung).
function findTransitions(year, tzid) {
  const DAY = 86400000;
  const end = Date.UTC(year + 1, 0, 1);
  const out = [];
  let prevMs = Date.UTC(year, 0, 1);
  let prevOff = tzOffsetMinutes(prevMs, tzid);
  for (let t = prevMs + DAY; t <= end; t += DAY) {
    const off = tzOffsetMinutes(t, tzid);
    if (off !== prevOff) {
      let lo = prevMs, hi = t;
      while (hi - lo > 60000) {
        const mid = lo + Math.floor((hi - lo) / 120000) * 60000; // minutengenaue Mitte
        if (tzOffsetMinutes(mid, tzid) === prevOff) lo = mid; else hi = mid;
      }
      out.push({ instant: hi, offsetBefore: prevOff, offsetAfter: off });
    }
    prevMs = t; prevOff = off;
  }
  return out;
}

// n-ter Wochentag im Monat als BYDAY-Wert (letzter → -1SU), aus einem lokalen Datum.
function bydayOf(d) {
  const dow = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getUTCDay()];
  const dom = d.getUTCDate();
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const nth = dom + 7 > daysInMonth ? -1 : Math.ceil(dom / 7);
  return `${nth}${dow}`;
}

// VTIMEZONE-Block für eine IANA-Zone, RRULE-basiert (extrapoliert für offene Serien).
//
// BEKANNTE GRENZE. Die Regeln eines Jahres werden per RRULE unbegrenzt
// fortgeschrieben. Für die meisten Zonen stimmt das - Europa und Nordamerika
// schalten nach festen Wochentagsregeln -, aber nicht für alle: Africa/Casablanca
// verschiebt seine Umstellungen mit dem Ramadan, also jährlich. Ein aus 2026
// gebauter Block (Februar 3SU, März 4SU) liegt dort 2027 (1SU, 2SU) für ein paar
// Wochen eine Stunde daneben.
//
// Das bleibt vorerst so, und zwar bewusst: der Block ist seit #549 in Gebrauch,
// die Alternative sind aufgezählte RDATEs über N Jahre - eine andere Bauart, kein
// Zusatz -, und der Fehler betrifft eine Handvoll Zonen für wenige Wochen im
// Jahr. Gegenüber dem Zustand davor ist es trotzdem ein Gewinn: der ausgehende
// CalDAV-Weg trug vorher GAR KEINE Zone (#938), und ein Termin ohne Zone ist in
// jeder Woche des Jahres unbestimmt, nicht nur in dreien.
function buildVTimezone(tzid, year) {
  const transitions = findTransitions(year, tzid);
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tzid}`];
  if (transitions.length === 0) {
    // Keine Sommerzeit: einzelne STANDARD-Komponente mit festem Offset.
    const off = tzOffsetMinutes(Date.UTC(year, 0, 1), tzid);
    const name = tzNameAt(Date.UTC(year, 0, 1), tzid);
    lines.push('BEGIN:STANDARD', `TZOFFSETFROM:${fmtOffset(off)}`, `TZOFFSETTO:${fmtOffset(off)}`);
    if (name) lines.push(`TZNAME:${name}`);
    lines.push('DTSTART:19700101T000000', 'END:STANDARD');
  } else {
    for (const tr of transitions) {
      const isDst = tr.offsetAfter > tr.offsetBefore; // Sprung nach vorne → Sommerzeit beginnt
      // DTSTART der Sub-Komponente ist die lokale Wanduhrzeit im FROM-Offset.
      const onset = new Date(tr.instant + tr.offsetBefore * 60000);
      const name = tzNameAt(tr.instant, tzid);
      lines.push(
        isDst ? 'BEGIN:DAYLIGHT' : 'BEGIN:STANDARD',
        `TZOFFSETFROM:${fmtOffset(tr.offsetBefore)}`,
        `TZOFFSETTO:${fmtOffset(tr.offsetAfter)}`,
      );
      if (name) lines.push(`TZNAME:${name}`);
      lines.push(
        `DTSTART:${onset.getUTCFullYear()}${pad(onset.getUTCMonth() + 1)}${pad(onset.getUTCDate())}` +
          `T${pad(onset.getUTCHours())}${pad(onset.getUTCMinutes())}${pad(onset.getUTCSeconds())}`,
        `RRULE:FREQ=YEARLY;BYMONTH=${onset.getUTCMonth() + 1};BYDAY=${bydayOf(onset)}`,
        isDst ? 'END:DAYLIGHT' : 'END:STANDARD',
      );
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

// buildVTimezone ist teuer (365 Offset-Sonden je Jahr plus Binärsuche) und liefert
// für dieselbe Zone im selben Jahr immer dasselbe. Abonnenten pollen den Feed im
// Minutentakt - deshalb einmal rechnen und behalten.
const vtimezoneCache = new Map();
export function vtimezoneFor(tzid, year) {
  const key = `${tzid}|${year}`;
  let lines = vtimezoneCache.get(key);
  if (!lines) { lines = buildVTimezone(tzid, year); vtimezoneCache.set(key, lines); }
  return lines;
}
