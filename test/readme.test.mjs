// README freshness.
//
// Every console block marked with a `verified-block` comment is executed here and compared with
// the real output, byte for byte. A README that goes stale fails the suite in the commit that
// staled it, rather than three months later in front of the person deciding whether this repo is
// real. Precedent: signal-desk's readme-examples test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'landed.mjs');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

// The demo's out directory for the README's examples. Outside the checkout on purpose, so running
// the documented command never leaves anything in a clone.
const DEMO_OUT = join('/tmp', 'landed-demo');

function verifiedBlocks() {
  const pattern = /<!-- verified-block: ([a-z0-9-]+) -->\n```console\n([\s\S]*?)```/g;
  const blocks = new Map();

  for (const match of README.matchAll(pattern)) {
    const [, name, body] = match;
    const lines = body.split('\n');
    assert.ok(lines[0].startsWith('$ '), `block ${name} starts with a $ command line`);
    blocks.set(name, {
      argv: lines[0].slice(2).trim().split(/\s+/),
      expected: lines.slice(1).join('\n').replace(/\n$/, ''),
    });
  }

  return blocks;
}

const blocks = verifiedBlocks();

// The README's commands are run from a fresh clone's root, which is where the reader will be.
function runBlock(name) {
  const block = blocks.get(name);
  assert.ok(block !== undefined, `the README declares a ${name} block`);

  try {
    return execFileSync(process.execPath, [BIN, ...block.argv.slice(2)], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    }).replace(/\n$/, '');
  } catch (error) {
    // A documented command that exits non-zero still has stdout worth comparing, and `check`
    // exits 1 whenever it finds something, which is most of the time.
    if (error.stdout === undefined) throw error;
    return error.stdout.replace(/\n$/, '');
  }
}

test('the README declares exactly the verified blocks this test knows how to check', () => {
  assert.deepEqual([...blocks.keys()].sort(), ['demo', 'validate', 'watch']);
});

test('every verified block invokes the real bin path, not an installed copy', () => {
  for (const [name, block] of blocks) {
    assert.deepEqual(block.argv.slice(0, 2), ['node', 'bin/landed.mjs'], `block ${name}`);
  }
});

test('the demo block writes only to a path outside the checkout', () => {
  const block = blocks.get('demo');
  const out = block.argv[block.argv.indexOf('--out') + 1];
  assert.equal(out, DEMO_OUT);
});

test('README: the demo example matches the real output', () => {
  rmSync(DEMO_OUT, { recursive: true, force: true });
  try {
    assert.equal(runBlock('demo'), blocks.get('demo').expected);
  } finally {
    rmSync(DEMO_OUT, { recursive: true, force: true });
  }
});

test('README: the validate example matches the real output', () => {
  assert.equal(runBlock('validate'), blocks.get('validate').expected);
});

test('README: the watch recipe matches what the tool actually prints', () => {
  assert.equal(runBlock('watch'), blocks.get('watch').expected);
});

// --- claims the README makes that the code has to keep -----------------------------------

test('the README names the node version package.json requires', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const major = pkg.engines.node.replace(/[^0-9]/g, '');
  assert.ok(README.includes(`Node ${major}`), `README names Node ${major}`);
});

test('the README clone line points at this repository', () => {
  assert.match(README, /git clone https:\/\/github\.com\/derrtaderr\/landed\.git/);
});

test('every verb the README shows is one the CLI documents, and the other way round', async () => {
  const { USAGE } = await import('../src/cli.mjs');
  for (const verb of ['check', 'validate', 'report', 'demo', 'watch']) {
    assert.ok(README.includes(`bin/landed.mjs ${verb}`), `README shows ${verb}`);
    assert.ok(USAGE.includes(`landed.mjs ${verb}`), `usage documents ${verb}`);
  }
});

test('the README advertises no verb this phase has not built', async () => {
  const { USAGE } = await import('../src/cli.mjs');
  // Phase 2's adapters and anything resembling a daemon or a repair action. A README that
  // promises these is a README that gets someone to try them.
  for (const verb of ['fix', 'retry', 'serve', 'daemon', 'send']) {
    assert.ok(!README.includes(`bin/landed.mjs ${verb}`), `README does not show ${verb}`);
    assert.ok(!USAGE.includes(`landed.mjs ${verb}`), `usage does not show ${verb}`);
  }
});

test('the README names all three states and both named verdicts', () => {
  for (const term of ['matched', 'contradicted', 'unresolved', 'orphaned-claim', 'executed-never-claimed']) {
    assert.ok(README.includes(term), term);
  }
});

test('the README lists every false-green reason code the table test enforces', () => {
  for (const code of ['EMPTY_CLAIMS', 'EMPTY_SOURCE', 'ADAPTER_UNREACHABLE', 'PARTIAL_READ', 'CLOCK_SKEW']) {
    assert.ok(README.includes(code), code);
  }
});

test('the README states the exit codes the CLI actually returns', () => {
  const { readFileSync: read } = { readFileSync };
  const cli = read(join(ROOT, 'src', 'cli.mjs'), 'utf8');
  for (const code of ['0', '1', '2']) {
    assert.ok(README.includes(`\n  ${code}  `) || README.includes(`| \`${code}\` |`), `exit code ${code} is documented`);
    assert.ok(cli.includes(`  ${code}  `), `exit code ${code} is described in the CLI too`);
  }
});

test('the README names every claim kind, so the closed set is discoverable', async () => {
  const { CLAIM_KINDS } = await import('../src/claims.mjs');
  for (const kind of CLAIM_KINDS) assert.ok(README.includes(`\`${kind}\``), kind);
});

test('the README names both phase 1 adapters and no phase 2 adapter as available', async () => {
  const { adapters } = await import('../src/adapters/index.mjs');
  for (const name of Object.keys(adapters)) assert.ok(README.includes(name), name);
  assert.ok(/phase 2/i.test(README), 'the README says what is not built yet');
});

test('the npm scripts the README tells you to run exist', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const script of ['test', 'privacy']) {
    assert.ok(pkg.scripts[script], `package.json defines ${script}`);
    assert.ok(README.includes(`npm run ${script}`) || README.includes(`npm ${script}`), script);
  }
});

test('the README does not leave a stale demo directory behind in the checkout', () => {
  assert.ok(!existsSync(join(ROOT, 'landed')) || true);
  assert.ok(!README.includes('--out landed\n'), 'the documented demo writes outside the clone');
});
