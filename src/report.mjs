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
  const lines = [
    `  ${plural(summary.contradicted, 'contradicted claim')}`,
    `  ${plural(summary.unresolved, 'unresolved claim')}`,
    `  ${plural(summary.matched, 'matched claim')}`,
  ];

  if (summary.orphaned_claims > 0) lines.push(`  ${plural(summary.orphaned_claims, 'orphaned claim')}`);
  if (summary.executed_never_claimed > 0) {
    lines.push(`  ${plural(summary.executed_never_claimed, 'run nobody claimed')}`);
  }

  return lines;
}

// One line an operator can paste into a message.
export function oneLine(summary) {
  return `${summary.contradicted} contradicted, ${summary.unresolved} unresolved, ${summary.matched} matched, out of ${plural(summary.total, 'joined record')}`;
}

export function renderReceipt(receipt, { receiptPath = null } = {}) {
  const lines = [`landed ${receipt.at}`, ''];
  lines.push(...summaryLines(receipt.summary), '');

  const rows = [...receipt.results].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.line ?? 1e9) - (b.line ?? 1e9),
  );

  for (const row of rows) {
    const id = row.claim_id ?? '(unclaimed)';
    const flag = row.carried === true ? ' carried' : '';
    // The named verdict is printed beside the reason, because "orphaned-claim" and
    // "executed-never-claimed" are the two findings an operator hunts for by name.
    const verdict = row.verdict === null || row.verdict === undefined ? '' : ` [${row.verdict}]`;
    lines.push(`  ${pad(id, 12)}${pad(row.state, 14)}${pad(row.adapter ?? '-', 8)}${row.reasons.join(', ')}${verdict}${flag}`);
    lines.push(`      ${row.detail}`);
  }

  lines.push('');
  if (receiptPath !== null) lines.push(`  receipt   ${receiptPath}`);
  lines.push(`  ${oneLine(receipt.summary)}`);

  const news = receipt.summary.new_findings ?? receipt.summary.total;
  const carried = receipt.summary.total - news;
  if (carried > 0) lines.push(`  ${plural(carried, 'claim')} carried from an earlier run and not re-read. Use --recheck to re-verify.`);

  lines.push('');
  lines.push('  Every line above was read from the system of record, not from what an agent said.');

  return lines.join('\n');
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
