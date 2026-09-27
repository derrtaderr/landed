// The static checks, and the rule that `validate` and `check` cannot disagree about them.
//
// Ship-check F-08: `validate` knew nothing about registered adapters or join keys, so it reported a
// merged claim with no `pr` as WELL FORMED while `check` resolved the same line
// `unresolved MALFORMED_CLAIM`. Same reason code, two answers, from two implementations of one idea.
//
// The fix is not "teach validate the same rules". It is one function, used by both, so a third
// static rule added tomorrow lands in both surfaces at once.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseClaims } from '../src/claims.mjs';
import { staticProblems, validationReport } from '../src/static-checks.mjs';
import { reconcile } from '../src/reconcile.mjs';
import { adapters } from '../src/adapters/index.mjs';

function claim(overrides = {}) {
  return {
    id: 'c-1',
    at: '2026-09-26T10:40:00.000Z',
    actor: 'lane-runner',
    kind: 'merged',
    target: { adapter: 'github', repo: 'example-org/example-repo', pr: 41 },
    ...overrides,
  };
}

// The cases the two surfaces used to answer differently.
const CASES = [
  { name: 'a merged claim with no pr', claim: claim({ target: { adapter: 'github', repo: 'example-org/example-repo' } }), reason: 'MALFORMED_CLAIM' },
  { name: 'a claim for an adapter nobody registered', claim: claim({ target: { adapter: 'gmail', messageId: 'm-1' } }), reason: 'UNKNOWN_ADAPTER' },
  { name: 'a kind the adapter does not answer', claim: claim({ kind: 'sent', target: { adapter: 'github', repo: 'example-org/example-repo', pr: 1 } }), reason: 'KIND_NOT_SUPPORTED' },
  { name: 'a pushed claim with neither branch nor commit', claim: claim({ kind: 'pushed', target: { adapter: 'github', repo: 'example-org/example-repo' } }), reason: 'MALFORMED_CLAIM' },
  { name: 'a join value carrying URL structure', claim: claim({ kind: 'pushed', target: { adapter: 'github', repo: 'example-org/example-repo', branch: 'main?x=1' } }), reason: 'MALFORMED_CLAIM' },
  { name: 'an adapter name with the wrong case', claim: claim({ target: { adapter: 'GitHub', repo: 'example-org/example-repo', pr: 1 } }), reason: 'UNKNOWN_ADAPTER' },
];

// An adapter registry that answers nothing, so a lookup cannot be what produced the reason.
const NO_LOOKUP = Object.fromEntries(
  Object.entries(adapters).map(([name, adapter]) => [
    name,
    {
      ...adapter,
      async lookup() {
        throw new Error('a static problem must be caught before any lookup');
      },
    },
  ]),
);

for (const testCase of CASES) {
  test(`${testCase.name}: validate and check give the same reason`, async () => {
    const line = JSON.stringify(testCase.claim);

    const report = validationReport(line, adapters);
    assert.equal(report.problems.length, 1, `validate found ${report.problems.length} problems`);
    assert.equal(report.problems[0].reason, testCase.reason);

    const { records } = parseClaims(line);
    const outcome = await reconcile({ records, adapters: NO_LOOKUP, deps: { config: {} } });
    assert.equal(outcome.results[0].state, 'unresolved');
    assert.equal(outcome.results[0].reasons[0], testCase.reason);
  });

  test(`${testCase.name}: and the same detail text, from one function`, () => {
    const line = JSON.stringify(testCase.claim);
    const report = validationReport(line, adapters);
    const problems = staticProblems(testCase.claim, adapters);

    assert.equal(problems.length, 1);
    assert.equal(report.problems[0].detail, `line 1: ${problems[0].detail}`);
  });
}

test('a well formed claim has no static problems', () => {
  assert.deepEqual(staticProblems(claim(), adapters), []);
  assert.equal(validationReport(JSON.stringify(claim()), adapters).problems.length, 0);
});

test('validate reports the line number and the claim id for every problem', () => {
  const text = [JSON.stringify(claim()), JSON.stringify(claim({ id: 'c-2', target: { adapter: 'nope' } }))].join('\n');
  const report = validationReport(text, adapters);

  assert.equal(report.total, 2);
  assert.equal(report.valid, 1);
  assert.deepEqual(report.problems.map((problem) => [problem.line, problem.id]), [[2, 'c-2']]);
});

test('validate still catches the schema problems it always caught', () => {
  const text = ['not json', JSON.stringify({ ...claim(), kind: 'delivered' }), JSON.stringify({ ...claim(), id: 'c-3', at: 'yesterday' })].join('\n');
  const report = validationReport(text, adapters);

  assert.equal(report.problems.length, 3);
  assert.ok(report.problems.every((problem) => problem.reason === 'MALFORMED_CLAIM'));
});

test('a schema problem stops the static checks, so one bad line gives one reason', () => {
  // A line with no target cannot also be told which adapter it should have named.
  const report = validationReport(JSON.stringify({ id: 'c-1', at: '2026-09-26T10:40:00.000Z', actor: 'x', kind: 'merged' }), adapters);
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0].detail, /target/);
});

test('the static checks need no adapter call, no file and no network', () => {
  // Called with a registry whose every lookup throws. Nothing here may touch one.
  assert.deepEqual(staticProblems(claim(), NO_LOOKUP), []);
});
