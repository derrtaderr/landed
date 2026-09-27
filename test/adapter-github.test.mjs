// The GitHub adapter, against recorded gh invocations.
//
// The four failure modes matter more than the happy path, because three of them look exactly
// like "no such record" and only one of them IS one. docs/ADAPTERS.md holds the table.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { github } from '../src/adapters/github.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECORDINGS = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'github', 'gh-recordings.json'), 'utf8')).calls;

const REPO = 'example-org/example-repo';

// Replays a recorded gh call, and refuses anything not recorded, so no test can quietly reach
// the network.
function recorded(extra = {}) {
  const calls = { ...RECORDINGS, ...extra };
  return {
    exec(file, args) {
      assert.equal(file, 'gh');
      const key = args.join(' ');
      const recording = calls[key];
      if (recording === undefined) throw new Error(`no recording for: gh ${key}`);
      return recording;
    },
    config: {},
  };
}

function failing(code, stderr) {
  return { exec: () => ({ code, stdout: '', stderr }), config: {} };
}

// --- the happy paths -------------------------------------------------------------------

test('a merged PR is found, with its state and merge sha', async () => {
  const receipt = await github.lookup({ repo: REPO, pr: 38 }, recorded());

  assert.equal(receipt.found, true);
  assert.equal(receipt.facts.kind, 'pull_request');
  assert.equal(receipt.facts.state, 'MERGED');
  assert.equal(receipt.facts.merge_commit, '4f1c9ab6d2e30517c8a1b4d9f0e6a2c37b58d194');
  assert.equal(receipt.facts.head_ref, 'lane/claims-format');
});

test('an open PR is found and reported open, which is the disagreement the tool exists for', async () => {
  const receipt = await github.lookup({ repo: REPO, pr: 41 }, recorded());

  assert.equal(receipt.found, true);
  assert.equal(receipt.facts.state, 'OPEN');
  assert.equal(receipt.facts.merge_commit, null);
});

test('a branch that exists on the remote is found, with the commit it points at', async () => {
  const receipt = await github.lookup(
    { repo: REPO, branch: 'lane/claims-format' },
    recorded({
      [`api repos/${REPO}/branches/lane/claims-format`]: {
        code: 0,
        stdout: JSON.stringify({ name: 'lane/claims-format', commit: { sha: '4f1c9ab6d2e30517c8a1b4d9f0e6a2c37b58d194' } }),
        stderr: '',
      },
    }),
  );

  assert.equal(receipt.found, true);
  assert.equal(receipt.facts.kind, 'branch');
  assert.equal(receipt.facts.commit, '4f1c9ab6d2e30517c8a1b4d9f0e6a2c37b58d194');
});

test('a commit contained in the default branch reports on_default_branch', async () => {
  const receipt = await github.lookup(
    { repo: REPO, commit: 'abc1234' },
    recorded({
      [`api repos/${REPO}`]: { code: 0, stdout: JSON.stringify({ default_branch: 'main' }), stderr: '' },
      [`api repos/${REPO}/compare/main...abc1234`]: { code: 0, stdout: JSON.stringify({ status: 'behind' }), stderr: '' },
    }),
  );

  assert.equal(receipt.facts.kind, 'commit');
  assert.equal(receipt.facts.default_branch, 'main');
  assert.equal(receipt.facts.on_default_branch, true);
});

test('a commit only on a side branch reports on_default_branch false', async () => {
  for (const status of ['ahead', 'diverged']) {
    const receipt = await github.lookup(
      { repo: REPO, commit: 'abc1234' },
      recorded({
        [`api repos/${REPO}`]: { code: 0, stdout: JSON.stringify({ default_branch: 'main' }), stderr: '' },
        [`api repos/${REPO}/compare/main...abc1234`]: { code: 0, stdout: JSON.stringify({ status }), stderr: '' },
      }),
    );

    assert.equal(receipt.facts.on_default_branch, false, status);
  }
});

test('an identical compare also counts as contained', async () => {
  const receipt = await github.lookup(
    { repo: REPO, commit: 'abc1234' },
    recorded({
      [`api repos/${REPO}`]: { code: 0, stdout: JSON.stringify({ default_branch: 'trunk' }), stderr: '' },
      [`api repos/${REPO}/compare/trunk...abc1234`]: { code: 0, stdout: JSON.stringify({ status: 'identical' }), stderr: '' },
    }),
  );

  assert.equal(receipt.facts.on_default_branch, true);
});

// --- the four ways a gh call ends, three of which are not an absence ---------------------

test('a 404 is the one genuine absence, and it is a COMPLETE read', async () => {
  const receipt = await github.lookup({ repo: REPO, branch: 'lane/never-pushed' }, recorded());

  assert.equal(receipt.found, false);
  assert.equal(receipt.source.complete, true);
  assert.equal(receipt.reachable, undefined);
});

test('a missing gh binary is unreachable', async () => {
  const receipt = await github.lookup({ repo: REPO, pr: 41 }, failing(127, 'gh: command not found'));

  assert.equal(receipt.reachable, false);
  assert.match(receipt.reason, /not installed/);
});

test('an unauthenticated gh is unreachable', async () => {
  for (const stderr of ['gh: To get started with GitHub CLI, please run: gh auth login', 'gh: Bad credentials (HTTP 401)']) {
    const receipt = await github.lookup({ repo: REPO, pr: 41 }, failing(1, stderr));
    assert.equal(receipt.reachable, false, stderr);
    assert.match(receipt.reason, /not authenticated/);
  }
});

test('a rate limited gh is an INCOMPLETE read, so the core resolves it unresolved', async () => {
  const receipt = await github.lookup({ repo: REPO, pr: 41 }, failing(1, 'gh: API rate limit exceeded for user ID 1'));

  assert.equal(receipt.found, false);
  assert.equal(receipt.source.complete, false);
});

test('an exec that throws outright is unreachable', async () => {
  const throwing = {
    exec() {
      throw new Error('spawn gh ENOENT');
    },
    config: {},
  };

  const receipt = await github.lookup({ repo: REPO, pr: 41 }, throwing);
  assert.equal(receipt.reachable, false);
});

test('gh output that is not JSON is unreachable rather than a crash', async () => {
  const garbage = { exec: () => ({ code: 0, stdout: 'Welcome to GitHub CLI', stderr: '' }), config: {} };

  const receipt = await github.lookup({ repo: REPO, pr: 41 }, garbage);
  assert.equal(receipt.reachable, false);
  assert.match(receipt.reason, /not JSON/);
});

test('an unexplained non-zero exit is unreachable, never an absence', async () => {
  const receipt = await github.lookup({ repo: REPO, pr: 41 }, failing(2, 'gh: something nobody has classified'));

  assert.equal(receipt.reachable, false);
  assert.match(receipt.reason, /exited 2/);
});

// --- refusals --------------------------------------------------------------------------

test('a target with no pr, branch or commit is unreachable rather than guessed at', async () => {
  const receipt = await github.lookup({ repo: REPO }, recorded());
  assert.equal(receipt.reachable, false);
});

test('no deps.exec at all is unreachable', async () => {
  const receipt = await github.lookup({ repo: REPO, pr: 41 }, { config: {} });
  assert.equal(receipt.reachable, false);
});

test('the adapter has no enumerate, so it never produces executed-never-claimed', () => {
  assert.equal(github.enumerate, undefined);
});
