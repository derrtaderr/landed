// The join. This is the only place a state is decided.
//
// Adapters report what the authoritative system says. This module decides what that MEANS
// against the claim, in one precedence order, so that every way of not knowing lands in
// `unresolved` rather than leaking into `matched`. docs/SPEC.md §3C is the contract.

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

function withinWindow(instant, window) {
  if (window === undefined || window === null) return true;
  const at = Date.parse(instant);
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (Number.isNaN(at) || Number.isNaN(from) || Number.isNaN(to)) return true;
  return at >= from && at <= to;
}

// The named n8n checks, applied to a `fires` receipt. They live here rather than in the
// adapter because they are interpretations, and an adapter that interprets is an adapter whose
// verdicts nobody can re-derive.
function checkFires(base, claim, facts, doubleFireSeconds) {
  const fires = [...(Array.isArray(facts.fires) ? facts.fires : [])];
  fires.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

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
        `${facts.workflowId} fired ${fires.length} time(s) in the window; the declared cadence expects ${expected}`,
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
    return Math.floor(span / cadence.every_seconds);
  }
  return null;
}

// What the claim ASSERTS, against the facts of a record that does exist. `found: true` only
// says the authoritative system holds a record; whether that record agrees with the claim is
// this function's question and nothing else's.
function interpret(base, claim, facts, doubleFireSeconds) {
  if (facts?.kind === 'fires') return checkFires(base, claim, facts, doubleFireSeconds);

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
    if (facts?.kind === 'commit') {
      return facts.on_default_branch === true
        ? matched(base, 'ON_DEFAULT_BRANCH', `${facts.sha} is contained in ${facts.default_branch}`)
        : contradicted(
            base,
            'COMMIT_NOT_ON_DEFAULT_BRANCH',
            `${facts.sha} exists but is not contained in ${facts.default_branch}`,
          );
    }
    return matched(base, 'PRESENT_ON_REMOTE', `${facts?.kind ?? 'record'} ${facts?.name ?? ''} exists on the remote`.replace(/\s+/g, ' ').trim());
  }

  if (claim.kind === 'completed') {
    if (facts?.status !== undefined && facts.status !== 'success') {
      return contradicted(base, 'CLAIMED_COMPLETED_BUT_FAILED', `execution ${facts.id} has status ${facts.status}`);
    }
    return matched(base, 'COMPLETED', `execution ${facts.id} finished with status ${facts.status ?? 'success'}`);
  }

  return matched(base, 'RECORD_EXISTS', `the authoritative system has a ${facts?.kind ?? 'record'} for this target`);
}

// A join key is either a name the target must carry, or a nested array meaning "at least one
// of these". GitHub answers a `pushed` claim about a branch OR about a commit, and a contract
// that could not say so would push that choice into the adapter, where the core could no
// longer refuse a target it cannot join.
function missingJoinKeys(required, target) {
  const missing = [];
  for (const key of required) {
    if (Array.isArray(key)) {
      if (key.every((alternative) => target[alternative] === undefined)) missing.push(key.join(' or '));
    } else if (target[key] === undefined) {
      missing.push(key);
    }
  }
  return missing;
}

async function resolveOne(record, adapters, deps, doubleFireSeconds) {
  const base = {
    claim_id: record.id,
    line: record.line,
    actor: record.claim?.actor ?? null,
    kind: record.claim?.kind ?? null,
    adapter: record.claim?.target?.adapter ?? null,
    at: record.claim?.at ?? null,
    // The window this claim asked about, kept on the result so that a run which CARRIES this
    // claim forward can still derive the enumeration scope from it. Without it, the second run
    // enumerates nothing and every unclaimed record silently stops being reported.
    window: record.claim?.target?.window ?? null,
    evidence: record.claim?.evidence ?? null,
    receipt: null,
  };

  if (!record.valid) return unresolved(base, record.reason, record.detail);

  const claim = record.claim;
  const adapter = adapters[claim.target.adapter];
  if (adapter === undefined) {
    return unresolved(base, 'UNKNOWN_ADAPTER', `no adapter named ${claim.target.adapter} is registered`);
  }

  if (!adapter.kinds.includes(claim.kind)) {
    return unresolved(
      base,
      'KIND_NOT_SUPPORTED',
      `the ${adapter.name} adapter answers ${adapter.kinds.join(', ')}, not ${claim.kind}`,
    );
  }

  const missing = missingJoinKeys(adapter.requiredKeys?.[claim.kind] ?? [], claim.target);
  if (missing.length > 0) {
    return unresolved(
      base,
      'MALFORMED_CLAIM',
      `target is missing the join key(s) ${missing.join(', ')} that ${adapter.name} needs for a ${claim.kind} claim`,
    );
  }

  let receipt;
  try {
    receipt = await adapter.lookup(claim.target, deps);
  } catch (error) {
    return unresolved(base, 'ADAPTER_UNREACHABLE', `${adapter.name} threw: ${error.message}`);
  }

  const withReceipt = { ...base, receipt };

  if (receipt?.reachable === false) {
    return unresolved(withReceipt, 'ADAPTER_UNREACHABLE', `${adapter.name} could not be read: ${receipt.reason}`);
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
      `${adapter.name} read its source and has no record for this target`,
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
    evidence: null,
    receipt: null,
    verdict: null,
    ...fields,
  };
}

