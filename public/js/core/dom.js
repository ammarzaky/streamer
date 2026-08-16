/**
 * Minimal DOM helpers.
 *
 * This is not a framework and should not grow into one. The app has two pages and a handful
 * of views; a dependency-free `h()` plus targeted updates is smaller and easier to debug in
 * a browser with no build step and no source maps than any reactive layer would be.
 */

/**
 * Create an element.
 *
 *   h('button', { class: 'btn btn--primary', onclick: fn }, 'Join')
 *   h('div', { class: 'tile', dataset: { peerId: id } }, [avatar, name])
 *
 * Props are applied by name: `class`, `dataset`, `style` (object), `on*` handlers, anything
 * starting with `aria-` or `data-`, and otherwise a direct property assignment falling back
 * to setAttribute. Children may be nodes, strings, numbers, or nested arrays; null,
 * undefined, and false are skipped so `cond && h(...)` works inline.
 */
export function h(tag, props = null, children = null) {
  const el = document.createElement(tag);

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;

      if (key === 'class') {
        el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(el.style, value);
      } else if (key === 'dataset' && typeof value === 'object') {
        Object.assign(el.dataset, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key.includes('-')) {
        // aria-*, data-*, and anything else that is not a valid JS property name.
        el.setAttribute(key, value === true ? '' : String(value));
      } else if (key in el) {
        el[key] = value;
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }

  if (children !== null) append(el, children);
  return el;
}

/** Append children of any accepted shape, flattening arrays and skipping empty values. */
export function append(parent, children) {
  if (children === null || children === undefined || children === false) return parent;

  if (Array.isArray(children)) {
    for (const child of children) append(parent, child);
    return parent;
  }

  parent.append(children instanceof Node ? children : document.createTextNode(String(children)));
  return parent;
}

/** Replace all children in one operation. */
export function replace(parent, children) {
  parent.replaceChildren();
  return append(parent, children);
}

export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Look up a required element, failing loudly at startup rather than silently at use. */
export function need(selector, root = document) {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`required element not found: ${selector}`);
  return el;
}

/**
 * Add a listener and return a function that removes it.
 * Returning the remover is what makes teardown reliable -- every view collects them in an
 * array and calls them on destroy, so nothing keeps a dead peer's DOM alive.
 */
export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** Toggle a class and return the element, for chaining. */
export function cls(el, name, present) {
  el.classList.toggle(name, Boolean(present));
  return el;
}

/** Show or hide via the [hidden] attribute, which base.css enforces with !important. */
export function show(el, visible = true) {
  el.hidden = !visible;
  return el;
}

/** Set text content only when it actually changed, to avoid clobbering a text selection. */
export function text(el, value) {
  const next = String(value ?? '');
  if (el.textContent !== next) el.textContent = next;
  return el;
}

/**
 * An <svg><use> reference into the sprite sheet.
 * Icons live in one sprite so the room UI makes no additional requests once loaded, which
 * also keeps the "no third-party requests" property trivially true.
 */
export function icon(name, className = 'btn__icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/assets/icons.svg#${name}`);
  svg.append(use);
  return svg;
}
