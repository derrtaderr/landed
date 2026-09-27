// The join, case by case. docs/SPEC.md §3C.
//
// Every adapter below is built from nothing but the documented contract, so this file also
// demonstrates that the core needs no knowledge of a particular vendor to resolve a claim.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseClaims } from '../src/claims.mjs';
import { reconcile } from '../src/reconcile.mjs';

const WINDOW = { from: '2026-09-26T10:00:00.000Z', to: '2026-09-26T11:00:00.000Z' };
const COMPLETE = { complete: true, empty: false };

function adapterReturning(name, kinds, response, extras = {}) {
  return {
    [name]: {
      name,
      kinds,
      requiredKeys: {},
      async lookup() {
        return typeof response === 'function' ? response() : response;
      },
      ...extras,
    },
  };
}

async function resolve(claim, adapters, options = {}) {
  const { records } = parseClaims(JSON.stringify(claim));
  return reconcile({ records, adapters, ...options });
}

function claim(overrides) {
  return {
    id: 'c-1',
    at: '2026-09-26T10:30:00.000Z',
    actor: 'lane-runner',
    kind: 'merged',
    target: { adapter: 'vcs', repo: 'example-org/example-repo', pr: 7 },
    ...overrides,
  };
}

// --- the per-kind agreement checks ---------------------------------------------------

test('a merged claim against a merged PR is matched, and the detail carries the merge sha', async () => {
  const outcome = await resolve(
    claim({}),
    adapterReturning('vcs', ['merged'], {
      found: true,
      source: COMPLETE,
      facts: { kind: 'pull_request', repo: 'example-org/example-repo', number: 7, state: 'MERGED', merge_commit: 'deadbeefcafe' },
    }),
  );

  assert.equal(outcome.results[0].state, 'matched');
  assert.match(outcome.results[0].detail, /deadbeefcafe/);
});

test('a merged claim against an OPEN PR is contradicted, which is the vault lane bug', async () => {
  const outcome = await resolve(
    claim({}),
    adapterReturning('vcs', ['merged'], {
      found: true,
      source: COMPLETE,
      facts: { kind: 'pull_request', repo: 'example-org/example-repo', number: 7, state: 'OPEN' },
    }),
  );

  assert.equal(outcome.results[0].state, 'contradicted');
  assert.ok(outcome.results[0].reasons.includes('CLAIMED_MERGED_NOT_MERGED'));
  assert.match(outcome.results[0].detail, /open/);
});

test('a merged claim against a CLOSED unmerged PR is contradicted too', async () => {
  const outcome = await resolve(
    claim({}),
    adapterReturning('vcs', ['merged'], {
      found: true,
      source: COMPLETE,
      facts: { kind: 'pull_request', repo: 'example-org/example-repo', number: 7, state: 'CLOSED' },
    }),
  );

  assert.equal(outcome.results[0].state, 'contradicted');
});

test('a pushed claim for a commit contained in the default branch is matched', async () => {
  const outcome = await resolve(
    claim({ kind: 'pushed', target: { adapter: 'vcs', repo: 'example-org/example-repo', commit: 'abc1234' } }),
    adapterReturning('vcs', ['pushed'], {
      found: true,
      source: COMPLETE,
      facts: { kind: 'commit', sha: 'abc1234', on_default_branch: true, default_branch: 'main' },
    }),
  );

  assert.equal(outcome.results[0].state, 'matched');
});

test('a pushed claim for a commit that exists but is not on the default branch is contradicted', async () => {
  const outcome = await resolve(
    claim({ kind: 'pushed', target: { adapter: 'vcs', repo: 'example-org/example-repo', commit: 'abc1234' } }),
    adapterReturning('vcs', ['pushed'], {
      found: true,
      source: COMPLETE,
      facts: { kind: 'commit', sha: 'abc1234', on_default_branch: false, default_branch: 'main' },
    }),
  );

  assert.equal(outcome.results[0].state, 'contradicted');
  assert.ok(outcome.results[0].reasons.includes('COMMIT_NOT_ON_DEFAULT_BRANCH'));
});

test('a pushed claim for a branch that exists on the remote is matched', async () => {
  const outcome = await resolve(
    claim({ kind: 'pushed', target: { adapter: 'vcs', repo: 'example-org/example-repo', branch: 'lane/x' } }),
    adapterReturning('vcs', ['pushed'], {
      found: true,
      source: COMPLETE,
      facts: { kind: 'branch', name: 'lane/x', commit: 'abc1234' },
    }),
  );

  assert.equal(outcome.results[0].state, 'matched');
});

