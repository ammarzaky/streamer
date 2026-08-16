/** Transient notifications. For things that happened; conditions that persist use a banner. */

import { h, replace } from '../core/dom.js';
import { icon } from '../core/dom.js';

const DEFAULT_MS = 4000;
const ERROR_MS = 8000;
const MAX_VISIBLE = 3;

export function createToasts(container) {
  const active = [];

  function render() {
    replace(
      container,
      active.map((t) => t.el),
    );
  }

  function dismiss(entry) {
    clearTimeout(entry.timer);
    const index = active.indexOf(entry);
    if (index === -1) return;
    active.splice(index, 1);
    render();
  }

  function push(text, { kind = 'info', ms } = {}) {
    if (!text) return () => {};

    const duration = ms ?? (kind === 'error' ? ERROR_MS : DEFAULT_MS);
    const glyph = kind === 'error' || kind === 'warn' ? 'warn' : kind === 'ok' ? 'check' : 'info';

    const entry = {};
    entry.el = h('div', { class: ['toast', `toast--${kind}`], role: 'status' }, [
      icon(glyph, 'btn__icon'),
      h('span', { class: 'toast__text' }, text),
      h(
        'button',
        {
          class: 'btn btn--ghost btn--sm',
          onclick: () => dismiss(entry),
          'aria-label': 'Dismiss',
        },
        '×',
      ),
    ]);

    active.push(entry);
    // Oldest first, so a burst of events does not push the newest one off screen.
    while (active.length > MAX_VISIBLE) dismiss(active[0]);

    render();
    entry.timer = setTimeout(() => dismiss(entry), duration);
    return () => dismiss(entry);
  }

  return {
    info: (text, opts) => push(text, { ...opts, kind: 'info' }),
    ok: (text, opts) => push(text, { ...opts, kind: 'ok' }),
    warn: (text, opts) => push(text, { ...opts, kind: 'warn' }),
    error: (text, opts) => push(text, { ...opts, kind: 'error' }),
    clear() {
      for (const entry of [...active]) dismiss(entry);
    },
  };
}
