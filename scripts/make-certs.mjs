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
 * -- including after the LAN IP changes and the leaf is reissued.
 *
 *   node scripts/make-certs.mjs            generate if missing or stale
 *   node scripts/make-certs.mjs --force    regenerate unconditionally
 *   node scripts/make-certs.mjs --check    verify only; exit 1 if regeneration is needed
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = join(ROOT, 'certs');

const CA_KEY = join(CERT_DIR, 'ca.key');
const CA_CRT = join(CERT_DIR, 'ca.crt');
const SRV_KEY = join(CERT_DIR, 'server.key');
const SRV_CRT = join(CERT_DIR, 'server.crt');

const CA_DAYS = 3650; // 10 years -- you install this once and forget it.
const LEAF_DAYS = 825; // Browsers reject server certificates valid for longer than ~825 days.
const RENEW_WITHIN_DAYS = 30;

const EXTRA_DNS = ['localhost', 'streamer.local'];

// ---------------------------------------------------------------------------
// OpenSSL discovery
// ---------------------------------------------------------------------------

const OPENSSL_CANDIDATES = [
  process.env.STREAMER_OPENSSL,
  'openssl',
  'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files (x86)\\Git\\mingw64\\bin\\openssl.exe',
  'C:\\Windows\\System32\\OpenSSH\\openssl.exe',
].filter(Boolean);

export function resolveOpenssl() {
  for (const candidate of OPENSSL_CANDIDATES) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'pipe' });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    'OpenSSL was not found.\n' +
      'It ships with Git for Windows at:\n' +
      '  C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe\n' +
      'Install Git for Windows, or set STREAMER_OPENSSL to the full path of openssl.exe.',
  );
}

function openssl(bin, args, opts = {}) {
  try {
    return execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    throw new Error(`openssl ${args[0]} failed:\n${stderr || err.message}`);
  }
}

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
  return {
    dns: EXTRA_DNS,
    ip: [...new Set(ips)],
  };
}

function sanString({ dns, ip }) {
  return [...dns.map((d) => `DNS:${d}`), ...ip.map((i) => `IP:${i}`)].join(',');
}

/**
 * OpenSSL writes "IP:::1" but Node reads it back as "IP Address:0:0:0:0:0:0:0:1".
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
  if (!existsSync(CA_CRT) || !existsSync(CA_KEY)) return 'no local CA yet';
  if (!existsSync(SRV_CRT) || !existsSync(SRV_KEY)) return 'no server certificate yet';

  let cert;
  try {
    cert = new X509Certificate(readFileSync(SRV_CRT));
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

export function fingerprint(certPath = SRV_CRT) {
  return new X509Certificate(readFileSync(certPath)).fingerprint256;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function generateCA(bin) {
  console.log('  creating local certificate authority (10 years)');
  openssl(bin, [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-days', String(CA_DAYS), '-sha256',
    '-keyout', CA_KEY, '-out', CA_CRT,
    '-subj', '/CN=Streamer Local CA/O=Streamer',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]);
}

function generateLeaf(bin, sans) {
  console.log(`  issuing server certificate for ${sanString(sans)}`);

  const csr = join(CERT_DIR, 'server.csr');
  const extFile = join(tmpdir(), `streamer-ext-${process.pid}.cnf`);

  // Written to a real temp file rather than piped: process substitution does not exist
  // outside a POSIX shell, and this script must work from cmd.exe and PowerShell too.
  writeFileSync(
    extFile,
    [
      `subjectAltName=${sanString(sans)}`,
      'basicConstraints=CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      '',
    ].join('\n'),
  );

  try {
    openssl(bin, [
      'req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', SRV_KEY, '-out', csr,
      '-subj', '/CN=streamer.local/O=Streamer',
    ]);

    openssl(bin, [
      'x509', '-req', '-in', csr,
      '-CA', CA_CRT, '-CAkey', CA_KEY, '-CAcreateserial',
      '-days', String(LEAF_DAYS), '-sha256',
      '-extfile', extFile,
      '-out', SRV_CRT,
    ]);
  } finally {
    rmSync(extFile, { force: true });
    rmSync(csr, { force: true });
  }
}

/**
 * Ensure usable certificates exist. Returns { key, cert, ca, regenerated }.
 * Safe to call on every server start -- it does nothing when the certificates are healthy.
 */
export function ensureCertificates({ force = false, quiet = false } = {}) {
  mkdirSync(CERT_DIR, { recursive: true });

  const problem = force ? 'regeneration was requested' : certProblem();
  if (!problem) {
    return { key: SRV_KEY, cert: SRV_CRT, ca: CA_CRT, regenerated: false };
  }

  if (!quiet) console.log(`Certificates: ${problem}`);
  const bin = resolveOpenssl();

  if (force || !existsSync(CA_CRT) || !existsSync(CA_KEY)) {
    generateCA(bin);
  }
  generateLeaf(bin, desiredSans());

  if (!quiet) {
    console.log(`  fingerprint (SHA-256): ${fingerprint()}`);
    console.log(`  trust file for other devices: ${CA_CRT}`);
  }

  return { key: SRV_KEY, cert: SRV_CRT, ca: CA_CRT, regenerated: true };
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
