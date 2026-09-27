// The CLI. Five verbs: check, validate, report, demo, watch.
//
// This is where bytes reach disk and where the exit code is decided, and the exit code is the
// part that matters most. `landed` runs unattended, so a reconciler that exits 0 after finding a
// contradiction has told nobody anything.
//
//   0  the run completed and nothing disagreed
//   1  findings: something is contradicted, or --strict and something is unresolved
//   2  a refusal: no claims file, no claims in it, nothing to report

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

import { adapters } from './adapters/index.mjs';
import { ReceiptWriteError } from './receipts.mjs';
import { parseClaims } from './claims.mjs';
import { validationReport, staticProblems } from './static-checks.mjs';
import { DEFAULT_DOUBLE_FIRE_SECONDS } from './reconcile.mjs';
import { runCheck } from './run.mjs';
import { latestReceipt, receiptFilename, receiptsDir } from './receipts.mjs';
import { renderReceipt, renderValidation } from './report.mjs';
import { hostDeps } from './host.mjs';
import { runDemo } from './demo.mjs';
import { appendClaim, generateClaimId } from './append.mjs';

export const USAGE = `landed — join what an agent CLAIMED against what actually LANDED, and
resolve every claim to matched, contradicted or unresolved.

Usage:
  node bin/landed.mjs check      Reconcile a claims file and write a receipt
  node bin/landed.mjs append     Append one validated claim, in a single atomic write
  node bin/landed.mjs validate   Check a claims file's shape, consulting no adapter
  node bin/landed.mjs report     Render the latest receipt as a table
  node bin/landed.mjs demo       Run the whole pipeline on recorded fixtures, keyless
  node bin/landed.mjs watch      Print a cron and launchd recipe for a standing check

Flags, per verb. Anything else is refused rather than ignored, so no invocation can quietly
become a different one than you typed. Write them as "--flag value", never "--flag=value".

  check      --claims <file>, --out <dir>, --strict, --recheck,
             --n8n-executions <file>, --n8n-workflows <file>,
             --double-fire-seconds <n>, --enumerate claimed|all, --since <ISO>
  append     --claims <file>, --actor <name>, --kind <kind>, --target <json>,
             --id <id>, --at <ISO>, --evidence <json>
  validate   --claims <file>
  report     --out <dir>
  demo       --out <dir>

Exit codes, because this is built to run from cron and the exit code is the only thing cron
reads:

  0  the run ran, every claim resolved, and nothing disagreed
  1  findings: something is contradicted
  2  a refusal: no claims file, nothing in it, an unwritable --out, or a flag that makes no sense
  3  nothing resolved: every claim this run actually read came back unresolved (carried rows do not count)

  --strict promotes ANY unresolved claim to exit 3, not just a run where everything was
  unresolved. Use it from cron. A lost credential must never share an exit code with a quiet
  healthy hour.

  Unclaimed runs are reported in their own section and do not set the exit code.

There is no install step, so the invocation is spelled out in full. A bare landed is not on
PATH in a fresh clone.

GitHub reads go through gh, which must already be authenticated; an unauthenticated or missing
gh is reported unreachable, never as an absence. n8n reads an executions export from disk, or
the REST API when LANDED_N8N_URL and LANDED_N8N_API_KEY are both set.

The demo needs no key and makes no network call. It writes only inside --out.
`;

const FLAG_SPEC = {
  check: {
    '--claims': 'value',
    '--out': 'value',
    '--strict': 'boolean',
    '--recheck': 'boolean',
    '--n8n-executions': 'value',
    '--n8n-workflows': 'value',
    '--double-fire-seconds': 'value',
    '--enumerate': 'value',
    '--since': 'value',
  },
  append: {
    '--claims': 'value',
    '--id': 'value',
    '--at': 'value',
    '--actor': 'value',
    '--kind': 'value',
    '--target': 'value',
    '--evidence': 'value',
  },
  validate: { '--claims': 'value' },
  report: { '--out': 'value' },
  demo: { '--out': 'value' },
  watch: {},
};

class Refusal extends Error {}

class HelpRequested extends Error {}

function parseFlags(verb, argv) {
  const spec = FLAG_SPEC[verb];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--help' || token === '-h') throw new HelpRequested();

    if (token.includes('=')) {
      throw new Refusal(`flags are written apart from their values: write "${token.split('=')[0]} ${token.split('=').slice(1).join('=')}", not "${token}"`);
    }
    if (spec[token] === undefined) throw new Refusal(`unknown flag: ${token}`);

    // A flag given twice used to keep the last value silently, which is exactly the "an invocation
    // quietly becomes a different one than you typed" that the usage text promises against.
    if (flags[token] !== undefined) throw new Refusal(`${token} given twice; one value per flag`);

    if (spec[token] === 'boolean') {
      flags[token] = true;
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Refusal(`${token} needs a value`);
    flags[token] = value;
    index += 1;
  }

  return flags;
}

