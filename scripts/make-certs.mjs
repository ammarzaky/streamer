#!/usr/bin/env node
/**
 * Certificate generation for local HTTPS.
 *
 * The browser will not expose getDisplayMedia() or getUserMedia() outside a secure context,
 * so serving this app over plain HTTP is not an option. Since there is no public DNS name to
 * get a real certificate for, we create a small local CA and issue a leaf certificate from it.
 *
 * Why a local CA instead of a bare self-signed certificate: a self-signed leaf must be trusted
 * on every device individually, and mobile browsers make that deliberately awkward. With a CA,
 * you install ONE file (certs/ca.crt) per device and every future leaf is trusted automatically
 * -- including after the LAN IP changes and the leaf is reissued. The desktop app skips this
 * entirely by pinning the leaf's fingerprint, but browser participants still rely on it.
 *
 * **Why this generates certificates in-process rather than shelling out to OpenSSL.** It used
 * to run `openssl`, found on PATH or inside a Git for Windows install. That is fine on a
 * developer machine and a hard blocker anywhere else: once any participant can host a room from
 * a packaged app, "hosting requires Git to be installed" is not a constraint we can ship. There
 * is no OpenSSL fallback on purpose -- two code paths for something this security-relevant means
 * the one you do not use daily is the one that is broken when you need it.
 *
 *   node scripts/make-certs.mjs            generate if missing or stale
 *   node scripts/make-certs.mjs --force    regenerate unconditionally
 *   node scripts/make-certs.mjs --check    verify only; exit 1 if regeneration is needed
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate, generateKeyPairSync, randomBytes } from 'node:crypto';
import forge from 'node-forge';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CA_DAYS = 3650; // 10 years -- you install this once and forget it.
const LEAF_DAYS = 825; // Browsers reject server certificates valid for longer than ~825 days.
const RENEW_WITHIN_DAYS = 30;
const KEY_BITS = 2048;

const EXTRA_DNS = ['localhost', 'streamer.local'];

// ---------------------------------------------------------------------------
// Where the certificates live
// ---------------------------------------------------------------------------

/**
 * Resolved on every call rather than once at import.
 *
 * A packaged Electron app runs from inside `resources/app.asar`, which is read-only, so it
 * points this at `app.getPath('userData')` instead. Reading the variable lazily means the main
 * process can set it before starting the server without having to control module import order
 * -- an ESM import is hoisted, so a constant captured at import time would already be wrong.
 */
export function certDir() {
  return process.env.STREAMER_CERT_DIR ? resolve(process.env.STREAMER_CERT_DIR) : join(ROOT, 'certs');
}

const paths = () => {
  const dir = certDir();
  return {
    dir,
    caKey: join(dir, 'ca.key'),
    caCrt: join(dir, 'ca.crt'),
    srvKey: join(dir, 'server.key'),
    srvCrt: join(dir, 'server.crt'),
  };
};

// ---------------------------------------------------------------------------
// Network addresses
// ---------------------------------------------------------------------------

/** Every non-internal IPv4 address on this machine, in a stable order. */
export function lanIPv4s() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return [...new Set(out)].sort();
}

function desiredSans() {
  const ips = ['127.0.0.1', '::1', ...lanIPv4s()];
  return { dns: EXTRA_DNS, ip: [...new Set(ips)] };
}

function sanString({ dns, ip }) {
  return [...dns.map((d) => `DNS:${d}`), ...ip.map((i) => `IP:${i}`)].join(',');
}

/**
 * Certificates store "::1" but Node reads it back as "IP Address:0:0:0:0:0:0:0:1".
 * Without expanding the compressed form, --check reports a missing SAN on every run and the
 * certificate is regenerated forever.
 */
