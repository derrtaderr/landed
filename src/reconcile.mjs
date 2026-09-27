// The join. This is the only place a state is decided.
//
// Adapters report what the authoritative system says. This module decides what that MEANS
// against the claim, in one precedence order, so that every way of not knowing lands in
// `unresolved` rather than leaking into `matched`. docs/SPEC.md §3C is the contract.

import { staticProblems } from './static-checks.mjs';

export const STATES = ['matched', 'contradicted', 'unresolved'];
export const VERDICTS = ['orphaned-claim', 'executed-never-claimed'];

export const DEFAULT_DOUBLE_FIRE_SECONDS = 15;

function unresolved(base, reason, detail) {
  return { ...base, state: 'unresolved', verdict: null, reasons: [reason], detail };
}

function contradicted(base, reason, detail, verdict = null) {
  return { ...base, state: 'contradicted', verdict, reasons: [reason], detail };
}

function matched(base, reason, detail) {
  return { ...base, state: 'matched', verdict: null, reasons: [reason], detail };
}

// A claim is written AFTER the work it describes, so its instant is allowed to fall a little past
// the end of the window it reports on. One minute, which covers a slow last node without covering
// a clock that is wrong.
export const CLAIM_LAG_TOLERANCE_MS = 60 * 1000;

// A claim that names no window is bounded to this much either side of its own instant, rather than
// matching any record the source happens to hold. Ship-check F-10: a windowless claim matched a fire
// three days older than itself. Six hours is wide enough for a late claim from a slow workflow and
// narrow enough that yesterday's run is not this claim's evidence.
export const DEFAULT_WINDOW_HALF_WIDTH_MS = 6 * 60 * 60 * 1000;

// The window a claim is actually read against, and where it came from. A result carries both, so
// nobody has to guess which one graded it.
export function effectiveWindow(claim) {
  const declared = claim.target?.window;
  if (declared !== undefined && declared !== null) return { window: declared, source: 'claim' };

  const at = Date.parse(claim.at);
  if (Number.isNaN(at)) return { window: null, source: 'none' };

  return {
    window: {
      from: new Date(at - DEFAULT_WINDOW_HALF_WIDTH_MS).toISOString(),
      to: new Date(at + DEFAULT_WINDOW_HALF_WIDTH_MS).toISOString(),
    },
    source: 'default',
  };
}

function withinWindow(instant, window, lagToleranceMs = 0) {
  if (window === undefined || window === null) return true;
  const at = Date.parse(instant);
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (Number.isNaN(at) || Number.isNaN(from) || Number.isNaN(to)) return true;
  return at >= from && at <= to + lagToleranceMs;
}

// The named n8n checks, applied to a `fires` receipt. They live here rather than in the
// adapter because they are interpretations, and an adapter that interprets is an adapter whose
// verdicts nobody can re-derive.
function checkFires(base, claim, facts, doubleFireSeconds) {
  const fires = [...(Array.isArray(facts.fires) ? facts.fires : [])];
  fires.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  // The fired-while-inactive check needs the flag, and "the export does not say" is neither true nor
  // false. Reading an absent flag as inactive contradicted every fire of a workflow whose export row
  // simply omitted the key (F-02).
  if (facts.active !== true && facts.active !== false && fires.length > 0) {
    return unresolved(
      base,
      'ACTIVE_FLAG_UNKNOWN',
      `${facts.workflowId} fired ${fires.length} time(s), and the workflows export does not say whether it was active, so fired-while-inactive cannot be decided`,
    );
  }

  if (facts.active === false && fires.length > 0) {
    return contradicted(
      base,
      'FIRED_WHILE_INACTIVE',
      `${facts.workflowId} fired ${fires.length} time(s) while its active flag was false (first at ${fires[0].startedAt})`,
    );
  }

  for (let i = 1; i < fires.length; i += 1) {
    const gapSeconds = (Date.parse(fires[i].startedAt) - Date.parse(fires[i - 1].startedAt)) / 1000;
    if (gapSeconds <= doubleFireSeconds) {
      return contradicted(
        base,
        'DOUBLE_FIRE',
        `${facts.workflowId} fired twice ${gapSeconds}s apart (${fires[i - 1].executionId} then ${fires[i].executionId}), inside the ${doubleFireSeconds}s double-fire window`,
      );
    }
  }

  const cadence = claim.target?.cadence;
  if (cadence !== undefined && cadence !== null) {
    const expected = expectedFires(cadence, claim.target.window);
    if (expected === null) {
      return unresolved(
        base,
        'CADENCE_UNDECLARED',
        'target.cadence needs expected_fires, or every_seconds together with a window; a cadence check with no derivable count is not a check',
      );
    }
    if (fires.length !== expected) {
      return contradicted(
        base,
        'COUNT_VS_CADENCE',
        `${facts.workflowId} fired ${fires.length} time(s) in the window; the cadence the operator declared on the claim expects ${expected}`,
      );
    }
  }

  return matched(
    base,
    'FIRED_AS_CLAIMED',
    `${facts.workflowId} fired ${fires.length} time(s) in the window (${fires.map((fire) => fire.executionId).join(', ')})`,
  );
}

