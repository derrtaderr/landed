// Receipts and idempotency. docs/SPEC.md §3D.
//
// A receipt is the run's own record: the verdict per claim AND the adapter response that
// produced it, so a verdict can be re-derived rather than taken on trust. The second thing this
// file pins is that running the check again over the same claims does not re-report settled
// matches as news, which is what makes an hourly cron readable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseClaims } from '../src/claims.mjs';
import { runCheck } from '../src/run.mjs';
import { latestReceipt, readReceipts, receiptFilename } from '../src/receipts.mjs';

function unclaimedIds(outcome) {
  return outcome.results
    .filter((result) => result.verdict === 'executed-never-claimed')
    .map((result) => result.receipt.facts.id)
    .sort();
}

const WINDOW = { from: '2026-09-26T10:00:00.000Z', to: '2026-09-26T11:00:00.000Z' };

const CLAIMS = [
  { id: 'c-1', at: '2026-09-26T10:30:00.000Z', actor: 'lane-runner', kind: 'merged', target: { adapter: 'vcs', repo: 'example-org/example-repo', pr: 38 } },
  { id: 'c-2', at: '2026-09-26T10:31:00.000Z', actor: 'lane-runner', kind: 'merged', target: { adapter: 'vcs', repo: 'example-org/example-repo', pr: 41 } },
]
  .map((claim) => JSON.stringify(claim))
  .join('\n');

function vcsAdapter(counter) {
  return {
    vcs: {
      name: 'vcs',
      kinds: ['merged'],
      requiredKeys: { merged: ['repo', 'pr'] },
      async lookup(target) {
        counter.calls.push(target.pr);
        return {
          found: true,
          source: { complete: true, empty: false },
          facts: {
            kind: 'pull_request',
            repo: target.repo,
            number: target.pr,
            state: target.pr === 38 ? 'MERGED' : 'OPEN',
            merge_commit: target.pr === 38 ? 'aa11bb22' : null,
          },
        };
      },
    },
  };
}

// Awaited, not just called. A synchronous finally around an async body deletes the directory
// before the test has finished using it, and the failure that produces points at the wrong file.
async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'landed-receipts-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function check(dir, options = {}) {
  const counter = { calls: [] };
  const outcome = await runCheck({
    records: parseClaims(options.claims ?? CLAIMS).records,
    adapters: vcsAdapter(counter),
    deps: { config: {} },
    outDir: dir,
    at: options.at ?? '2026-09-26T11:00:00.000Z',
    inputs: { claims: 'claims.jsonl' },
    ...options,
  });
  return { ...outcome, calls: counter.calls };
}

// --- the receipt file ------------------------------------------------------------------

test('a run writes one receipt under receipts/, named for its instant', async () => {
  await inTempDir(async (dir) => {
    const { path } = await check(dir);

    assert.ok(path.includes(join('receipts', receiptFilename('2026-09-26T11:00:00.000Z'))));
    assert.deepEqual(readdirSync(join(dir, 'receipts')), [receiptFilename('2026-09-26T11:00:00.000Z')]);
  });
});

test('the receipt filename is filesystem safe and sorts chronologically', () => {
  const names = [
    receiptFilename('2026-09-26T09:00:00.000Z'),
    receiptFilename('2026-09-26T11:00:00.000Z'),
    receiptFilename('2026-10-01T08:00:00.000Z'),
  ];

  for (const name of names) assert.ok(!name.includes(':'), name);
  assert.deepEqual([...names].sort(), names);
});

test('the receipt carries the verdict AND the adapter response for every claim', async () => {
  await inTempDir(async (dir) => {
    const { path } = await check(dir);
    const receipt = JSON.parse(readFileSync(path, 'utf8'));

    assert.equal(receipt.results.length, 2);
    for (const result of receipt.results) {
      assert.ok(['matched', 'contradicted', 'unresolved'].includes(result.state));
      assert.ok(Array.isArray(result.reasons));
      assert.equal(typeof result.detail, 'string');
      assert.notEqual(result.receipt, null, 'the adapter response is stored beside the verdict');
    }
  });
});

test('the receipt records the run inputs, so a verdict can be re-derived', async () => {
  await inTempDir(async (dir) => {
    const { path } = await check(dir, { doubleFireSeconds: 20 });
    const receipt = JSON.parse(readFileSync(path, 'utf8'));

    assert.equal(receipt.at, '2026-09-26T11:00:00.000Z');
    assert.equal(receipt.inputs.claims, 'claims.jsonl');
    assert.equal(receipt.inputs.double_fire_seconds, 20);
    assert.equal(receipt.version, 1);
  });
});

