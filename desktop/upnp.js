/**
 * Optional UPnP port mapping.
 *
 * The problem it addresses is real and specific: the server runs in one country and the people
 * joining are in another, so the port has to be reachable from outside the router. Doing that by
 * hand means finding the router's admin page, finding the port-forwarding section, and getting a
 * LAN IP right -- for someone who just wants to watch a screen.
 *
 * **This is an attempt, never a promise, and the difference has to survive into the UI.** Plenty
 * of routers ship with UPnP off, ISPs increasingly put customers behind CGNAT where no amount of
 * forwarding helps, and some routers claim success and do nothing. So every function here reports
 * what actually happened rather than resolving quietly, and a failure carries a message the user
 * can act on instead of a boolean.
 *
 * Off by default. Something that reconfigures the household router should be a decision, not a
 * side effect of opening an app.
 */

import natUpnp from 'nat-upnp';

const DESCRIPTION = 'Streamer screen sharing';
/** Renewed while the app runs; a short TTL means an unclean exit expires instead of lingering. */
const TTL_SECONDS = 3600;
const RENEW_MS = (TTL_SECONDS / 2) * 1000;

let client = null;
let mapping = null;
let renewTimer = null;

const promisify =
  (method) =>
  (...args) =>
    new Promise((resolve, reject) => {
      client[method](...args, (error, result) => (error ? reject(error) : resolve(result)));
    });

/**
 * Try to open `port` on the router.
 * @returns {Promise<{ok: true, port: number, externalIp: string|null} | {ok: false, reason: string}>}
 */
export async function open(port) {
  try {
    client ??= natUpnp.createClient();

    await promisify('portMapping')({
      public: port,
      private: port,
      protocol: 'tcp',
      ttl: TTL_SECONDS,
      description: DESCRIPTION,
    });

    mapping = port;
    scheduleRenewal(port);

    return { ok: true, port, externalIp: await externalIp() };
  } catch (error) {
    return { ok: false, reason: explain(error) };
  }
}

/**
 * Remove the mapping. Called on quit.
 *
 * Leaving a port open on someone's router after the app has closed is the kind of side effect
 * that is invisible until it matters, so this runs even on an abrupt shutdown path and never
 * throws -- a failure to clean up must not become a failure to exit.
 */
export async function close() {
  clearTimeout(renewTimer);
  renewTimer = null;

  const port = mapping;
  mapping = null;
  if (port === null || !client) return { ok: true };

  try {
    await promisify('portUnmapping')({ public: port, protocol: 'tcp' });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: explain(error) };
  }
}

export const isOpen = () => mapping !== null;

/** The router's WAN address, or null if it will not say. Never throws. */
export async function externalIp() {
  try {
    client ??= natUpnp.createClient();
    const ip = await promisify('externalIp')();
    // A router behind CGNAT often reports a private WAN address, which is the clearest possible
    // signal that forwarding cannot work -- worth surfacing rather than showing as a success.
    return typeof ip === 'string' ? ip : null;
  } catch {
    return null;
  }
}

/** True when the address the router calls "external" is itself private -- i.e. CGNAT. */
export function isCarrierGrade(ip) {
  if (!ip) return false;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // RFC 6598, the shared address space CGNAT uses
  );
}

function scheduleRenewal(port) {
  clearTimeout(renewTimer);
  renewTimer = setTimeout(() => {
    // Best effort. If a renewal fails the mapping simply lapses at its TTL, which is the same
    // outcome as never having had one -- not worth interrupting a call in progress to report.
    void open(port);
  }, RENEW_MS);
  renewTimer.unref?.();
}

function explain(error) {
  const message = error?.message ?? String(error);
  if (/timeout|ETIMEDOUT|ENETUNREACH/i.test(message)) {
    return 'No router answered. UPnP is probably turned off, or this network does not allow it.';
  }
  if (/718|ConflictInMappingEntry/i.test(message)) {
    return 'The router already has a different mapping for this port.';
  }
  if (/606|Action not authorized/i.test(message)) {
    return 'The router refused the request. UPnP is likely disabled in its settings.';
  }
  return message;
}