test('a completed claim against an execution that errored is contradicted', async () => {
  // The n8n report verbatim: run marked COMPLETED with ok true, next to status 403.
  const outcome = await resolve(
    claim({ kind: 'completed', target: { adapter: 'runner', executionId: 'e-77' } }),
    adapterReturning('runner', ['completed'], {
      found: true,
      source: COMPLETE,
      facts: { kind: 'execution', id: 'e-77', workflowId: 'wf-9', status: 'error' },
    }),
  );

  assert.equal(outcome.results[0].state, 'contradicted');
  assert.ok(outcome.results[0].reasons.includes('CLAIMED_COMPLETED_BUT_FAILED'));
  assert.match(outcome.results[0].detail, /error/);
});

test('a completed claim against a successful execution is matched', async () => {
  const outcome = await resolve(
    claim({ kind: 'completed', target: { adapter: 'runner', executionId: 'e-77' } }),
    adapterReturning('runner', ['completed'], {
      found: true,
      source: COMPLETE,
      facts: { kind: 'execution', id: 'e-77', workflowId: 'wf-9', status: 'success' },
    }),
  );

  assert.equal(outcome.results[0].state, 'matched');
});

// --- the named n8n checks -------------------------------------------------------------

function firesResponse(facts, source = { ...COMPLETE, window: WINDOW }) {
  return { found: true, source, facts: { kind: 'fires', workflowId: 'wf-201', active: true, ...facts } };
}

function executedClaim(extraTarget = {}) {
  return claim({
    kind: 'executed',
    target: { adapter: 'runner', workflowId: 'wf-201', window: WINDOW, ...extraTarget },
  });
}

test('fired-while-inactive: a fire recorded while the active flag was false is contradicted', async () => {
  const outcome = await resolve(
    executedClaim(),
    adapterReturning('runner', ['executed'], firesResponse({
      active: false,
      fires: [{ executionId: 'e-1', startedAt: '2026-09-26T10:05:00.000Z', status: 'success' }],
    })),
  );

  assert.equal(outcome.results[0].state, 'contradicted');
  assert.ok(outcome.results[0].reasons.includes('FIRED_WHILE_INACTIVE'));
});

test('double-fire: two fires 14 seconds apart are contradicted, the reported bug exactly', async () => {
  const outcome = await resolve(
    executedClaim(),
    adapterReturning('runner', ['executed'], firesResponse({
      fires: [
        { executionId: 'e-1', startedAt: '2026-09-26T10:05:00.000Z', status: 'success' },
        { executionId: 'e-2', startedAt: '2026-09-26T10:05:14.000Z', status: 'success' },
      ],
    })),
  );

  assert.equal(outcome.results[0].state, 'contradicted');
  assert.ok(outcome.results[0].reasons.includes('DOUBLE_FIRE'));
  assert.match(outcome.results[0].detail, /14s apart/);
});

test('double-fire: two fires far apart are not a double fire', async () => {
  const outcome = await resolve(
    executedClaim(),
    adapterReturning('runner', ['executed'], firesResponse({
      fires: [
        { executionId: 'e-1', startedAt: '2026-09-26T10:05:00.000Z', status: 'success' },
        { executionId: 'e-2', startedAt: '2026-09-26T10:35:00.000Z', status: 'success' },
      ],
    })),
  );

  assert.equal(outcome.results[0].state, 'matched');
});

test('double-fire: the window is configurable, and widening it catches a slower repeat', async () => {
  const fires = firesResponse({
    fires: [
      { executionId: 'e-1', startedAt: '2026-09-26T10:05:00.000Z', status: 'success' },
      { executionId: 'e-2', startedAt: '2026-09-26T10:05:40.000Z', status: 'success' },
    ],
  });

  const loose = await resolve(executedClaim(), adapterReturning('runner', ['executed'], fires));
  assert.equal(loose.results[0].state, 'matched');

  const tight = await resolve(executedClaim(), adapterReturning('runner', ['executed'], fires), { doubleFireSeconds: 60 });
  assert.equal(tight.results[0].state, 'contradicted');
  assert.ok(tight.results[0].reasons.includes('DOUBLE_FIRE'));
});

test('count-vs-cadence: fewer fires than the declared cadence is contradicted', async () => {
  const outcome = await resolve(
    executedClaim({ cadence: { expected_fires: 2 } }),
    adapterReturning('runner', ['executed'], firesResponse({
      fires: [{ executionId: 'e-1', startedAt: '2026-09-26T10:05:00.000Z', status: 'success' }],
    })),
  );

  assert.equal(outcome.results[0].state, 'contradicted');
  assert.ok(outcome.results[0].reasons.includes('COUNT_VS_CADENCE'));
  assert.match(outcome.results[0].detail, /expects 2/);
});

