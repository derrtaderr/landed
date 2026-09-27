// The claims format. docs/SPEC.md §3A is the schema.
//
// The rule the whole file turns on: a malformed claim is never dropped. It becomes a record
// carrying a reason that names the field, because a claim silently discarded is exactly the
// class of invisible failure this tool exists to catch.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseClaims, CLAIM_KINDS } from '../src/claims.mjs';
import { validationReport } from '../src/static-checks.mjs';

const GOOD = {
  id: 'c-0001',
  at: '2026-09-26T10:30:00.000Z',
  actor: 'nightly-agent',
  kind: 'merged',
  target: { adapter: 'github', repo: 'example-org/example-repo', pr: 7 },
  evidence: { printed: 'merged successfully' },
};

function parseOne(claim) {
  const { records } = parseClaims(JSON.stringify(claim));
  return records[0];
}

test('the kind set is closed and holds exactly the seven documented kinds', () => {
  assert.deepEqual(CLAIM_KINDS, ['sent', 'created', 'updated', 'merged', 'pushed', 'executed', 'completed']);
});

test('a well formed claim parses and keeps its evidence', () => {
  const record = parseOne(GOOD);
  assert.equal(record.valid, true);
  assert.equal(record.id, 'c-0001');
  assert.deepEqual(record.claim.evidence, { printed: 'merged successfully' });
});

test('evidence is optional', () => {
  const { evidence, ...withoutEvidence } = GOOD;
  assert.equal(parseOne(withoutEvidence).valid, true);
});

for (const field of ['id', 'at', 'actor', 'kind', 'target']) {
  test(`a claim missing ${field} is invalid and the reason names the field`, () => {
    const { [field]: _dropped, ...without } = GOOD;
    const record = parseOne(without);
    assert.equal(record.valid, false);
    assert.equal(record.reason, 'MALFORMED_CLAIM');
    assert.match(record.detail, new RegExp(field));
  });
}

test('a kind outside the closed set is invalid and the reason lists what is allowed', () => {
  const record = parseOne({ ...GOOD, kind: 'delivered' });
  assert.equal(record.valid, false);
  assert.match(record.detail, /delivered/);
  assert.match(record.detail, /merged/);
});

test('an `at` that is not an ISO instant is invalid', () => {
  for (const at of ['yesterday', '2026-09-26', 1758888000000, '2026-13-45T99:00:00Z']) {
    const record = parseOne({ ...GOOD, at });
    assert.equal(record.valid, false, `at=${JSON.stringify(at)}`);
    assert.match(record.detail, /at is not an ISO 8601 instant/);
  }
});

test('a target with no adapter is invalid, because nothing could answer for it', () => {
  const record = parseOne({ ...GOOD, target: { repo: 'example-org/example-repo', pr: 7 } });
  assert.equal(record.valid, false);
  assert.match(record.detail, /target\.adapter/);
});

test('a target that is not an object is invalid', () => {
  assert.equal(parseOne({ ...GOOD, target: 'github' }).valid, false);
});

test('a line that is not JSON becomes a record, not a silent drop', () => {
  const { records } = parseClaims(`${JSON.stringify(GOOD)}\nnot json at all\n`);
  assert.equal(records.length, 2);
  assert.equal(records[1].valid, false);
  assert.equal(records[1].line, 2);
  assert.match(records[1].detail, /line 2 is not valid JSON/);
});

test('a claim that is a JSON array or null is invalid rather than crashing the parse', () => {
  for (const line of ['[1,2,3]', 'null', '"a string"', '42']) {
    const { records } = parseClaims(line);
    assert.equal(records[0].valid, false, line);
    assert.match(records[0].detail, /a claim is a JSON object/);
  }
});

test('blank lines are not records, so line numbers still point at the real line', () => {
  const { records } = parseClaims(`\n\n${JSON.stringify(GOOD)}\n\n`);
  assert.equal(records.length, 1);
  assert.equal(records[0].line, 3);
});

test('the same id appearing twice with the SAME content is not a problem', () => {
  const line = JSON.stringify(GOOD);
  const { records } = parseClaims(`${line}\n${line}`);
  assert.equal(records.every((record) => record.valid), true);
});

test('the same id appearing twice with DIFFERENT content is a refusal, not an overwrite', () => {
  const { records } = parseClaims(`${JSON.stringify(GOOD)}\n${JSON.stringify({ ...GOOD, actor: 'someone-else' })}`);
  assert.equal(records[1].valid, false);
  assert.equal(records[1].reason, 'DUPLICATE_CLAIM_ID');
  assert.match(records[1].detail, /c-0001/);
});

test('validationReport counts the file without consulting any adapter', () => {
  // The shared static checks live in src/static-checks.mjs and are covered there. This keeps the
  // schema half honest, with a registry whose one adapter answers the claim's kind.
  const registry = { github: { name: 'github', kinds: ['merged'], requiredKeys: {} } };
  const report = validationReport(`${JSON.stringify(GOOD)}\nnot json\n${JSON.stringify({ ...GOOD, id: 'c-2', kind: 'nope' })}`, registry);
  assert.equal(report.total, 3);
  assert.equal(report.valid, 1);
  assert.equal(report.problems.length, 2);
  assert.deepEqual(report.problems.map((problem) => problem.line), [2, 3]);
  assert.ok(report.problems.every((problem) => typeof problem.detail === 'string' && problem.detail !== ''));
});
