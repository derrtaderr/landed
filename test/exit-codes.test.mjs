// The exit-code contract. SPEC §3C.1, decided by the orchestrator after ship-check F-07.
//
//   0  ran, every claim resolved, nothing disagreed
//   1  findings: something is contradicted
//   2  a refusal: no claims file, nothing in it, an unwritable --out, a flag that makes no sense
//   3  nothing resolved: every claim came back unresolved. --strict promotes ANY unresolved to 3.
//
// The reason 3 exists at all: a run that lost its export path or its gh credential used to exit 0,
// which is the one number cron reads, and the documented cron recipe did not pass --strict. A lost
// credential must never share an exit code with a quiet healthy hour.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, USAGE } from '../src/cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPORTS = ['--n8n-executions', join(ROOT, 'fixtures', 'n8n', 'executions.json'), '--n8n-workflows', join(ROOT, 'fixtures', 'n8n', 'workflows.json')];

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'landed-exit-'));
  try {
    return await fn(dir);
  } finally {
    try {
      chmodSync(dir, 0o700);
    } catch {}
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

function claimsFile(dir, claims) {
  const path = join(dir, 'claims.jsonl');
  writeFileSync(path, `${claims.map((claim) => JSON.stringify(claim)).join('\n')}\n`);
  return path;
}

const MATCHING = { id: 'ok-1', at: '2026-09-26T10:31:00.000Z', actor: 'x', kind: 'completed', target: { adapter: 'n8n', executionId: 'e-1002' } };
const CONTRADICTING = { id: 'bad-1', at: '2026-09-26T10:51:00.000Z', actor: 'x', kind: 'completed', target: { adapter: 'n8n', executionId: 'e-4001' } };
const UNRESOLVABLE = { id: 'unk-1', at: '2026-09-26T10:31:00.000Z', actor: 'x', kind: 'sent', target: { adapter: 'gmail', messageId: 'm-1' } };

// --- the four codes ---------------------------------------------------------------------

test('exit 0: every claim resolved and nothing disagreed', async () => {
  await inTempDir(async (dir) => {
    const { code } = await run(['check', '--claims', claimsFile(dir, [MATCHING]), '--out', join(dir, 'o'), ...EXPORTS]);
    assert.equal(code, 0);
  });
});

test('exit 1: something is contradicted', async () => {
  await inTempDir(async (dir) => {
    const { code } = await run(['check', '--claims', claimsFile(dir, [MATCHING, CONTRADICTING]), '--out', join(dir, 'o'), ...EXPORTS]);
    assert.equal(code, 1);
  });
});

test('exit 3: every claim came back unresolved, with no --strict needed', async () => {
  await inTempDir(async (dir) => {
    const { code, out } = await run(['check', '--claims', claimsFile(dir, [UNRESOLVABLE]), '--out', join(dir, 'o'), ...EXPORTS]);
    assert.equal(code, 3);
    assert.match(out, /resolved nothing/i);
  });
});

test('exit 3: a lost export path is exit 3, not exit 0', async () => {
  // The F-07 scenario exactly: the operator's export moved and nobody configured it.
  await inTempDir(async (dir) => {
    const { code } = await run(['check', '--claims', claimsFile(dir, [MATCHING, CONTRADICTING]), '--out', join(dir, 'o')]);
    assert.equal(code, 3);
  });
});

test('a mixed run without --strict is exit 1, because a contradiction is the louder finding', async () => {
  await inTempDir(async (dir) => {
    const { code } = await run(['check', '--claims', claimsFile(dir, [CONTRADICTING, UNRESOLVABLE]), '--out', join(dir, 'o'), ...EXPORTS]);
    assert.equal(code, 1);
  });
});

test('--strict promotes ANY unresolved claim to exit 3, even beside a match', async () => {
  await inTempDir(async (dir) => {
    const loose = await run(['check', '--claims', claimsFile(dir, [MATCHING, UNRESOLVABLE]), '--out', join(dir, 'a'), ...EXPORTS]);
    assert.equal(loose.code, 0, 'without --strict, one unresolved beside a match is not fatal');

    const strict = await run(['check', '--claims', claimsFile(dir, [MATCHING, UNRESOLVABLE]), '--out', join(dir, 'b'), '--strict', ...EXPORTS]);
    assert.equal(strict.code, 3);
  });
});

test('--strict promotes unresolved over a contradiction, because an unread source outranks a finding', async () => {
  await inTempDir(async (dir) => {
    const { code } = await run(['check', '--claims', claimsFile(dir, [CONTRADICTING, UNRESOLVABLE]), '--out', join(dir, 'o'), '--strict', ...EXPORTS]);
    assert.equal(code, 3);
  });
});

test('exit 2: the refusals, and none of them is 1 or 3', async () => {
  await inTempDir(async (dir) => {
    const missing = await run(['check', '--claims', join(dir, 'nope.jsonl'), '--out', join(dir, 'o')]);
    assert.equal(missing.code, 2);

    const empty = join(dir, 'empty.jsonl');
    writeFileSync(empty, '\n\n');
    assert.equal((await run(['check', '--claims', empty, '--out', join(dir, 'o')])).code, 2);

    assert.equal((await run(['check', '--out', join(dir, 'o')])).code, 2, 'no --claims');
    assert.equal((await run(['check', '--claims', empty, '--yolo'])).code, 2, 'unknown flag');
    assert.equal((await run(['nonsense'])).code, 2, 'unknown verb');
    assert.equal((await run([])).code, 2, 'no verb');
  });
});

test('the exit code contract is documented in the usage text', () => {
  for (const line of ['0  ', '1  ', '2  ', '3  ']) assert.ok(USAGE.includes(line), line);
  assert.match(USAGE, /every claim unresolved|nothing resolved/i);
});

// --- the recipe the tool prints ------------------------------------------------------------

test('the watch recipe passes --strict, since it is the recipe that made F-07 possible', async () => {
  const { out } = await run(['watch']);
  const cronLine = out.split('\n').find((line) => line.includes('bin/landed.mjs check') && line.includes('* * * *'));

  assert.ok(cronLine !== undefined, 'the cron line is there');
  assert.match(cronLine, /--strict/);
  assert.match(out, /\bexit 3\b/);
});

test('the launchd recipe passes --strict too', async () => {
  const { out } = await run(['watch']);
  const plist = out.slice(out.indexOf('plist'));
  assert.match(plist, /--strict/);
});

// --- m-3, m-4, m-5 -------------------------------------------------------------------------

test('m-3: a repeated flag is refused rather than silently keeping the last value', async () => {
  const { code, err } = await run(['check', '--claims', 'a.jsonl', '--claims', 'b.jsonl']);
  assert.equal(code, 2);
  assert.match(err, /--claims given twice/);
});

test('m-3: a repeated boolean flag is refused too', async () => {
  const { code, err } = await run(['check', '--claims', 'a.jsonl', '--strict', '--strict']);
  assert.equal(code, 2);
  assert.match(err, /--strict given twice/);
});

test('m-3: --help on a verb prints usage and exits 0', async () => {
  for (const argv of [['check', '--help'], ['validate', '--help'], ['report', '--help'], ['demo', '--help'], ['watch', '--help']]) {
    const { code, out } = await run(argv);
    assert.equal(code, 0, argv.join(' '));
    assert.match(out, /Usage:/, argv.join(' '));
  }
});

test('m-4: report exits 0 when it rendered something and 2 when there is nothing to render', async () => {
  await inTempDir(async (dir) => {
    assert.equal((await run(['report', '--out', join(dir, 'nothing')])).code, 2);

    await run(['demo', '--out', dir]);
    assert.equal((await run(['report', '--out', dir])).code, 0);
  });
});

test('m-4: report exits 0 even when the receipt it renders is full of contradictions', async () => {
  await inTempDir(async (dir) => {
    await run(['demo', '--out', dir]);
    const { code, out } = await run(['report', '--out', dir]);

    assert.equal(code, 0, 'report reports; it does not re-decide');
    assert.match(out, /contradicted/);
  });
});

test('m-5: an unwritable --out is a one-line refusal at exit 2, not a stack trace', async () => {
  await inTempDir(async (dir) => {
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);

    const { code, err } = await run(['check', '--claims', claimsFile(dir, [MATCHING]), '--out', join(locked, 'out'), ...EXPORTS]);

    assert.equal(code, 2);
    assert.ok(!err.includes('at '), `no stack frames in: ${err}`);
    assert.equal(err.split('\n').filter((line) => line.trim() !== '').length, 1, err);
    assert.match(err, /cannot write/i);
  });
});

test('m-5: two runs in the same instant write two receipts, never one overwritten', async () => {
  await inTempDir(async (dir) => {
    const claims = claimsFile(dir, [MATCHING]);
    const at = () => '2026-09-26T11:00:00.000Z';

    await run(['check', '--claims', claims, '--out', dir, ...EXPORTS], { now: at });
    await run(['check', '--claims', claims, '--out', dir, '--recheck', ...EXPORTS], { now: at });

    assert.equal(readdirSync(join(dir, 'receipts')).filter((name) => name.endsWith('.json')).length, 2);
  });
});
