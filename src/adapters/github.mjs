// The GitHub adapter.
//
// It shells out to `gh`, which is already authenticated on the operator's machine, so no token lives
// in this repo and none reaches a receipt. Every call goes through `gh api`, because `gh api` reports
// an HTTP STATUS and the higher-level verbs report English.
//
// Two rules, both of them ship-check scars:
//
//   F-05  A FAILURE is classified from the spawn error, the exit code and the HTTP status in stderr.
//         Never from a body. The old code scanned stdout too, so a successful `compare` whose 250
//         commit messages happened to contain "Not Found" became a false absence on ordinary
//         repositories.
//   F-06  A 404 is an absence only when the CONTAINER is proven present. GitHub answers 404 for a
//         repo that does not exist, for a private repo the token cannot see, and for a branch
//         deleted at merge, which is the normal end of a healthy `pushed` claim. So a 404 on
//         anything inside a repo triggers a read of the repo itself before anything is concluded.

const KINDS = ['merged', 'pushed', 'created'];

const COMPLETE = { complete: true, empty: false };

function unreachable(reason) {
  return { reachable: false, reason };
}

// A read that could not be completed. `found: false` with `complete: false` tells the core that
// neither presence nor absence was established.
function incomplete(reason) {
  return { found: false, source: { complete: false, empty: false, reason } };
}

// The HTTP status of a FAILED gh call, from gh's own error line on stderr. gh writes
// "gh: <message> (HTTP 404)". The body, which lives on stdout, is never consulted here.
function statusOf(result) {
  const match = /\(HTTP (\d{3})\)/.exec(result.stderr ?? '');
  return match === null ? null : Number(match[1]);
}

// What a gh call turned into, decided from the spawn error, the exit code and the HTTP status. In
// that order, and from nothing else.
function classify(result) {
  if (result.spawn_error === 'ENOENT') {
    return { kind: 'unreachable', reason: 'the gh CLI is not installed on this machine' };
  }
  if (result.spawn_error !== undefined && result.spawn_error !== null) {
    return { kind: 'unreachable', reason: `gh could not be started: ${result.spawn_error}` };
  }
  if (result.code === 0) return { kind: 'ok', reason: null };

  const status = statusOf(result);

  if (status === 401) return { kind: 'unreachable', reason: 'the gh CLI is not authenticated (run gh auth login)' };
  if (status === 403) {
    // 403 covers a rate limit, a SAML-protected org and a token without the scope. None of them is
    // an absence, and none of them is something this tool can tell apart from here.
    return { kind: 'unreachable', reason: 'GitHub answered 403: rate limited, or this token may not read that repository' };
  }
  if (status === 429) return { kind: 'incomplete', reason: 'GitHub answered 429: this read was rate limited' };
  if (status === 404) return { kind: 'absent', reason: 'GitHub answered 404' };
  if (status !== null) return { kind: 'unreachable', reason: `GitHub answered ${status}` };

  if (result.code === 127) return { kind: 'unreachable', reason: 'the gh CLI is not installed on this machine' };
  return { kind: 'unreachable', reason: `gh exited ${result.code} without an HTTP status` };
}

async function api(path, deps) {
  let result;
  try {
    result = await deps.exec('gh', ['api', path]);
  } catch (error) {
    return { outcome: { kind: 'unreachable', reason: `gh could not be run: ${error.message}` } };
  }

  const outcome = classify(result);
  if (outcome.kind !== 'ok') return { outcome };

  try {
    return { outcome, json: JSON.parse(result.stdout) };
  } catch (error) {
    return { outcome: { kind: 'unreachable', reason: `gh returned output that is not JSON: ${error.message}` } };
  }
}

function fromOutcome(outcome) {
  if (outcome.kind === 'unreachable') return unreachable(outcome.reason);
  if (outcome.kind === 'incomplete') return incomplete(outcome.reason);
  return { found: false, source: COMPLETE };
}

// Is the repository itself readable? Until this answers yes, a 404 on anything inside it proves
// nothing at all. Decision D3.
async function proveRepo(repo, deps) {
  const { outcome, json } = await api(`repos/${repo}`, deps);

  if (outcome.kind === 'ok') return { present: true, repo: json };
  if (outcome.kind === 'absent') {
    return {
      present: false,
      receipt: unreachable(`the repository ${repo} answered 404: it does not exist, or this token cannot see it. A 404 inside a repository proves nothing until the repository itself is readable`),
    };
  }
  return { present: false, receipt: fromOutcome(outcome) };
}

