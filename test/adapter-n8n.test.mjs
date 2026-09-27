// The n8n adapter, against the recorded export in fixtures/n8n/.
//
// Every workflow name and id in those files is invented. docs/ADAPTERS.md is the contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { n8n } from '../src/adapters/n8n.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'fixtures', 'n8n');

const WINDOW = { from: '2026-09-26T10:00:00.000Z', to: '2026-09-26T11:00:00.000Z' };

function deps(overrides = {}) {
  return {
    readFile: (path) => readFileSync(path, 'utf8'),
    config: {
      n8n: {
        executionsPath: join(FIXTURES, 'executions.json'),
        workflowsPath: join(FIXTURES, 'workflows.json'),
        ...overrides,
      },
    },
  };
}

// --- reading the export ----------------------------------------------------------------

test('an export that is a bare array is read as well as a { data: [...] } response', async () => {
  const rows = JSON.parse(readFileSync(join(FIXTURES, 'executions.json'), 'utf8')).data;
  const asArray = {
    readFile: () => JSON.stringify(rows),
    config: { n8n: { executionsPath: 'anywhere', workflowsPath: join(FIXTURES, 'workflows.json') } },
  };

  const receipt = await n8n.lookup({ executionId: 'e-1002' }, asArray);
  assert.equal(receipt.found, true);
});

test('a missing export is unreachable and the reason says how to configure one', async () => {
  const receipt = await n8n.lookup({ executionId: 'e-1' }, { readFile: () => '', config: {} });
  assert.equal(receipt.reachable, false);
  assert.match(receipt.reason, /--n8n-executions/);
});

test('an export that is not JSON is unreachable, not empty', async () => {
  const receipt = await n8n.lookup(
    { executionId: 'e-1' },
    { readFile: () => '<html>login page</html>', config: { n8n: { executionsPath: 'x.json' } } },
  );
  assert.equal(receipt.reachable, false);
  assert.match(receipt.reason, /not valid JSON/);
});

test('an export of zero executions reports source.empty rather than an absence', async () => {
  const receipt = await n8n.lookup({ executionId: 'e-1002' }, deps({ executionsPath: join(FIXTURES, 'executions-empty.json') }));
  assert.equal(receipt.found, false);
  assert.equal(receipt.source.empty, true);
});

test('a paginated export with a nextCursor reports an incomplete read', async () => {
  const receipt = await n8n.lookup({ executionId: 'e-9999' }, deps({ executionsPath: join(FIXTURES, 'executions-truncated.json') }));
  assert.equal(receipt.source.complete, false);
});

// --- the id-keyed question: did execution X run, and how did it end? --------------------

test('a known execution id is found, with its status', async () => {
  const receipt = await n8n.lookup({ executionId: 'e-4001' }, deps());
  assert.equal(receipt.found, true);
  assert.equal(receipt.facts.kind, 'execution');
  assert.equal(receipt.facts.id, 'e-4001');
  assert.equal(receipt.facts.status, 'error');
  assert.equal(receipt.facts.workflowId, 'wf-204');
});

test('an unknown execution id in a complete, non-empty export is a genuine absence', async () => {
  const receipt = await n8n.lookup({ executionId: 'e-does-not-exist' }, deps());
  assert.equal(receipt.found, false);
  assert.equal(receipt.source.complete, true);
  assert.equal(receipt.source.empty, false);
});

test('an id-keyed read reports NO window, because no window bounds it', async () => {
  // Reporting the export's coverage here would make a claim dated outside it look like clock
  // skew, when the exact record was in hand.
  const receipt = await n8n.lookup({ executionId: 'e-1001' }, deps());
  assert.equal(receipt.source.window, undefined);
});

// --- the window-scoped question: did workflow W fire in window T? -----------------------

test('a window-scoped read reports what the export actually covers', async () => {
  const receipt = await n8n.lookup({ workflowId: 'wf-201', window: WINDOW }, deps());
  assert.deepEqual(receipt.source.window, { from: '2026-09-26T09:58:00.000Z', to: '2026-09-26T11:05:00.000Z' });
});

test('fires are filtered to the window asked about, not the whole export', async () => {
  // wf-201 ran twice: once at 09:58 and once at 10:30. Only the second is inside the window.
  const receipt = await n8n.lookup({ workflowId: 'wf-201', window: WINDOW }, deps());
  assert.deepEqual(receipt.facts.fires.map((fire) => fire.executionId), ['e-1002']);
});

test('a fires receipt declares the executions it covers', async () => {
  const receipt = await n8n.lookup({ workflowId: 'wf-203', window: WINDOW }, deps());
  assert.deepEqual(receipt.facts.covers, ['e-3001', 'e-3002']);
});

test('the active flag comes from the workflows export', async () => {
  const inactive = await n8n.lookup({ workflowId: 'wf-202', window: WINDOW }, deps());
  assert.equal(inactive.facts.active, false);
  assert.equal(inactive.facts.name, 'Refund claim drafter');

  const active = await n8n.lookup({ workflowId: 'wf-201', window: WINDOW }, deps());
  assert.equal(active.facts.active, true);
});

