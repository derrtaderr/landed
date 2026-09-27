// No model, anywhere. docs/SPEC.md §3F.
//
// The join is deterministic. A reconciler whose verdict depends on a sampled model answer cannot
// be replayed, cannot be audited, and would be one more claim rather than a check on claims.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const sourceFiles = ['src', 'bin', 'scripts'].flatMap((dir) => walk(join(ROOT, dir)));

test('no source file imports a model SDK', () => {
  const offenders = [];
  for (const file of sourceFiles) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)) {
      if (/anthropic|openai|langchain|@google\/gener|ollama|cohere|mistral/i.test(match[1])) {
        offenders.push(`${relative(ROOT, file)} imports ${match[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('no source file names a model endpoint or a model id', () => {
  const offenders = [];
  for (const file of sourceFiles) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of [/api\.anthropic\.com/, /api\.openai\.com/, /generativelanguage\.googleapis/, /\bclaude-[a-z0-9-]*\d/, /\bgpt-[0-9]/]) {
      if (pattern.test(text)) offenders.push(`${relative(ROOT, file)} names ${pattern}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the package declares no dependencies at all, so nothing can pull an SDK in', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {});
  assert.deepEqual(pkg.devDependencies, {});
  assert.equal(pkg.peerDependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
});

test('no module under src/ imports anything but a node builtin or a relative file', () => {
  const offenders = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)) {
      const specifier = match[1];
      if (!specifier.startsWith('.') && !specifier.startsWith('node:')) {
        offenders.push(`${relative(ROOT, file)} imports ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('no adapter reaches the filesystem, a subprocess or the network directly', () => {
  // Adapters receive readFile, exec and fetch through deps. An adapter that imported them could
  // not be replayed from a fixture, and the keyless demo would stop being keyless.
  const offenders = [];
  for (const file of walk(join(ROOT, 'src', 'adapters'))) {
    const text = readFileSync(file, 'utf8');
    for (const specifier of ['node:fs', 'node:child_process', 'node:http', 'node:https', 'node:net']) {
      if (text.includes(`'${specifier}'`)) offenders.push(`${relative(ROOT, file)} imports ${specifier}`);
    }
    if (/(?<!deps\.)\bfetch\s*\(/.test(text)) offenders.push(`${relative(ROOT, file)} calls fetch() directly`);
    if (/\bDate\.now\s*\(/.test(text)) offenders.push(`${relative(ROOT, file)} reads the wall clock`);
    if (text.includes('process.env')) offenders.push(`${relative(ROOT, file)} reads process.env`);
  }
  assert.deepEqual(offenders, []);
});

test('the core decides states without knowing what a vendor is', () => {
  // src/reconcile.mjs may name a claim kind and a receipt field. It may not name an adapter.
  const text = readFileSync(join(ROOT, 'src', 'reconcile.mjs'), 'utf8');
  const code = text.replace(/^\s*\/\/.*$/gm, '');
  for (const vendor of ['n8n', 'github', 'gmail', 'hubspot']) {
    assert.ok(!new RegExp(`['"\`]${vendor}['"\`]`).test(code), `reconcile.mjs does not name ${vendor}`);
  }
});