// The cadence comes from the claim rather than the workflow export, and docs/SPEC.md §5.1 says
// why: an n8n schedule lives in an untyped node-parameters blob whose shape moves between
// trigger types and versions, so parsing it is a guess that fails silently on the next release.
function expectedFires(cadence, window) {
  if (Number.isInteger(cadence.expected_fires)) return cadence.expected_fires;
  if (Number.isFinite(cadence.every_seconds) && cadence.every_seconds > 0 && window) {
    const span = (Date.parse(window.to) - Date.parse(window.from)) / 1000;
    if (Number.isNaN(span)) return null;
    // The window is half-open, so a span of exactly N intervals holds exactly N fires. With both
    // edges inclusive it held N+1 and every healthy schedule was contradicted (F-09).
    return Math.floor(span / cadence.every_seconds);
  }
  return null;
}

// Which receipt shapes can answer which claim kind. A receipt of any other shape cannot grade the
// claim at all, and the core says so rather than reaching for whatever field happens to be there.
//
// This table is the fix for ship-check F-01. The old code dispatched on the RECEIPT's shape before
// it looked at the claim, so a `completed` claim that arrived with a `fires` receipt was graded as
// a fire and its execution's `error` status was never read.
export const RECEIPT_SHAPES_BY_KIND = {
  merged: ['pull_request'],
  created: ['pull_request', 'branch', 'commit', 'message', 'record'],
  updated: ['pull_request', 'branch', 'commit', 'message', 'record'],
  pushed: ['branch', 'commit'],
  sent: ['message'],
  completed: ['execution'],
  executed: ['fires', 'execution'],
};

// n8n's execution statuses, split by what they let a `completed` claim conclude.
const UNFINISHED_STATUSES = new Set(['running', 'waiting', 'new']);
const SUCCEEDED_STATUSES = new Set(['success', 'warning']);
const FAILED_STATUSES = new Set(['error', 'crashed', 'canceled', 'cancelled', 'failed']);

