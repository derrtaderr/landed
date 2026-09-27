// The phase-2 proof.
//
// Gmail and HubSpot are out of scope for phase 1, and the risk that carries is a contract that
// turns out to need a core change the moment a third adapter arrives. So this file builds a
// fictional adapter out of NOTHING but the documented contract, hands it to the real
// reconcile, and asserts it resolves all three states and both verdicts. If a future adapter
// needs more than this, this test is where that shows up.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ADAPTER_CONTRACT_FIELDS, describeReceipt } from '../src/adapters/index.mjs';
import { parseClaims } from '../src/claims.mjs';
import { reconcile } from '../src/reconcile.mjs';

// A pretend outbox, standing in for whatever phase 2 brings. It knows about two messages and
// nothing else, and it implements exactly the four required fields plus enumerate.
const outbox = {
  name: 'outbox',
  kinds: ['sent', 'created'],
  requiredKeys: { sent: ['messageId'], created: ['messageId'] },
  async lookup(target, deps) {
    const rows = deps.config?.outbox?.rows;
    if (rows === undefined) return { reachable: false, reason: 'no outbox export was configured' };
    const source = { complete: true, empty: rows.length === 0 };
    const row = rows.find((candidate) => candidate.id === target.messageId);
    if (row === undefined) return { found: false, source };
    return { found: true, source, facts: { kind: 'message', id: row.id, status: row.status } };
  },
  async enumerate(scope, deps) {
    const rows = deps.config?.outbox?.rows ?? [];
    return {
      source: { complete: true, empty: rows.length === 0 },
      records: rows.map((row) => ({ kind: 'execution', id: row.id, startedAt: row.at, status: row.status })),
    };
  },
};

const WINDOW = { from: '2026-09-26T10:00:00.000Z', to: '2026-09-26T11:00:00.000Z' };

const CLAIMS = [
  { id: 'c-1', at: '2026-09-26T10:10:00.000Z', actor: 'mailer', kind: 'sent', target: { adapter: 'outbox', messageId: 'm-1', window: WINDOW } },
  { id: 'c-2', at: '2026-09-26T10:20:00.000Z', actor: 'mailer', kind: 'sent', target: { adapter: 'outbox', messageId: 'm-missing', window: WINDOW } },
  { id: 'c-3', at: '2026-09-26T10:30:00.000Z', actor: 'mailer', kind: 'sent', target: { adapter: 'outbox' } },
]
  .map((claim) => JSON.stringify(claim))
  .join('\n');

test('a brand new adapter satisfies the contract without touching the core', () => {
  for (const field of ADAPTER_CONTRACT_FIELDS) assert.notEqual(outbox[field], undefined, field);
});

test('its receipts are all contract shapes', async () => {
  const withRows = { config: { outbox: { rows: [{ id: 'm-1', at: '2026-09-26T10:10:00.000Z', status: 'sent' }] } } };
  assert.equal(describeReceipt(await outbox.lookup({ messageId: 'm-1' }, withRows)), 'found');
  assert.equal(describeReceipt(await outbox.lookup({ messageId: 'nope' }, withRows)), 'absent');
  assert.equal(describeReceipt(await outbox.lookup({ messageId: 'm-1' }, { config: {} })), 'unreachable');
});

test('the real core resolves three states and both verdicts for it, with no core change', async () => {
  const { records } = parseClaims(CLAIMS);
  const outcome = await reconcile({
    records,
    adapters: { outbox },
    deps: {
      config: {
        outbox: {
          rows: [
            { id: 'm-1', at: '2026-09-26T10:10:00.000Z', status: 'sent' },
            { id: 'm-unclaimed', at: '2026-09-26T10:45:00.000Z', status: 'sent' },
          ],
        },
      },
    },
  });

  assert.equal(outcome.summary.matched, 1, 'm-1 matched');
  assert.equal(outcome.summary.orphaned_claims, 1, 'm-missing is an orphaned claim');
  assert.equal(outcome.summary.unresolved, 1, 'the claim with no join key is unresolved');
  assert.equal(outcome.summary.executed_never_claimed, 1, 'm-unclaimed was never claimed');
});
