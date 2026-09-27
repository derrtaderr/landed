// Enumeration: what ran that nobody claimed. Decision D2, after ship-check F-03 and F-04.
//
// Three things were wrong and all three came from treating an unclaimed run as a contradiction of
// a claim that does not exist:
//
//   F-03  a claim whose lookup came back unreachable had no facts, so its OWN executions were
//         reported as unclaimed. Omitting --n8n-workflows turned one unresolved claim into seven
//         false contradictions and exit 1.
//   F-04  the scope was every workflow in the export, not the ones the claims named, and the rows
//         were never carried. One claim on a busy instance meant every other workflow's runs,
//         every hour, forever.
//   D2    an unclaimed run is not a contradiction. It is its own row class, in its own section,
//         it does not set the exit code, and once reported it is carried like any other finding.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseClaims } from '../src/claims.mjs';
import { reconcile } from '../src/reconcile.mjs';
import { runCheck } from '../src/run.mjs';
import { n8n } from '../src/adapters/n8n.mjs';
import { main } from '../src/cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTIONS = join(ROOT, 'fixtures', 'n8n', 'executions.json');
const WORKFLOWS = join(ROOT, 'fixtures', 'n8n', 'workflows.json');
const WINDOW = { from: '2026-09-26T10:00:00.000Z', to: '2026-09-26T11:00:00.000Z' };

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'landed-enum-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WORKFLOWS_PARTIAL = join(ROOT, 'fixtures', 'n8n', 'workflows-partial.json');

function n8nDeps({ workflows = true, partialWorkflows = false } = {}) {
  const workflowsPath = partialWorkflows ? WORKFLOWS_PARTIAL : WORKFLOWS;
  return {
    readFile: (path) => require$readFile(path),
    config: { n8n: { executionsPath: EXECUTIONS, ...(workflows ? { workflowsPath } : {}) } },
  };
}

// node:fs read, kept out of the adapter as the contract requires.
import { readFileSync } from 'node:fs';
function require$readFile(path) {
  return readFileSync(path, 'utf8');
}

function executedClaim(id, workflowId, extra = {}) {
  return { id, at: '2026-09-26T10:31:00.000Z', actor: 'x', kind: 'executed', target: { adapter: 'n8n', workflowId, window: WINDOW, ...extra } };
}

// The shape an unclaimed run actually has under D2, and the reason these tests changed shape during
// the fix: a fires receipt COVERS every fire inside its own window, so a run of a claimed workflow
// can only be unclaimed when it falls outside that claim's window while another claim widens the
// enumeration scope to reach it. Here wf-206 is claimed for the first half hour only, and its real
// run at 10:55 is the finding.
const NARROW = { from: '2026-09-26T10:00:00.000Z', to: '2026-09-26T10:30:00.000Z' };
const CLAIMED_LATE_RUN = [
  executedClaim('c-1', 'wf-201'),
  { id: 'c-206', at: '2026-09-26T10:21:00.000Z', actor: 'x', kind: 'executed', target: { adapter: 'n8n', workflowId: 'wf-206', window: NARROW } },
];

async function resolve(claims, options = {}) {
  const { records } = parseClaims(claims.map((claim) => JSON.stringify(claim)).join('\n'));
  return reconcile({ records, adapters: { n8n }, deps: n8nDeps(options), ...options });
}

function unclaimedRows(outcome) {
  return outcome.results.filter((result) => result.state === 'unclaimed');
}

// --- D2: an unclaimed run is its own row class ---------------------------------------------

test('D2: an unclaimed run is state `unclaimed`, not `contradicted`', async () => {
  const outcome = await resolve(CLAIMED_LATE_RUN);
  const rows = unclaimedRows(outcome);

  assert.ok(rows.length >= 1, 'wf-206 ran at 10:55, outside the claim about it');
  for (const row of rows) {
    assert.equal(row.state, 'unclaimed');
    assert.equal(row.verdict, 'executed-never-claimed');
  }
  // c-206 IS contradicted, because wf-206 did not run inside the window it claimed. What must not
  // happen is the unclaimed RUN being counted as a contradiction of anything.
  assert.equal(rows.filter((row) => row.state === 'contradicted').length, 0);
  assert.equal(outcome.summary.contradicted, 1, 'exactly the orphaned claim, and nothing from enumeration');
  assert.equal(outcome.results.filter((row) => row.verdict === 'orphaned-claim').length, 1);
});