function normalizeIp(ip) {
  if (!ip.includes(':')) return ip; // IPv4
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : ip.split(':');
  return groups.map((g) => parseInt(g || '0', 16).toString(16)).join(':');
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

/**
 * Why the existing certificate is unusable, or null if it is fine.
 * Used by both the generator (should I rebuild?) and --check (should this fail the build?).
 */
export function certProblem() {
  const p = paths();
  if (!existsSync(p.caCrt) || !existsSync(p.caKey)) return 'no local CA yet';
  if (!existsSync(p.srvCrt) || !existsSync(p.srvKey)) return 'no server certificate yet';

  let cert;
  try {
    cert = new X509Certificate(readFileSync(p.srvCrt));
  } catch (err) {
    return `server certificate is unreadable (${err.message})`;
  }

  const daysLeft = (new Date(cert.validTo).getTime() - Date.now()) / 86_400_000;
  if (daysLeft < 0) return 'server certificate has expired';
  if (daysLeft < RENEW_WITHIN_DAYS) {
    return `server certificate expires in ${Math.floor(daysLeft)} days`;
  }

  // The common failure in practice: the machine got a new LAN IP (new network, DHCP lease,
  // VPN up/down) and the certificate no longer covers the address people are typing.
  const entries = (cert.subjectAltName ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const dnsPresent = new Set();
  const ipPresent = new Set();
  for (const entry of entries) {
    const [label, ...rest] = entry.split(':');
    const value = rest.join(':');
    if (label === 'DNS') dnsPresent.add(value);
    else if (label === 'IP Address' || label === 'IP') ipPresent.add(normalizeIp(value));
  }

  const missing = [];
  const want = desiredSans();
  for (const d of want.dns) if (!dnsPresent.has(d)) missing.push(`DNS:${d}`);
  for (const i of want.ip) if (!ipPresent.has(normalizeIp(i))) missing.push(`IP:${i}`);
  if (missing.length) return `certificate does not cover ${missing.join(', ')}`;

  return null;
}

/** SHA-256 of the server certificate, in OpenSSL's colon-separated hex form. */
export function fingerprint(certPath = paths().srvCrt) {
  return new X509Certificate(readFileSync(certPath)).fingerprint256;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * An RSA keypair, generated by Node and handed to forge.
 *
 * forge can generate keys itself, but in pure JavaScript a 2048-bit RSA keygen takes seconds --
 * and we need two. Node's native implementation does it in milliseconds, and forge is perfectly
 * happy to import the result, so it only has to do the part it is actually needed for: building
 * and signing the certificate structure.
 *
 * RSA rather than the EC P-256 the OpenSSL version used, because forge cannot generate or sign
 * with EC keys. For a certificate that exists to satisfy the secure-context rule on a private
 * network, 2048-bit RSA is not the weak link.
 */
function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: KEY_BITS,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return {
    privatePem: privateKey,
    forgePrivate: forge.pki.privateKeyFromPem(privateKey),
    forgePublic: forge.pki.publicKeyFromPem(publicKey),
  };
}

/**
 * A positive serial number.
 *
 * X.509 serials are signed integers, so a value whose leading byte has the high bit set is read
 * as negative -- which some clients reject outright. The '00' prefix keeps it positive.
 */
const serial = () => `00${randomBytes(16).toString('hex')}`;

function validity(days) {
  const notBefore = new Date();
  // Backdated an hour so a client whose clock is slightly behind ours does not reject a
  // certificate that was, from its point of view, issued in the future.
  notBefore.setHours(notBefore.getHours() - 1);
  const notAfter = new Date(notBefore);
  notAfter.setDate(notAfter.getDate() + days);
  return { notBefore, notAfter };
}

function generateCA() {
  const keys = keypair();
  const cert = forge.pki.createCertificate();
  const { notBefore, notAfter } = validity(CA_DAYS);

  cert.publicKey = keys.forgePublic;
  cert.serialNumber = serial();
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  const attrs = [
    { name: 'commonName', value: 'Streamer Local CA' },
    { name: 'organizationName', value: 'Streamer' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed
  cert.setExtensions([
    { name: 'basicConstraints', critical: true, cA: true, pathLenConstraint: 0 },
    { name: 'keyUsage', critical: true, keyCertSign: true, cRLSign: true },
    { name: 'subjectKeyIdentifier' },
  ]);

  cert.sign(keys.forgePrivate, forge.md.sha256.create());
  return { keyPem: keys.privatePem, certPem: forge.pki.certificateToPem(cert) };
}

function generateLeaf(ca, sans) {
  const keys = keypair();
  const cert = forge.pki.createCertificate();
  const { notBefore, notAfter } = validity(LEAF_DAYS);

  cert.publicKey = keys.forgePublic;
  cert.serialNumber = serial();
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  cert.setSubject([
    { name: 'commonName', value: 'streamer.local' },
    { name: 'organizationName', value: 'Streamer' },
  ]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', critical: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      // forge's altName type numbers: 2 = dNSName, 7 = iPAddress.
      altNames: [
        ...sans.dns.map((value) => ({ type: 2, value })),
        ...sans.ip.map((ip) => ({ type: 7, ip })),
      ],
    },
  ]);

  cert.sign(ca.key, forge.md.sha256.create());
  return { keyPem: keys.privatePem, certPem: forge.pki.certificateToPem(cert) };
}

/**
 * Load the existing CA so a new leaf can be signed with it, or null if it cannot be used.
 *
 * Returning null rather than throwing is what makes the migration off OpenSSL invisible: the CA
 * this project used to generate has an EC key, and forge cannot sign with one. Rather than
 * failing on a machine that has been running fine for months, we treat an unusable CA as an
 * absent one and issue a fresh pair. The only cost is that browser participants re-install
 * ca.crt once -- which the desktop app does not need at all.
 */
function loadCA() {
  const p = paths();
  if (!existsSync(p.caCrt) || !existsSync(p.caKey)) return null;
  try {
    return {
      key: forge.pki.privateKeyFromPem(readFileSync(p.caKey, 'utf8')),
      cert: forge.pki.certificateFromPem(readFileSync(p.caCrt, 'utf8')),
    };
  } catch {
    return null;
  }
}

/**
 * Ensure usable certificates exist. Returns { key, cert, ca, regenerated }.
 * Safe to call on every server start -- it does nothing when the certificates are healthy.
 */
export function ensureCertificates({ force = false, quiet = false } = {}) {
  const p = paths();
  mkdirSync(p.dir, { recursive: true });

  const problem = force ? 'regeneration was requested' : certProblem();
  if (!problem) {
    return { key: p.srvKey, cert: p.srvCrt, ca: p.caCrt, regenerated: false };
  }

  if (!quiet) console.log(`Certificates: ${problem}`);

  let ca = force ? null : loadCA();
  if (!ca) {
    if (!quiet) console.log('  creating local certificate authority (10 years)');
    const generated = generateCA();
    writeFileSync(p.caKey, generated.keyPem, { mode: 0o600 });
    writeFileSync(p.caCrt, generated.certPem);
    ca = loadCA();
  }

  const sans = desiredSans();
  if (!quiet) console.log(`  issuing server certificate for ${sanString(sans)}`);
  const leaf = generateLeaf(ca, sans);
  writeFileSync(p.srvKey, leaf.keyPem, { mode: 0o600 });
  writeFileSync(p.srvCrt, leaf.certPem);

  if (!quiet) {
    console.log(`  fingerprint (SHA-256): ${fingerprint()}`);
    console.log(`  trust file for other devices: ${p.caCrt}`);
  }

  return { key: p.srvKey, cert: p.srvCrt, ca: p.caCrt, regenerated: true };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = new Set(process.argv.slice(2));

  if (args.has('--check')) {
    const problem = certProblem();
    if (problem) {
      console.error(`FAIL  certificates need regeneration: ${problem}`);
      console.error('      run: npm run certs');
      process.exit(1);
    }
    console.log(`OK    certificates valid, covering ${sanString(desiredSans())}`);
    console.log(`      fingerprint (SHA-256): ${fingerprint()}`);
    process.exit(0);
  }

  try {
    const result = ensureCertificates({ force: args.has('--force') });
    if (!result.regenerated) {
      console.log('Certificates are already valid. Use --force to regenerate.');
      console.log(`  fingerprint (SHA-256): ${fingerprint()}`);
    }
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
}
