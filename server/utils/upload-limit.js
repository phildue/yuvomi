/**
 * Modul: Obergrenze für Datei-Uploads
 *
 * Die Grenze lag als `5 * 1024 * 1024` an sieben Stellen: drei im Server
 * (Dokument-Route, WebDAV-Speicher, Google-Drive-Speicher), vier im Browser
 * (Dokumente, Dokument-Anhang, Kalender-Anhang, Haushaltshilfe) - und ein
 * achtes Mal als Text „5 MB" in vier Übersetzungsschlüsseln je Sprache. Wer sie
 * ändern wollte, musste alle finden; wer eine übersah, bekam eine Oberfläche,
 * die etwas anderes verspricht als der Server annimmt (#806).
 *
 * Hier steht sie einmal. `MAX_UPLOAD_MB` hebt sie an - das ist der einzige
 * Regler, und er gilt für alle Uploads gleichermaßen.
 *
 * WARUM EINE OBERGRENZE ÜBERHAUPT: `express.json` puffert den kompletten Body
 * im Arbeitsspeicher, bevor eine Route ihn sieht. Die Grenze schützt also nicht
 * die Festplatte, sondern den Prozess - auf einem kleinen Einplatinenrechner
 * beendet ein 500-MB-Upload die Instanz. Deshalb ist der Wert gedeckelt, statt
 * beliebig zu sein.
 */
import { createLogger } from '../logger.js';

const log = createLogger('Upload');

const DEFAULT_MB = 5;
const MIN_MB     = 1;
/**
 * Deckel mit Ansage: darüber hinaus ist nicht die Datei das Problem, sondern
 * der Speicher, den ihr base64-Body im Prozess belegt (siehe unten).
 */
const MAX_MB = 100;

function readLimitMb() {
  const raw = (process.env.MAX_UPLOAD_MB || '').trim();
  if (!raw) return DEFAULT_MB;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    log.warn(`MAX_UPLOAD_MB is "${raw}", which is not a positive number - falling back to ${DEFAULT_MB} MB.`);
    return DEFAULT_MB;
  }
  const clamped = Math.min(Math.max(Math.floor(value), MIN_MB), MAX_MB);
  if (clamped !== Math.floor(value)) {
    log.warn(`MAX_UPLOAD_MB is ${value}, outside the supported range ${MIN_MB}-${MAX_MB} - using ${clamped} MB.`);
  }
  return clamped;
}

export const MAX_UPLOAD_MB    = readLimitMb();
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/**
 * Body-Grenze für express.json/urlencoded.
 *
 * Dateien reisen als base64 im JSON-Body, und base64 wächst um ein Drittel;
 * dazu kommen die übrigen Felder des Formulars. Der Faktor 1,4 hält denselben
 * Abstand, den die früher fest verdrahteten Werte hatten (5 MB Datei bei
 * 7 MB Body) - er ist also keine neue Annahme, sondern die alte, jetzt
 * mitwachsend.
 */
export const BODY_LIMIT = `${Math.ceil(MAX_UPLOAD_MB * 1.4)}mb`;

export const __test = { readLimitMb, DEFAULT_MB, MIN_MB, MAX_MB };
