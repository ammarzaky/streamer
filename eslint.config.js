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
    files: ['src/**/*.js', 'scripts/**/*.mjs', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js', 'playwright.config.js'],
    languageOptions: { globals: globals.node },
  },

  // Shared code runs in BOTH runtimes, so it gets no globals at all.
  // Reaching for `window` or `process` here is a lint error by construction.
  {
    files: ['src/shared/**/*.js'],
    languageOptions: { globals: {} },
  },
];
