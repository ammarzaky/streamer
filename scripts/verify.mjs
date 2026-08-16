#!/usr/bin/env node
/**
 * The single green/red command.
 *
 * Deliberately a script rather than `a && b && c` in package.json: npm runs scripts through
 * the shell configured in `script-shell`, and on Windows that may be PowerShell 5.1, where
 * `&&` is a parse error rather than a chain operator. This runs the same everywhere.
 *
 * Tools are invoked as `node <package entry>` rather than through their `.cmd` shims, which
 * sidesteps PATH and shim quoting differences between cmd.exe, PowerShell, and Git Bash.
 *
 *   node scripts/verify.mjs              everything
 *   node scripts/verify.mjs --no-e2e     skip the browser suite (fast inner loop)
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

const bin = (...parts) => join(ROOT, 'node_modules', ...parts);

// Node 24 resolves a bare directory argument as a module to execute, not a suite to scan,
// so the test paths must be globs.
const TEST_GLOB = 'test/**/*.test.js';

const STEPS = [
  {
    name: 'lint',
    args: [bin('eslint', 'bin', 'eslint.js'), '.'],
    skipIf: () => !existsSync(bin('eslint')) && 'eslint not installed',
  },
  {
    name: 'unit+int',
    args: ['--test', '--test-timeout=20000', '--test-reporter=spec', TEST_GLOB],
    skipIf: () => !existsSync(join(ROOT, 'test', 'unit')) && 'no unit tests yet',
  },
  {
    name: 'certs',
    args: ['scripts/make-certs.mjs', '--check'],
  },
  {
    name: 'e2e',
    args: [bin('@playwright', 'test', 'cli.js'), 'test'],
    skipIf: () => {
      if (args.has('--no-e2e')) return 'skipped by --no-e2e';
      if (!existsSync(join(ROOT, 'playwright.config.js'))) return 'no playwright config yet';
      if (!existsSync(join(ROOT, 'test', 'e2e'))) return 'no e2e tests yet';
      return false;
    },
  },
];

function run(step) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, step.args, {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', (err) => done({ code: 1, ms: Date.now() - started, error: err.message }));
    child.on('exit', (code) => done({ code: code ?? 1, ms: Date.now() - started }));
  });
}

const results = [];
let failed = false;

for (const step of STEPS) {
  const skip = step.skipIf?.();
  if (skip) {
    results.push({ name: step.name, status: 'SKIP', ms: 0, note: skip });
    continue;
  }

  console.log(`\n=== ${step.name} ===`);
  const { code, ms, error } = await run(step);
  results.push({
    name: step.name,
    status: code === 0 ? 'PASS' : 'FAIL',
    ms,
    note: error,
  });

  // Fail fast: a red unit suite makes the e2e output noise rather than information.
  if (code !== 0) {
    failed = true;
    break;
  }
}

console.log('\n──────── VERDICT ────────');
for (const r of results) {
  const time = r.ms ? `${(r.ms / 1000).toFixed(1)}s` : '';
  console.log(
    `${r.status.padEnd(5)} ${r.name.padEnd(10)} ${time.padStart(6)}${r.note ? `  (${r.note})` : ''}`,
  );
}
console.log(failed ? '\nRESULT: RED' : '\nRESULT: GREEN');
process.exit(failed ? 1 : 0);
