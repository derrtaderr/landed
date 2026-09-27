// One reconciliation run, end to end: what is already settled, what still has to be looked up,
// the join, and the receipt.
//
// The idempotency rule lives here rather than in the core, because it is a fact about this
// operator's history on this machine and not about the join. A claim that matched in an earlier
// receipt is carried forward without consulting the adapter again, so an hourly cron reports
// what is NEW rather than restating everything it has ever agreed with.

import { reconcile, DEFAULT_DOUBLE_FIRE_SECONDS } from './reconcile.mjs';
import { writeReceipt, settledClaims, RECEIPT_VERSION } from './receipts.mjs';

// The run's configuration, with anything secret left out. A receipt that recorded a key would
// turn every reconciliation into a credential leak.
function safeInputs(inputs, deps, doubleFireSeconds, recheck) {
  const config = deps?.config ?? {};
  return {
    ...inputs,
    double_fire_seconds: doubleFireSeconds,
    recheck: recheck === true,
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
  doubleFireSeconds = DEFAULT_DOUBLE_FIRE_SECONDS,
}) {
  const settled = recheck ? new Map() : settledClaims(outDir);

  const fresh = records.filter((record) => !(record.valid && settled.has(record.id)));

  // A carried result keeps its original receipt, which is what lets the enumeration still see
  // the records that claim covered. Dropping it would report those records as unclaimed on every
  // run after the first.
  const carried = records
    .filter((record) => record.valid && settled.has(record.id))
    .map((record) => ({ ...settled.get(record.id), carried: true }));

  const outcome = await reconcile({ records: fresh, adapters, deps, doubleFireSeconds, carried });

  if (outcome.refusal !== null) return { outcome, path: null, receipt: null };

  const receipt = {
    version: RECEIPT_VERSION,
    tool: 'landed',
    at,
    inputs: safeInputs(inputs, deps, doubleFireSeconds, recheck),
    summary: outcome.summary,
    strict_ok: outcome.strict_ok,
    results: outcome.results.map((result) => ({ ...result, first_seen: result.first_seen ?? at })),
  };

  return { outcome, receipt, path: writeReceipt(outDir, receipt) };
}
