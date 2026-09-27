// `landed append`, and why appending a claim needs a helper at all.
//
// The claims file is append-only and written by several agents at once. A POSIX write to a file
// opened O_APPEND is atomic only up to PIPE_BUF (512 bytes guaranteed by POSIX, 4096 on Linux), and
// only if the whole line goes out in ONE write. Two agents that each do "open, write JSON, write
// newline" can interleave and produce a line that is neither claim. `append` makes that one write,
// and validates the claim before making it, so a malformed line never reaches the file at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, USAGE } from '../src/cli.mjs';
import { appendClaim, MAX_ATOMIC_APPEND } from '../src/append.mjs';
import { parseClaims } from '../src/claims.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'landed-append-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function run(argv, cwd) {
  const out = [];
  const err = [];
  const code = await main({ argv, out: (line) => out.push(line), err: (line) => err.push(line), cwd, env: {}, now: () => '2026-09-26T11:00:00.000Z' });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const CLAIM = {
  id: 'a-1',
  at: '2026-09-26T10:40:00.000Z',
  actor: 'lane-runner',
  kind: 'merged',
  target: { adapter: 'github', repo: 'example-org/example-repo', pr: 41 },
};

// --- the function ------------------------------------------------------------------------

test('append writes one line, newline included', async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, 'claims.jsonl');
    appendClaim(path, CLAIM);

    const text = readFileSync(path, 'utf8');
    assert.equal(text.split('\n').length, 2, 'one line and a trailing newline');
    assert.equal(parseClaims(text).records.length, 1);
  });
});

test('append creates the file when it is not there yet', async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, 'nested', 'claims.jsonl');
    appendClaim(path, CLAIM);
    assert.ok(existsSync(path));
  });
});

test('append adds to what is already there rather than replacing it', async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, 'claims.jsonl');
    appendClaim(path, CLAIM);
    appendClaim(path, { ...CLAIM, id: 'a-2' });

    assert.deepEqual(parseClaims(readFileSync(path, 'utf8')).records.map((record) => record.id), ['a-1', 'a-2']);
  });
});

test('append writes the line as ONE write, so a concurrent append cannot interleave with it', async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, 'claims.jsonl');
    const writes = [];

    // A fake writer that records each write it is asked to make. Two writes for one line is the bug.
    appendClaim(path, CLAIM, { write: (target, chunk) => writes.push(chunk) });

    assert.equal(writes.length, 1);
    assert.ok(writes[0].endsWith('\n'));
  });
});

test('append refuses a claim that would be malformed, before the file is touched', async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, 'claims.jsonl');

    assert.throws(() => appendClaim(path, { ...CLAIM, kind: 'delivered' }), /kind is not one of/);
    assert.equal(existsSync(path), false, 'nothing was written');
  });
});

test('append refuses a claim too long to be written atomically', async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, 'claims.jsonl');
    const huge = { ...CLAIM, evidence: { printed: 'x'.repeat(MAX_ATOMIC_APPEND) } };

    assert.throws(() => appendClaim(path, huge), /atomic/i);
    assert.equal(existsSync(path), false);
  });
});

test('the atomic limit is the POSIX guarantee, not a guess', () => {
  assert.equal(MAX_ATOMIC_APPEND, 512);
});

test('append never writes a newline inside the line', async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, 'claims.jsonl');
    appendClaim(path, { ...CLAIM, evidence: { printed: 'two\nlines' } });

    const text = readFileSync(path, 'utf8');
    assert.equal(text.split('\n').filter((line) => line !== '').length, 1);
    assert.equal(parseClaims(text).records[0].claim.evidence.printed, 'two\nlines');
  });
});

// --- the verb ----------------------------------------------------------------------------

test('the CLI appends a claim from flags', async () => {
  await inTempDir(async (dir) => {
    const { code } = await run(
      ['append', '--claims', 'claims.jsonl', '--at', '2026-09-26T10:40:00.000Z', '--actor', 'lane-runner', '--kind', 'merged', '--target', '{"adapter":"github","repo":"example-org/example-repo","pr":41}'],
      dir,
    );

    assert.equal(code, 0);
    const records = parseClaims(readFileSync(join(dir, 'claims.jsonl'), 'utf8')).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].claim.actor, 'lane-runner');
  });
});

test('the CLI generates an id and an instant when they are not given', async () => {
  await inTempDir(async (dir) => {
    await run(['append', '--claims', 'claims.jsonl', '--actor', 'x', '--kind', 'merged', '--target', '{"adapter":"github","repo":"example-org/example-repo","pr":1}'], dir);

    const claim = parseClaims(readFileSync(join(dir, 'claims.jsonl'), 'utf8')).records[0].claim;
    assert.equal(claim.at, '2026-09-26T11:00:00.000Z', 'the run clock');
    assert.match(claim.id, /^[a-z0-9-]+$/);
  });
});

test('the CLI refuses an append that check would call malformed, exit 2', async () => {
  await inTempDir(async (dir) => {
    const { code, err } = await run(['append', '--claims', 'claims.jsonl', '--actor', 'x', '--kind', 'merged', '--target', '{"adapter":"github","repo":"example-org/example-repo"}'], dir);

    assert.equal(code, 2);
    assert.match(err, /pr/);
    assert.equal(existsSync(join(dir, 'claims.jsonl')), false);
  });
});

test('the CLI refuses a --target that is not JSON', async () => {
  await inTempDir(async (dir) => {
    const { code, err } = await run(['append', '--claims', 'claims.jsonl', '--actor', 'x', '--kind', 'merged', '--target', 'adapter=github'], dir);
    assert.equal(code, 2);
    assert.match(err, /--target/);
  });
});

test('append is documented in the usage text with its flags', () => {
  assert.ok(USAGE.includes('landed.mjs append'));
  for (const flag of ['--actor', '--kind', '--target']) assert.ok(USAGE.includes(flag), flag);
});

test('a file written only by append is a file check can read', async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, 'claims.jsonl');
    for (const pr of [38, 41]) {
      await run(['append', '--claims', path, '--actor', 'lane-runner', '--kind', 'merged', '--target', `{"adapter":"github","repo":"example-org/example-repo","pr":${pr}}`], dir);
    }

    const { code } = await run(['validate', '--claims', path], dir);
    assert.equal(code, 0, 'validate is happy with what append wrote');
  });
});

test('the README tells the reader who appends the file and how', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /PIPE_BUF|single write/i);
  assert.match(readme, /landed\.mjs append/);
});
