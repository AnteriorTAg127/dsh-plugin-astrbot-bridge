/**
 * Structured English logging for every bridge layer.
 *
 * One shape only: a level, a stable event name, and a small object of ids.
 * Nothing else is accepted, because the protocol forbids secrets, image
 * bytes, prompts, filesystem paths and peer input in logs (§11.4, §13.6), and
 * a free-form message string is the usual way those leak in.
 * @module dsh-plugin-astrbot-bridge/log
 */

import { BridgeError } from './errors.js';

/** Fields that must never be logged, matched case-insensitively. */
const FORBIDDEN_FIELDS = new Set([
  'psk',
  'psksecret',
  'psk_secret',
  'secret',
  'password',
  'token',
  'authorization',
  'apikey',
  'api_key',
  'keymaterial',
  'ciphertext',
  'ct',
  'plaintext',
  'prompt',
  'path',
  'hostpath',
  'data',
  'bytes',
]);

/** Severity of the fallback console sink. */
const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

/**
 * The logging surface every bridge subsystem depends on.
 *
 * Subsystems type their injected logger as this structural shape rather than
 * the concrete {@link Logger} class, because a caller may legitimately pass a
 * silent stub (tests, headless embedding) that implements the same methods.
 * Both satisfy it, so neither has to cast.
 * @typedef {object} LoggerLike
 * @property {(component: string) => LoggerLike} [child] - derive a component
 *   logger; only the composition root needs it, so a silent stub may omit it.
 * @property {(event: string, context?: object) => void} error - error-level record.
 * @property {(event: string, context?: object) => void} warn - warn-level record.
 * @property {(event: string, context?: object) => void} info - info-level record.
 * @property {(event: string, context?: object) => void} debug - debug-level record.
 * @property {(event: string, error: unknown, context?: object) => void} failure - rejected operation.
 */

/**
 * Copy only primitive, non-forbidden fields out of a log context.
 * @param {object|undefined} context - candidate fields.
 * @returns {object} sanitized fields.
 */
function sanitize(context) {
  const out = {};
  if (context === null || typeof context !== 'object') return out;
  for (const [key, value] of Object.entries(context)) {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase())) continue;
    if (value === null || typeof value === 'string' || typeof value === 'number') {
      out[key] = typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Write one record to the fallback console sink.
 * @param {'error'|'warn'|'info'|'debug'} level - severity.
 * @param {string} event - stable event name.
 * @param {object} fields - sanitized fields.
 * @returns {void}
 */
function consoleSink(level, event, fields) {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/**
 * A logger bound to one subsystem name.
 *
 * The host logger from `ctx.logger(name)` is used when available; otherwise a
 * JSON-lines console sink keeps plugin code testable outside a Cordis host.
 */
export class Logger {
  /**
   * @param {string} name - subsystem name shown on every record.
   * @param {object|null} [sink] - host logger facade (`error/warn/info/debug`).
   * @param {number} [level] - minimum severity for the console sink.
   */
  constructor(name, sink = null, level = LEVELS.info) {
    this.name = name;
    this.sink = sink;
    this.level = level;
  }

  /**
   * Create a child logger with a component suffix.
   * @param {string} component - component name.
   * @returns {Logger} derived logger.
   */
  child(component) {
    return new Logger(`${this.name}:${component}`, this.sink, this.level);
  }

  /**
   * Emit one structured record.
   * @param {'error'|'warn'|'info'|'debug'} level - severity.
   * @param {string} event - stable event name.
   * @param {object} [context] - id fields.
   * @returns {void}
   */
  log(level, event, context) {
    const fields = sanitize(context);
    if (this.sink && typeof this.sink[level] === 'function') {
      this.sink[level](`${event} %o`, fields);
      return;
    }
    if (LEVELS[level] <= this.level) consoleSink(level, event, fields);
  }

  /**
   * Log an error-level record.
   * @param {string} event - stable event name.
   * @param {object} [context] - id fields.
   * @returns {void}
   */
  error(event, context) {
    this.log('error', event, context);
  }

  /**
   * Log a warn-level record.
   * @param {string} event - stable event name.
   * @param {object} [context] - id fields.
   * @returns {void}
   */
  warn(event, context) {
    this.log('warn', event, context);
  }

  /**
   * Log an info-level record.
   * @param {string} event - stable event name.
   * @param {object} [context] - id fields.
   * @returns {void}
   */
  info(event, context) {
    this.log('info', event, context);
  }

  /**
   * Log a debug-level record.
   * @param {string} event - stable event name.
   * @param {object} [context] - id fields.
   * @returns {void}
   */
  debug(event, context) {
    this.log('debug', event, context);
  }

  /**
   * Log a rejected operation without leaking its message or stack.
   *
   * Only the protocol code is kept: `BridgeError` messages are fixed English
   * sentences, but raw errors may embed paths or peer input.
   * @param {string} event - stable event name.
   * @param {unknown} error - caught failure.
   * @param {object} [context] - id fields.
   * @returns {void}
   */
  failure(event, error, context) {
    const code = error instanceof BridgeError ? error.code : 'internal_error';
    this.log('error', event, { ...context, code });
  }
}

/** Process-wide default logger used before a host logger is injected. */
export const defaultLogger = new Logger('astrbot-bridge');
