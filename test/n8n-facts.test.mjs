// The n8n remainders from the ship-check: F-02, F-09, F-11, and the claim-shape minors m-1 and m-8.
//
// The theme is the same one the whole review found: an unknown must not be resolved into whichever
// answer the code happened to reach for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseClaims } from '../src/claims.mjs';
import { validationReport } from '../src/static-checks.mjs';
import { reconcile } from '../src/reconcile.mjs';
import { n8n } from '../src/adapters/n8n.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOW = { from: '2026-09-26T10:00:00.000Z', to: '2026-09-26T11:00:00.000Z' };

function deps(executions, workflows) {
  return {
    readFile: (path) => (path === 'executions' ? JSON.stringify({ data: executions, nextCursor: null }) : JSON.stringify({ data: workflows, nextCursor: null })),
    config: { n8n: { executionsPath: 'executions', workflowsPath: 'workflows' } },
  };
}

async function resolve(claim, executions, workflows) {
  const { records } = parseClaims(JSON.stringify(claim));
  return reconcile({ records, adapters: { n8n }, deps: deps(executions, workflows) });
}

function executedClaim(extra = {}) {
  return { id: 'e-1', at: '2026-09-26T10:31:00.000Z', actor: 'x', kind: 'executed', target: { adapter: 'n8n', workflowId: 'wf-1', window: WINDOW, ...extra } };
}

const FIRED = [{ id: 'x-1', workflowId: 'wf-1', status: 'success', startedAt: '2026-09-26T10:30:00.000Z', finished: true }];

// --- F-02: an absent active flag is unknown, not false --------------------------------------

test('F-02: a workflows row with no active key is unresolved ACTIVE_FLAG_UNKNOWN', async () => {
  // The file's own comment said assuming true would manufacture a green. Assuming false manufactured
  // a red: every fire became contradicted FIRED_WHILE_INACTIVE.
  const outcome = await resolve(executedClaim(), FIRED, [{ id: 'wf-1', name: 'No flag here' }]);

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('ACTIVE_FLAG_UNKNOWN'));
});

test('F-02: active false is still a contradiction, and active true still matches', async () => {
  const inactive = await resolve(executedClaim(), FIRED, [{ id: 'wf-1', active: false }]);
  assert.equal(inactive.results[0].state, 'contradicted');
  assert.ok(inactive.results[0].reasons.includes('FIRED_WHILE_INACTIVE'));

  const active = await resolve(executedClaim(), FIRED, [{ id: 'wf-1', active: true }]);
  assert.equal(active.results[0].state, 'matched');
});

test('F-02: a non-boolean active value is unknown rather than coerced', async () => {
  for (const active of ['true', 1, null, {}]) {
    const outcome = await resolve(executedClaim(), FIRED, [{ id: 'wf-1', active }]);
    assert.equal(outcome.results[0].state, 'unresolved', JSON.stringify(active));
    assert.ok(outcome.results[0].reasons.includes('ACTIVE_FLAG_UNKNOWN'), JSON.stringify(active));
  }
});

test('F-02: the adapter reports the flag as null rather than deciding for the core', async () => {
  const receipt = await n8n.lookup({ workflowId: 'wf-1', window: WINDOW }, deps(FIRED, [{ id: 'wf-1' }]));
  assert.equal(receipt.facts.active, null);
});

// --- F-09 / D4: the window is half-open ------------------------------------------------------

test('F-09: an hourly workflow over a one-hour window expects one fire and gets one', async () => {
  // The reviewer's exp/exec-hourly.json: fires at 10:00:00 and at 11:00:00. With both window edges
  // inclusive that is two fires against floor(3600/3600) = 1, and a healthy hourly workflow was
  // contradicted forever. The window is half-open, [from, to), so 11:00 belongs to the next window.
  const hourly = [
    { id: 'h-1', workflowId: 'wf-1', status: 'success', startedAt: '2026-09-26T10:00:00.000Z', finished: true },
    { id: 'h-2', workflowId: 'wf-1', status: 'success', startedAt: '2026-09-26T11:00:00.000Z', finished: true },
  ];

  const outcome = await resolve(executedClaim({ cadence: { every_seconds: 3600 } }), hourly, [{ id: 'wf-1', active: true }]);

  assert.equal(outcome.results[0].state, 'matched');
  assert.match(outcome.results[0].detail, /1 time/);
});

test('F-09: the instant at `from` is inside the window and the instant at `to` is not', async () => {
  const atFrom = await n8n.lookup(
    { workflowId: 'wf-1', window: WINDOW },
    deps([{ id: 'a', workflowId: 'wf-1', status: 'success', startedAt: WINDOW.from, finished: true }], [{ id: 'wf-1', active: true }]),
  );
  assert.equal(atFrom.found, true, 'from is included');

  const atTo = await n8n.lookup(
    { workflowId: 'wf-1', window: WINDOW },
    deps([{ id: 'b', workflowId: 'wf-1', status: 'success', startedAt: WINDOW.to, finished: true }], [{ id: 'wf-1', active: true }]),
  );
  assert.equal(atTo.found, false, 'to belongs to the next window');
});

test('F-09: a genuinely missed hourly run is still contradicted', async () => {
  const outcome = await resolve(executedClaim({ cadence: { every_seconds: 1800 } }), FIRED, [{ id: 'wf-1', active: true }]);

  assert.equal(outcome.results[0].state, 'contradicted');
  assert.ok(outcome.results[0].reasons.includes('COUNT_VS_CADENCE'));
  assert.match(outcome.results[0].detail, /expects 2/);
});