test('with no workflows export the read is unreachable, never active by assumption', async () => {
  const withoutWorkflows = {
    readFile: (path) => readFileSync(path, 'utf8'),
    config: { n8n: { executionsPath: join(FIXTURES, 'executions.json') } },
  };

  const receipt = await n8n.lookup({ workflowId: 'wf-201', window: WINDOW }, withoutWorkflows);
  assert.equal(receipt.reachable, false);
  assert.match(receipt.reason, /fired-while-inactive/);
});

test('a workflow absent from the workflows export is unreachable, because its flag is unknown', async () => {
  // A workflow that DID fire, against a workflow list that has never heard of it. Answering
  // "active" here would be an assumption dressed as a fact.
  const strangerFired = {
    readFile: (path) =>
      path === 'executions'
        ? JSON.stringify({ data: [{ id: 'e-x', workflowId: 'wf-unlisted', status: 'success', startedAt: '2026-09-26T10:30:00.000Z' }] })
        : JSON.stringify({ data: [{ id: 'wf-201', name: 'Nightly lead digest', active: true }] }),
    config: { n8n: { executionsPath: 'executions', workflowsPath: 'workflows' } },
  };

  const receipt = await n8n.lookup({ workflowId: 'wf-unlisted' }, strangerFired);
  assert.equal(receipt.reachable, false);
  assert.match(receipt.reason, /active flag is unknown/);
});

test('a workflow that did not fire in the window is an absence, not a crash', async () => {
  const receipt = await n8n.lookup(
    { workflowId: 'wf-201', window: { from: '2026-09-26T10:35:00.000Z', to: '2026-09-26T10:45:00.000Z' } },
    deps(),
  );
  assert.equal(receipt.found, false);
});

test('a window the export does not span is an incomplete read', async () => {
  // Asking about yesterday against an export that starts this morning cannot be answered, and
  // an absence would be the wrong answer rather than a small inaccuracy.
  const receipt = await n8n.lookup(
    { workflowId: 'wf-201', window: { from: '2026-09-25T00:00:00.000Z', to: '2026-09-26T11:00:00.000Z' } },
    deps(),
  );
  assert.equal(receipt.source.complete, false);
  assert.equal(receipt.found, false);
});

// --- enumerate -------------------------------------------------------------------------

test('enumerate lists the executions inside the scope and no others', async () => {
  const listing = await n8n.enumerate(WINDOW, deps());
  const ids = listing.records.map((record) => record.id);

  assert.ok(ids.includes('e-6001'), 'the 10:55 run is in scope');
  assert.ok(!ids.includes('e-1001'), 'the 09:58 run is before the scope');
  assert.ok(!ids.includes('e-5001'), 'the 11:05 run is after the scope');
});

test('enumerate over a truncated export reports an incomplete read', async () => {
  const listing = await n8n.enumerate(WINDOW, deps({ executionsPath: join(FIXTURES, 'executions-truncated.json') }));
  assert.equal(listing.source.complete, false);
});

// --- the optional live REST path --------------------------------------------------------

test('a configured URL and key read over REST instead of from disk', async () => {
  const calls = [];
  const live = {
    readFile() {
      throw new Error('the live path must not touch the disk');
    },
    async fetch(url, init) {
      calls.push({ url, key: init.headers['X-N8N-API-KEY'] });
      return { ok: true, status: 200, async json() { return { data: [{ id: 'e-live', workflowId: 'wf-1', status: 'success', startedAt: '2026-09-26T10:30:00.000Z' }], nextCursor: null }; } };
    },
    config: { n8n: { url: 'https://n8n.example.com/', apiKey: 'test-key-not-a-real-credential' } },
  };

  const receipt = await n8n.lookup({ executionId: 'e-live' }, live);

  assert.equal(receipt.found, true);
  assert.equal(calls[0].url, 'https://n8n.example.com/api/v1/executions');
  assert.equal(calls[0].key, 'test-key-not-a-real-credential');
});

test('a live read that answers non-200 is unreachable and reports the status', async () => {
  const live = {
    async fetch() {
      return { ok: false, status: 401, async json() { return {}; } };
    },
    config: { n8n: { url: 'https://n8n.example.com', apiKey: 'x' } },
  };

  const receipt = await n8n.lookup({ executionId: 'e-1' }, live);
  assert.equal(receipt.reachable, false);
  assert.match(receipt.reason, /401/);
});

test('a live read configured with no fetch available is unreachable, not a fall back to disk', async () => {
  const receipt = await n8n.lookup(
    { executionId: 'e-1' },
    { readFile: () => '{"data":[{"id":"e-1"}]}', config: { n8n: { url: 'https://n8n.example.com', apiKey: 'x', executionsPath: 'x.json' } } },
  );

  assert.equal(receipt.reachable, false);
  assert.match(receipt.reason, /fetch/);
});
