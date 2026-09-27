// How a gh call is classified, and when a 404 is allowed to mean "it never happened".
//
// Decision D3, after ship-check F-05, F-06, W-2 and W-3. Four separate wrongs, one theme: the
// adapter was reading the wrong thing to decide what it had learned.
//
//   F-05  classification scanned stdout AND stderr regardless of exit code, so a SUCCESSFUL call
//         whose JSON body contained "Not Found" (a commit message, a repo description) became a
//         false orphaned-claim. `compare` returns up to 250 commit messages, so this fired on
//         ordinary repositories.
//   F-06  a 404 was called "the one genuine absence". GitHub also answers 404 for a private repo a
//         token cannot see, and for a branch deleted at merge, which is the normal end of a healthy
//         `pushed` claim.
//   W-3   a missing gh binary produced "gh exited ENOENT: " because the spawn error arrived in
//         `code` and the not-installed branch looked for ENOENT in stdout.
//   m-2   the claimed branch name was never compared with the returned one, and claim values
//         reached the API path unsanitised.

import test from 'node:test';
import assert from 'node:assert/strict';

import { github } from '../src/adapters/github.mjs';
import { parseClaims } from '../src/claims.mjs';
import { reconcile } from '../src/reconcile.mjs';

const REPO = 'example-org/example-repo';

// A gh that answers from a table keyed by the path, with an explicit HTTP status. Nothing here
// lets a body affect classification.
function ghApi(table) {
  const calls = [];
  return {
    calls,
    deps: {
      exec(file, args) {
        assert.equal(file, 'gh');
        const path = args[args.indexOf('api') + 1] ?? args.join(' ');
        calls.push(path);
        const answer = table[path];
        if (answer === undefined) throw new Error(`no stub for gh api ${path}`);
        if (answer.status === 200) return { code: 0, stdout: JSON.stringify(answer.body), stderr: '' };
        return { code: 1, stdout: '', stderr: `gh: ${answer.message ?? 'error'} (HTTP ${answer.status})` };
      },
      config: {},
    },
  };
}

const REPO_OK = { status: 200, body: { default_branch: 'main', full_name: REPO, owner: { login: 'example-org' } } };

async function resolve(claim, deps) {
  const { records } = parseClaims(JSON.stringify(claim));
  return reconcile({ records, adapters: { github }, deps });
}

function pushedClaim(target) {
  return { id: 'p-1', at: '2026-09-26T10:42:00.000Z', actor: 'lane-runner', kind: 'pushed', target: { adapter: 'github', repo: REPO, ...target } };
}

function mergedClaim(pr) {
  return { id: 'm-1', at: '2026-09-26T10:42:00.000Z', actor: 'lane-runner', kind: 'merged', target: { adapter: 'github', repo: REPO, pr } };
}

// --- F-05: a body never classifies anything -----------------------------------------------

test('F-05: a 200 whose body says "Not Found" is still a success', async () => {
  // The compare endpoint returns commit messages. One of them saying "fix: Not Found on /health"
  // used to turn the whole read into an absence.
  const { deps } = ghApi({
    [`repos/${REPO}`]: REPO_OK,
    [`repos/${REPO}/compare/main...abc1234`]: {
      status: 200,
      body: { status: 'behind', commits: [{ commit: { message: 'fix: Not Found on /health' } }] },
    },
  });

  const receipt = await github.lookup({ repo: REPO, commit: 'abc1234' }, deps);

  assert.equal(receipt.found, true);
  assert.equal(receipt.facts.on_default_branch, true);
});

test('F-05: a 200 whose body mentions authentication or rate limits is still a success', async () => {
  for (const message of ['chore: rotate authentication keys', 'perf: avoid API rate limit'] ) {
    const { deps } = ghApi({
      [`repos/${REPO}`]: REPO_OK,
      [`repos/${REPO}/compare/main...abc1234`]: { status: 200, body: { status: 'identical', commits: [{ commit: { message } }] } },
    });

    const receipt = await github.lookup({ repo: REPO, commit: 'abc1234' }, deps);
    assert.equal(receipt.found, true, message);
  }
});

