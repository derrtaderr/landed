// `node --check` over every module, inside the suite.
//
// It is also one of the declared gate commands, and having it here means a file that does not
// parse fails the same run that broke it rather than the next time someone remembers to run the
// gate by hand.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const modules = ['src', 'bin', 'scripts', 'test']
  .flatMap((dir) => walk(join(ROOT, dir)))
  .filter((file) => file.endsWith('.mjs'));

test('the module list is not empty, so the loop below is not vacuous', () => {
  assert.ok(modules.length >= 15, `found ${modules.length} modules`);
});

test('every module parses', () => {
  const offenders = [];
  for (const file of modules) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
      offenders.push(`${relative(ROOT, file)}: ${error.stderr?.toString().split('\n')[0] ?? error.message}`);
    }
  }
  assert.deepEqual(offenders, []);
});