// What the claim ASSERTS, against the facts of a record that does exist. `found: true` only
// says the authoritative system holds a record; whether that record agrees with the claim is
// this function's question and nothing else's.
//
// The claim's kind decides, always. The receipt only supplies facts.
function interpret(base, claim, facts, doubleFireSeconds) {
  const allowed = RECEIPT_SHAPES_BY_KIND[claim.kind] ?? [];
  const shape = facts?.kind ?? 'record';

  if (!allowed.includes(shape)) {
    return unresolved(
      base,
      'RECEIPT_SHAPE_MISMATCH',
      `a ${claim.kind} claim cannot be graded against a ${shape} record; ${claim.kind} needs one of ${allowed.join(', ') || 'a shape no adapter offers yet'}`,
    );
  }

  if (claim.kind === 'executed' && shape === 'fires') return checkFires(base, claim, facts, doubleFireSeconds);

  if (claim.kind === 'merged') {
    if (facts?.state === 'MERGED') {
      return matched(
        base,
        'MERGED',
        `${facts.repo}#${facts.number} is merged at ${facts.merge_commit ?? 'an unreported sha'}`,
      );
    }
    return contradicted(
      base,
      'CLAIMED_MERGED_NOT_MERGED',
      `${facts.repo}#${facts.number} is ${String(facts?.state ?? 'in an unreported state').toLowerCase()}, not merged`,
    );
  }

  if (claim.kind === 'pushed') {
    if (shape === 'commit') {
      return facts.on_default_branch === true
        ? matched(base, 'ON_DEFAULT_BRANCH', `${facts.sha} is contained in ${facts.default_branch}`)
        : contradicted(
            base,
            'COMMIT_NOT_ON_DEFAULT_BRANCH',
            `${facts.sha} exists but is not contained in ${facts.default_branch}`,
          );
    }

    // The record has to be about the branch that was claimed. Nothing used to check this, and a
    // claimed "main?per_page=1" was matched against a record for "main" (m-2).
    if (claim.target.branch !== undefined && facts.name !== undefined && facts.name !== claim.target.branch) {
      return unresolved(
        base,
        'RECEIPT_TARGET_MISMATCH',
        `the claim is about branch ${claim.target.branch} and the record returned is for ${facts.name}`,
      );
    }

    // A branch deleted at merge is the normal end of a healthy push, not evidence it never happened.
    // The merge is the record; the deletion is what GitHub does afterwards (D3).
    if (facts.present === false) {
      return facts.merged_in_pr === undefined
        ? unresolved(base, 'BRANCH_ABSENT_UNEXPLAINED', `${facts.name} is not on the remote and nothing explains why`)
        : matched(
            base,
            'MERGED_AND_BRANCH_DELETED',
            `${facts.name} is gone from the remote because PR #${facts.merged_in_pr} merged it at ${facts.commit ?? 'an unreported sha'}`,
          );
    }

    return matched(base, 'PRESENT_ON_REMOTE', `branch ${facts.name} exists on the remote at ${facts.commit ?? 'an unreported sha'}`);
  }

  if (claim.kind === 'completed') {
    const status = facts.status;

    if (UNFINISHED_STATUSES.has(status)) {
      // Not a failure and not a success. The claim may yet come true, and saying "failed" here was
      // a reason code that disagreed with the fact beside it.
      return unresolved(base, 'STILL_RUNNING', `execution ${facts.id} has status ${status}; it has not finished, so the claim is neither kept nor broken yet`);
    }
    if (FAILED_STATUSES.has(status)) {
      return contradicted(base, 'CLAIMED_COMPLETED_BUT_FAILED', `execution ${facts.id} has status ${status}`);
    }
    if (SUCCEEDED_STATUSES.has(status)) {
      return matched(base, 'COMPLETED', `execution ${facts.id} finished with status ${status}`);
    }
    return unresolved(
      base,
      'EXECUTION_STATUS_UNKNOWN',
      `execution ${facts.id} reports status ${JSON.stringify(status)}, which this version does not know how to read`,
    );
  }

  if (claim.kind === 'executed') {
    return matched(base, 'EXECUTED', `execution ${facts.id} exists, with status ${facts.status ?? 'unreported'}`);
  }

  return matched(base, 'RECORD_EXISTS', `the authoritative system has a ${shape} for this target`);
}

// The join keys, spelled out. "No record for this target" sends an operator back to the claims
// file to work out which target; the keys are already in hand, so the detail carries them.
function describeTarget(target) {
  const keys = Object.entries(target)
    .filter(([key, value]) => key !== 'adapter' && key !== 'window' && key !== 'cadence' && typeof value !== 'object')
    .map(([key, value]) => `${key}=${value}`);
  return keys.length === 0 ? 'this target' : keys.join(' ');
}

