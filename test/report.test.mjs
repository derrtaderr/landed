// The renderer. Small surface, and one of its lines was wrong until a live run with five
// unclaimed executions printed "5 run nobody claimeds".

import test from 'node:test';
import assert from 'node:assert/strict';

import { summaryLines, oneLine, renderReceipt } from '../src/report.mjs';

function summary(overrides = {}) {
  return {
    total: 1,
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
    summary: summary({ total: 2, matched: 2, new_findings: 1 }),
    results: [
      { claim_id: 'c-1', line: 1, adapter: 'github', state: 'matched', verdict: null, reasons: ['MERGED'], detail: 'merged', carried: true },
      { claim_id: 'c-2', line: 2, adapter: 'github', state: 'matched', verdict: null, reasons: ['MERGED'], detail: 'merged', carried: false },
    ],
  };

  const text = renderReceipt(receipt, { receiptPath: 'landed/receipts/x.json' });
  assert.match(text, /c-1\s+matched\s+github\s+MERGED carried/);
  assert.match(text, /1 claim carried from an earlier run/);
});

test('an unclaimed row renders without a claim id rather than with an empty column', () => {
  const receipt = {
    at: '2026-09-26T11:00:00.000Z',
    summary: summary({ total: 1, matched: 0, contradicted: 1, executed_never_claimed: 1, new_findings: 1 }),
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
    summary: summary({ total: 3, matched: 1, contradicted: 1, unresolved: 1, new_findings: 3 }),
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
    summary: summary({ total: 2, matched: 0, unresolved: 2, new_findings: 2 }),
    results: [
      { claim_id: 'c-1', line: 1, adapter: 'n8n', state: 'unresolved', verdict: null, reasons: ['ADAPTER_UNREACHABLE'], detail: 'no export', carried: false },
      { claim_id: 'c-2', line: 2, adapter: 'n8n', state: 'unresolved', verdict: null, reasons: ['ADAPTER_UNREACHABLE'], detail: 'no export', carried: false },
    ],
  };

  const text = renderReceipt(receipt, {});
  assert.match(text, /resolved nothing/i);
  assert.match(text, /--strict/);
});

test('a run that resolved something does not print the learned-nothing warning', () => {
  const receipt = {
    at: '2026-09-26T11:00:00.000Z',
    summary: summary({ total: 2, matched: 1, unresolved: 1, new_findings: 2 }),
    results: [
      { claim_id: 'c-1', line: 1, adapter: 'n8n', state: 'matched', verdict: null, reasons: ['COMPLETED'], detail: 'ok', carried: false },
      { claim_id: 'c-2', line: 2, adapter: 'n8n', state: 'unresolved', verdict: null, reasons: ['ADAPTER_UNREACHABLE'], detail: 'no export', carried: false },
    ],
  };

  assert.ok(!/resolved nothing/i.test(renderReceipt(receipt, {})));
});
