// The renderer. Small surface, and one of its lines was wrong until a live run with five
// unclaimed executions printed "5 run nobody claimeds".

import test from 'node:test';
import assert from 'node:assert/strict';

import { summaryLines, oneLine, renderReceipt } from '../src/report.mjs';

function summary(overrides = {}) {
  return {
    total: 1,
    // `claims` counts the rows that answer a claim, apart from unclaimed runs (D2). The renderer
    // reads it to decide whether a run resolved nothing at all.
    claims: 1,
    unclaimed: 0,
    matched: 1,
    contradicted: 0,
    unresolved: 0,
    orphaned_claims: 0,
    executed_never_claimed: 0,
    new_findings: 1,
    ...overrides,
  };
}

test('every count line pluralises correctly at one and at more than one', () => {
  const singular = summaryLines(summary({ total: 1, matched: 1, contradicted: 1, unresolved: 1, orphaned_claims: 1, executed_never_claimed: 1 })).join('\n');
  assert.match(singular, /1 contradicted claim\n/);
  assert.match(singular, /1 unresolved claim\n/);
  assert.match(singular, /1 matched claim\n/);
  assert.match(singular, /1 orphaned claim\n/);
  assert.match(singular, /1 run nobody claimed$/);

  const plural = summaryLines(summary({ total: 5, matched: 5, contradicted: 5, unresolved: 5, orphaned_claims: 5, executed_never_claimed: 5 })).join('\n');
  assert.match(plural, /5 contradicted claims\n/);
  assert.match(plural, /5 unresolved claims\n/);
  assert.match(plural, /5 matched claims\n/);
  assert.match(plural, /5 orphaned claims\n/);
  assert.match(plural, /5 runs nobody claimed$/);
  assert.ok(!plural.includes('claimeds'), 'no word gets an s stapled to the end of a phrase');
});

test('a zero count still prints, because a missing line reads as a missing check', () => {
  const lines = summaryLines(summary({ total: 0, matched: 0 })).join('\n');
  assert.match(lines, /0 contradicted claims/);
  assert.match(lines, /0 unresolved claims/);
  assert.match(lines, /0 matched claims/);
});

test('the two named verdict lines appear only when there is something to say', () => {
  const quiet = summaryLines(summary()).join('\n');
  assert.ok(!quiet.includes('orphaned'));
  assert.ok(!quiet.includes('nobody claimed'));
});

test('the one-line summary pluralises its record count', () => {
  assert.match(oneLine(summary({ total: 1 })), /out of 1 joined record$/);
  assert.match(oneLine(summary({ total: 4 })), /out of 4 joined records$/);
});

test('a carried claim is marked in its row and counted in the footer', () => {
  const receipt = {
    at: '2026-09-26T11:00:00.000Z',
    summary: summary({ total: 2, claims: 2, matched: 2, new_findings: 1 }),
    results: [
      { claim_id: 'c-1', line: 1, adapter: 'github', state: 'matched', verdict: null, reasons: ['MERGED'], detail: 'merged', carried: true },
      { claim_id: 'c-2', line: 2, adapter: 'github', state: 'matched', verdict: null, reasons: ['MERGED'], detail: 'merged', carried: false },
    ],
  };

  const text = renderReceipt(receipt, { receiptPath: 'landed/receipts/x.json' });
  assert.match(text, /c-1\s+matched\s+github\s+MERGED carried/);
  // "row", not "claim": the same footer counts carried unclaimed runs, which are not claims (D2).
  assert.match(text, /1 row carried from an earlier run/);
});

test('an unclaimed row renders without a claim id rather than with an empty column', () => {
  const receipt = {
    at: '2026-09-26T11:00:00.000Z',
    summary: summary({ total: 1, claims: 0, unclaimed: 1, matched: 0, contradicted: 1, executed_never_claimed: 1, new_findings: 1 }),
    results: [
      { claim_id: null, line: null, adapter: 'n8n', state: 'contradicted', verdict: 'executed-never-claimed', reasons: ['EXECUTED_NEVER_CLAIMED'], detail: 'n8n ran e-9', carried: false },
    ],
  };

  assert.match(renderReceipt(receipt, {}), /\(unclaimed\)\s+contradicted\s+n8n\s+EXECUTED_NEVER_CLAIMED \[executed-never-claimed\]/);
});