async function resolveOne(record, adapters, deps, doubleFireSeconds) {
  const base = {
    claim_id: record.id,
    line: record.line,
    actor: record.claim?.actor ?? null,
    kind: record.claim?.kind ?? null,
    adapter: record.claim?.target?.adapter ?? null,
    at: record.claim?.at ?? null,
    // The window this claim was read against, kept on the result so that a run which CARRIES this
    // claim forward can still derive the enumeration scope from it. Without it, the second run
    // enumerates nothing and every unclaimed record silently stops being reported.
    window: null,
    window_source: 'none',
    target: record.claim?.target ?? null,
    evidence: record.claim?.evidence ?? null,
    receipt: null,
  };

  if (!record.valid) return unresolved(base, record.reason, record.detail);

  const claim = record.claim;
  const { window, source: windowSource } = effectiveWindow(claim);
  base.window = window;
  base.window_source = windowSource;
  // Everything decidable without reading anything, from the one implementation `validate` also uses
  // (F-08). A claim that fails here never reaches a lookup.
  const [problem] = staticProblems(claim, adapters);
  if (problem !== undefined) return unresolved(base, problem.reason, problem.detail);

  const adapter = adapters[claim.target.adapter];

  // A claim that disagrees with ITSELF. An agent whose clock is behind stamps a claim about a
  // window that, by its own clock, has not happened yet; which of the two is wrong cannot be
  // decided from here, so neither is believed. Checked before the lookup, because it costs
  // nothing to notice and a lookup cannot settle it.
  if (windowSource === 'claim' && !withinWindow(claim.at, claim.target.window, CLAIM_LAG_TOLERANCE_MS)) {
    return unresolved(
      base,
      'CLOCK_SKEW',
      `the claim is dated ${claim.at}, outside the window it reports on (${claim.target.window.from} to ${claim.target.window.to})`,
    );
  }

  let receipt;
  try {
    // The adapter reads against the EFFECTIVE window, so an adapter never has to invent a bound of
    // its own and a windowless claim cannot match a record from any distance away (F-10).
    receipt = await adapter.lookup({ ...claim.target, window }, deps);
  } catch (error) {
    return unresolved(base, 'ADAPTER_UNREACHABLE', `${adapter.name} threw: ${error.message}`);
  }

  const withReceipt = { ...base, receipt };

  if (receipt?.reachable === false) {
    // A container that could not be read is its own finding, because "the repository is not
    // readable" and "the adapter is broken" send an operator to different places (D3).
    const reason = /^the repository /.test(receipt.reason ?? '') ? 'REPO_UNREACHABLE' : 'ADAPTER_UNREACHABLE';
    return unresolved(withReceipt, reason, `${adapter.name} could not be read: ${receipt.reason}`);
  }

  const source = receipt?.source;

  if (source?.complete === false) {
    return unresolved(
      withReceipt,
      'PARTIAL_READ',
      `${adapter.name} read only part of its source, so neither presence nor absence is decided here`,
    );
  }

  if (source?.empty === true) {
    return unresolved(
      withReceipt,
      'EMPTY_SOURCE',
      `${adapter.name} returned zero records; zero is not evidence the claim did not land`,
    );
  }

  if (source?.window !== undefined && !withinWindow(claim.at, source.window)) {
    return unresolved(
      withReceipt,
      'CLOCK_SKEW',
      `the claim is dated ${claim.at}, outside the window read (${source.window.from} to ${source.window.to})`,
    );
  }

  if (receipt?.found !== true) {
    return contradicted(
      withReceipt,
      'ORPHANED_CLAIM',
      `${adapter.name} read its source and has no record for ${describeTarget(claim.target)}`,
      'orphaned-claim',
    );
  }

  return interpret(withReceipt, claim, receipt.facts ?? {}, doubleFireSeconds);
}

function bareResult(adapter, fields) {
  return {
    claim_id: null,
    line: null,
    actor: null,
    kind: null,
    adapter,
    at: null,
    window: null,
    window_source: 'none',
    target: null,
    evidence: null,
    receipt: null,
    verdict: null,
    carried: false,
    ...fields,
  };
}

// What a claim is ABOUT, in the adapter's own terms. n8n declares `workflowId`; an adapter that
// declares no subject key cannot be scoped, and so is only enumerated under --enumerate all.
function subjectOf(adapter, target) {
  const key = adapter.subjectKey;
  const value = key === undefined ? undefined : target?.[key];
  return value === undefined ? undefined : String(value);
}