test('the receipt never records a credential', async () => {
  await inTempDir(async (dir) => {
    const { path } = await check(dir, {
      deps: { config: { n8n: { url: 'https://n8n.example.com', apiKey: 'super-secret-value' } } },
    });

    assert.ok(!readFileSync(path, 'utf8').includes('super-secret-value'));
  });
});

// --- idempotency ------------------------------------------------------------------------

test('a second run over the same claims reports the settled match as carried, not as new', async () => {
  await inTempDir(async (dir) => {
    const first = await check(dir);
    assert.equal(first.outcome.results.find((result) => result.claim_id === 'c-1').carried, false);

    const second = await check(dir, { at: '2026-09-26T12:00:00.000Z' });
    const carried = second.outcome.results.find((result) => result.claim_id === 'c-1');

    assert.equal(carried.state, 'matched');
    assert.equal(carried.carried, true);
    assert.equal(second.outcome.summary.new_findings, 1, 'only the contradiction is news');
  });
});

test('a carried claim is not looked up again, which is what makes an hourly cron cheap', async () => {
  await inTempDir(async (dir) => {
    await check(dir);
    const second = await check(dir, { at: '2026-09-26T12:00:00.000Z' });

    assert.deepEqual(second.calls, [41], 'only the unsettled claim was re-read');
  });
});

test('--recheck re-verifies a carried claim from the adapter', async () => {
  await inTempDir(async (dir) => {
    await check(dir);
    const second = await check(dir, { at: '2026-09-26T12:00:00.000Z', recheck: true });

    assert.deepEqual(second.calls.sort(), [38, 41]);
    assert.equal(second.outcome.results.find((result) => result.claim_id === 'c-1').carried, false);
  });
});

test('a contradiction is never carried, because it is still true and still unfixed', async () => {
  await inTempDir(async (dir) => {
    await check(dir);
    const second = await check(dir, { at: '2026-09-26T12:00:00.000Z' });
    const contradiction = second.outcome.results.find((result) => result.claim_id === 'c-2');

    assert.equal(contradiction.state, 'contradicted');
    assert.equal(contradiction.carried, false);
  });
});

test('the second run writes its own receipt rather than overwriting the first', async () => {
  await inTempDir(async (dir) => {
    await check(dir);
    await check(dir, { at: '2026-09-26T12:00:00.000Z' });

    assert.equal(readdirSync(join(dir, 'receipts')).length, 2);
    assert.equal(readReceipts(dir).length, 2);
    assert.equal(latestReceipt(dir).at, '2026-09-26T12:00:00.000Z');
  });
});

test('a carried claim keeps accounting for the records it covered, so nothing looks unclaimed', async () => {
  // The trap: skip the lookup for a settled claim, lose the executions its receipt covered, and
  // report them as executed-never-claimed on every subsequent run.
  const claims = JSON.stringify({
    id: 'c-1',
    at: '2026-09-26T10:30:00.000Z',
    actor: 'cron',
    kind: 'executed',
    target: { adapter: 'runner', workflowId: 'wf-201', window: WINDOW },
  });

  const adapters = {
    runner: {
      name: 'runner',
      kinds: ['executed'],
      requiredKeys: { executed: ['workflowId'] },
      subjectKey: 'workflowId',
      async lookup() {
        return {
          found: true,
          source: { complete: true, empty: false, window: WINDOW },
          facts: { kind: 'fires', workflowId: 'wf-201', active: true, fires: [{ executionId: 'e-1', startedAt: '2026-09-26T10:30:00.000Z', status: 'success' }], covers: ['e-1'] },
        };
      },
      async enumerate() {
        return {
          source: { complete: true, empty: false },
          records: [
            { kind: 'execution', id: 'e-1', subject: 'wf-201', workflowId: 'wf-201', startedAt: '2026-09-26T10:30:00.000Z', status: 'success' },
            // A run nobody claimed, of the SAME workflow, since D2 scopes enumeration to the
            // subjects the claims named. Its presence in the report is the proof that the second
            // pass enumerated at all, so "e-1 was not reported" cannot pass by the enumeration
            // silently never running.
            { kind: 'execution', id: 'e-stray', subject: 'wf-201', workflowId: 'wf-201', startedAt: '2026-09-26T10:40:00.000Z', status: 'success' },
          ],
        };
      },
    },
  };

  await inTempDir(async (dir) => {
    const base = { records: parseClaims(claims).records, adapters, deps: { config: {} }, outDir: dir, inputs: {} };

    const first = await runCheck({ ...base, at: '2026-09-26T11:00:00.000Z' });
    assert.equal(first.outcome.summary.executed_never_claimed, 1);
    assert.deepEqual(unclaimedIds(first.outcome), ['e-stray']);

    const second = await runCheck({ ...base, at: '2026-09-26T12:00:00.000Z' });
    assert.deepEqual(unclaimedIds(second.outcome), ['e-stray'], 'the carried claim still covers e-1');
  });
});