test('F-05: the HTTP status decides, and 401 403 404 429 each land differently', async () => {
  const cases = [
    { status: 401, expect: 'unreachable' },
    { status: 403, expect: 'unreachable' },
    { status: 429, expect: 'partial' },
    { status: 500, expect: 'unreachable' },
  ];

  for (const { status, expect } of cases) {
    const { deps } = ghApi({ [`repos/${REPO}`]: { status }, [`repos/${REPO}/pulls/41`]: { status } });
    const receipt = await github.lookup({ repo: REPO, pr: 41 }, deps);

    if (expect === 'unreachable') {
      assert.equal(receipt.reachable, false, `HTTP ${status}`);
    } else {
      assert.equal(receipt.found, false, `HTTP ${status}`);
      assert.equal(receipt.source.complete, false, `HTTP ${status}`);
    }
  }
});

// --- F-06 / D3: a 404 is an absence only when the container is proven present ---------------

test('D3: a 404 on the repo makes every claim on it unresolved REPO_UNREACHABLE', async () => {
  // W-2 exactly: a repo that does not exist came back contradicted [orphaned-claim] from a single
  // 404, and a private repo the token cannot see looks identical from here.
  const { deps } = ghApi({ [`repos/${REPO}`]: { status: 404 }, [`repos/${REPO}/pulls/41`]: { status: 404 } });

  const outcome = await resolve(mergedClaim(41), deps);

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('REPO_UNREACHABLE'));
  assert.equal(outcome.summary.orphaned_claims, 0);
});

test('D3: a 404 on the PR with the repo present IS an absence', async () => {
  const { deps } = ghApi({ [`repos/${REPO}`]: REPO_OK, [`repos/${REPO}/pulls/9999`]: { status: 404 } });

  const outcome = await resolve(mergedClaim(9999), deps);

  assert.equal(outcome.results[0].state, 'contradicted');
  assert.equal(outcome.results[0].verdict, 'orphaned-claim');
});

test('D3: a deleted branch whose PR was merged is matched MERGED_AND_BRANCH_DELETED', async () => {
  // The normal end of a healthy lane. This used to alarm hourly on merged work.
  const { deps } = ghApi({
    [`repos/${REPO}`]: REPO_OK,
    [`repos/${REPO}/branches/lane/done`]: { status: 404 },
    [`repos/${REPO}/pulls?state=all&head=example-org:lane/done`]: {
      status: 200,
      body: [{ number: 38, merged_at: '2026-09-25T18:04:11Z', merge_commit_sha: 'aa11bb22cc33', head: { ref: 'lane/done' } }],
    },
  });

  const outcome = await resolve(pushedClaim({ branch: 'lane/done' }), deps);

  assert.equal(outcome.results[0].state, 'matched');
  assert.ok(outcome.results[0].reasons.includes('MERGED_AND_BRANCH_DELETED'));
  assert.match(outcome.results[0].detail, /38/);
});

test('D3: a deleted branch with no merged PR, on a reachable repo, stays an orphaned claim', async () => {
  const { deps } = ghApi({
    [`repos/${REPO}`]: REPO_OK,
    [`repos/${REPO}/branches/lane/never-pushed`]: { status: 404 },
    [`repos/${REPO}/pulls?state=all&head=example-org:lane/never-pushed`]: { status: 200, body: [] },
  });

  const outcome = await resolve(pushedClaim({ branch: 'lane/never-pushed' }), deps);

  assert.equal(outcome.results[0].state, 'contradicted');
  assert.equal(outcome.results[0].verdict, 'orphaned-claim');
});