// Runs the authoritative system knows about that no claim accounted for. Decision D2:
//
//   * scoped to the subjects the claims named, unless --enumerate all
//   * suppressed for any subject whose own claim could not be resolved, because a claim we could
//     not read cannot tell us which of its runs it covered (F-03)
//   * its own row class, never a contradiction of a claim that does not exist
async function findUnclaimed(records, adapters, deps, results, enumerateAll) {
  // What the claims already account for, from the receipts' own declarations.
  const accounted = new Set();
  for (const result of results) {
    const facts = result.receipt?.facts;
    if (facts?.id !== undefined) accounted.add(`${result.adapter}:${facts.id}`);
    for (const id of facts?.covers ?? []) accounted.add(`${result.adapter}:${id}`);
  }

  const extras = [];

  for (const [name, adapter] of Object.entries(adapters)) {
    if (typeof adapter.enumerate !== 'function') continue;

    const mine = records.filter((record) => record.valid && record.claim.target.adapter === name);
    if (mine.length === 0) continue;

    const subjects = new Set();
    for (const record of mine) {
      const subject = subjectOf(adapter, record.claim.target);
      if (subject !== undefined) subjects.add(subject);
    }

    // A subject whose own claim came back unresolved is not enumerated at all. Its runs are not
    // "unclaimed"; they are runs nobody could attribute, and reporting them as unclaimed is the
    // F-03 false contradiction, seven of them from one missing export.
    const suppressed = new Set();
    for (const result of results) {
      if (result.adapter !== name || result.state !== 'unresolved') continue;
      const subject = subjectOf(adapter, result.target ?? {});
      if (subject !== undefined) suppressed.add(subject);
    }

    for (const subject of [...suppressed].sort()) {
      extras.push(bareResult(name, {
        state: 'unresolved',
        reasons: ['ENUMERATION_SUPPRESSED'],
        detail: `${name} did not enumerate ${subject}, because the claim about it could not be resolved; its runs cannot be attributed either way`,
      }));
    }

    const scopeSubjects = enumerateAll ? null : [...subjects].filter((subject) => !suppressed.has(subject));
    if (scopeSubjects !== null && scopeSubjects.length === 0) continue;

    // The union of the windows asked about by the claims THAT NAMED A SUBJECT. A claim keyed by
    // execution id names no workflow, so it contributes no subject; folding its default window in
    // anyway dragged an unrelated run six hours away into scope, which is how the demo first showed
    // this.
    const windows = results
      .filter((result) => result.adapter === name && result.window !== null && result.window !== undefined)
      .filter((result) => subjectOf(adapter, result.target ?? {}) !== undefined)
      .map((result) => result.window);
    if (windows.length === 0) continue;

    const scope = {
      from: windows.map((window) => window.from).sort()[0],
      to: windows.map((window) => window.to).sort().at(-1),
      subjects: scopeSubjects,
    };

    let listing;
    try {
      listing = await adapter.enumerate(scope, deps);
    } catch (error) {
      extras.push(bareResult(name, {
        state: 'unresolved',
        reasons: ['ADAPTER_UNREACHABLE'],
        detail: `${name} could not enumerate its source: ${error.message}`,
      }));
      continue;
    }

    if (listing?.reachable === false || listing?.source?.complete === false || listing?.source?.empty === true) {
      const reason = listing?.reachable === false
        ? 'ADAPTER_UNREACHABLE'
        : listing?.source?.empty === true
          ? 'EMPTY_SOURCE'
          : 'PARTIAL_READ';
      extras.push(bareResult(name, {
        receipt: listing,
        state: 'unresolved',
        reasons: [reason],
        detail: `${name} could not fully enumerate ${scope.from} to ${scope.to}, so nothing here rules out an unclaimed run`,
      }));
      continue;
    }

    for (const found of listing?.records ?? []) {
      if (accounted.has(`${name}:${found.id}`)) continue;
      const subject = found.subject === undefined ? undefined : String(found.subject);
      if (subject !== undefined && suppressed.has(subject)) continue;
      if (scopeSubjects !== null && subject !== undefined && !scopeSubjects.includes(subject)) continue;

      extras.push(bareResult(name, {
        at: found.startedAt ?? null,
        receipt: { found: true, source: listing.source, facts: found },
        // Its own row class. An unclaimed run contradicts no claim, so it is not `contradicted`,
        // and it is not a claim, so it is none of the three claim states.
        state: 'unclaimed',
        verdict: 'executed-never-claimed',
        reasons: ['EXECUTED_NEVER_CLAIMED'],
        detail: `${name} ran ${found.id} (${found.workflowId ?? subject ?? 'unknown subject'}) at ${found.startedAt}; no claim accounts for it`,
      }));
    }
  }

  return extras;
}

