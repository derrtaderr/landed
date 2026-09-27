// The claim's KIND decides what agreement means. Nothing else does.
//
// F-01, the blocking ship-check finding: a `completed` claim carrying both `executionId` and
// `workflowId` was routed to the n8n workflow-window branch, and `interpret` dispatched on the
// receipt's shape before it looked at the claim, so `checkFires` graded it and never read the
// execution's status. An errored execution came back `matched FIRED_AS_CLAIMED`, exit 0. An n8n
// hook has both ids in hand and will naturally write both.
//
// The rule this file enforces: no claim resolves `matched` while the receipt it is graded against
// carries a fact that disagrees with the claim's kind.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseClaims } from '../src/claims.mjs';
import { reconcile } from '../src/reconcile.mjs';
import { n8n } from '../src/adapters/n8n.mjs';

const COMPLETE = { complete: true, empty: false };

function execExport(rows) {
  return {
    readFile: () => JSON.stringify({ data: rows, nextCursor: null }),
    config: { n8n: { executionsPath: 'executions', workflowsPath: 'workflows' } },
  };
}

function bothExports(executions, workflows = [{ id: 'wf-204', name: 'Invoice reconciler', active: true }]) {
  return {
    readFile: (path) => JSON.stringify({ data: path === 'executions' ? executions : workflows, nextCursor: null }),
    config: { n8n: { executionsPath: 'executions', workflowsPath: 'workflows' } },
  };
}

async function resolveWith(claim, deps, adapters = { n8n }) {
  const { records } = parseClaims(JSON.stringify(claim));
  return reconcile({ records, adapters, deps });
}

function completedClaim(target) {
  return { id: 'a-1', at: '2026-09-26T10:51:00.000Z', actor: 'invoice-reconciler', kind: 'completed', target: { adapter: 'n8n', ...target } };
}

// --- F-01, the table the hard gate asks for ---------------------------------------------

test('F-01: a completed claim with BOTH ids, against an errored execution, is contradicted', async () => {
  const outcome = await resolveWith(
    completedClaim({ executionId: 'e-4001', workflowId: 'wf-204' }),
    bothExports([{ id: 'e-4001', workflowId: 'wf-204', status: 'error', startedAt: '2026-09-26T10:50:00.000Z', finished: true }]),
  );

  assert.equal(outcome.results[0].state, 'contradicted');
  assert.ok(outcome.results[0].reasons.includes('CLAIMED_COMPLETED_BUT_FAILED'));
  assert.equal(outcome.summary.matched, 0);
});

test('F-01: the same claim against a successful execution is matched', async () => {
  const outcome = await resolveWith(
    completedClaim({ executionId: 'e-4001', workflowId: 'wf-204' }),
    bothExports([{ id: 'e-4001', workflowId: 'wf-204', status: 'success', startedAt: '2026-09-26T10:50:00.000Z', finished: true }]),
  );

  assert.equal(outcome.results[0].state, 'matched');
});

test('m-9: a completed claim against a still-running execution is unresolved, not failed', async () => {
  // The old code called this CLAIMED_COMPLETED_BUT_FAILED. The reason code said failed while the
  // fact said running, which is a different wrong answer from the right one.
  for (const status of ['running', 'waiting', 'new']) {
    const outcome = await resolveWith(
      completedClaim({ executionId: 'r-1', workflowId: 'wf-204' }),
      bothExports([{ id: 'r-1', workflowId: 'wf-204', status, startedAt: '2026-09-26T10:50:00.000Z', finished: false }]),
    );

    assert.equal(outcome.results[0].state, 'unresolved', status);
    assert.ok(outcome.results[0].reasons.includes('STILL_RUNNING'), status);
  }
});

test('a completed claim against a crashed or cancelled execution is contradicted', async () => {
  for (const status of ['crashed', 'canceled']) {
    const outcome = await resolveWith(
      completedClaim({ executionId: 'e-1', workflowId: 'wf-204' }),
      bothExports([{ id: 'e-1', workflowId: 'wf-204', status, startedAt: '2026-09-26T10:50:00.000Z', finished: true }]),
    );

    assert.equal(outcome.results[0].state, 'contradicted', status);
  }
});

test('a completed claim against a status nobody recognises is unresolved, never matched', async () => {
  const outcome = await resolveWith(
    completedClaim({ executionId: 'e-1', workflowId: 'wf-204' }),
    bothExports([{ id: 'e-1', workflowId: 'wf-204', status: 'quantum', startedAt: '2026-09-26T10:50:00.000Z', finished: true }]),
  );

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('EXECUTION_STATUS_UNKNOWN'));
});

