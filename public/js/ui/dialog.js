/**
 * Modal confirmations, on top of the native <dialog>.
 *
 * `showModal()` brings focus trapping, Escape handling, inert background, and the ::backdrop
 * pseudo-element for free. Reimplementing any of that by hand is how modals end up
 * inaccessible.
 */

import { h, need, replace, show } from '../core/dom.js';
import { UI } from './strings.js';

/**
 * Render an {ar, en} pair as two lines: Arabic (right-to-left) above, English below.
 * A single-language pair renders one line. Used by banners, tiles and the audio check.
 */
export function biNode(pair, { inline = false } = {}) {
  const ar = pair?.ar ?? '';
  const en = pair?.en ?? '';
  if (inline) return document.createTextNode([ar, en].filter(Boolean).join(' — '));
  return h('span', { class: 'banner__text--bi' }, [
    ar ? h('span', { class: 'diag__ar', dir: 'rtl', lang: 'ar' }, ar) : null,
    en ? h('span', { class: 'diag__en', lang: 'en' }, en) : null,
  ]);
}

/**
 * @returns {Promise<boolean>} true if confirmed, false if cancelled or dismissed.
 */
export function confirmDialog({
  title,
  body,
  confirmLabel = 'OK',
  cancelLabel = UI.cancel,
  danger = false,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };

    // Test ids rather than labels: a dialog's confirm text often repeats a control-bar
    // button's text ("Take over" appears in both), which makes a by-name lookup ambiguous.
    const confirmButton = h(
      'button',
      {
        class: ['btn', danger ? 'btn--danger' : 'btn--primary'],
        dataset: { testid: 'dialog-confirm' },
        onclick: () => finish(true),
      },
      confirmLabel,
    );

    const dialog = h('dialog', { class: 'dialog', dataset: { testid: 'dialog' } }, [
      h('div', { class: 'dialog__body' }, [
        h('h2', { class: 'dialog__title' }, title),
        body ? h('p', { class: 'dialog__text' }, body) : null,
      ]),
      h('div', { class: 'dialog__actions' }, [
        h(
          'button',
          {
            class: 'btn btn--secondary',
            dataset: { testid: 'dialog-cancel' },
            onclick: () => finish(false),
          },
          cancelLabel,
        ),
        confirmButton,
      ]),
    ]);

    // Escape and backdrop clicks both mean "no". Treating a dismissal as confirmation is how
    // people accidentally end a session for everyone.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) finish(false);
    });

    document.body.append(dialog);
    dialog.showModal();
    confirmButton.focus();
  });
}

/**
 * A multi-step guided dialog. Each step renders its own body into a container and may return
 * a cleanup function, which runs when the step is left -- that is what lets a step host a live
 * level meter or a polling readout without leaking timers.
 *
 *   steps: [{ title: Node|string, render: (container, api) => (() => void) | void }]
 *   api:   { next(), back(), close(), index, isLast }
 *
 * Resolves when closed, with the index of the last step shown.
 */