test('D2: the summary counts claims and unclaimed runs separately', async () => {
  const outcome = await resolve(CLAIMED_LATE_RUN);

  assert.equal(outcome.summary.claims, 2);
  assert.equal(outcome.summary.unclaimed, unclaimedRows(outcome).length);
  assert.equal(outcome.summary.matched + outcome.summary.contradicted + outcome.summary.unresolved, outcome.summary.claims);
});

// --- F-04: the scope is the workflows the claims named -------------------------------------

test('F-04: enumeration covers only the workflows the claims named', async () => {
  // wf-201 and wf-206 are claimed. wf-203, wf-204 and wf-207 all ran inside the same window and
  // nobody claimed them, which is exactly the noise F-04 was about. They must not appear.
  const outcome = await resolve(CLAIMED_LATE_RUN);

  assert.deepEqual(unclaimedRows(outcome).map((row) => row.receipt.facts.workflowId), ['wf-206']);
});

test('F-04: the unclaimed run reported IS a run of the claimed workflow outside the claim', async () => {
  const outcome = await resolve(CLAIMED_LATE_RUN, { enumerateAll: false });

  assert.deepEqual(unclaimedRows(outcome).map((row) => row.receipt.facts.id), ['e-6001']);
});

test('F-04: a fire inside the claim window is covered by the claim, never reported as unclaimed', async () => {
  // The other half of the rule. wf-201 fired at 10:30, inside its claim, so the claim's receipt
  // covers it and no enumeration row appears for it.
  const outcome = await resolve(CLAIMED_LATE_RUN);
  assert.ok(!unclaimedRows(outcome).some((row) => row.receipt.facts.id === 'e-1002'));
});

test('F-04: --enumerate all widens the scope to everything in the window', async () => {
  const outcome = await resolve(CLAIMED_LATE_RUN, { enumerateAll: true });
  const workflows = new Set(unclaimedRows(outcome).map((row) => row.receipt.facts.workflowId));

  assert.ok(workflows.size > 1, `saw ${[...workflows].join(', ')}`);
  assert.ok(workflows.has('wf-206'));
});

test('F-04: an unclaimed row is carried on the next run and does not alarm twice', async () => {
  await inTempDir(async (dir) => {
    const claims = join(dir, 'claims.jsonl');
    writeFileSync(claims, `${CLAIMED_LATE_RUN.map((claim) => JSON.stringify(claim)).join('\n')}\n`);
    const base = { records: parseClaims(readFileSync(claims, 'utf8')).records, adapters: { n8n }, deps: n8nDeps(), outDir: dir, inputs: {} };

    const first = await runCheck({ ...base, at: '2026-09-26T11:00:00.000Z' });
    const firstRows = first.outcome.results.filter((row) => row.state === 'unclaimed');
    assert.ok(firstRows.length >= 1);
    assert.equal(firstRows[0].carried, false);

    const second = await runCheck({ ...base, at: '2026-09-26T12:00:00.000Z' });
    const secondRows = second.outcome.results.filter((row) => row.state === 'unclaimed');
    assert.deepEqual(secondRows.map((row) => row.carried), firstRows.map(() => true));
    assert.equal(secondRows.filter((row) => row.carried !== true).length, 0, 'no unclaimed run is news twice');
    // The contradiction beside it is NOT carried, because it is still true and still unfixed. That
    // is the difference between a finding about a claim and a finding about a run nobody claimed.
    assert.equal(second.outcome.summary.new_findings, 1);
    assert.equal(secondRows[0].first_seen, '2026-09-26T11:00:00.000Z', 'it remembers when it was first seen');
  });
});

// --- F-03: an unreachable lookup suppresses its own workflow --------------------------------

test('F-03: omitting the workflows export does not turn one unresolved claim into contradictions', async () => {
  // The exact reproduce from the ship-check. Without --n8n-workflows the fired-while-inactive check
  // cannot run, so the claim is unresolved; its own executions must not then be reported as runs
  // nobody claimed.
  const outcome = await resolve([executedClaim('c-1', 'wf-201')], { workflows: false });

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.equal(outcome.summary.contradicted, 0);
  assert.equal(outcome.summary.executed_never_claimed, 0);
});

