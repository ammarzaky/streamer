/**
 * Turning browser failures into codes the UI can explain.
 *
 * The browser reports media failures as `DOMException`s whose names are shared across wildly
 * different causes -- `NotAllowedError` means both "the user denied permission" and "the user
 * dismissed the picker", which need opposite responses from us. This module is where that
 * ambiguity is resolved once, so no view ever inspects a DOMException directly.
 */

import { ERRORS } from '../../shared/protocol.js';
import { errorCopy } from '../ui/strings.js';

/**
 * An error that carries a code the UI knows how to render.
 * `cause` keeps the original exception for the diagnostics dump without ever showing it to
 * the user -- raw DOMException text is not something anyone can act on.
 */
export class AppError extends Error {
  constructor(code, { cause = null, detail = null, fatal = false } = {}) {
    const { message } = errorCopy(code);
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.cause = cause;
    this.detail = detail;
    this.fatal = fatal;
  }

  get hint() {
    return errorCopy(this.code).hint;
  }
}

export const isAppError = (err) => err instanceof AppError;

/** Wrap anything thrown into an AppError, preserving one that already is. */
export function toAppError(err, fallbackCode = ERRORS.SHARE_FAILED) {
  if (isAppError(err)) return err;
  return new AppError(fallbackCode, { cause: err, detail: err?.message ?? String(err) });
}

/**
 * Map a getUserMedia rejection to a code.
 *
 * `NotAllowedError` here really is a denial: getUserMedia has no cancellable picker, so there
 * is no ambiguity to resolve -- unlike getDisplayMedia below.
 */
export function micError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return new AppError(ERRORS.MIC_DENIED, { cause: err });

    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new AppError(ERRORS.MIC_NOT_FOUND, { cause: err });

    // The device exists but the OS will not hand it over -- almost always another application
    // holding it exclusively.
    case 'NotReadableError':
    case 'TrackStartError':
      // The browser's message is the only clue to WHICH of several OS-level causes this is
      // (another app, the Windows privacy gate, a driver that failed to open), so it travels
      // as detail into the diagnostics dump.
      return new AppError(ERRORS.MIC_IN_USE, { cause: err, detail: err?.message || undefined });

    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new AppError(ERRORS.MIC_FAILED, {
        cause: err,
        detail: `constraint: ${err.constraint}`,
      });

    case 'SecurityError':
      return new AppError(ERRORS.INSECURE_CONTEXT, { cause: err, fatal: true });

    default:
      return new AppError(ERRORS.MIC_FAILED, { cause: err, detail: err?.message });
  }
}

/**
 * Map a getDisplayMedia rejection to a code.
 *
 * The important distinction: `NotAllowedError` from getDisplayMedia overwhelmingly means the
 * user closed the picker, which is not an error and must not raise an alarm. A genuine policy
 * block is rare and reads differently in the message, so we treat cancellation as the default
 * and only escalate when the browser tells us otherwise. Showing "permission blocked" every
 * time someone changes their mind about sharing would train people to ignore the messages.
 */
export function shareError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError': {
      const message = String(err?.message ?? '').toLowerCase();
      const blockedByPolicy =
        message.includes('disallowed') ||
        message.includes('policy') ||
        message.includes('permissions policy');
      return blockedByPolicy
        ? new AppError(ERRORS.SHARE_FAILED, { cause: err, detail: err.message })
        : new AppError(ERRORS.SHARE_CANCELLED, { cause: err });
    }

    // No shareable surface: on some platforms this is the OS refusing screen recording.
    case 'NotFoundError':
      return new AppError(ERRORS.SHARE_FAILED, { cause: err });

    case 'NotReadableError':
    case 'AbortError':
      return new AppError(ERRORS.SHARE_FAILED, { cause: err, detail: err?.message });

    // Safari throws this when getDisplayMedia is reached after an await, i.e. once transient
    // user activation has been consumed. The remedy is a code change, not a user action, so it
    // is worth keeping distinguishable in diagnostics.
    case 'InvalidStateError':
      return new AppError(ERRORS.SHARE_FAILED, {
        cause: err,
        detail: 'getDisplayMedia lost user activation',
      });

    case 'SecurityError':
      return new AppError(ERRORS.INSECURE_CONTEXT, { cause: err, fatal: true });

    case 'TypeError':
      return new AppError(ERRORS.SHARE_UNSUPPORTED, { cause: err });

    default:
      return new AppError(ERRORS.SHARE_FAILED, { cause: err, detail: err?.message });
  }
}

/** An `error` frame from the server. */
export function serverError(code, detail = null) {
  return new AppError(code, { detail });
}