test('count-vs-cadence: every_seconds over the window derives the expected count', async () => {
  // An hour-long window at one fire every 30 minutes expects two.
  const outcome = await resolve(
    executedClaim({ cadence: { every_seconds: 1800 } }),
    adapterReturning('runner', ['executed'], firesResponse({
      fires: [
        { executionId: 'e-1', startedAt: '2026-09-26T10:05:00.000Z', status: 'success' },
        { executionId: 'e-2', startedAt: '2026-09-26T10:40:00.000Z', status: 'success' },
      ],
    })),
  );

  assert.equal(outcome.results[0].state, 'matched');
});

test('count-vs-cadence: a cadence the run cannot derive is unresolved, never a default', async () => {
  const outcome = await resolve(
    executedClaim({ cadence: { roughly: 'hourly' } }),
    adapterReturning('runner', ['executed'], firesResponse({
      fires: [{ executionId: 'e-1', startedAt: '2026-09-26T10:05:00.000Z', status: 'success' }],
    })),
  );

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('CADENCE_UNDECLARED'));
});

// --- the two named verdicts ------------------------------------------------------------

test('orphaned-claim: a complete read of a non-empty source with no such record', async () => {
  const outcome = await resolve(
    claim({}),
    adapterReturning('vcs', ['merged'], { found: false, source: COMPLETE }),
  );

  assert.equal(outcome.results[0].state, 'contradicted');
  assert.equal(outcome.results[0].verdict, 'orphaned-claim');
  assert.equal(outcome.summary.orphaned_claims, 1);
});

test('an orphaned claim names the join keys that were looked for', async () => {
  // "no record for this target" sends an operator back to the claims file to find out which
  // target. The keys are already in hand, so the detail carries them.
  const outcome = await resolve(
    claim({ kind: 'pushed', target: { adapter: 'vcs', repo: 'example-org/example-repo', branch: 'lane/never-pushed' } }),
    adapterReturning('vcs', ['pushed'], { found: false, source: COMPLETE }),
  );

  assert.match(outcome.results[0].detail, /repo=example-org\/example-repo/);
  assert.match(outcome.results[0].detail, /branch=lane\/never-pushed/);
});

test('executed-never-claimed: an enumerated run that no claim accounts for', async () => {
  const adapters = adapterReturning(
    'runner',
    ['executed'],
    firesResponse({ fires: [{ executionId: 'e-1', startedAt: '2026-09-26T10:05:00.000Z', status: 'success' }], covers: ['e-1'] }),
    {
      async enumerate() {
        return {
          source: COMPLETE,
          records: [
            { kind: 'execution', id: 'e-1', workflowId: 'wf-201', startedAt: '2026-09-26T10:05:00.000Z', status: 'success' },
            { kind: 'execution', id: 'e-2', workflowId: 'wf-999', startedAt: '2026-09-26T10:50:00.000Z', status: 'success' },
          ],
        };
      },
    },
  );

  const outcome = await resolve(executedClaim(), adapters);

  assert.equal(outcome.summary.executed_never_claimed, 1);
  const extra = outcome.results.find((result) => result.verdict === 'executed-never-claimed');
  assert.equal(extra.state, 'contradicted');
  assert.match(extra.detail, /e-2/);
  assert.equal(extra.claim_id, null);
});

test('executed-never-claimed: an enumeration that could not complete is unresolved, not zero', async () => {
  const adapters = adapterReturning('runner', ['executed'], firesResponse({ fires: [] }), {
    async enumerate() {
      return { reachable: false, reason: 'the export ends at 250 records' };
    },
  });

  const outcome = await resolve(executedClaim(), adapters);

  assert.equal(outcome.summary.executed_never_claimed, 0);
  assert.ok(outcome.results.some((result) => result.state === 'unresolved' && result.claim_id === null));
});

test('a receipt that declares no coverage accounts for nothing, which is the safe default', async () => {
  // The core does not guess which vendor field held the record ids. A receipt that stands for
  // several records says so in facts.covers; one that does not gets no credit.
  const adapters = adapterReturning(
    'runner',
    ['executed'],
    firesResponse({ fires: [{ executionId: 'e-1', startedAt: '2026-09-26T10:05:00.000Z', status: 'success' }] }),
    {
      async enumerate() {
        return {
          source: COMPLETE,
          records: [{ kind: 'execution', id: 'e-1', workflowId: 'wf-201', startedAt: '2026-09-26T10:05:00.000Z', status: 'success' }],
        };
      },
    },
  );

  const outcome = await resolve(executedClaim(), adapters);
  assert.equal(outcome.summary.executed_never_claimed, 1);
});

test('an adapter with no enumerate simply never produces the second verdict', async () => {
  const outcome = await resolve(
    executedClaim(),
    adapterReturning('runner', ['executed'], firesResponse({ fires: [{ executionId: 'e-1', startedAt: '2026-09-26T10:05:00.000Z', status: 'success' }] })),
  );

  assert.equal(outcome.summary.executed_never_claimed, 0);
  assert.equal(outcome.results.length, 1);
});