test('F-03: the suppressed workflow is reported as skipped, not silently dropped', async () => {
  const outcome = await resolve([executedClaim('c-1', 'wf-201')], { workflows: false });
  const skipped = outcome.results.filter((row) => row.reasons.includes('ENUMERATION_SUPPRESSED'));

  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].state, 'unresolved');
  assert.match(skipped[0].detail, /wf-201/);
});

test('F-03: one unreadable workflow does not suppress enumeration of a readable one', async () => {
  // wf-206 fired, and workflows-partial.json does not list it, so its active flag is unknown and its
  // claim is unresolved: it is suppressed. wf-203 also fired, IS listed, and its claim covers only
  // the first five minutes, so its 10:10 runs are genuinely unclaimed and must still be reported.
  const claims = [
    executedClaim('c-1', 'wf-201'),
    { id: 'c-203', at: '2026-09-26T10:02:00.000Z', actor: 'x', kind: 'executed', target: { adapter: 'n8n', workflowId: 'wf-203', window: { from: '2026-09-26T10:00:00.000Z', to: '2026-09-26T10:05:00.000Z' } } },
    executedClaim('c-206', 'wf-206'),
  ];

  const outcome = await resolve(claims, { partialWorkflows: true });

  assert.ok(outcome.results.some((row) => row.reasons.includes('ENUMERATION_SUPPRESSED') && row.detail.includes('wf-206')), 'wf-206 is suppressed');
  assert.ok(!unclaimedRows(outcome).some((row) => row.receipt.facts.workflowId === 'wf-206'), 'and none of its runs is reported');
  assert.deepEqual(
    unclaimedRows(outcome).map((row) => row.receipt.facts.id).sort(),
    ['e-3001', 'e-3002'],
    'while the readable workflow is still enumerated',
  );
});

// --- F-10: a windowless claim is bounded ----------------------------------------------------

test('F-10: an executed claim with no window is bounded to a default window around its instant', async () => {
  // The old behaviour matched any fire of that workflow in the export, including one three days
  // older than the claim.
  const claim = { id: 'g-1', at: '2026-09-29T10:31:00.000Z', actor: 'x', kind: 'executed', target: { adapter: 'n8n', workflowId: 'wf-201' } };
  const outcome = await resolve([claim]);

  assert.notEqual(outcome.results[0].state, 'matched', 'a fire three days earlier is not this claim');
});

test('F-10: a windowless claim still matches a fire near its own instant', async () => {
  const claim = { id: 'g-2', at: '2026-09-26T10:31:00.000Z', actor: 'x', kind: 'executed', target: { adapter: 'n8n', workflowId: 'wf-201' } };
  const outcome = await resolve([claim]);

  assert.equal(outcome.results[0].state, 'matched');
});

test('F-10: the default window is stated in the result, so nobody has to guess it', async () => {
  const claim = { id: 'g-3', at: '2026-09-26T10:31:00.000Z', actor: 'x', kind: 'executed', target: { adapter: 'n8n', workflowId: 'wf-201' } };
  const outcome = await resolve([claim]);

  assert.notEqual(outcome.results[0].window, null);
  assert.equal(outcome.results[0].window_source, 'default');
});

test('F-10: a declared window is used as given and says so', async () => {
  const outcome = await resolve([executedClaim('c-1', 'wf-201')]);
  assert.deepEqual(outcome.results[0].window, WINDOW);
  assert.equal(outcome.results[0].window_source, 'claim');
});

// --- the CLI flag ---------------------------------------------------------------------------

test('--enumerate takes only the documented values', async () => {
  const err = [];
  const code = await main({
    argv: ['check', '--claims', join(ROOT, 'fixtures', 'claims.jsonl'), '--enumerate', 'everything'],
    out: () => {},
    err: (line) => err.push(line),
    cwd: ROOT,
    env: {},
    now: () => '2026-09-26T11:00:00.000Z',
  });

  assert.equal(code, 2);
  assert.match(err.join('\n'), /--enumerate/);
});
