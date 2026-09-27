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
export function settledClaims(outDir) {
  const settled = new Map();
  for (const receipt of readReceipts(outDir)) {
    for (const result of receipt.results ?? []) {
      if (result.claim_id === null || result.claim_id === undefined) continue;
      if (result.state === 'matched') {
        settled.set(result.claim_id, { ...result, first_seen: result.first_seen ?? receipt.at });
      } else {
        settled.delete(result.claim_id);
      }
    }
  }
  return settled;
}
