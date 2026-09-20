/**
 * Obergrenze für Datei-Uploads, wie der Server sie meldet.
 *
 * Die Grenze stand als `5 * 1024 * 1024` in vier Seiten nebeneinander und
 * zusätzlich als Text „5 MB" in vier Übersetzungsschlüsseln (#806). Sobald der
 * Server sie über `MAX_UPLOAD_MB` anhebt, log alles davon falsch: die Prüfung
 * wies eine Datei ab, die der Server angenommen hätte, und der Hinweis nannte
 * eine Zahl, die nirgends mehr galt.
 *
 * Hier steht sie einmal, gefüllt beim Start aus `/version`. Der Vorgabewert ist
 * der Server-Default: er greift nur, bis die Antwort da ist, und liegt damit
 * nie über dem, was der Server wirklich annimmt.
 */
const DEFAULT_BYTES = 5 * 1024 * 1024;

let maxBytes = DEFAULT_BYTES;

/** Übernimmt den Wert aus /version. Unsinnige Werte lassen die Vorgabe stehen. */
export function setMaxUploadBytes(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) maxBytes = n;
}

export function maxUploadBytes() {
  return maxBytes;
}

/**
 * Ganze Megabyte für die Anzeige. Die Texte sagen „bis zu N MB", und eine
 * Nachkommastelle wäre dort Lärm - der Server rundet ohnehin auf ganze MB.
 */
export function maxUploadMb() {
  return Math.round(maxBytes / (1024 * 1024));
}

export const __test = { DEFAULT_BYTES };
