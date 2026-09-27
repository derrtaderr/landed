// `landed append`: one validated claim, written in one write.
//
// The claims file is append-only and several agents write to it at once. A write to a file opened
// O_APPEND is atomic only up to PIPE_BUF, and only if the whole line goes out in ONE call: two agents
// that each do "write the JSON, then write the newline" can interleave and leave a line that is
// neither claim. This module exists so the operator's hooks do not have to know that.
//
// It also validates before it writes. A malformed claim caught here never enters the file, which is
// better than being reported as unresolved forever after.

import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

import { parseClaims } from './claims.mjs';

// POSIX guarantees PIPE_BUF is at least 512 bytes, and that is the number to build on rather than
// the 4096 Linux happens to offer. A claim that does not fit is refused rather than written in a way
// that could tear.
export const MAX_ATOMIC_APPEND = 512;

export function appendClaim(path, claim, { write = appendFileSync } = {}) {
  // JSON.stringify escapes any newline inside a string, so one claim is always one line.
  const line = `${JSON.stringify(claim)}\n`;

  const { records } = parseClaims(line);
  const record = records[0];
  if (record === undefined) throw new Error('an empty claim cannot be appended');
  if (!record.valid) throw new Error(record.detail);

  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_ATOMIC_APPEND) {
    throw new Error(
      `this claim is ${bytes} bytes and cannot be appended atomically (the limit is ${MAX_ATOMIC_APPEND}); shorten its evidence, or write it with a lock of your own`,
    );
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    throw new Error(`cannot create ${dirname(path)}: ${error.code ?? error.message}`);
  }

  // ONE call. Not two, and not a stream.
  write(path, line);
  return line;
}

// A readable id that is unique per CLAIM, not per actor and instant. Two claims from one actor about
// two different PRs in the same second are two claims, and giving them one id made the second a
// DUPLICATE_CLAIM_ID refusal.
//
// Derived from the content, so replaying a byte-identical claim produces the same id, which
// parseClaims accepts as the replay it is.
export function generateClaimId(claim) {
  const stamp = String(claim.at).replace(/[^0-9]/g, '').slice(0, 14);
  const slug = `${claim.actor}-${claim.kind}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const digest = createHash('sha256').update(JSON.stringify({ ...claim, id: undefined })).digest('hex').slice(0, 8);
  return `${slug}-${stamp}-${digest}`;
}
