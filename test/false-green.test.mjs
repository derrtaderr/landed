// The false-green table. This file is the first one in the repo on purpose.
//
// GREEN IS EARNED. Every state below is a way the join can LOOK healthy while the
// authoritative side was never actually read, and each one must resolve to `unresolved` or to
// a refusal. None of them may ever produce `matched`. docs/SPEC.md §3C holds the table; this
// file is what makes it a rule.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseClaims } from '../src/claims.mjs';
import { reconcile } from '../src/reconcile.mjs';

const WINDOW = { from: '2026-09-26T10:00:00.000Z', to: '2026-09-26T11:00:00.000Z' };

function claimLine(overrides = {}) {
  return JSON.stringify({
    id: 'c-0001',
    at: '2026-09-26T10:30:00.000Z',
    actor: 'nightly-agent',
    kind: 'executed',
    target: { adapter: 'probe', workflowId: 'wf-201', window: WINDOW },
    ...overrides,
  });
}

// A minimal adapter built from nothing but the documented contract, whose lookup returns
// whatever shape the case under test needs.
function probe(response) {
  return {
    probe: {
      name: 'probe',
      kinds: ['executed'],
      requiredKeys: { executed: ['workflowId'] },
      async lookup() {
        return response;
      },
    },
  };
}

async function runOne(response, line = claimLine()) {
  const { records } = parseClaims(line);
  return reconcile({ records, adapters: probe(response) });
}

test('case 1: an empty claims file is a refusal, not a clean run', async () => {
  const { records } = parseClaims('');
  const outcome = await reconcile({ records, adapters: probe({ found: true, facts: {} }) });

  assert.equal(outcome.refusal?.reason, 'EMPTY_CLAIMS');
  assert.deepEqual(outcome.results, []);
  assert.equal(outcome.summary.matched, 0);
});

test('case 1b: a claims file of only blank lines is the same refusal', async () => {
  const { records } = parseClaims('\n\n   \n');
  const outcome = await reconcile({ records, adapters: probe({ found: true, facts: {} }) });

  assert.equal(outcome.refusal?.reason, 'EMPTY_CLAIMS');
});

test('case 2: an empty source is unresolved, because zero records is not absence', async () => {
  const outcome = await runOne({
    found: false,
    source: { complete: true, empty: true, window: WINDOW },
  });

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('EMPTY_SOURCE'));
  assert.equal(outcome.results[0].verdict, null);
  assert.equal(outcome.summary.matched, 0);
});

test('case 2b: an empty source is NOT reported as an orphaned claim', async () => {
  // The distinction the whole design turns on. An absence is evidence only when the source
  // returned something.
  const outcome = await runOne({
    found: false,
    source: { complete: true, empty: true, window: WINDOW },
  });

  assert.notEqual(outcome.results[0].verdict, 'orphaned-claim');
});

test('case 3: an unreachable adapter is unresolved, never green', async () => {
  const outcome = await runOne({ reachable: false, reason: 'gh is not authenticated' });

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('ADAPTER_UNREACHABLE'));
  assert.match(outcome.results[0].detail, /gh is not authenticated/);
});

test('case 4: a partial read is unresolved even when the record was not found', async () => {
  const outcome = await runOne({
    found: false,
    source: { complete: false, empty: false, truncated_at: 250, window: WINDOW },
  });

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('PARTIAL_READ'));
});

test('case 4b: a partial read is unresolved even when a record WAS found', async () => {
  // A truncated export can confirm a single record and still be the wrong basis for a count.
  const outcome = await runOne({
    found: true,
    facts: { kind: 'fires', workflowId: 'wf-201', active: true, fires: [{ executionId: 'e-1', startedAt: '2026-09-26T10:05:00.000Z', status: 'success' }] },
    source: { complete: false, empty: false, window: WINDOW },
  });

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('PARTIAL_READ'));
});

test('case 5: clock skew is unresolved, because the window read did not cover the claim', async () => {
  const outcome = await runOne({
    found: false,
    source: { complete: true, empty: false, window: { from: '2026-09-26T12:00:00.000Z', to: '2026-09-26T13:00:00.000Z' } },
  });

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('CLOCK_SKEW'));
});

test('case 5b: clock skew outranks a found record, so a fire outside the claim is not a match', async () => {
  const outcome = await runOne({
    found: true,
    facts: { kind: 'fires', workflowId: 'wf-201', active: true, fires: [{ executionId: 'e-9', startedAt: '2026-09-26T12:05:00.000Z', status: 'success' }] },
    source: { complete: true, empty: false, window: { from: '2026-09-26T12:00:00.000Z', to: '2026-09-26T13:00:00.000Z' } },
  });

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('CLOCK_SKEW'));
});

test('none of the five false-green states can produce a matched claim', async () => {
  const responses = [
    { found: false, source: { complete: true, empty: true, window: WINDOW } },
    { reachable: false, reason: 'unreachable' },
    { found: false, source: { complete: false, empty: false, window: WINDOW } },
    { found: true, facts: { kind: 'fires', workflowId: 'wf-201', active: true, fires: [] }, source: { complete: true, empty: false, window: { from: '2026-09-26T12:00:00.000Z', to: '2026-09-26T13:00:00.000Z' } } },
  ];

  for (const response of responses) {
    const outcome = await runOne(response);
    assert.equal(outcome.summary.matched, 0, JSON.stringify(response));
  }
});

test('a run whose every claim is unresolved is not green under --strict', async () => {
  const outcome = await runOne({ reachable: false, reason: 'unreachable' });

  assert.equal(outcome.summary.unresolved, 1);
  assert.equal(outcome.summary.matched, 0);
  assert.equal(outcome.strict_ok, false);
});
