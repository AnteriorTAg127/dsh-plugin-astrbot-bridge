/**
 * Layering enforcement (protocol §1.1).
 *
 * The four layers depend in one direction only. This suite is a text scan over
 * every source file, because an import cycle is not otherwise observable until
 * a runtime initialization order surprises someone in production.
 * @module dsh-plugin-astrbot-bridge/tests/layering
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/** Repository root resolved from this test file. */
const ROOT = new URL('..', import.meta.url).pathname;

/**
 * List every JavaScript source file under one directory, recursively.
 * @param {string} directory - absolute directory path.
 * @returns {string[]} absolute file paths.
 */
function listSources(directory) {
  const out = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...listSources(path));
    else if (entry.endsWith('.js')) out.push(path);
  }
  return out;
}

/** Every source file of the plugin, keyed by its path relative to `lib/`. */
const SOURCES = listSources(join(ROOT, 'lib')).map((path) => ({
  path,
  relative: path.slice(join(ROOT, 'lib').length + 1),
  text: readFileSync(path, 'utf8'),
}));

/**
 * Collect the module specifiers imported by one file.
 * @param {string} text - file contents.
 * @returns {string[]} specifiers.
 */
function importsOf(text) {
  const specifiers = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) specifiers.push(match[1]);
  const dynamic = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of text.matchAll(dynamic)) specifiers.push(match[1]);
  return specifiers;
}

/**
 * Whether one specifier points into a layer.
 * @param {string} specifier - import specifier.
 * @param {string} layer - layer directory name.
 * @returns {boolean} whether it targets that layer.
 */
function targets(specifier, layer) {
  return new RegExp(`(^|/)(\\.\\./)*${layer}/`).test(specifier) || specifier.includes(`/${layer}/`);
}

test('the source tree is present and non-trivial', () => {
  assert.ok(SOURCES.length >= 15, `expected the full layer set, found ${SOURCES.length} files`);
  for (const expected of [
    'transport/base.js',
    'transport/ws.js',
    'transport/webhook.js',
    'transport/longpoll.js',
    'transport/manager.js',
    'session.js',
    'router.js',
    'store.js',
    'app/tasks.js',
    'app/approvals.js',
    'app/sessions.js',
    'app/blobs.js',
    'app/notify.js',
    'host/agents.js',
    'host/approval.js',
    'host/attachments.js',
    'host/llm.js',
    'host/storage.js',
    'index.js',
  ]) {
    assert.ok(
      SOURCES.some((source) => source.relative === expected),
      `missing ${expected}`,
    );
  }
});

test('transport never imports app, host or session', () => {
  for (const source of SOURCES.filter((entry) => entry.relative.startsWith('transport/'))) {
    for (const specifier of importsOf(source.text)) {
      assert.ok(!targets(specifier, 'app'), `${source.relative} must not import app (${specifier})`);
      assert.ok(!targets(specifier, 'host'), `${source.relative} must not import host (${specifier})`);
      assert.ok(
        !/(^|\/)session\.js$/.test(specifier),
        `${source.relative} must not import the session layer (${specifier})`,
      );
      assert.ok(
        !/(^|\/)router\.js$/.test(specifier),
        `${source.relative} must not import the router (${specifier})`,
      );
    }
  }
});

test('session and router never import app or host', () => {
  for (const source of SOURCES.filter((entry) => entry.relative === 'session.js' || entry.relative === 'router.js')) {
    for (const specifier of importsOf(source.text)) {
      assert.ok(!targets(specifier, 'app'), `${source.relative} must not import app (${specifier})`);
      assert.ok(!targets(specifier, 'host'), `${source.relative} must not import host (${specifier})`);
      assert.ok(!targets(specifier, 'transport/'), `${source.relative} must not import transport (${specifier})`);
    }
  }
});

test('app never touches a carrier or the network', () => {
  for (const source of SOURCES.filter((entry) => entry.relative.startsWith('app/'))) {
    for (const specifier of importsOf(source.text)) {
      assert.ok(!targets(specifier, 'transport/'), `${source.relative} must not import transport (${specifier})`);
    }
    for (const forbidden of ['node:http', 'node:https', 'node:net', 'node:tls', "'ws'"]) {
      assert.ok(
        !source.text.includes(`from '${forbidden}'`) && !source.text.includes(`import('${forbidden}')`),
        `${source.relative} must not use ${forbidden}`,
      );
    }
  }
});

test('host never imports transport nor the session layer', () => {
  for (const source of SOURCES.filter((entry) => entry.relative.startsWith('host/'))) {
    for (const specifier of importsOf(source.text)) {
      assert.ok(!targets(specifier, 'transport/'), `${source.relative} must not import transport (${specifier})`);
      assert.ok(
        !/(^|\/)session\.js$/.test(specifier),
        `${source.relative} must not import the session layer (${specifier})`,
      );
    }
  }
});

test('only the composition root imports across every layer', () => {
  const nonRoot = SOURCES.filter((source) => source.relative !== 'index.js');
  for (const source of nonRoot) {
    const layerImports = importsOf(source.text).filter((specifier) => targets(specifier, 'app'));
    if (source.relative.startsWith('app/')) continue;
    assert.equal(
      layerImports.length,
      0,
      `${source.relative} imports app-layer modules outside the composition root`,
    );
  }
});

test('no source file uses a forbidden API or a plaintext credential header', () => {
  for (const source of SOURCES) {
    for (const forbidden of ['setApprovalPolicy', 'setPolicy(', 'Math.random(', 'createHash(\'md5\'']) {
      assert.ok(
        !source.text.includes(forbidden),
        `${source.relative} must not contain ${forbidden}`,
      );
    }
    assert.ok(
      !/Authorization['"]?\s*:\s*['"]Bearer/.test(source.text),
      `${source.relative} must not send a bearer token`,
    );
    assert.ok(
      !/console\.(log|error|warn)\(/.test(source.text),
      `${source.relative} must use the structured logger`,
    );
  }
});

test('the repository root does not contain an AstrBot entry point', () => {
  const entries = readdirSync(ROOT);
  assert.ok(!entries.includes('main.py'), 'the bridge must not be loadable as an AstrBot plugin');
  assert.ok(
    !entries.some((entry) => entry.endsWith('.py')),
    'no Python file may exist at the repository root',
  );
});