test('contradictions are rendered before unresolved, and matches last', () => {
  const row = (id, state) => ({ claim_id: id, line: 1, adapter: 'x', state, verdict: null, reasons: ['R'], detail: 'd', carried: false });
  const receipt = {
    at: '2026-09-26T11:00:00.000Z',
    summary: summary({ total: 3, claims: 3, matched: 1, contradicted: 1, unresolved: 1, new_findings: 3 }),
    results: [row('c-m', 'matched'), row('c-u', 'unresolved'), row('c-c', 'contradicted')],
  };

  const ids = renderReceipt(receipt, {})
    .split('\n')
    .filter((line) => /^ {2}c-/.test(line))
    .map((line) => line.trim().split(/\s+/)[0]);

  assert.deepEqual(ids, ['c-c', 'c-u', 'c-m']);
});

test('a run that resolved nothing says so, because exit 0 on its own would read as quiet', async () => {
  // The exit code contract ties this to --strict, which is what the spec asks for. A run that
  // could not read the authoritative side at all still has to SAY that in the output, or an
  // hourly cron that lost its credential looks exactly like an hourly cron with nothing to report.
  const receipt = {
    at: '2026-09-26T11:00:00.000Z',
    summary: summary({ total: 2, claims: 2, matched: 0, unresolved: 2, new_findings: 2 }),
    results: [
      { claim_id: 'c-1', line: 1, adapter: 'n8n', state: 'unresolved', verdict: null, reasons: ['ADAPTER_UNREACHABLE'], detail: 'no export', carried: false },
      { claim_id: 'c-2', line: 2, adapter: 'n8n', state: 'unresolved', verdict: null, reasons: ['ADAPTER_UNREACHABLE'], detail: 'no export', carried: false },
    ],
  };

  const text = renderReceipt(receipt, {});
  assert.match(text, /resolved nothing/i);
  assert.match(text, /--strict/);
  // And it must not also claim the rows were read. Both unresolved rows here were unreachable.
  assert.ok(!/Every line above was read/.test(text));
});

test('a run that resolved something does not print the learned-nothing warning', () => {
  const receipt = {
    at: '2026-09-26T11:00:00.000Z',
    summary: summary({ total: 2, claims: 2, matched: 1, unresolved: 1, new_findings: 2 }),
    results: [
      { claim_id: 'c-1', line: 1, adapter: 'n8n', state: 'matched', verdict: null, reasons: ['COMPLETED'], detail: 'ok', carried: false },
      { claim_id: 'c-2', line: 2, adapter: 'n8n', state: 'unresolved', verdict: null, reasons: ['ADAPTER_UNREACHABLE'], detail: 'no export', carried: false },
    ],
  };

  assert.ok(!/resolved nothing/i.test(renderReceipt(receipt, {})));
});

// --- W-1: the trust footer is earned, not printed ------------------------------------------
//
// "Every line above was read from the system of record" was printed unconditionally: after a run
// where every row was ADAPTER_UNREACHABLE, after `report` (which reads nothing), and beside a
// "carried, not re-read" row. The product's one trust sentence was false on four screens.

// Anchored to the POSITIVE sentence. A looser /read from the system of record/ also matches the
// replacement line, "N of M rows above were not read from the system of record", so every one of
// these tests passed for the wrong reason until the regex was tightened.
const TRUST = /Every line above was read from the system of record/;

function row(fields) {
  return {
    claim_id: 'c-1',
    line: 1,
    adapter: 'n8n',
    state: 'matched',
    verdict: null,
    reasons: ['COMPLETED'],
    detail: 'ok',
    carried: false,
    receipt: { found: true, source: { complete: true, empty: false }, facts: { kind: 'execution', id: 'e-1' } },
    ...fields,
  };
}

function receiptOf(rows, summaryOverrides = {}) {
  return {
    at: '2026-09-26T11:00:00.000Z',
    summary: {
      total: rows.length,
      claims: rows.filter((r) => r.claim_id !== null).length,
      unclaimed: rows.filter((r) => r.state === 'unclaimed').length,
      matched: rows.filter((r) => r.state === 'matched').length,
      contradicted: rows.filter((r) => r.state === 'contradicted').length,
      unresolved: rows.filter((r) => r.state === 'unresolved').length,
      orphaned_claims: 0,
      executed_never_claimed: 0,
      new_findings: rows.filter((r) => r.carried !== true).length,
      ...summaryOverrides,
    },
    results: rows,
  };
}

test('W-1: the trust line prints when every row was read from a reachable source this run', () => {
  const text = renderReceipt(receiptOf([row({})]), { receiptPath: 'landed/r.json' });
  assert.match(text, TRUST);
});