function resolvePath(cwd, path) {
  return isAbsolute(path) ? path : join(cwd, path);
}

function outDirOf(flags, cwd) {
  return resolvePath(cwd, flags['--out'] ?? 'landed');
}

function readClaims(flags, cwd) {
  if (flags['--claims'] === undefined) throw new Refusal('check needs --claims <file>');
  const path = resolvePath(cwd, flags['--claims']);
  if (!existsSync(path)) throw new Refusal(`no claims file at ${path}`);
  return { path, text: readFileSync(path, 'utf8') };
}

// A path an operator can paste, without leaking where this machine keeps things.
function shortPath(cwd, path) {
  const short = relative(cwd, path);
  return short.startsWith('..') ? path : short;
}

// The contract, in one place. SPEC §3C.1.
//
// Only rows that answer a CLAIM count. An unclaimed run is reported in its own section and is
// deliberately not an exit code, because nobody claimed it and so no claim is wrong.
export function exitFor(outcome, strict) {
  const claims = outcome.results.filter((result) => result.claim_id !== null);
  const unresolved = claims.filter((result) => result.state === 'unresolved').length;
  const contradicted = claims.filter((result) => result.state === 'contradicted').length;

  // "Nothing resolved" is judged over the rows this run actually READ. Carried matches were read
  // on an earlier run; a run that read nothing new and hit an unreachable adapter must still be 3,
  // or this protection fires only on the first run in default mode (ship-check N-5).
  const fresh = claims.filter((result) => result.carried !== true);
  const freshUnresolved = fresh.filter((result) => result.state === 'unresolved').length;
  if (fresh.length > 0 && freshUnresolved === fresh.length) return 3;
  if (strict && unresolved > 0) return 3;
  if (contradicted > 0) return 1;
  return 0;
}

async function verbCheck(flags, { cwd, env, out }) {
  const claims = readClaims(flags, cwd);
  const outDir = outDirOf(flags, cwd);
  const doubleFireSeconds = flags['--double-fire-seconds'] === undefined
    ? DEFAULT_DOUBLE_FIRE_SECONDS
    : Number(flags['--double-fire-seconds']);

  if (!Number.isFinite(doubleFireSeconds) || doubleFireSeconds <= 0) {
    throw new Refusal(`--double-fire-seconds needs a positive number, not ${flags['--double-fire-seconds']}`);
  }

  const config = { n8n: {} };
  if (flags['--n8n-executions'] !== undefined) config.n8n.executionsPath = resolvePath(cwd, flags['--n8n-executions']);
  if (flags['--n8n-workflows'] !== undefined) config.n8n.workflowsPath = resolvePath(cwd, flags['--n8n-workflows']);

  const enumerate = flags['--enumerate'] ?? 'claimed';
  if (enumerate !== 'claimed' && enumerate !== 'all') {
    throw new Refusal(`--enumerate takes claimed or all, not ${enumerate}`);
  }

  const since = flags['--since'];
  if (since !== undefined && Number.isNaN(Date.parse(since))) {
    throw new Refusal(`--since needs an ISO 8601 instant, not ${since}`);
  }

  const { records } = parseClaims(claims.text);
  const result = await runCheck({
    records,
    adapters,
    deps: hostDeps({ env, config }),
    outDir,
    at: flags.__now,
    recheck: flags['--recheck'] === true,
    enumerateAll: enumerate === 'all',
    since: since ?? null,
    doubleFireSeconds,
    inputs: { claims: shortPath(cwd, claims.path) },
  });

  if (result.outcome.refusal !== null) {
    throw new Refusal(`${result.outcome.refusal.reason}: ${result.outcome.refusal.detail}`);
  }

  const strict = flags['--strict'] === true;
  out(renderReceipt(result.receipt, { receiptPath: shortPath(cwd, result.path), strict }));
  return exitFor(result.outcome, strict);
}

// Appending is the one write `landed` makes outside --out, and the only one that touches the
// operator's own claims file. It validates first, so a malformed claim never enters the file.
function verbAppend(flags, { cwd, out }) {
  for (const required of ['--claims', '--actor', '--kind', '--target']) {
    if (flags[required] === undefined) throw new Refusal(`append needs ${required}`);
  }

  const parseJsonFlag = (flag) => {
    try {
      return JSON.parse(flags[flag]);
    } catch (error) {
      throw new Refusal(`${flag} must be JSON: ${error.message}`);
    }
  };

  const claim = {
    at: flags['--at'] ?? flags.__now,
    actor: flags['--actor'],
    kind: flags['--kind'],
    target: parseJsonFlag('--target'),
  };
  claim.id = flags['--id'] ?? generateClaimId(claim);
  if (flags['--evidence'] !== undefined) claim.evidence = parseJsonFlag('--evidence');

  const path = resolvePath(cwd, flags['--claims']);

  // The static checks too, so `append` refuses exactly what `check` would call malformed (F-08).
  const [problem] = staticProblems(claim, adapters);
  if (problem !== undefined) throw new Refusal(problem.detail);

  try {
    appendClaim(path, claim);
  } catch (error) {
    throw new Refusal(error.message);
  }

  out(`appended ${claim.id} to ${shortPath(cwd, path)}`);
  return 0;
}

