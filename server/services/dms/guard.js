/**
 * Module: DMS Target Guard
 * Purpose: Validate a DMS account's base_url before any request leaves the
 *          server. The URL is operator-supplied and reaches the network from
 *          inside the container, so it is the same class of target that
 *          ICS subscriptions, recipe providers and WebDAV document storage
 *          already guard (server/utils/ssrf.js).
 *
 *          DMS_ALLOW_PRIVATE_NETWORK INVERTS the house default, and that is
 *          deliberate. The other four opt-INs default to "private targets
 *          blocked" because their typical target is on the public internet.
 *          A DMS is the opposite case: Paperless-ngx and Papra are self-hosted
 *          by definition, and in practice they sit on the same LAN or the same
 *          Docker network as Yuvomi. Shipping this as an opt-in would have
 *          broken essentially every existing installation on update, so the
 *          flag defaults to ALLOWED and an operator who wants the guard sets
 *          it to `false`.
 *
 *          Scope: this is a pre-flight check of the configured base_url, not
 *          the per-connection anti-rebinding lookup that http.js provides.
 *          The adapters speak to APIs that need FormData uploads and
 *          res.json(), which global fetch() gives us and safeRequest() does
 *          not; fetch() in turn has no way to validate DNS per connection.
 *          A target that resolves public on this check and private on the
 *          actual connect is therefore still reachable. That residual gap is
 *          accepted here because the guard is off by default anyway - what
 *          this closes is the far larger hole of an arbitrary URL never being
 *          looked at at all.
 *
 * Dependencies: node:dns/promises, server/utils/ssrf.js
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isBlockedAddress, isBlockedHostname, normalizeHostname } from '../../utils/ssrf.js';

const ENV_ALLOW_PRIVATE_NETWORK = 'DMS_ALLOW_PRIVATE_NETWORK';

// Injizierbar für Tests - dieselbe Bauart wie hostnameLookup in
// services/document-storage.js, damit kein Test echtes DNS braucht.
let hostnameLookup = dnsLookup;
export function _setHostnameLookup(fn) { hostnameLookup = fn || dnsLookup; }

/**
 * Ist der Zugriff auf private/lokale Netze erlaubt?
 *
 * Umgekehrt zu readPrivateNetworkOptIn() aus utils/ssrf.js: NICHT gesetzt heißt
 * hier erlaubt. Nur ein ausdrückliches `false`/`0` (nach trim, case-insensitiv)
 * schaltet den Schutz ein. Ein Tippfehler lässt den Zustand damit auf dem
 * Default statt still eine laufende Anbindung zu kappen - der Default ist
 * ohnehin offen, ein verschriebener Wert ändert also nichts gegenüber dem
 * Zustand ohne Variable.
 *
 * Zur Laufzeit gelesen, damit Tests process.env vor dem Aufruf setzen können.
 */
export function isPrivateNetworkAllowed() {
  const raw = process.env[ENV_ALLOW_PRIVATE_NETWORK];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return !(normalized === 'false' || normalized === '0');
}

export class DmsTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DmsTargetError';
    this.status = 400;
  }
}

/**
 * Prüft die base_url eines DMS-Kontos, bevor ein Request rausgeht.
 *
 * Reihenfolge ist Absicht: erst die Namensprüfung (localhost, .local, .internal
 * - die braucht kein DNS und fängt den häufigsten Fall sofort), dann die
 * Auflösung mit `all: true` und die Prüfung JEDER zurückgegebenen Adresse. Eine
 * einzelne öffentliche Adresse neben einer privaten darf nicht durchrutschen.
 *
 * @param {string} baseUrl  Die konfigurierte base_url des Kontos.
 * @throws {DmsTargetError} Wenn die URL unbrauchbar oder das Ziel gesperrt ist.
 */
export async function assertDmsTargetAllowed(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl || ''));
  } catch {
    throw new DmsTargetError('The DMS base URL is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DmsTargetError('The DMS base URL must use http or https.');
  }

  if (isPrivateNetworkAllowed()) return;

  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new DmsTargetError(
      `The DMS base URL points at a local host: ${hostname}. `
      + `Set ${ENV_ALLOW_PRIVATE_NETWORK}=true if that is intended.`,
    );
  }

  let addresses;
  try {
    addresses = await hostnameLookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new DmsTargetError(`The DMS hostname could not be resolved: ${hostname}`, { cause: error });
  }
  const results = Array.isArray(addresses) ? addresses : [addresses];
  if (results.length === 0) {
    throw new DmsTargetError(`The DMS hostname did not resolve to an address: ${hostname}`);
  }
  for (const entry of results) {
    if (isBlockedAddress(entry.address)) {
      throw new DmsTargetError(
        `The DMS base URL resolves to a private address: ${entry.address}. `
        + `Set ${ENV_ALLOW_PRIVATE_NETWORK}=true if that is intended.`,
      );
    }
  }
}

export { ENV_ALLOW_PRIVATE_NETWORK };