// --- the refusal ------------------------------------------------------------------------

test('an empty claims file writes no receipt and refuses', async () => {
  await inTempDir(async (dir) => {
    const { outcome, path } = await check(dir, { claims: '' });

    assert.equal(outcome.refusal.reason, 'EMPTY_CLAIMS');
    assert.equal(path, null);
    assert.equal(readReceipts(dir).length, 0);
  });
});

test('reading receipts from a directory that does not exist is empty, not a crash', () => {
  assert.deepEqual(readReceipts(join(tmpdir(), 'landed-does-not-exist-9f3a')), []);
  assert.equal(latestReceipt(join(tmpdir(), 'landed-does-not-exist-9f3a')), null);
});

// --- m-6: the settled index, and --since ----------------------------------------------------
//
// Ship-check measured a 50MB claims file producing a 482MB receipt set, then 11 seconds and 2.8GB
// RSS on the next run, all of it re-parsing history. A run now reads one small index instead.

test('m-6: a run writes a settled index beside the receipts, not inside them', async () => {
  await inTempDir(async (dir) => {
    await check(dir);

    const index = JSON.parse(readFileSync(join(dir, 'settled.json'), 'utf8'));
    assert.equal(index.version, 1);
    assert.ok(Object.keys(index.claims).includes('c-1'), 'the matched claim is in it');
    assert.ok(!Object.keys(index.claims).includes('c-2'), 'the contradicted one is not');
    assert.ok(!readdirSync(join(dir, 'receipts')).includes('settled.json'));
  });
});

test('m-6: the second run reads the index, not every receipt ever written', async () => {
  await inTempDir(async (dir) => {
    await check(dir);

    // Remove the history. If the second run still carries c-1 forward, it read the index.
    rmSync(join(dir, 'receipts'), { recursive: true, force: true });

    const second = await check(dir, { at: '2026-09-26T12:00:00.000Z' });
    const carried = second.outcome.results.find((result) => result.claim_id === 'c-1');

    assert.equal(carried.carried, true);
    assert.deepEqual(second.calls, [41], 'and it still skipped the lookup');
  });
});

test('m-6: a lost index is rebuilt from the receipts rather than losing what was settled', async () => {
  await inTempDir(async (dir) => {
    await check(dir);
    rmSync(join(dir, 'settled.json'), { force: true });

    const second = await check(dir, { at: '2026-09-26T12:00:00.000Z' });
    assert.equal(second.outcome.results.find((result) => result.claim_id === 'c-1').carried, true);
  });
});

test('m-6: a corrupt index is rebuilt rather than being fatal', async () => {
  await inTempDir(async (dir) => {
    await check(dir);
    writeFileSync(join(dir, 'settled.json'), '{ this is not json');

    const second = await check(dir, { at: '2026-09-26T12:00:00.000Z' });
    assert.equal(second.outcome.results.find((result) => result.claim_id === 'c-1').carried, true);
  });
});

test('m-6: --since skips claims older than the instant given', async () => {
  await inTempDir(async (dir) => {
    const outcome = await check(dir, { since: '2026-09-26T10:31:00.000Z' });

    // c-1 is dated 10:30 and c-2 is dated 10:31.
    assert.deepEqual(outcome.outcome.results.map((result) => result.claim_id), ['c-2']);
  });
});

test('m-6: --since keeps a malformed line, because its instant cannot be trusted to exclude it', async () => {
  await inTempDir(async (dir) => {
    const outcome = await check(dir, { claims: `not json\n${CLAIMS}`, since: '2026-09-26T10:31:00.000Z' });

    assert.ok(outcome.outcome.results.some((result) => result.reasons.includes('MALFORMED_CLAIM')));
  });
});

test('m-6: the receipt records the since bound it ran with', async () => {
  await inTempDir(async (dir) => {
    const { path } = await check(dir, { since: '2026-09-26T10:31:00.000Z' });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).inputs.since, '2026-09-26T10:31:00.000Z');
  });
});
