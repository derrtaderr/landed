// The keyless demo.
//
// It runs the whole pipeline over the recorded corpus in fixtures/, with no network, no
// credential and no gh binary, and it shows one of each state plus both named verdicts. Every
// workflow, repo and branch in that corpus is invented.
//
// The demo always re-checks rather than carrying earlier matches forward, so its output is the
// same on the fifth run as on the first. A demo whose output depends on how many times you have
// run it is a demo nobody can compare against a README.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adapters } from './adapters/index.mjs';
import { parseClaims } from './claims.mjs';
import { runCheck } from './run.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(PACKAGE_ROOT, 'fixtures');

// The instant the corpus was recorded at. Fixed, so the demo's receipt filename and output are
// byte-identical on every machine.
export const DEMO_AT = '2026-09-26T11:00:00.000Z';

// Replays the recorded gh calls, and refuses anything not recorded rather than falling through
// to the real binary. A demo that could reach the network is not keyless.
function recordedExec(recordings) {
  return (file, args) => {
    if (file !== 'gh') throw new Error(`the demo runs no binary but gh, and was asked for ${file}`);
    const key = args.join(' ');
    const recording = recordings[key];
    if (recording === undefined) {
      throw new Error(`the demo has no recording for: gh ${key}. Re-record it in fixtures/github/gh-recordings.json`);
    }
    return recording;
  };
}

export function demoDeps() {
  const recordings = JSON.parse(readFileSync(join(FIXTURES, 'github', 'gh-recordings.json'), 'utf8')).calls;

  return {
    readFile: (path) => readFileSync(path, 'utf8'),
    exec: recordedExec(recordings),
    // No fetch. The n8n adapter reads the recorded export from disk, and a demo holding a live
    // fetch is one refactor away from making a network call.
    config: {
      n8n: {
        executionsPath: join(FIXTURES, 'n8n', 'executions.json'),
        workflowsPath: join(FIXTURES, 'n8n', 'workflows.json'),
      },
    },
  };
}

export async function runDemo({ outDir }) {
  const claimsPath = join(FIXTURES, 'claims.jsonl');
  const { records } = parseClaims(readFileSync(claimsPath, 'utf8'));

  return runCheck({
    records,
    adapters,
    deps: demoDeps(),
    outDir,
    at: DEMO_AT,
    recheck: true,
    inputs: { claims: 'fixtures/claims.jsonl', mode: 'demo' },
  });
}