// Every record the adapter can enumerate that no claim accounted for. An adapter with no
// enumerate never produces this verdict, which is the honest outcome; a zero from an adapter
// that cannot look is not the same as a zero from one that looked.
async function findUnclaimed(records, adapters, deps, results) {
  // What a claim ACCOUNTS FOR comes from the receipt's own declaration: `facts.id` for a
  // single record, `facts.covers` for a receipt that stands for several. The core knowing which
  // vendor field held the ids was the gap test/new-adapter.test.mjs opened; a receipt that
  // declares no coverage accounts for nothing, which is the safe default.
  const accounted = new Set();
  for (const result of results) {
    const facts = result.receipt?.facts;
    if (facts?.id !== undefined) accounted.add(`${result.adapter}:${facts.id}`);
    for (const id of facts?.covers ?? []) accounted.add(`${result.adapter}:${id}`);
  }

  const extras = [];

  for (const [name, adapter] of Object.entries(adapters)) {
    if (typeof adapter.enumerate !== 'function') continue;

    // The scope is the union of the windows the claims themselves asked about. Enumerating
    // wider would report runs from a period nobody was reconciling.
    const windows = records
      .filter((record) => record.valid && record.claim.target.adapter === name && record.claim.target.window)
      .map((record) => record.claim.target.window);
    if (windows.length === 0) continue;

    const scope = {
      from: windows.map((window) => window.from).sort()[0],
      to: windows.map((window) => window.to).sort().at(-1),
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
      extras.push(bareResult(name, {
        at: found.startedAt ?? null,
        receipt: { found: true, source: listing.source, facts: found },
        state: 'contradicted',
        verdict: 'executed-never-claimed',
        reasons: ['EXECUTED_NEVER_CLAIMED'],
        detail: `${name} ran ${found.id} (${found.workflowId ?? 'unknown workflow'}) at ${found.startedAt}; no claim accounts for it`,
      }));
    }
  }

  return extras;
}

// A carried result stands in for the claim that produced it, so the enumeration scope still
// covers the window that claim asked about.
function carriedRecords(carried) {
  return carried
    .filter((result) => result.window !== null && result.window !== undefined)
    .map((result) => ({ valid: true, claim: { target: { adapter: result.adapter, window: result.window } } }));
}

export async function reconcile({
  records,
  adapters,
  deps = {},
  doubleFireSeconds = DEFAULT_DOUBLE_FIRE_SECONDS,
  // Results settled by an earlier run. They are not re-looked-up, and they are here rather than
  // simply omitted because their receipts still account for the records they covered.
  carried = [],
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

  const extras = await findUnclaimed([...records, ...carriedRecords(carried)], adapters, deps, results);
  const all = [...results, ...extras];

  return { refusal: null, results: all, summary: summarize(all), strict_ok: strictOk(all) };
}

function summarize(results) {
  return {
    total: results.length,
    matched: results.filter((result) => result.state === 'matched').length,
    // What this run learned that an earlier one had not already settled. An hourly cron whose
    // summary restates every agreement it has ever reached is a summary nobody reads.
    new_findings: results.filter((result) => result.carried !== true).length,
    contradicted: results.filter((result) => result.state === 'contradicted').length,
    unresolved: results.filter((result) => result.state === 'unresolved').length,
    orphaned_claims: results.filter((result) => result.verdict === 'orphaned-claim').length,
    executed_never_claimed: results.filter((result) => result.verdict === 'executed-never-claimed').length,
  };
}

// A run every one of whose claims is unresolved learned nothing, and saying so is the point of
// --strict. A run with any contradiction is also not ok, because a contradiction is the thing
// this tool was built to surface.
function strictOk(results) {
  if (results.length === 0) return false;
  if (results.some((result) => result.state === 'contradicted')) return false;
  return results.every((result) => result.state === 'matched');
}

export { summarize };
