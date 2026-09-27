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
  const fires = Array.isArray(facts.fires) ? [...facts.fires] : [];
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
        'target.cadence needs expected_fires, or every_seconds together with a window',
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

function expectedFires(cadence, window) {
  if (Number.isInteger(cadence.expected_fires)) return cadence.expected_fires;
  if (Number.isFinite(cadence.every_seconds) && window) {
    const span = (Date.parse(window.to) - Date.parse(window.from)) / 1000;
    if (Number.isNaN(span)) return null;
    return Math.floor(span / cadence.every_seconds);
  }
  return null;
}

// What the claim asserts, against the facts of a record that exists.
function interpret(base, claim, facts, doubleFireSeconds) {
  const kind = claim.kind;

  if (facts?.kind === 'fires') return checkFires(base, claim, facts, doubleFireSeconds);

  if (kind === 'merged') {
    if (facts?.state === 'MERGED') {
      return matched(base, 'MERGED', `${facts.repo}#${facts.number} is merged at ${facts.merge_commit ?? 'an unreported sha'}`);
    }
    return contradicted(
      base,
      'CLAIMED_MERGED_NOT_MERGED',
      `${facts.repo}#${facts.number} is ${String(facts?.state).toLowerCase()}, not merged`,
    );
  }

  if (kind === 'pushed') {
    if (facts?.kind === 'commit') {
      return facts.on_default_branch === true
        ? matched(base, 'ON_DEFAULT_BRANCH', `${facts.sha} is contained in ${facts.default_branch}`)
        : contradicted(base, 'COMMIT_NOT_ON_DEFAULT_BRANCH', `${facts.sha} exists but is not contained in ${facts.default_branch}`);
    }
    return matched(base, 'PRESENT_ON_REMOTE', `${facts?.kind ?? 'record'} ${facts?.name ?? ''} exists on the remote`.trim());
  }

  if (kind === 'completed') {
    if (facts?.status !== undefined && facts.status !== 'success') {
      return contradicted(
        base,
        'CLAIMED_COMPLETED_BUT_FAILED',
        `execution ${facts.id} has status ${facts.status}`,
      );
    }
    return matched(base, 'COMPLETED', `execution ${facts.id} finished with status ${facts.status ?? 'success'}`);
  }

  return matched(base, 'RECORD_EXISTS', `the authoritative system has a ${facts?.kind ?? 'record'} for this target`);
}

async function resolveOne(record, adapters, deps, doubleFireSeconds) {
  const base = {
    claim_id: record.id,
    line: record.line,
    actor: record.claim?.actor ?? null,
    kind: record.claim?.kind ?? null,
    adapter: record.claim?.target?.adapter ?? null,
    at: record.claim?.at ?? null,
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

  const required = adapter.requiredKeys?.[claim.kind] ?? [];
  const missing = required.filter((key) => claim.target[key] === undefined);
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

// Every execution the adapter can enumerate that no claim accounted for. An adapter with no
// enumerate simply never produces this verdict, which is the honest outcome rather than a
// silent zero.
async function findUnclaimed(records, adapters, deps, results) {
  const claimedRecordIds = new Set();
  for (const result of results) {
    const facts = result.receipt?.facts;
    if (facts?.kind === 'execution' && facts.id !== undefined) claimedRecordIds.add(`${result.adapter}:${facts.id}`);
    if (facts?.kind === 'fires') {
      for (const fire of facts.fires ?? []) claimedRecordIds.add(`${result.adapter}:${fire.executionId}`);
    }
  }

  const extras = [];
  for (const [name, adapter] of Object.entries(adapters)) {
    if (typeof adapter.enumerate !== 'function') continue;

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
      extras.push({
        claim_id: null,
        line: null,
        actor: null,
        kind: null,
        adapter: name,
        at: null,
        evidence: null,
        receipt: null,
        state: 'unresolved',
        verdict: null,
        reasons: ['ADAPTER_UNREACHABLE'],
        detail: `${name} could not enumerate its source: ${error.message}`,
      });
      continue;
    }

    if (listing?.reachable === false || listing?.source?.complete === false) {
      extras.push({
        claim_id: null,
        line: null,
        actor: null,
        kind: null,
        adapter: name,
        at: null,
        evidence: null,
        receipt: listing,
        state: 'unresolved',
        verdict: null,
        reasons: [listing.reachable === false ? 'ADAPTER_UNREACHABLE' : 'PARTIAL_READ'],
        detail: `${name} could not fully enumerate ${scope.from} to ${scope.to}, so nothing here rules out an unclaimed run`,
      });
      continue;
    }

    for (const found of listing?.records ?? []) {
      if (claimedRecordIds.has(`${name}:${found.id}`)) continue;
      extras.push({
        claim_id: null,
        line: null,
        actor: null,
        kind: null,
        adapter: name,
        at: found.startedAt ?? null,
        evidence: null,
        receipt: { found: true, facts: found },
        state: 'contradicted',
        verdict: 'executed-never-claimed',
        reasons: ['EXECUTED_NEVER_CLAIMED'],
        detail: `${name} ran ${found.id} (${found.workflowId ?? 'unknown workflow'}) at ${found.startedAt}; no claim accounts for it`,
      });
    }
  }

  return extras;
}

export async function reconcile({ records, adapters, deps = {}, doubleFireSeconds = DEFAULT_DOUBLE_FIRE_SECONDS }) {
  if (records.length === 0) {
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

  const results = [];
  for (const record of records) {
    results.push(await resolveOne(record, adapters, deps, doubleFireSeconds));
  }

  const extras = await findUnclaimed(records, adapters, deps, results);
  const all = [...results, ...extras];

  return { refusal: null, results: all, summary: summarize(all), strict_ok: strictOk(all) };
}

function summarize(results) {
  return {
    total: results.length,
    matched: results.filter((result) => result.state === 'matched').length,
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
