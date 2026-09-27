// The only module that touches the machine.
//
// Adapters receive these as `deps` rather than importing them, which is what lets the demo
// replay a recorded corpus with no network and lets every adapter test run without a gh binary.

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

export function hostReadFile(path) {
  return readFileSync(path, 'utf8');
}

// Never throws for a non-zero exit, because a non-zero exit is an ANSWER the adapter classifies.
//
// A FAILURE TO START is reported separately, in `spawn_error`, and that separation is ship-check
// W-3: node puts the spawn failure's `ENOENT` in the same `code` field it uses for exit statuses, so
// a missing binary used to read as "gh exited ENOENT" and the not-installed message never fired.
export function hostExec(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr });
        return;
      }

      // A process that ran and exited carries a numeric code. A process that never started carries a
      // string errno and no exit status at all.
      if (typeof error.code === 'number') {
        resolve({ code: error.code, stdout, stderr });
        return;
      }

      resolve({ code: null, spawn_error: error.code ?? 'SPAWN_FAILED', stdout, stderr });
    });
  });
}

export function hostDeps({ env = {}, config = {} } = {}) {
  const n8n = { ...(config.n8n ?? {}) };
  if (env.LANDED_N8N_URL !== undefined && env.LANDED_N8N_API_KEY !== undefined) {
    n8n.url = env.LANDED_N8N_URL;
    n8n.apiKey = env.LANDED_N8N_API_KEY;
  }

  return {
    readFile: hostReadFile,
    exec: hostExec,
    fetch: globalThis.fetch,
    config: { ...config, n8n },
  };
}
