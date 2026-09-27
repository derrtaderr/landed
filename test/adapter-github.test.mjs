// The GitHub adapter, against recorded `gh api` calls.
//
// Rewritten for decision D3. The wave 1 version stubbed `gh pr view` and classified on the text of
// its error messages, which is exactly what ship-check F-05 and F-06 were about. Every call now goes
// through `gh api`, because `gh api` reports an HTTP status and the higher-level verbs report
// English.
//
// The detailed status and container-proof behaviour lives in test/github-classification.test.mjs.
// This file pins the shapes the adapter returns from the recorded fixture corpus, which is what the
// keyless demo replays.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { github } from '../src/adapters/github.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECORDINGS = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'github', 'gh-recordings.json'), 'utf8')).calls;

const REPO = 'example-org/example-repo';

// Replays a recorded gh call and refuses anything not recorded, so no test can quietly reach the
// network.
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

function apiResult(status, body) {
  return status === 200
    ? { code: 0, stdout: JSON.stringify(body), stderr: '' }
    : { code: 1, stdout: '', stderr: `gh: error (HTTP ${status})` };
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

test('a closed but unmerged PR is reported CLOSED, not MERGED', async () => {
  const receipt = await github.lookup(
    { repo: REPO, pr: 44 },
    recorded({ [`api repos/${REPO}/pulls/44`]: apiResult(200, { number: 44, state: 'closed', merged: false, merged_at: null, head: { ref: 'lane/abandoned' } }) }),
  );

  assert.equal(receipt.facts.state, 'CLOSED');
});

test('a branch that exists on the remote is found, present, with the commit it points at', async () => {
  const receipt = await github.lookup(
    { repo: REPO, branch: 'lane/live' },
    recorded({ [`api repos/${REPO}/branches/lane/live`]: apiResult(200, { name: 'lane/live', commit: { sha: 'abc1234' } }) }),
  );

  assert.equal(receipt.found, true);
  assert.equal(receipt.facts.kind, 'branch');
  assert.equal(receipt.facts.present, true);
  assert.equal(receipt.facts.commit, 'abc1234');
});

test('a branch deleted at merge is found as the MERGE, with the PR that did it', async () => {
  const receipt = await github.lookup({ repo: REPO, branch: 'lane/claims-format' }, recorded());

  assert.equal(receipt.found, true);
  assert.equal(receipt.facts.present, false);
  assert.equal(receipt.facts.merged_in_pr, 38);
});

test('a commit contained in the default branch reports on_default_branch', async () => {
  const receipt = await github.lookup(
    { repo: REPO, commit: 'abc1234' },
    recorded({ [`api repos/${REPO}/compare/main...abc1234`]: apiResult(200, { status: 'behind' }) }),
  );

  assert.equal(receipt.facts.kind, 'commit');
  assert.equal(receipt.facts.default_branch, 'main');
  assert.equal(receipt.facts.on_default_branch, true);
});

test('a commit only on a side branch reports on_default_branch false', async () => {
  for (const status of ['ahead', 'diverged']) {
    const receipt = await github.lookup(
      { repo: REPO, commit: 'abc1234' },
      recorded({ [`api repos/${REPO}/compare/main...abc1234`]: apiResult(200, { status }) }),
    );

    assert.equal(receipt.facts.on_default_branch, false, status);
  }
});

test('an identical compare also counts as contained', async () => {
  const receipt = await github.lookup(
    { repo: REPO, commit: 'abc1234' },
    recorded({ [`api repos/${REPO}/compare/main...abc1234`]: apiResult(200, { status: 'identical' }) }),
  );

  assert.equal(receipt.facts.on_default_branch, true);
});

// --- absence, and the container proof that licenses it -----------------------------------

test('a 404 inside a repo that IS readable is a genuine absence, and a COMPLETE read', async () => {
  const receipt = await github.lookup({ repo: REPO, branch: 'lane/never-pushed' }, recorded());

  assert.equal(receipt.found, false);
  assert.equal(receipt.source.complete, true);
  assert.equal(receipt.reachable, undefined);
});

test('the repo is read before any 404 inside it is believed', async () => {
  const seen = [];
  const deps = {
    exec(file, args) {
      seen.push(args.join(' '));
      const key = args.join(' ');
      if (key === `api repos/${REPO}/branches/lane/never-pushed`) return apiResult(404);
      if (key === `api repos/${REPO}`) return RECORDINGS[`api repos/${REPO}`];
      if (key.includes('pulls?state=all')) return apiResult(200, []);
      throw new Error(`unexpected: ${key}`);
    },
    config: {},
  };

  await github.lookup({ repo: REPO, branch: 'lane/never-pushed' }, deps);

  assert.ok(seen.includes(`api repos/${REPO}`), `the repo was never read: ${seen.join(' | ')}`);
});

// --- the ways a gh call ends --------------------------------------------------------------

test('a missing gh binary is unreachable and says it is not installed', async () => {
  const receipt = await github.lookup({ repo: REPO, pr: 41 }, { exec: () => ({ code: null, spawn_error: 'ENOENT', stdout: '', stderr: '' }), config: {} });

  assert.equal(receipt.reachable, false);
  assert.match(receipt.reason, /not installed/);
});

test('an unauthenticated gh is unreachable', async () => {
  const receipt = await github.lookup({ repo: REPO, pr: 41 }, { exec: () => apiResult(401), config: {} });

  assert.equal(receipt.reachable, false);
  assert.match(receipt.reason, /not authenticated/);
});

test('a 429 is an INCOMPLETE read, so the core resolves it unresolved', async () => {
  const receipt = await github.lookup({ repo: REPO, pr: 41 }, { exec: () => apiResult(429), config: {} });

  assert.equal(receipt.found, false);
  assert.equal(receipt.source.complete, false);
});

test('a 403 is unreachable, because rate limit, SAML and scope look identical from here', async () => {
  const receipt = await github.lookup({ repo: REPO, pr: 41 }, { exec: () => apiResult(403), config: {} });

  assert.equal(receipt.reachable, false);
  assert.match(receipt.reason, /403/);
});

test('an exec that throws outright is unreachable', async () => {
  const throwing = {
    exec() {
      throw new Error('spawn gh EACCES');
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

test('a non-zero exit with no HTTP status at all is unreachable, never an absence', async () => {
  const receipt = await github.lookup({ repo: REPO, pr: 41 }, { exec: () => ({ code: 2, stdout: '', stderr: 'gh: something nobody has classified' }), config: {} });

  assert.equal(receipt.reachable, false);
  assert.match(receipt.reason, /without an HTTP status/);
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

test('every call the adapter makes goes through `gh api`, so every failure carries a status', async () => {
  const seen = [];
  const deps = {
    exec(file, args) {
      seen.push(args);
      const key = args.join(' ');
      if (RECORDINGS[key] !== undefined) return RECORDINGS[key];
      if (key.includes('compare')) return apiResult(200, { status: 'behind' });
      return apiResult(404);
    },
    config: {},
  };

  for (const target of [{ pr: 38 }, { branch: 'lane/never-pushed' }, { commit: 'abc1234' }]) {
    await github.lookup({ repo: REPO, ...target }, deps);
  }

  assert.ok(seen.length >= 3);
  for (const args of seen) assert.equal(args[0], 'api', args.join(' '));
});