// --- routing refusals -----------------------------------------------------------------

test('a claim naming an adapter nobody registered is unresolved', async () => {
  const outcome = await resolve(claim({ target: { adapter: 'gmail', messageId: 'x' } }), adapterReturning('vcs', ['merged'], {}));

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('UNKNOWN_ADAPTER'));
});

test('a kind the adapter does not answer is unresolved, and the reason lists what it does answer', async () => {
  const outcome = await resolve(claim({ kind: 'sent' }), adapterReturning('vcs', ['merged', 'pushed'], {}));

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('KIND_NOT_SUPPORTED'));
  assert.match(outcome.results[0].detail, /merged, pushed/);
});

test('a target missing a join key the adapter needs is unresolved before any lookup', async () => {
  let lookedUp = false;
  const adapters = {
    vcs: {
      name: 'vcs',
      kinds: ['merged'],
      requiredKeys: { merged: ['repo', 'pr'] },
      async lookup() {
        lookedUp = true;
        return { found: true, source: COMPLETE, facts: {} };
      },
    },
  };

  const outcome = await resolve(claim({ target: { adapter: 'vcs', repo: 'example-org/example-repo' } }), adapters);

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('MALFORMED_CLAIM'));
  assert.match(outcome.results[0].detail, /pr/);
  assert.equal(lookedUp, false, 'no lookup is attempted for a target that cannot be joined');
});

test('an adapter that throws is unresolved, not a crash and not a match', async () => {
  const adapters = adapterReturning('vcs', ['merged'], () => {
    throw new Error('ENOENT: no such file');
  });

  const outcome = await resolve(claim({}), adapters);

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('ADAPTER_UNREACHABLE'));
  assert.match(outcome.results[0].detail, /ENOENT/);
});

// --- the summary ----------------------------------------------------------------------

test('strict_ok is false when anything is contradicted, even with matches present', async () => {
  const twoClaims = [
    JSON.stringify(claim({ id: 'c-1' })),
    JSON.stringify(claim({ id: 'c-2', target: { adapter: 'vcs', repo: 'example-org/example-repo', pr: 8 } })),
  ].join('\n');

  const { records } = parseClaims(twoClaims);
  const outcome = await reconcile({
    records,
    adapters: {
      vcs: {
        name: 'vcs',
        kinds: ['merged'],
        requiredKeys: {},
        async lookup(target) {
          const state = target.pr === 7 ? 'MERGED' : 'OPEN';
          return { found: true, source: COMPLETE, facts: { kind: 'pull_request', repo: target.repo, number: target.pr, state, merge_commit: 'sha' } };
        },
      },
    },
  });

  assert.equal(outcome.summary.matched, 1);
  assert.equal(outcome.summary.contradicted, 1);
  assert.equal(outcome.strict_ok, false);
});

test('strict_ok is true only when every claim matched', async () => {
  const outcome = await resolve(
    claim({}),
    adapterReturning('vcs', ['merged'], {
      found: true,
      source: COMPLETE,
      facts: { kind: 'pull_request', repo: 'example-org/example-repo', number: 7, state: 'MERGED', merge_commit: 'sha' },
    }),
  );

  assert.equal(outcome.strict_ok, true);
});

// --- alternative join keys -------------------------------------------------------------
//
// Some adapters need one of several keys rather than all of them: GitHub can answer a `pushed`
// claim about a branch OR about a commit. A nested array inside requiredKeys means "at least
// one of these".

test('a nested requiredKeys group is satisfied by any one of its keys', async () => {
  const adapters = {
    vcs: {
      name: 'vcs',
      kinds: ['pushed'],
      requiredKeys: { pushed: ['repo', ['branch', 'commit']] },
      async lookup() {
        return { found: true, source: COMPLETE, facts: { kind: 'branch', name: 'lane/x' } };
      },
    },
  };

  for (const key of ['branch', 'commit']) {
    const outcome = await resolve(
      claim({ kind: 'pushed', target: { adapter: 'vcs', repo: 'example-org/example-repo', [key]: 'value' } }),
      adapters,
    );
    assert.equal(outcome.results[0].state, 'matched', key);
  }
});

test('a nested requiredKeys group satisfied by none of its keys is unresolved, and names them all', async () => {
  const adapters = {
    vcs: {
      name: 'vcs',
      kinds: ['pushed'],
      requiredKeys: { pushed: ['repo', ['branch', 'commit']] },
      async lookup() {
        return { found: true, source: COMPLETE, facts: { kind: 'branch' } };
      },
    },
  };

  const outcome = await resolve(claim({ kind: 'pushed', target: { adapter: 'vcs', repo: 'example-org/example-repo' } }), adapters);

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('MALFORMED_CLAIM'));
  assert.match(outcome.results[0].detail, /branch or commit/);
});
