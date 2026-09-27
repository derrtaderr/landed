// The adapter contract, applied to EVERY registered adapter by one harness.
//
// The same idea as signal-desk's contract-conformance test: an adapter added tomorrow is
// covered the moment it is registered, rather than whenever someone remembers to write tests
// for it. docs/ADAPTERS.md is the prose; this file is what makes it a contract.

import test from 'node:test';
import assert from 'node:assert/strict';

import { adapters, ADAPTER_CONTRACT_FIELDS, RECEIPT_SHAPES, describeReceipt } from '../src/adapters/index.mjs';
import { CLAIM_KINDS } from '../src/claims.mjs';

// Deps in which nothing works: no file on disk, no binary on PATH. Every adapter must answer
// `reachable: false` rather than throwing, guessing, or reporting an absence.
const DEAD_DEPS = {
  readFile() {
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  },
  exec() {
    return { code: 127, stdout: '', stderr: 'command not found' };
  },
  config: {},
};

test('the registry is not empty, so the harness below is not vacuous', () => {
  assert.ok(Object.keys(adapters).length >= 2, 'phase 1 registers n8n and github');
});

test('the contract names the fields every adapter carries', () => {
  assert.deepEqual(ADAPTER_CONTRACT_FIELDS, ['name', 'kinds', 'requiredKeys', 'lookup']);
});

test('the three receipt shapes are the only ones the contract allows', () => {
  assert.deepEqual(RECEIPT_SHAPES, ['found', 'absent', 'unreachable']);
});

for (const [key, adapter] of Object.entries(adapters)) {
  test(`${key}: carries every field the contract requires`, () => {
    for (const field of ADAPTER_CONTRACT_FIELDS) {
      assert.notEqual(adapter[field], undefined, `${key} has ${field}`);
    }
  });

  test(`${key}: its registry key is its own name`, () => {
    assert.equal(adapter.name, key);
  });

  test(`${key}: answers only kinds from the closed claim set`, () => {
    assert.ok(adapter.kinds.length > 0);
    for (const kind of adapter.kinds) assert.ok(CLAIM_KINDS.includes(kind), `${kind} is a real claim kind`);
  });

  test(`${key}: declares required join keys only for kinds it answers`, () => {
    for (const kind of Object.keys(adapter.requiredKeys)) {
      assert.ok(adapter.kinds.includes(kind), `${key} answers ${kind}, which it declares keys for`);
      assert.ok(Array.isArray(adapter.requiredKeys[kind]));
    }
  });

  test(`${key}: returns a contract-shaped receipt when nothing on the machine works`, async () => {
    for (const kind of adapter.kinds) {
      const receipt = await adapter.lookup({ adapter: key, kind }, DEAD_DEPS);
      assert.ok(RECEIPT_SHAPES.includes(describeReceipt(receipt)), `${key}/${kind} returned ${JSON.stringify(receipt)}`);
    }
  });

  test(`${key}: reports an unreadable source as unreachable, never as an absence`, async () => {
    for (const kind of adapter.kinds) {
      const receipt = await adapter.lookup({ adapter: key, kind }, DEAD_DEPS);
      assert.equal(describeReceipt(receipt), 'unreachable', `${key}/${kind}`);
      assert.equal(typeof receipt.reason, 'string');
      assert.notEqual(receipt.reason, '');
    }
  });

  test(`${key}: enumerate, if present, also answers unreachable rather than an empty list`, async () => {
    if (typeof adapter.enumerate !== 'function') return;
    const listing = await adapter.enumerate({ from: '2026-09-26T10:00:00.000Z', to: '2026-09-26T11:00:00.000Z' }, DEAD_DEPS);
    assert.equal(listing.reachable, false);
  });
}

test('describeReceipt refuses a shape the contract does not allow', () => {
  for (const bogus of [undefined, null, {}, { found: 'yes' }, { reachable: true }]) {
    assert.equal(describeReceipt(bogus), null, JSON.stringify(bogus) ?? 'undefined');
  }
});
