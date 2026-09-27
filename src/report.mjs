// Rendering a receipt as something an operator reads in five seconds.
//
// The shape of the output follows what the tool is for. The counts come first, because the
// question at 9am is "did anything disagree overnight". Then one line per claim with its reason
// code, and under it the detail in the authoritative system's own terms. Nothing here is a
// claim; every detail line was read from the system of record.

const STATE_ORDER = { contradicted: 0, unresolved: 1, matched: 2 };

function pad(value, width) {
  return String(value).padEnd(width);
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export function summaryLines(summary) {
  // Claims first, and unclaimed runs on their own line. The old header counted an unclaimed run as a
  // contradicted claim, which is the arithmetic D2 exists to undo.
  const lines = [
    `  ${plural(summary.contradicted, 'contradicted claim')}`,
    `  ${plural(summary.unresolved, 'unresolved claim')}`,
    `  ${plural(summary.matched, 'matched claim')}`,
  ];

  if (summary.orphaned_claims > 0) lines.push(`  ${plural(summary.orphaned_claims, 'orphaned claim')}`);
  if (summary.notes > 0) lines.push(`  ${plural(summary.notes, 'note about this run')}`);
  if (summary.executed_never_claimed > 0) {
    // Spelled out, because the default "add an s" turns this phrase into "run nobody claimeds",
    // which is what a live run with five unclaimed executions printed.
    lines.push(`  ${plural(summary.executed_never_claimed, 'run nobody claimed', 'runs nobody claimed')}`);
  }

  return lines;
}

// One line an operator can paste into a message.
export function oneLine(summary) {
  return `${summary.contradicted} contradicted, ${summary.unresolved} unresolved, ${summary.matched} matched, out of ${plural(summary.total, 'joined record')}`;
}

// Was this row's verdict read from a reachable source, on THIS run?
//
// Ship-check W-1: the trust line was printed unconditionally, including after a run where every row
// was ADAPTER_UNREACHABLE, after `report` (which reads nothing), and beside a row carried from an
// earlier run and deliberately not re-read. A product's one trust sentence has to be the one claim
// in it that is always true.
function wasRead(row) {
  if (row.carried === true) return false;
  const receipt = row.receipt;
  if (receipt === null || receipt === undefined) return false;
  if (receipt.reachable === false) return false;
  if (receipt.source?.complete === false) return false;
  return true;
}

export function renderReceipt(receipt, { receiptPath = null, strict = false, mode = 'check' } = {}) {
  const lines = [`landed ${receipt.at}`, ''];
  lines.push(...summaryLines(receipt.summary), '');

  const rows = [...receipt.results].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.line ?? 1e9) - (b.line ?? 1e9),
  );

  const claims = rows.filter((row) => row.claim_id !== null);
  const unclaimed = rows.filter((row) => row.state === 'unclaimed');
  const notes = rows.filter((row) => row.claim_id === null && row.state !== 'unclaimed');

  for (const row of claims) lines.push(...rowLines(row));

  // Its own section, because an unclaimed run answers no claim and reading it in the same list as
  // the claims is what made the old header count it as a contradicted claim (m-7, D2).
  if (unclaimed.length > 0) {
    lines.push('', `  unclaimed runs (${unclaimed.length}) — records the authoritative system holds that no claim accounts for`);
    for (const row of unclaimed) lines.push(...rowLines(row));
  }

  // Facts about the RUN rather than answers about a claim: a subject that was not enumerated, a
  // listing that could not be completed. They belong nowhere near the claim counts.
  if (notes.length > 0) {
    lines.push('', `  notes on this run (${notes.length})`);
    for (const row of notes) lines.push(...rowLines(row));
  }

  lines.push('');
  if (receiptPath !== null) lines.push(`  receipt   ${receiptPath}`);
  lines.push(`  ${oneLine(receipt.summary)}`);

  const news = receipt.summary.new_findings ?? receipt.summary.total;
  const carried = receipt.summary.total - news;
  if (carried > 0) lines.push(`  ${plural(carried, 'row')} carried from an earlier run and not re-read. Use --recheck to re-verify.`);

  lines.push('');

  // A run that could not read the authoritative side at all is not a quiet run.
  if (receipt.summary.claims > 0 && receipt.summary.matched === 0 && receipt.summary.contradicted === 0) {
    lines.push('  This run resolved nothing. Every claim is unresolved, which means the authoritative');
    lines.push(strict
      ? '  side was not read rather than that your systems agree. This run exits 3.'
      : '  side was not read rather than that your systems agree. Run with --strict to make that a');
    if (!strict) lines.push('  non-zero exit.');
    lines.push('');
  }

  if (mode === 'demo') {
    lines.push('  This is the recorded demo corpus, so it disagrees on purpose and still exits 0.');
    lines.push('  A non-zero demo would read as a broken install rather than as a working tool.');
    lines.push('');
  }

  const unread = rows.filter((row) => !wasRead(row));

  if (mode === 'report') {
    lines.push(`  Rendered from the stored receipt for ${receipt.at}. Nothing was read for this table;`);
    lines.push('  run check to reconcile again.');
  } else if (unread.length === 0) {
    lines.push('  Every line above was read from the system of record, not from what an agent said.');
  } else {
    // Says what was NOT read, which is the useful half of the sentence it replaces.
    const codes = [...new Set(unread.flatMap((row) => (row.carried === true ? ['CARRIED'] : row.reasons)))].sort();
    lines.push(`  ${unread.length} of ${rows.length} rows above were not read from the system of record on this run`);
    lines.push(`  (${codes.join(', ')}). The rest were.`);
  }

  return lines.join('\n');
}

function rowLines(row) {
  // Three row classes, three labels. An unclaimed RUN and a note about the run share only "no claim
  // id", and reusing one label for both is how a reader concludes the tool found a run it never
  // mentioned.
  const id = row.claim_id ?? (row.state === 'unclaimed' ? '(unclaimed)' : '(note)');
  const flag = row.carried === true ? ' carried' : '';
  // The named verdict is printed beside the reason, because "orphaned-claim" and
  // "executed-never-claimed" are the two findings an operator hunts for by name.
  const verdict = row.verdict === null || row.verdict === undefined ? '' : ` [${row.verdict}]`;
  return [
    `  ${pad(id, 12)}${pad(row.state, 14)}${pad(row.adapter ?? '-', 8)}${row.reasons.join(', ')}${verdict}${flag}`,
    `      ${row.detail}`,
  ];
}

export function renderValidation(report, { path }) {
  const lines = [`landed validate ${path}`, ''];
  lines.push(`  ${plural(report.valid, 'claim')} well formed`);
  lines.push(`  ${plural(report.problems.length, 'claim')} refused`);

  if (report.problems.length > 0) {
    lines.push('');
    for (const problem of report.problems) {
      lines.push(`  line ${pad(problem.line, 5)}${pad(problem.id ?? '-', 10)}${problem.reason}`);
      lines.push(`      ${problem.detail}`);
    }
  }

  lines.push('');
  lines.push('  A refused claim is never dropped. It resolves to unresolved, with this reason.');
  return lines.join('\n');
}
