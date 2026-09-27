// Receipt files. One per run, under `<out>/receipts/`.
//
// A receipt holds the verdict per claim AND the adapter response that produced it, so a verdict
// can be re-derived later rather than taken on trust. That is the same reason `landed` stores
// the run's inputs: a reconciler whose own output has to be believed is not much of an
// improvement on the claims it reads.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const RECEIPT_VERSION = 1;

// Colons are legal in a POSIX filename and a nuisance everywhere else, so the instant is
// flattened. The substitution keeps lexical order equal to chronological order.
export function receiptFilename(at, suffix = 1) {
  const stem = at.replace(/:/g, '-').replace(/\./g, '-');
  return suffix === 1 ? `${stem}.json` : `${stem}--${suffix}.json`;
}

export function receiptsDir(outDir) {
  return join(outDir, 'receipts');
}

// Thrown when the out directory cannot be written. The CLI turns it into a one-line refusal; an
// uncaught stack trace exits 1, which is the same code as "findings" and reads as an alarm.
export class ReceiptWriteError extends Error {}

export function writeReceipt(outDir, receipt) {
  const dir = receiptsDir(outDir);

  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new ReceiptWriteError(`cannot write receipts into ${dir}: ${error.code ?? error.message}`);
  }

  // Two runs can land in the same millisecond, and the second must not erase the first. A suffix is
  // added rather than the name reused, so the receipt set is append-only in practice as well as in
  // intent.
  let path = join(dir, receiptFilename(receipt.at));
  for (let suffix = 2; existsSync(path); suffix += 1) {
    path = join(dir, receiptFilename(receipt.at, suffix));
  }

  try {
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    throw new ReceiptWriteError(`cannot write ${path}: ${error.code ?? error.message}`);
  }

  return path;
}

// Every receipt in the directory, oldest first. A file that is not readable JSON is skipped
// rather than fatal: a half-written receipt from a killed cron run must not stop the next one.
export function readReceipts(outDir) {
  const dir = receiptsDir(outDir);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(dir, name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((receipt) => receipt !== null && typeof receipt.at === 'string');
}

export function latestReceipt(outDir) {
  const receipts = readReceipts(outDir);
  return receipts.length === 0 ? null : receipts.at(-1);
}

// The claims that are already settled, by id, taken from the most recent receipt that resolved
// each one. Only a MATCH settles a claim: a contradiction is still true and still unfixed, so it
// is re-reported every run until the world changes.
export const SETTLED_FILE = 'settled.json';
export const SETTLED_VERSION = 1;

// Beside the receipts directory, not inside it, so `receipts/` holds receipts and nothing else.
export function settledPath(outDir) {
  return join(outDir, SETTLED_FILE);
}

// The settled index. One small file beside the receipts, so a run does not have to parse every
// receipt it has ever written: ship-check measured a 50MB claims file producing a 482MB receipt set
// and 2.8GB RSS on the next run, all of it re-parsing history (m-6).
//
// Two kinds of entry. A CLAIM is settled only by a match, because a contradiction is still true and
// still unfixed. An UNCLAIMED RUN is settled by having been reported once, because the report is the
// whole finding and repeating it hourly is the F-04 noise.
export function readSettled(outDir) {
  const path = settledPath(outDir);

  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed?.version === SETTLED_VERSION) {
        return {
          claims: new Map(Object.entries(parsed.claims ?? {})),
          unclaimed: new Map(Object.entries(parsed.unclaimed ?? {})),
        };
      }
    } catch {
      // A half-written index is rebuilt below rather than being fatal.
    }
  }

  return rebuildSettled(outDir);
}

// The one-time fallback, for an out directory written before the index existed, or whose index was
// lost. It is the old behaviour, kept only as a repair path.
export function rebuildSettled(outDir) {
  const claims = new Map();
  const unclaimed = new Map();

  for (const receipt of readReceipts(outDir)) {
    for (const result of receipt.results ?? []) {
      if (result.state === 'unclaimed') {
        const key = `${result.adapter}:${result.receipt?.facts?.id}`;
        if (!unclaimed.has(key)) unclaimed.set(key, { first_seen: result.first_seen ?? receipt.at });
        continue;
      }
      if (result.claim_id === null || result.claim_id === undefined) continue;
      if (result.state === 'matched') {
        claims.set(result.claim_id, { ...result, first_seen: result.first_seen ?? receipt.at });
      } else {
        claims.delete(result.claim_id);
      }
    }
  }

  return { claims, unclaimed };
}

export function writeSettled(outDir, settled) {
  const path = settledPath(outDir);
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (error) {
    throw new ReceiptWriteError(`cannot write ${path}: ${error.code ?? error.message}`);
  }
  const body = {
    version: SETTLED_VERSION,
    updated_at: settled.updated_at,
    claims: Object.fromEntries(settled.claims),
    unclaimed: Object.fromEntries(settled.unclaimed),
  };

  try {
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  } catch (error) {
    throw new ReceiptWriteError(`cannot write ${path}: ${error.code ?? error.message}`);
  }
}
