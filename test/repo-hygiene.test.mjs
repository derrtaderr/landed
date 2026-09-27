// Repo hygiene: the things that make a byte comparison mean the same thing on every machine, and
// the things a stranger's clone depends on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const textFiles = ['src', 'test', 'scripts', 'bin', 'fixtures', 'docs']
  .filter((dir) => existsSync(join(ROOT, dir)))
  .flatMap((dir) => walk(join(ROOT, dir)));

// Precedent: signal-desk's repo-hygiene test, written after a NUL byte inside a template literal
// silently changed a hash separator and made grep treat the file as binary.
test('no tracked text file contains a control character outside tab, newline and return', () => {
  const offenders = [];
  for (const file of textFiles) {
    const text = readFileSync(file, 'utf8');
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
        offenders.push(`${relative(ROOT, file)} contains U+${code.toString(16).padStart(4, '0')}`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('.gitattributes pins LF for every type the byte-comparing tests read', () => {
  const rules = readFileSync(join(ROOT, '.gitattributes'), 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '');

  assert.ok(rules.some((rule) => /^\*\s+text=auto\s+eol=lf$/.test(rule)), 'a repo-wide default');
  for (const extension of ['.jsonl', '.md', '.json', '.mjs']) {
    assert.ok(
      rules.some((rule) => rule.startsWith(`*${extension} `) && rule.includes('eol=lf')),
      `eol=lf for ${extension}`,
    );
  }
});

test('the bin entry point is a compiled-nothing shim that resolves to real code', async () => {
  const bin = readFileSync(join(ROOT, 'bin', 'landed.mjs'), 'utf8');
  assert.match(bin, /^#!\/usr\/bin\/env node/);
  assert.match(bin, /src\/cli\.mjs/);

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.landed, './bin/landed.mjs');
  assert.equal(pkg.type, 'module');
});

test('the fixture corpus is present, because the demo and the README both depend on it', () => {
  for (const path of ['fixtures/claims.jsonl', 'fixtures/n8n/executions.json', 'fixtures/n8n/workflows.json', 'fixtures/github/gh-recordings.json']) {
    assert.ok(existsSync(join(ROOT, path)), path);
  }
});

test('every fixture file is valid JSON or JSONL', () => {
  for (const file of walk(join(ROOT, 'fixtures'))) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.jsonl')) {
      for (const line of text.split('\n').filter((candidate) => candidate.trim() !== '')) JSON.parse(line);
    } else if (file.endsWith('.json')) {
      JSON.parse(text);
    }
  }
});

test('the docs a future session is told to read exist and declare a reader', () => {
  for (const path of ['docs/SPEC.md', 'docs/ADAPTERS.md', '.vibecodepm/flow.md', '.vibecodepm/metrics.md']) {
    const full = join(ROOT, path);
    assert.ok(existsSync(full), path);
    const text = readFileSync(full, 'utf8');
    assert.match(text, /^---\n[\s\S]*?read_by:/, `${path} names who reads it`);
  }
});
