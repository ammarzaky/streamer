/**
 * Where things live, in development and inside a packaged app.
 *
 * The distinction that matters: the application directory is read-only once installed, so
 * anything the app WRITES -- certificates, config overrides -- has to go to userData, while
 * anything it merely READS -- config.default.json, public/ -- stays in the bundle. Getting this
 * wrong does not fail at build time; it fails on someone else's machine, at first launch, with
 * an EACCES nobody can act on.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The bundle root: holds config.default.json, public/, src/. Read-only when packaged. */
export const appRoot = () => path.resolve(HERE, '..');

/** Writable per-user directory. */
export const userDataDir = () => app.getPath('userData');

/** Where the TLS key and certificate are generated and read from. */
export const certDir = () => path.join(userDataDir(), 'certs');

/** Optional user overrides, deep-merged over the shipped defaults. */
export const overridesDir = () => userDataDir();

/** Renderer pages and the preload bridge. */
export const ui = (file) => path.join(HERE, 'ui', file);
export const preload = () => path.join(HERE, 'preload.cjs');