export function wizardDialog({ title, steps, labels = {}, testid = 'wizard' }) {
  return new Promise((resolve) => {
    let index = 0;
    let cleanup = null;
    let settled = false;

    const nextLabel = labels.next ?? 'Next';
    const backLabel = labels.back ?? 'Back';
    const closeLabel = labels.close ?? 'Close';

    const stepTitle = h('h3', { class: 'dialog__title', dataset: { testid: `${testid}-step-title` } });
    const body = h('div', { class: 'diag__step', dataset: { testid: `${testid}-body` } });
    const backButton = h('button', { class: 'btn btn--secondary', dataset: { testid: `${testid}-back` }, onclick: () => go(index - 1) }, backLabel);
    const nextButton = h('button', { class: 'btn btn--primary', dataset: { testid: `${testid}-next` }, onclick: () => (index >= steps.length - 1 ? finish() : go(index + 1)) }, nextLabel);
    const closeButton = h('button', { class: 'btn btn--ghost', dataset: { testid: `${testid}-close` }, onclick: () => finish() }, closeLabel);

    const finish = () => {
      if (settled) return;
      settled = true;
      try { cleanup?.(); } catch { /* a leaving step must not block closing */ }
      cleanup = null;
      dialog.close();
      dialog.remove();
      resolve(index);
    };

    const api = {
      next: () => (index >= steps.length - 1 ? finish() : go(index + 1)),
      back: () => go(index - 1),
      close: finish,
      get index() { return index; },
      get isLast() { return index >= steps.length - 1; },
    };

    function go(to) {
      if (settled) return;
      if (to < 0 || to >= steps.length) return;
      try { cleanup?.(); } catch { /* see above */ }
      cleanup = null;
      index = to;
      const step = steps[index];
      replace(stepTitle, [typeof step.title === 'string' ? step.title : step.title]);
      replace(body, []);
      show(backButton, index > 0);
      nextButton.textContent = index >= steps.length - 1 ? closeLabel : nextLabel;
      const result = step.render(body, api);
      cleanup = typeof result === 'function' ? result : null;
    }

    const dialog = h('dialog', { class: 'dialog dialog--wide', dataset: { testid } }, [
      h('div', { class: 'dialog__body' }, [
        h('h2', { class: 'dialog__title' }, [typeof title === 'string' ? title : title]),
        stepTitle,
        body,
      ]),
      h('div', { class: 'dialog__actions' }, [closeButton, backButton, nextButton]),
    ]);

    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish();
    });

    document.body.append(dialog);
    dialog.showModal();
    go(0);
    nextButton.focus();
  });
}

/**
 * A block of text the user can select and copy by hand. The fallback for every clipboard
 * path: in the sandboxed desktop renderer `navigator.clipboard` needs a gesture the button
 * may have already spent, and a silently failed copy is worse than a textarea.
 */
export function textDialog({ title, text, hint, copyLabel = 'Copy', closeLabel = 'Close', onCopy }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve();
    };

    const area = h('textarea', { class: 'diag__textarea', readOnly: true, dataset: { testid: 'text-dialog-area' } });
    area.value = text;

    const dialog = h('dialog', { class: 'dialog dialog--wide', dataset: { testid: 'text-dialog' } }, [
      h('div', { class: 'dialog__body' }, [
        h('h2', { class: 'dialog__title' }, [typeof title === 'string' ? title : title]),
        hint ? h('p', { class: 'dialog__text' }, [typeof hint === 'string' ? hint : hint]) : null,
        area,
      ]),
      h('div', { class: 'dialog__actions' }, [
        h('button', { class: 'btn btn--secondary', onclick: finish, dataset: { testid: 'text-dialog-close' } }, closeLabel),
        h(
          'button',
          {
            class: 'btn btn--primary',
            dataset: { testid: 'text-dialog-copy' },
            onclick: async () => {
              area.select();
              try {
                await navigator.clipboard.writeText(text);
                onCopy?.(true);
              } catch {
                // Selection is already made; the user can press Ctrl+C.
                try { document.execCommand?.('copy'); } catch { /* nothing more to try */ }
                onCopy?.(false);
              }
            },
          },
          copyLabel,
        ),
      ]),
    ]);

    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish();
    });

    document.body.append(dialog);
    dialog.showModal();
    area.focus();
    area.select();
  });
}

/** A blocking, unrecoverable state: the room ended, or the environment cannot run the app. */
export function showFatal({ title, detail, hint, actionLabel, onAction }) {
  const existing = document.querySelector('.fatal');
  if (existing) existing.remove();

  const screen = h('div', { class: 'fatal', role: 'alertdialog', 'aria-modal': 'true' }, [
    h('div', { class: 'fatal__card' }, [
      h('h1', {}, title),
      detail ? h('p', { class: 'fatal__detail' }, detail) : null,
      // The hint is visually separate from the message because they answer different
      // questions: what happened, and what to do about it.
      hint ? h('p', { class: 'fatal__hint' }, hint) : null,
      actionLabel
        ? h('button', { class: 'btn btn--primary btn--lg', onclick: onAction }, actionLabel)
        : null,
    ]),
  ]);

  document.body.append(screen);
  screen.querySelector('button')?.focus();
  return screen;
}

export function mountToastContainer() {
  let container = document.querySelector('.toasts');
  if (!container) {
    container = h('div', { class: 'toasts', 'aria-live': 'polite' });
    document.body.append(container);
  }
  return container;
}

export { need };
