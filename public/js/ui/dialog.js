/**
 * Modal confirmations, on top of the native <dialog>.
 *
 * `showModal()` brings focus trapping, Escape handling, inert background, and the ::backdrop
 * pseudo-element for free. Reimplementing any of that by hand is how modals end up
 * inaccessible.
 */

import { h, need } from '../core/dom.js';
import { UI } from './strings.js';

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
