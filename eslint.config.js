import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'certs/**',
      'test-results/**',
      'playwright-report/**',
      'scratchpad/**',
      // Packaged output. It contains a copy of src/ and public/, so without this every file is
      // linted twice -- the second time under the wrong config, since the copies sit at paths
      // no `files:` block below matches and therefore get no globals at all. Globbed rather than
      // named, so an alternate output directory does not quietly reintroduce 280 phantom errors.
      'dist*/**',
    ],
  },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
    },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-implicit-globals': 'error',
      'require-atomic-updates': 'error',
      'no-promise-executor-return': 'error',
      'no-console': 'off',
    },
  },

  // Browser code.
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: globals.browser },
  },

  // Node code.
  {
    files: [
      'src/**/*.js',
      'scripts/**/*.mjs',
      'scripts/**/*.js',
      'test/**/*.js',
      'eslint.config.js',
      'playwright.config.js',
      'playwright.desktop.config.js',
    ],
    languageOptions: { globals: globals.node },
  },

  // Playwright specs run in Node but pass closures into the browser via page.evaluate, so
  // they legitimately reference both sets of globals.
  {
    files: ['test/e2e/**/*.js', 'test/desktop/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // The Electron main process is Node.
  {
    files: ['desktop/**/*.js'],
    languageOptions: { globals: globals.node },
  },

  // Preload scripts must be CommonJS -- a sandboxed preload cannot be an ES module, and the
  // sandbox is worth more than the syntax. They see both runtimes: Node's `require` and
  // `process`, and the page's `window`.
  {
    files: ['desktop/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // Electron renderer pages are browser documents. They reach the main process only through
  // the preload bridge, so they get browser globals and no Node ones -- which is the lint-level
  // expression of contextIsolation: a `require` in here is an error, not a shortcut.
  //
  // Must come after the desktop/**/*.js block so it overrides the Node globals.
  {
    files: ['desktop/ui/**/*.js'],
    languageOptions: { globals: globals.browser },
  },

  // Shared code runs in BOTH runtimes, so it gets no globals at all. Reaching for `window`
  // or `process` here is a lint error by construction.
  //
  // It lives under public/ because the browser can only import what the static server can
  // serve: a browser module importing ../../src/shared/protocol.js resolves to
  // /src/shared/protocol.js, which is outside the static root and 404s -- silently defeating
  // the one file whose entire purpose is keeping the two trees in sync. Node imports it by
  // relative path, which has no such restriction.
  //
  // This block must come after the public/**/*.js block so it overrides the browser globals.
  {
    files: ['public/shared/**/*.js'],
    languageOptions: { globals: {} },
  },
];
