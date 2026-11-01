/**
 * Host storage binding: resolve the bridge data root under the harness home
 * (PRD §5).
 *
 * Data is never written inside the plugin repository — a reinstall would
 * destroy it — so the root must come from the harness home resolution, with an
 * explicit configuration override available for operators. Every failure path
 * here is loud: a relative override, an unresolvable home, or a root that lands
 * inside the plugin checkout rejects instead of being "fixed up" into a
 * repository path that would be lost on the next update.
 * @module dsh-plugin-astrbot-bridge/host/storage
 */

import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATA_DOMAIN_DIRS } from '../constants.js';
import { BridgeError } from '../errors.js';

/**
 * Absolute plugin checkout root, used to refuse a repository-resident root.
 *
 * `import.meta.url` points at `lib/host/storage.js`, so two levels up is the
 * package directory (`node_modules` parent for an installed copy).
 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Resolve the bridge data root.
 *
 * Precedence: the explicit `dataRoot` configuration, then
 * `dshHomePath(...DATA_DOMAIN_DIRS)` from the host helper. The host helper is
 * imported lazily so this module stays usable when the package is absent (for
 * example in an isolated unit test), in which case the `$DSH_HOME`/`~/.dsh`
 * rule from `dsh-home-paths` is reproduced exactly — and the reason is logged,
 * never swallowed.
 * @param {object} input - resolution inputs.
 * @param {string} [input.dataRoot] - configured override.
 * @param {Record<string, string|undefined>} [input.env] - environment mapping.
 * @param {import('../log.js').Logger} [input.logger] - logger used to report a
 *   fallback resolution.
 * @returns {Promise<string>} absolute data root.
 * @throws {BridgeError} `internal_error` when the resolved root would be
 *   relative (working-directory dependent) or inside the plugin checkout.
 */
export async function resolveDataRoot(input = {}) {
  const configured = String(input.dataRoot ?? '').trim();
  // An internationalised install path is not an error: `file://` URLs percent-
  // encode, so the package root is compared after decoding.
  if (configured.length > 0) return assertSafeRoot(configured, 'configured', input.logger);
  try {
    const module = await import('@deepseek-ai/dsh-home-paths');
    return assertSafeRoot(module.dshHomePath(...DATA_DOMAIN_DIRS), 'harness_home', input.logger);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    // The helper is optional at runtime, but a missing package must not turn
    // into a repository-relative write root: the fallback is the documented
    // `$DSH_HOME` → `~/.dsh` rule, and it fails when neither anchor exists.
    const root = fallbackDataRoot(input.env ?? process.env);
    input.logger?.warn('storage_root_fallback', { reason: 'home_paths_unavailable' });
    return assertSafeRoot(root, 'dsh_home_env', input.logger);
  }
}

/**
 * Reproduce the `dsh-home-paths` rule without the package.
 *
 * Precedence is `$DSH_HOME`, then `~/.dsh`, with a blank override treated as
 * unset so a stray empty variable never resolves the root to the CWD.
 * @param {Record<string, string|undefined>} env - environment mapping.
 * @returns {string} absolute data root.
 * @throws {BridgeError} `internal_error` when no home anchor exists, because
 *   the only remaining base would be the current working directory.
 */
function fallbackDataRoot(env) {
  const configured = String(env.DSH_HOME ?? '').trim();
  if (configured.length > 0) return join(configured, ...DATA_DOMAIN_DIRS);
  const home = String(env.HOME ?? env.USERPROFILE ?? '').trim();
  if (home.length === 0) {
    throw new BridgeError('internal_error', { details: { reason: 'home_unresolved' } });
  }
  return join(home, '.dsh', ...DATA_DOMAIN_DIRS);
}

/**
 * Require an absolute root that is not inside the plugin checkout.
 *
 * A relative root depends on the process working directory, which for a plugin
 * is usually the repository being edited; the same reasoning forbids any
 * resolved path under the package directory even when written absolutely.
 * @param {string} root - candidate root.
 * @param {string} source - resolution branch, for the diagnostic log.
 * @param {import('../log.js').Logger} [logger] - logger for the refusal reason.
 * @returns {string} the absolute root.
 * @throws {BridgeError} `internal_error` for a relative or repository-resident root.
 */
function assertSafeRoot(root, source, logger) {
  const absolute = isAbsolute(root) ? resolve(root) : '';
  if (absolute.length === 0) {
    logger?.error('storage_root_rejected', { reason: 'data_root_not_absolute', source });
    throw new BridgeError('internal_error', { details: { reason: 'data_root_not_absolute', source } });
  }
  if (absolute === PACKAGE_ROOT || absolute.startsWith(`${PACKAGE_ROOT}${sep}`)) {
    logger?.error('storage_root_rejected', { reason: 'data_root_inside_package', source });
    throw new BridgeError('internal_error', { details: { reason: 'data_root_inside_package', source } });
  }
  return absolute;
}