// --- the routing half of the same bug ----------------------------------------------------

test('an executionId in the target routes to the execution record, whatever else is there', async () => {
  const receipt = await n8n.lookup(
    { executionId: 'e-4001', workflowId: 'wf-204' },
    execExport([{ id: 'e-4001', workflowId: 'wf-204', status: 'error', startedAt: '2026-09-26T10:50:00.000Z', finished: true }]),
  );

  assert.equal(receipt.facts.kind, 'execution');
  assert.equal(receipt.facts.status, 'error');
});

// --- the interpret half, independent of any adapter --------------------------------------

test('a completed claim handed a fires receipt is unresolved, never graded as a fire', async () => {
  // Belt and braces. requiredKeys makes this unreachable through the n8n adapter today, but the
  // core must not grade a claim against a receipt of the wrong shape whatever an adapter does.
  const firesOnly = {
    n8n: {
      name: 'n8n',
      kinds: ['completed'],
      requiredKeys: {},
      async lookup() {
        return { found: true, source: COMPLETE, facts: { kind: 'fires', workflowId: 'wf-204', active: true, fires: [{ executionId: 'e-4001', startedAt: '2026-09-26T10:50:00.000Z', status: 'error' }] } };
      },
    },
  };

  const outcome = await resolveWith(completedClaim({ executionId: 'e-4001' }), { config: {} }, firesOnly);

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('RECEIPT_SHAPE_MISMATCH'));
});

test('an executed claim handed an execution record is matched, because it did execute', async () => {
  const outcome = await resolveWith(
    { id: 'x-1', at: '2026-09-26T10:51:00.000Z', actor: 'x', kind: 'executed', target: { adapter: 'n8n', workflowId: 'wf-204', executionId: 'e-4001' } },
    bothExports([{ id: 'e-4001', workflowId: 'wf-204', status: 'error', startedAt: '2026-09-26T10:50:00.000Z', finished: true }]),
  );

  assert.equal(outcome.results[0].state, 'matched');
});

test('a merged claim handed an n8n execution receipt is unresolved, not matched', async () => {
  const wrongShape = {
    n8n: {
      name: 'n8n',
      kinds: ['merged'],
      requiredKeys: {},
      async lookup() {
        return { found: true, source: COMPLETE, facts: { kind: 'execution', id: 'e-1', status: 'success' } };
      },
    },
  };

  const outcome = await resolveWith(
    { id: 'y-1', at: '2026-09-26T10:51:00.000Z', actor: 'x', kind: 'merged', target: { adapter: 'n8n', pr: 1 } },
    { config: {} },
    wrongShape,
  );

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('RECEIPT_SHAPE_MISMATCH'));
});

test('a receipt shape the kind does not accept can never produce matched', async () => {
  // Stated as the invariant rather than as "no combination matches", because `created` against a
  // pull_request receipt IS a match: for that kind, existence is the agreement. The invariant is
  // about the shapes a kind cannot read at all.
  const { RECEIPT_SHAPES_BY_KIND } = await import('../src/reconcile.mjs');
  const shapes = ['pull_request', 'branch', 'commit', 'execution', 'fires', 'message'];
  const kinds = ['merged', 'pushed', 'created', 'executed', 'completed', 'sent', 'updated'];
  let checked = 0;

  for (const shape of shapes) {
    for (const kind of kinds) {
      if (RECEIPT_SHAPES_BY_KIND[kind].includes(shape)) continue;
      checked += 1;
      const adapters = {
        probe: {
          name: 'probe',
          kinds: [kind],
          requiredKeys: {},
          async lookup() {
            return {
              found: true,
              source: COMPLETE,
              facts: { kind: shape, id: 'x', status: 'error', state: 'OPEN', active: false, fires: [], on_default_branch: false },
            };
          },
        },
      };

      const outcome = await resolveWith(
        { id: 'z-1', at: '2026-09-26T10:51:00.000Z', actor: 'x', kind, target: { adapter: 'probe' } },
        { config: {} },
        adapters,
      );

      assert.notEqual(outcome.results[0].state, 'matched', `${kind} against a ${shape} receipt`);
      assert.ok(outcome.results[0].reasons.includes('RECEIPT_SHAPE_MISMATCH'), `${kind}/${shape}`);
    }
  }

  assert.ok(checked >= 25, `checked ${checked} mismatched pairs, so the loop is not vacuous`);
});