test('W-1: the trust line does NOT print when a row could not be read', () => {
  const text = renderReceipt(
    receiptOf([row({}), row({ claim_id: 'c-2', state: 'unresolved', reasons: ['ADAPTER_UNREACHABLE'], detail: 'no export', receipt: { reachable: false, reason: 'no export' } })]),
    { receiptPath: 'landed/r.json' },
  );

  assert.ok(!TRUST.test(text), text);
  assert.match(text, /1 of 2 rows/);
  assert.match(text, /ADAPTER_UNREACHABLE/);
});

test('W-1: the trust line does NOT print when every row was unreachable', () => {
  const text = renderReceipt(
    receiptOf([row({ state: 'unresolved', reasons: ['ADAPTER_UNREACHABLE'], detail: 'no export', receipt: { reachable: false, reason: 'x' } })]),
    {},
  );

  assert.ok(!TRUST.test(text));
});

test('W-1: the trust line does NOT print beside a carried row, which was not re-read', () => {
  const text = renderReceipt(receiptOf([row({ carried: true })]), {});

  assert.ok(!TRUST.test(text));
  assert.match(text, /not re-read/);
});

test('W-1: the trust line does NOT print for a partial read', () => {
  const text = renderReceipt(
    receiptOf([row({ receipt: { found: false, source: { complete: false, empty: false } }, state: 'unresolved', reasons: ['PARTIAL_READ'] })]),
    {},
  );

  assert.ok(!TRUST.test(text));
});

test('W-1: report never claims anything was read this run, because it reads nothing', () => {
  const text = renderReceipt(receiptOf([row({})]), { receiptPath: 'landed/r.json', mode: 'report' });

  assert.ok(!TRUST.test(text));
  assert.match(text, /stored receipt/i);
  assert.match(text, /2026-09-26T11:00:00\.000Z/);
});

test('W-1: a row with no receipt at all does not earn the trust line', () => {
  const text = renderReceipt(receiptOf([row({ state: 'unresolved', reasons: ['MALFORMED_CLAIM'], receipt: null })]), {});
  assert.ok(!TRUST.test(text));
});

// --- W-4 and m-7: the strict hint, and the two counts ---------------------------------------

test('W-4: the --strict hint prints only when the run was NOT strict', () => {
  const allUnresolved = receiptOf([row({ state: 'unresolved', reasons: ['ADAPTER_UNREACHABLE'], receipt: { reachable: false, reason: 'x' } })]);

  assert.match(renderReceipt(allUnresolved, { strict: false }), /--strict/);
  assert.ok(!/--strict/.test(renderReceipt(allUnresolved, { strict: true })), 'not while it IS strict');
});

test('W-4: a strict run says the exit code is already fatal', () => {
  const allUnresolved = receiptOf([row({ state: 'unresolved', reasons: ['ADAPTER_UNREACHABLE'], receipt: { reachable: false, reason: 'x' } })]);
  assert.match(renderReceipt(allUnresolved, { strict: true }), /exits 3/);
});

test('m-7: the header counts claims and unclaimed runs in separate lines', () => {
  const rows = [
    row({}),
    row({ claim_id: null, state: 'unclaimed', verdict: 'executed-never-claimed', reasons: ['EXECUTED_NEVER_CLAIMED'], detail: 'ran e-9' }),
  ];
  const text = renderReceipt(receiptOf(rows, { executed_never_claimed: 1 }), {});

  assert.match(text, /1 matched claim/);
  assert.match(text, /1 run nobody claimed/);
  // The unclaimed row is not counted as a contradicted claim, which is what the old header did.
  assert.match(text, /0 contradicted claims/);
});

test('m-7: unclaimed runs are rendered under their own heading', () => {
  const rows = [
    row({}),
    row({ claim_id: null, state: 'unclaimed', verdict: 'executed-never-claimed', reasons: ['EXECUTED_NEVER_CLAIMED'], detail: 'ran e-9' }),
  ];
  const text = renderReceipt(receiptOf(rows, { executed_never_claimed: 1 }), {});

  assert.match(text, /unclaimed runs/i);
  const headingAt = text.indexOf('unclaimed runs');
  assert.ok(text.indexOf('ran e-9') > headingAt, 'the row comes after its heading');
  assert.ok(text.indexOf('c-1') < headingAt, 'and the claims come before it');
});

test('m-7: the unclaimed heading is absent when there are none', () => {
  assert.ok(!/unclaimed runs/i.test(renderReceipt(receiptOf([row({})]), {})));
});

test('W-5: the demo says its own exit code is deliberate', () => {
  const text = renderReceipt(receiptOf([row({ state: 'contradicted', reasons: ['CLAIMED_COMPLETED_BUT_FAILED'] })]), { mode: 'demo' });
  assert.match(text, /exits 0/);
});