test('F-09: the detail says the count is against the operator\'s declared expectation', async () => {
  const outcome = await resolve(executedClaim({ cadence: { expected_fires: 4 } }), FIRED, [{ id: 'wf-1', active: true }]);

  assert.equal(outcome.results[0].state, 'contradicted');
  assert.match(outcome.results[0].detail, /declared/);
});

// --- F-11: fires are deduplicated by execution id --------------------------------------------

test('F-11: an export assembled from overlapping pages is not a double fire', async () => {
  // The reviewer's exp/exec-dup.json: the same execution id twice, so the gap between them is 0s and
  // every run reported DOUBLE_FIRE against a workflow that fired once.
  const duplicated = [
    { id: 'x-1', workflowId: 'wf-1', status: 'success', startedAt: '2026-09-26T10:30:00.000Z', finished: true },
    { id: 'x-1', workflowId: 'wf-1', status: 'success', startedAt: '2026-09-26T10:30:00.000Z', finished: true },
  ];

  const outcome = await resolve(executedClaim(), duplicated, [{ id: 'wf-1', active: true }]);

  assert.equal(outcome.results[0].state, 'matched');
  assert.match(outcome.results[0].detail, /1 time/);
});

test('F-11: two DIFFERENT executions 14 seconds apart are still a double fire', async () => {
  const twice = [
    { id: 'x-1', workflowId: 'wf-1', status: 'success', startedAt: '2026-09-26T10:30:00.000Z', finished: true },
    { id: 'x-2', workflowId: 'wf-1', status: 'success', startedAt: '2026-09-26T10:30:14.000Z', finished: true },
  ];

  const outcome = await resolve(executedClaim(), twice, [{ id: 'wf-1', active: true }]);

  assert.equal(outcome.results[0].state, 'contradicted');
  assert.ok(outcome.results[0].reasons.includes('DOUBLE_FIRE'));
});

test('F-11: a deduplicated fires receipt covers the id once', async () => {
  const receipt = await n8n.lookup(
    { workflowId: 'wf-1', window: WINDOW },
    deps(
      [
        { id: 'x-1', workflowId: 'wf-1', status: 'success', startedAt: '2026-09-26T10:30:00.000Z', finished: true },
        { id: 'x-1', workflowId: 'wf-1', status: 'success', startedAt: '2026-09-26T10:30:00.000Z', finished: true },
      ],
      [{ id: 'wf-1', active: true }],
    ),
  );

  assert.deepEqual(receipt.facts.covers, ['x-1']);
});

// --- m-1: a window that does not parse ---------------------------------------------------------

test('m-1: a window whose instants do not parse is a malformed claim', async () => {
  const outcome = await resolve(executedClaim({ window: { from: 'garbage', to: 'garbage' } }), FIRED, [{ id: 'wf-1', active: true }]);

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('MALFORMED_CLAIM'));
  assert.notEqual(outcome.results[0].verdict, 'orphaned-claim');
});

test('m-1: a window that is not an object, or is backwards, is also malformed', async () => {
  for (const window of ['10:00 to 11:00', { from: WINDOW.from }, { from: WINDOW.to, to: WINDOW.from }, []]) {
    const outcome = await resolve(executedClaim({ window }), FIRED, [{ id: 'wf-1', active: true }]);
    assert.equal(outcome.results[0].state, 'unresolved', JSON.stringify(window));
    assert.ok(outcome.results[0].reasons.includes('MALFORMED_CLAIM'), JSON.stringify(window));
  }
});

test('m-1: validate reports the same bad window, at the same line', () => {
  const report = validationReport(JSON.stringify(executedClaim({ window: { from: 'garbage', to: 'garbage' } })), { n8n });
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0].detail, /window/);
});

// --- m-8: any ISO 8601 offset -------------------------------------------------------------------

test('m-8: an offset other than Z is accepted', () => {
  for (const at of ['2026-09-26T10:40:00+00:00', '2026-09-26T06:40:00-04:00', '2026-09-26T12:40:00+02:00', '2026-09-26T10:40:00.123+05:30']) {
    const { records } = parseClaims(JSON.stringify({ ...executedClaim(), at }));
    assert.equal(records[0].valid, true, at);
  }
});

test('m-8: an offset form still has to be a real instant', () => {
  for (const at of ['2026-09-26T10:40:00+25:00', '2026-09-26T10:40:00+0000extra', 'yesterday', '2026-09-26']) {
    const { records } = parseClaims(JSON.stringify({ ...executedClaim(), at }));
    assert.equal(records[0].valid, false, at);
  }
});

test('m-8: an offset instant is compared correctly, not lexically', async () => {
  // 06:40-04:00 is 10:40Z, inside the window. A string comparison would place it before 10:00.
  const outcome = await resolve({ ...executedClaim(), at: '2026-09-26T06:40:00-04:00' }, FIRED, [{ id: 'wf-1', active: true }]);
  assert.equal(outcome.results[0].state, 'matched');
});

test('the reviewer\'s own hourly fixture is the one this file pins', () => {
  // Reading it here keeps the test honest about where the case came from.
  const path = join(ROOT, 'fixtures', 'n8n', 'executions-hourly.json');
  const rows = JSON.parse(readFileSync(path, 'utf8')).data;
  assert.deepEqual(rows.map((row) => row.startedAt), ['2026-09-26T10:00:00.000Z', '2026-09-26T11:00:00.000Z']);
});
