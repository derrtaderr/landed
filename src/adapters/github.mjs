// The GitHub adapter.
//
// It shells out to `gh`, which is already authenticated on the operator's machine, so there is
// no token in this repo and none in a receipt. Every failure mode of that binary is classified
// before any answer is given, because the three that matter all LOOK like "no such record":
//
//   gh is not installed        -> unreachable
//   gh is not authenticated    -> unreachable
//   gh is rate limited         -> an incomplete read, which the core turns into unresolved
//   the API answered 404       -> a genuine absence, and the only one of the four that is
//
// This is the vault's own dogfood: lane records claiming "PR opened", "merged" and "pushed" are
// exactly the claims joined here.

const KINDS = ['merged', 'pushed', 'created'];

function unreachable(reason) {
  return { reachable: false, reason };
}

// A read that could not be completed. `found: false` with `complete: false` is how the core is
// told that neither presence nor absence was established.
function incomplete(reason) {
  return { found: false, source: { complete: false, empty: false, reason } };
}

const COMPLETE = { complete: true, empty: false };

function classify(result) {
  const noise = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  if (result.code === 127 || /command not found|ENOENT|not recognized/i.test(noise)) {
    return { kind: 'unreachable', reason: 'the gh CLI is not installed on this machine' };
  }
  if (/gh auth login|authentication|Bad credentials|HTTP 401/i.test(noise)) {
    return { kind: 'unreachable', reason: 'the gh CLI is not authenticated (run gh auth login)' };
  }
  if (/rate limit|API rate limit exceeded|secondary rate/i.test(noise)) {
    return { kind: 'incomplete', reason: 'the GitHub API rate limited this read' };
  }
  if (/HTTP 404|Not Found|Could not resolve to|no pull requests found|no.*PullRequest/i.test(noise)) {
    return { kind: 'absent', reason: 'the GitHub API answered 404' };
  }
  if (result.code !== 0) {
    return { kind: 'unreachable', reason: `gh exited ${result.code}: ${(result.stderr ?? '').trim().split('\n')[0]}` };
  }
  return { kind: 'ok', reason: null };
}

async function gh(args, deps) {
  let result;
  try {
    result = await deps.exec('gh', args);
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

async function lookupPr(target, deps) {
  const { outcome, json } = await gh(
    ['pr', 'view', String(target.pr), '--repo', target.repo, '--json', 'number,state,mergedAt,mergeCommit,headRefName'],
    deps,
  );
  if (outcome.kind !== 'ok') return fromOutcome(outcome);

  return {
    found: true,
    source: COMPLETE,
    facts: {
      kind: 'pull_request',
      repo: target.repo,
      number: json.number,
      state: json.state,
      merged_at: json.mergedAt ?? null,
      merge_commit: json.mergeCommit?.oid ?? null,
      head_ref: json.headRefName ?? null,
    },
  };
}

async function lookupBranch(target, deps) {
  const { outcome, json } = await gh(['api', `repos/${target.repo}/branches/${target.branch}`], deps);
  if (outcome.kind !== 'ok') return fromOutcome(outcome);

  return {
    found: true,
    source: COMPLETE,
    facts: { kind: 'branch', repo: target.repo, name: json.name, commit: json.commit?.sha ?? null },
  };
}

async function lookupCommit(target, deps) {
  const repo = await gh(['api', `repos/${target.repo}`], deps);
  if (repo.outcome.kind !== 'ok') return fromOutcome(repo.outcome);
  const defaultBranch = repo.json.default_branch;

  // `compare` answers containment in one call. "identical" means the same commit and "behind"
  // means the default branch has moved past it; both mean contained. "ahead" and "diverged"
  // mean it is not on the default branch, which is a real contradiction of a "pushed" claim.
  const compare = await gh(['api', `repos/${target.repo}/compare/${defaultBranch}...${target.commit}`], deps);
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
    // Either key answers a pushed claim, and neither one alone is required.
    pushed: ['repo', ['branch', 'commit']],
  },

  async lookup(target, deps) {
    if (typeof deps.exec !== 'function') return unreachable('no way to run gh was provided');
    if (target.repo === undefined) return unreachable('target.repo is required for any GitHub lookup');

    if (target.pr !== undefined) return lookupPr(target, deps);
    if (target.branch !== undefined) return lookupBranch(target, deps);
    if (target.commit !== undefined) return lookupCommit(target, deps);

    return unreachable('a GitHub target needs a pr, a branch or a commit');
  },

  // No enumerate in phase 1. Enumerating "everything that happened in this repo" is a
  // different shape of question from the ones above, and an adapter without enumerate simply
  // never produces the executed-never-claimed verdict. That is the honest outcome rather than a
  // zero nobody can trust.
};
