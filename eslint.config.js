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
    ],
    languageOptions: { globals: globals.node },
  },

  // Playwright specs run in Node but pass closures into the browser via page.evaluate, so
  // they legitimately reference both sets of globals.
  {
    files: ['test/e2e/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
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
