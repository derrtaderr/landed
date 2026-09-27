// Three corrections made at gate time by the orchestrator after the second ship-check pass
// (BLESS with N-1, N-5, N-7 on record). Each test was red against 64b8eac before its fix.

import test from 'node:test';
import assert from 'node:assert/strict';

import { github } from '../src/adapters/github.mjs';
import { exitFor } from '../src/cli.mjs';
import { renderReceipt } from '../src/report.mjs';

const REPO = 'example-org/example-repo';

function deps(bodyByKey) {
  return {
    exec(file, args) {
      const key = args.join(' ');
      if (!(key in bodyByKey)) throw new Error(`no recording for: gh ${key}`);
      return { code: 0, stdout: JSON.stringify(bodyByKey[key]), stderr: '' };
    },
    config: {},
  };
}

// N-1. A pulls body that omits merged_at entirely must not read as MERGED. GitHub always sends the
// key, so this is a nonconforming body (a null-stripping proxy, a hand-written recording), and the
// answer to a body the adapter cannot read is unreachable, never a match inherited from absence.
test('N-1: a pulls body with no merged_at key is never MERGED', async () => {
  const receipt = await github.lookup({ repo: REPO, pr: 41 }, deps({
    [`api repos/${REPO}/pulls/41`]: { number: 41, state: 'open' },
  }));
  assert.equal(receipt.found, true);
  assert.equal(receipt.facts.state, 'OPEN');
});

test('N-1: a pulls body with neither merged_at nor state is unreachable, not a guess', async () => {
  const receipt = await github.lookup({ repo: REPO, pr: 41 }, deps({
    [`api repos/${REPO}/pulls/41`]: { number: 41 },
  }));
  assert.equal(receipt.reachable, false);
  assert.match(String(receipt.reason), /PULL_BODY_MALFORMED/);
});

// N-5. "Nothing resolved" is judged over the rows this run actually READ. Once settled.json exists,
// every later run carries earlier matches, and a run that read nothing and hit an unreachable
// adapter must still be exit 3 in default mode, or the D1 protection only fires on the first run.
const carriedMatch = (id) => ({ claim_id: id, state: 'matched', carried: true });
const freshMatch = (id) => ({ claim_id: id, state: 'matched', carried: false });
const freshUnresolved = (id) => ({ claim_id: id, state: 'unresolved', carried: false });

test('N-5: carried matches plus one fresh unresolved read is exit 3 without --strict', () => {
  assert.equal(exitFor({ results: [carriedMatch('a'), carriedMatch('b'), freshUnresolved('c')] }, false), 3);
});

test('N-5: only carried matches and nothing to read stays exit 0, because nothing needed reading', () => {
  assert.equal(exitFor({ results: [carriedMatch('a'), carriedMatch('b')] }, false), 0);
});

test('N-5: a fresh match beside a fresh unresolved is exit 0 without --strict, 3 with it', () => {
  const outcome = { results: [carriedMatch('a'), freshMatch('b'), freshUnresolved('c')] };
  assert.equal(exitFor(outcome, false), 0);
  assert.equal(exitFor(outcome, true), 3);
});

// N-7. The footer never says "The rest were." when there is no rest.
test('N-7: an all-unread footer does not claim the rest were read', () => {
  const receipt = {
    at: '2026-09-26T11:00:00.000Z',
    results: [
      { claim_id: 'a', state: 'matched', carried: true, adapter: 'github', verdict: 'MERGED', detail: '', reasons: [] },
      { claim_id: 'b', state: 'unresolved', carried: false, adapter: 'github', verdict: 'ADAPTER_UNREACHABLE', detail: '', reasons: ['ADAPTER_UNREACHABLE'] },
    ],
    summary: { matched: 1, contradicted: 0, unresolved: 1 },
  };
  const text = renderReceipt(receipt, { mode: 'check' });
  assert.match(text, /2 of 2 rows above were not read/);
  assert.doesNotMatch(text, /The rest were\./);
});