// A carried result stands in for the claim that produced it, so the enumeration scope still covers
// the subject and the window that claim asked about.
function carriedRecords(carried) {
  return carried
    .filter((result) => result.claim_id !== null && result.window !== null && result.window !== undefined)
    .map((result) => ({
      id: result.claim_id,
      valid: true,
      claim: { target: { ...(result.target ?? {}), adapter: result.adapter, window: result.window } },
    }));
}

export async function reconcile({
  records,
  adapters,
  deps = {},
  doubleFireSeconds = DEFAULT_DOUBLE_FIRE_SECONDS,
  // Results settled by an earlier run. They are not re-looked-up, and they are here rather than
  // simply omitted because their receipts still account for the records they covered.
  carried = [],
  // Widen enumeration past the subjects the claims named. Off by default, per decision D2.
  enumerateAll = false,
}) {
  if (records.length === 0 && carried.length === 0) {
    return {
      refusal: {
        reason: 'EMPTY_CLAIMS',
        detail: 'the claims file holds no claims; a run with nothing to join is not a healthy run',
      },
      results: [],
      summary: summarize([]),
      strict_ok: false,
    };
  }

  const results = [...carried];
  for (const record of records) {
    results.push({ ...(await resolveOne(record, adapters, deps, doubleFireSeconds)), carried: false });
  }
  results.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

  const extras = await findUnclaimed([...records, ...carriedRecords(carried)], adapters, deps, results, enumerateAll);
  const all = [...results, ...extras];

  return { refusal: null, results: all, summary: summarize(all), strict_ok: strictOk(all) };
}

function summarize(results) {
  const claims = results.filter((result) => result.claim_id !== null);
  // A row that answers no claim and is not a record either: "I did not enumerate wf-201, because the
  // claim about it could not be resolved". A fact about the run. Counting it as an unresolved CLAIM
  // made the header read "2 unresolved claims" for one claim and one note.
  const notes = results.filter((result) => result.claim_id === null && result.state !== 'unclaimed');
  return {
    total: results.length,
    // Claims, unclaimed runs and notes are counted apart, because one is an answer about something
    // somebody asserted, one is a record nobody mentioned, and one is neither.
    claims: claims.length,
    unclaimed: results.filter((result) => result.state === 'unclaimed').length,
    notes: notes.length,
    matched: claims.filter((result) => result.state === 'matched').length,
    // What this run learned that an earlier one had not already settled. An hourly cron whose
    // summary restates every agreement it has ever reached is a summary nobody reads.
    new_findings: results.filter((result) => result.carried !== true).length,
    contradicted: claims.filter((result) => result.state === 'contradicted').length,
    unresolved: claims.filter((result) => result.state === 'unresolved').length,
    orphaned_claims: results.filter((result) => result.verdict === 'orphaned-claim').length,
    executed_never_claimed: results.filter((result) => result.verdict === 'executed-never-claimed').length,
  };
}

// A run every one of whose claims is unresolved learned nothing, and saying so is the point of
// --strict. A run with any contradiction is also not ok, because a contradiction is the thing
// this tool was built to surface.
function strictOk(results) {
  const claims = results.filter((result) => result.claim_id !== null);
  if (claims.length === 0) return false;
  return claims.every((result) => result.state === 'matched');
}

export { summarize };
