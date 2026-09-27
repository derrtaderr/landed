// The CLI surface: the verbs, the flags they accept, and the exit codes a cron reads.
//
// The exit code is the part that matters most. `landed` runs unattended, so a reconciler that
// exits 0 after finding a contradiction has told nobody anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, USAGE } from '../src/cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_CLAIMS = join(ROOT, 'fixtures', 'claims.jsonl');

// Awaited, not just called. A synchronous finally around an async body deletes the directory
// before the test has finished using it, and the failure that produces points at the wrong file.
async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'landed-cli-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function run(argv, options = {}) {
  const out = [];
  const err = [];
  const code = await main({
    argv,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    cwd: options.cwd ?? ROOT,
    env: options.env ?? {},
    now: options.now ?? (() => '2026-09-26T11:00:00.000Z'),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

// --- the surface ------------------------------------------------------------------------

test('no verb prints usage and exits non-zero', async () => {
  const { code, err } = await run([]);
  assert.notEqual(code, 0);
  assert.match(err, /Usage:/);
});

test('an unknown verb is refused by name rather than doing something surprising', async () => {
  const { code, err } = await run(['reconcile']);
  assert.notEqual(code, 0);
  assert.match(err, /unknown verb: reconcile/);
});

test('every verb the usage text documents is a verb the CLI dispatches', async () => {
  for (const verb of ['check', 'validate', 'report', 'demo', 'watch']) {
    assert.ok(USAGE.includes(`landed.mjs ${verb}`), `usage documents ${verb}`);
    const { err } = await run([verb, '--claims', FIXTURE_CLAIMS]);
    assert.ok(!err.includes(`unknown verb: ${verb}`), `${verb} is dispatched`);
  }
});

test('an unknown flag is refused, so no invocation quietly becomes a different one', async () => {
  const { code, err } = await run(['check', '--claims', FIXTURE_CLAIMS, '--yolo']);
  assert.notEqual(code, 0);
  assert.match(err, /unknown flag: --yolo/);
});

test('--flag=value is refused, because the usage text says to write them apart', async () => {
  const { code, err } = await run(['check', `--claims=${FIXTURE_CLAIMS}`]);
  assert.notEqual(code, 0);
  assert.match(err, /--claims=/);
});

test('the usage text advertises no bare invocation, because nothing installs landed on PATH', () => {
  for (const line of USAGE.split('\n')) {
    assert.ok(!line.trim().startsWith('landed check'), line);
  }
});

// --- validate ---------------------------------------------------------------------------

test('validate reports the malformed claims in the fixture corpus and exits non-zero', async () => {
  const { code, out } = await run(['validate', '--claims', FIXTURE_CLAIMS]);

  assert.notEqual(code, 0);
  assert.match(out, /c-10/);
  assert.match(out, /kind is not one of/);
});

test('validate on a clean file exits 0', async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, 'claims.jsonl');
    writeFileSync(path, `${JSON.stringify({ id: 'c-1', at: '2026-09-26T10:00:00.000Z', actor: 'a', kind: 'merged', target: { adapter: 'github', repo: 'example-org/example-repo', pr: 1 } })}\n`);

    const { code, out } = await run(['validate', '--claims', path]);
    assert.equal(code, 0);
    assert.match(out, /1 claim/);
  });
});

test('validate consults no adapter, so it needs no export and no gh', async () => {
  const { out } = await run(['validate', '--claims', FIXTURE_CLAIMS]);
  assert.ok(!out.includes('unreachable'));
});

// --- check, and the exit codes -----------------------------------------------------------

test('a missing claims file is a refusal naming the path, exit 2', async () => {
  const { code, err } = await run(['check', '--claims', join(tmpdir(), 'landed-no-such-file.jsonl')]);
  assert.equal(code, 2);
  assert.match(err, /landed-no-such-file\.jsonl/);
});

test('an empty claims file is a refusal, exit 2, and writes no receipt', async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, 'empty.jsonl');
    writeFileSync(path, '\n\n');

    const { code, err } = await run(['check', '--claims', path, '--out', join(dir, 'out')]);
    assert.equal(code, 2);
    assert.match(err, /EMPTY_CLAIMS/);
    assert.deepEqual(readdirSync(dir).sort(), ['empty.jsonl']);
  });
});

test('a run with a contradiction exits 1, because a cron that exits 0 tells nobody', async () => {
  await inTempDir(async (dir) => {
    const { code, out } = await run([
      'check',
      '--claims', FIXTURE_CLAIMS,
      '--out', dir,
      '--n8n-executions', join(ROOT, 'fixtures', 'n8n', 'executions.json'),
      '--n8n-workflows', join(ROOT, 'fixtures', 'n8n', 'workflows.json'),
    ]);

    assert.equal(code, 1);
    assert.match(out, /contradicted/);
  });
});