function verbValidate(flags, { cwd, out }) {
  const claims = readClaims(flags, cwd);
  // The same static checks `check` runs, so the two surfaces cannot disagree (F-08).
  const report = validationReport(claims.text, adapters);

  out(renderValidation(report, { path: shortPath(cwd, claims.path) }));
  return report.problems.length === 0 ? 0 : 1;
}

function verbReport(flags, { cwd, out }) {
  const outDir = outDirOf(flags, cwd);
  const receipt = latestReceipt(outDir);
  if (receipt === null) {
    throw new Refusal(`no receipt in ${shortPath(cwd, receiptsDir(outDir))}; run check or demo first`);
  }

  // `report` re-renders a stored receipt. It reports; it does not re-decide, so it does not carry
  // the check's exit code. 0 when it rendered something, 2 when there was nothing to render.
  out(renderReceipt(receipt, { receiptPath: shortPath(cwd, receipt.path ?? join(receiptsDir(outDir), receiptFilename(receipt.at))), mode: 'report' }));
  return 0;
}

async function verbDemo(flags, { cwd, out }) {
  const outDir = outDirOf(flags, cwd);
  const result = await runDemo({ outDir });

  out(renderReceipt(result.receipt, { receiptPath: shortPath(cwd, result.path), mode: 'demo' }));
  // The demo's corpus contains contradictions on purpose, so its exit code says "the demo ran",
  // not "your systems agree". A non-zero demo would read as a broken install.
  return 0;
}

function verbWatch(_flags, { out }) {
  out(`landed watch

  This is not a daemon, and it will not become one. A reconciler that only runs when someone
  remembers to run it is the problem this tool exists to solve, so the schedule belongs to the
  operating system, which already knows how to restart it.

  crontab -e, hourly, on the hour:

    0 * * * * cd /path/to/your/claims && /usr/local/bin/node /path/to/landed/bin/landed.mjs check --strict --claims claims.jsonl --out landed --n8n-executions exports/executions.json --n8n-workflows exports/workflows.json >> landed/check.log 2>&1

  launchd (macOS), the same thing, in ~/Library/LaunchAgents/ai.landed.check.plist:

    <?xml version="1.0" encoding="UTF-8"?>
    <plist version="1.0"><dict>
      <key>Label</key><string>ai.landed.check</string>
      <key>ProgramArguments</key><array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/landed/bin/landed.mjs</string>
        <string>check</string><string>--strict</string>
        <string>--claims</string><string>/path/to/claims.jsonl</string>
        <string>--out</string><string>/path/to/landed</string>
      </array>
      <key>StartCalendarInterval</key><dict><key>Minute</key><integer>0</integer></dict>
      <key>StandardOutPath</key><string>/path/to/landed/check.log</string>
      <key>StandardErrorPath</key><string>/path/to/landed/check.err</string>
    </dict></plist>

    launchctl load ~/Library/LaunchAgents/ai.landed.check.plist

  Both recipes pass --strict on purpose. Exit 1 means something disagreed and exit 3 means
  nothing could be read at all, which is the case that used to exit 0 and look like a quiet
  hour. Pipe the output wherever your team reads alarms; a finding nobody sees is the state this
  tool was built to end.`);
  return 0;
}

export async function main({ argv, out = console.log, err = console.error, cwd = process.cwd(), env = process.env, now = () => new Date().toISOString() }) {
  const [verb, ...rest] = argv;

  if (verb === undefined || verb === '--help' || verb === '-h') {
    err(USAGE);
    return verb === undefined ? 2 : 0;
  }

  if (FLAG_SPEC[verb] === undefined) {
    err(`unknown verb: ${verb}`);
    err('');
    err(USAGE);
    return 2;
  }

  try {
    const flags = parseFlags(verb, rest);
    flags.__now = now();

    if (verb === 'check') return await verbCheck(flags, { cwd, env, out });
    if (verb === 'append') return verbAppend(flags, { cwd, out });
    if (verb === 'validate') return verbValidate(flags, { cwd, out });
    if (verb === 'report') return verbReport(flags, { cwd, out });
    if (verb === 'demo') return await verbDemo(flags, { cwd, out });
    return verbWatch(flags, { out });
  } catch (error) {
    if (error instanceof HelpRequested) {
      out(USAGE);
      return 0;
    }
    // A write that cannot happen is a refusal, not a finding. An uncaught stack trace exits 1,
    // which is the code for "something disagreed", and reads as an alarm about the wrong thing.
    if (error instanceof Refusal || error instanceof ReceiptWriteError) {
      err(error.message);
      return 2;
    }
    throw error;
  }
}