async function lookupPr(target, deps) {
  const { outcome, json } = await api(`repos/${target.repo}/pulls/${target.pr}`, deps);

  if (outcome.kind === 'absent') {
    const container = await proveRepo(target.repo, deps);
    return container.present ? { found: false, source: COMPLETE } : container.receipt;
  }
  if (outcome.kind !== 'ok') return fromOutcome(outcome);

  const state = json.merged === true || json.merged_at !== null ? 'MERGED' : String(json.state ?? '').toUpperCase();

  return {
    found: true,
    source: COMPLETE,
    facts: {
      kind: 'pull_request',
      repo: target.repo,
      number: json.number,
      state,
      merged_at: json.merged_at ?? null,
      merge_commit: json.merge_commit_sha ?? null,
      head_ref: json.head?.ref ?? null,
    },
  };
}

// A branch that is gone is not evidence a push never happened: at merge, GitHub deletes it. So an
// absent branch asks whether a PR from it was merged, and reports the merge as the record.
async function lookupBranch(target, deps) {
  const { outcome, json } = await api(`repos/${target.repo}/branches/${target.branch}`, deps);

  if (outcome.kind === 'ok') {
    return {
      found: true,
      source: COMPLETE,
      facts: { kind: 'branch', repo: target.repo, name: json.name, present: true, commit: json.commit?.sha ?? null },
    };
  }
  if (outcome.kind !== 'absent') return fromOutcome(outcome);

  const container = await proveRepo(target.repo, deps);
  if (!container.present) return container.receipt;

  const owner = container.repo?.owner?.login ?? String(target.repo).split('/')[0];
  const pulls = await api(`repos/${target.repo}/pulls?state=all&head=${owner}:${target.branch}`, deps);
  if (pulls.outcome.kind === 'unreachable' || pulls.outcome.kind === 'incomplete') return fromOutcome(pulls.outcome);

  const merged = (Array.isArray(pulls.json) ? pulls.json : []).find(
    (pull) => pull.merged_at !== null && pull.merged_at !== undefined && pull.head?.ref === target.branch,
  );

  if (merged === undefined) return { found: false, source: COMPLETE };

  return {
    found: true,
    source: COMPLETE,
    facts: {
      kind: 'branch',
      repo: target.repo,
      name: target.branch,
      // The branch is gone AND a PR from it was merged. The merge is the record that the push
      // happened; the deletion is what GitHub does afterwards.
      present: false,
      merged_in_pr: merged.number,
      commit: merged.merge_commit_sha ?? null,
      merged_at: merged.merged_at,
    },
  };
}

async function lookupCommit(target, deps) {
  // The repo read is the container proof AND the source of the default branch, in one call.
  const container = await proveRepo(target.repo, deps);
  if (!container.present) return container.receipt;

  const defaultBranch = container.repo.default_branch;

  // `compare` answers containment in one call. "identical" is the same commit and "behind" means the
  // default branch has moved past it; both mean contained. "ahead" and "diverged" mean it is not on
  // the default branch, which contradicts a pushed claim rather than being absent.
  const compare = await api(`repos/${target.repo}/compare/${defaultBranch}...${target.commit}`, deps);
  if (compare.outcome.kind === 'absent') return { found: false, source: COMPLETE };
  if (compare.outcome.kind !== 'ok') return fromOutcome(compare.outcome);

  return {
    found: true,
    source: COMPLETE,
    facts: {
      kind: 'commit',
      repo: target.repo,
      sha: target.commit,
      default_branch: defaultBranch,
      compare_status: compare.json.status,
      on_default_branch: compare.json.status === 'identical' || compare.json.status === 'behind',
    },
  };
}

export const github = {
  name: 'github',
  kinds: KINDS,

  requiredKeys: {
    merged: ['repo', 'pr'],
    created: ['repo', 'pr'],
    // Either key answers a pushed claim, and neither alone is required.
    pushed: ['repo', ['branch', 'commit']],
  },

  // No enumerate in phase 1. "Everything that happened in this repo" is a different shape of
  // question, and an adapter without enumerate simply never produces the executed-never-claimed
  // verdict. That is the honest outcome rather than a zero nobody can trust.

  async lookup(target, deps) {
    if (typeof deps.exec !== 'function') return unreachable('no way to run gh was provided');
    if (target.repo === undefined) return unreachable('target.repo is required for any GitHub lookup');

    if (target.pr !== undefined) return lookupPr(target, deps);
    if (target.branch !== undefined) return lookupBranch(target, deps);
    if (target.commit !== undefined) return lookupCommit(target, deps);

    return unreachable('a GitHub target needs a pr, a branch or a commit');
  },
};