test('a run where everything matched exits 0', async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, 'claims.jsonl');
    writeFileSync(path, `${JSON.stringify({ id: 'c-1', at: '2026-09-26T10:30:00.000Z', actor: 'cron', kind: 'completed', target: { adapter: 'n8n', executionId: 'e-1002' } })}\n`);

    const { code } = await run(['check', '--claims', path, '--out', dir, '--n8n-executions', join(ROOT, 'fixtures', 'n8n', 'executions.json')]);
    assert.equal(code, 0);
  });
});

test('--strict turns an unresolved claim into a non-zero exit', async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, 'claims.jsonl');
    // No export configured, so the adapter is unreachable and the claim is unresolved.
    writeFileSync(path, `${JSON.stringify({ id: 'c-1', at: '2026-09-26T10:30:00.000Z', actor: 'cron', kind: 'completed', target: { adapter: 'n8n', executionId: 'e-1002' } })}\n`);

    const loose = await run(['check', '--claims', path, '--out', dir]);
    assert.equal(loose.code, 0, 'without --strict an unresolved claim is reported, not fatal');

    const strict = await run(['check', '--claims', path, '--out', join(dir, 'strict'), '--strict']);
    assert.notEqual(strict.code, 0);
  });
});

test('check writes exactly one receipt and says where it is', async () => {
  await inTempDir(async (dir) => {
    const { out } = await run([
      'check', '--claims', FIXTURE_CLAIMS, '--out', dir,
      '--n8n-executions', join(ROOT, 'fixtures', 'n8n', 'executions.json'),
      '--n8n-workflows', join(ROOT, 'fixtures', 'n8n', 'workflows.json'),
    ]);

    const written = readdirSync(join(dir, 'receipts'));
    assert.equal(written.length, 1);
    assert.match(out, /receipt/);
    assert.match(out, new RegExp(written[0].replace(/\./g, '\\.')));
  });
});

// --- demo -------------------------------------------------------------------------------

test('demo exits 0, needs no network and no credential', async () => {
  await inTempDir(async (dir) => {
    const { code, out } = await run(['demo', '--out', dir], { env: {} });

    assert.equal(code, 0, out);
  });
});

test('demo shows one of each state and both named verdicts', async () => {
  await inTempDir(async (dir) => {
    const { out } = await run(['demo', '--out', dir]);

    for (const needle of ['matched', 'contradicted', 'unresolved', 'orphaned-claim', 'executed-never-claimed']) {
      assert.match(out, new RegExp(needle), needle);
    }
  });
});

test('demo shows the fires-while-inactive case and the PR-claimed-merged case', async () => {
  await inTempDir(async (dir) => {
    const { out } = await run(['demo', '--out', dir]);

    assert.match(out, /FIRED_WHILE_INACTIVE/);
    assert.match(out, /CLAIMED_MERGED_NOT_MERGED/);
    assert.match(out, /DOUBLE_FIRE/);
    assert.match(out, /COUNT_VS_CADENCE/);
    assert.match(out, /CLOCK_SKEW/);
  });
});

test('demo writes nothing outside its --out directory', async () => {
  await inTempDir(async (outer) => {
    const out = join(outer, 'demo-out');
    const before = readdirSync(ROOT).sort();

    await run(['demo', '--out', out], { cwd: outer });

    assert.deepEqual(readdirSync(ROOT).sort(), before, 'the package directory is untouched');
    assert.deepEqual(readdirSync(outer).sort(), ['demo-out']);
  });
});

test('demo is deterministic, so the same run produces the same receipt twice', async () => {
  await inTempDir(async (dir) => {
    const first = await run(['demo', '--out', dir]);
    const receiptPath = join(dir, 'receipts', readdirSync(join(dir, 'receipts'))[0]);
    const firstReceipt = readFileSync(receiptPath, 'utf8');

    const second = await run(['demo', '--out', dir]);

    assert.equal(second.out, first.out);
    assert.equal(readFileSync(receiptPath, 'utf8'), firstReceipt);
  });
});

// --- report -----------------------------------------------------------------------------

test('report renders the latest receipt', async () => {
  await inTempDir(async (dir) => {
    await run(['demo', '--out', dir]);
    const { code, out } = await run(['report', '--out', dir]);

    assert.equal(code, 0);
    assert.match(out, /c-1\b/);
    assert.match(out, /contradicted/);
  });
});

test('report with no receipt yet says so rather than printing an empty table', async () => {
  await inTempDir(async (dir) => {
    const { code, err } = await run(['report', '--out', dir]);
    assert.notEqual(code, 0);
    assert.match(err, /no receipt/i);
  });
});

// --- watch ------------------------------------------------------------------------------

test('watch prints a cron and a launchd recipe and exits, because it is not a daemon', async () => {
  const { code, out } = await run(['watch']);

  assert.equal(code, 0);
  assert.match(out, /crontab/);
  assert.match(out, /launchd|launchctl/);
  assert.match(out, /not a daemon/i);
});