test('D3: a branch whose PR exists but was never merged is not a match', async () => {
  const { deps } = ghApi({
    [`repos/${REPO}`]: REPO_OK,
    [`repos/${REPO}/branches/lane/open`]: { status: 404 },
    [`repos/${REPO}/pulls?state=all&head=example-org:lane/open`]: {
      status: 200,
      body: [{ number: 41, merged_at: null, merge_commit_sha: null, head: { ref: 'lane/open' } }],
    },
  });

  const outcome = await resolve(pushedClaim({ branch: 'lane/open' }), deps);

  assert.notEqual(outcome.results[0].state, 'matched');
});

test('D3: a branch that is simply present is matched without any PR lookup', async () => {
  const { deps, calls } = ghApi({
    [`repos/${REPO}/branches/lane/live`]: { status: 200, body: { name: 'lane/live', commit: { sha: 'abc1234' } } },
  });

  const outcome = await resolve(pushedClaim({ branch: 'lane/live' }), deps);

  assert.equal(outcome.results[0].state, 'matched');
  assert.ok(!calls.some((path) => path.includes('pulls')), 'no PR query when the branch is there');
});

// --- W-3: the spawn error ------------------------------------------------------------------

test('W-3: a missing gh binary says gh is not installed', async () => {
  const noGh = { exec: () => ({ code: null, spawn_error: 'ENOENT', stdout: '', stderr: '' }), config: {} };

  const receipt = await github.lookup({ repo: REPO, pr: 41 }, noGh);

  assert.equal(receipt.reachable, false);
  assert.match(receipt.reason, /not installed/);
});

test('W-3: the real host exec reports a spawn failure as spawn_error, not as an exit code', async () => {
  const { hostExec } = await import('../src/host.mjs');
  const result = await hostExec('landed-no-such-binary-row65', ['--version']);

  assert.equal(result.spawn_error, 'ENOENT');
  assert.equal(result.code, null);
});

test('W-3: the real host exec still reports a non-zero EXIT as a code', async () => {
  const { hostExec } = await import('../src/host.mjs');
  const result = await hostExec(process.execPath, ['-e', 'process.exit(3)']);

  assert.equal(result.code, 3);
  assert.equal(result.spawn_error, undefined);
});

// --- m-2: the name that came back, and the value that went out -----------------------------

test('m-2: a returned branch name that differs from the claimed one is not a match', async () => {
  const { deps } = ghApi({
    [`repos/${REPO}/branches/main`]: { status: 200, body: { name: 'trunk', commit: { sha: 'abc1234' } } },
  });

  const outcome = await resolve(pushedClaim({ branch: 'main' }), deps);

  assert.equal(outcome.results[0].state, 'unresolved');
  assert.ok(outcome.results[0].reasons.includes('RECEIPT_TARGET_MISMATCH'));
});

test('m-2: a join key carrying URL structure is refused before any call is made', async () => {
  for (const branch of ['main?per_page=1', 'main#frag', 'lane/../../etc', 'lane name', 'lane\tname', '/absolute']) {
    let called = false;
    const deps = { exec: () => { called = true; return { code: 0, stdout: '{}', stderr: '' }; }, config: {} };

    const outcome = await resolve(pushedClaim({ branch }), deps);

    assert.equal(outcome.results[0].state, 'unresolved', branch);
    assert.ok(outcome.results[0].reasons.includes('MALFORMED_CLAIM'), branch);
    assert.equal(called, false, `${branch} reached the API`);
  }
});

test('m-2: an ordinary branch name with slashes and dots is still allowed', async () => {
  for (const branch of ['lane/row65-landed-core', 'release/v1.2.3', 'feature/a.b_c-d']) {
    const { deps } = ghApi({ [`repos/${REPO}/branches/${branch}`]: { status: 200, body: { name: branch, commit: { sha: 'abc' } } } });
    const outcome = await resolve(pushedClaim({ branch }), deps);
    assert.equal(outcome.results[0].state, 'matched', branch);
  }
});
