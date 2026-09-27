// One reconciliation run, end to end: what is already settled, what still has to be looked up,
// the join, and the receipt.
//
// The idempotency rule lives here rather than in the core, because it is a fact about this
// operator's history on this machine and not about the join. A claim that matched in an earlier
// receipt is carried forward without consulting the adapter again, so an hourly cron reports
// what is NEW rather than restating everything it has ever agreed with.

import { reconcile, DEFAULT_DOUBLE_FIRE_SECONDS } from './reconcile.mjs';
import { writeReceipt, readSettled, writeSettled, RECEIPT_VERSION } from './receipts.mjs';

// The run's configuration, with anything secret left out. A receipt that recorded a key would
// turn every reconciliation into a credential leak.
function safeInputs(inputs, deps, doubleFireSeconds, recheck, enumerateAll, since) {
  const config = deps?.config ?? {};
  return {
    ...inputs,
    double_fire_seconds: doubleFireSeconds,
    recheck: recheck === true,
    enumerate: enumerateAll === true ? 'all' : 'claimed',
    since: since ?? null,
    adapters: Object.fromEntries(
      Object.entries(config).map(([name, settings]) => [
        name,
        Object.fromEntries(
          Object.entries(settings ?? {})
            .filter(([key]) => !/key|token|secret|password/i.test(key))
            .map(([key, value]) => [key, value]),
        ),
      ]),
    ),
  };
}

export async function runCheck({
  records,
  adapters,
  deps = {},
  outDir,
  at,
  inputs = {},
  recheck = false,
  enumerateAll = false,
  since = null,
  doubleFireSeconds = DEFAULT_DOUBLE_FIRE_SECONDS,
}) {
  const settled = recheck ? { claims: new Map(), unclaimed: new Map() } : readSettled(outDir);

  // --since skips claims older than an instant, so an append-only claims file does not grow the
  // work of every run forever (m-6).
  const inScope = since === null
    ? records
    : records.filter((record) => !record.valid || Date.parse(record.claim.at) >= Date.parse(since));

  const fresh = inScope.filter((record) => !(record.valid && settled.claims.has(record.id)));

  // A carried result keeps its original receipt, which is what lets the enumeration still see
  // the records that claim covered. Dropping it would report those records as unclaimed on every
  // run after the first.
  const carried = inScope
    .filter((record) => record.valid && settled.claims.has(record.id))
    .map((record) => ({ ...settled.claims.get(record.id), carried: true }));

  const outcome = await reconcile({ records: fresh, adapters, deps, doubleFireSeconds, carried, enumerateAll });

  if (outcome.refusal !== null) return { outcome, path: null, receipt: null };

  // An unclaimed run that an earlier receipt already reported is carried, not re-reported as news.
  // It is still printed, because it is still true; it just stops being new (D2).
  const results = outcome.results.map((result) => {
    if (result.state !== 'unclaimed') return result;
    const key = unclaimedKey(result);
    const known = settled.unclaimed.get(key);
    return known === undefined
      ? result
      : { ...result, carried: true, first_seen: known.first_seen };
  });

  const withFirstSeen = results.map((result) => ({ ...result, first_seen: result.first_seen ?? at }));
  const summary = { ...outcome.summary, new_findings: withFirstSeen.filter((result) => result.carried !== true).length };

  const receipt = {
    version: RECEIPT_VERSION,
    tool: 'landed',
    at,
    inputs: safeInputs(inputs, deps, doubleFireSeconds, recheck, enumerateAll, since),
    summary,
    strict_ok: outcome.strict_ok,
    results: withFirstSeen,
  };

  const path = writeReceipt(outDir, receipt);
  writeSettled(outDir, nextSettled(settled, withFirstSeen, at));

  return { outcome: { ...outcome, results: withFirstSeen, summary }, receipt, path };
}

function unclaimedKey(result) {
  return `${result.adapter}:${result.receipt?.facts?.id}`;
}

// The index the NEXT run reads. Only what that run needs: the matched claims it can skip, and the
// unclaimed runs it should not call news again.
function nextSettled(settled, results, at) {
  const claims = new Map(settled.claims);
  const unclaimed = new Map(settled.unclaimed);

  for (const result of results) {
    if (result.state === 'unclaimed') {
      const key = unclaimedKey(result);
      if (!unclaimed.has(key)) unclaimed.set(key, { first_seen: result.first_seen ?? at });
      continue;
    }
    if (result.claim_id === null || result.claim_id === undefined) continue;
    if (result.state === 'matched') claims.set(result.claim_id, result);
    else claims.delete(result.claim_id);
  }

  return { claims, unclaimed, updated_at: at };
}
