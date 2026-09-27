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
// It throws only when the binary could not be run at all.
export function hostExec(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null && error.code === undefined) {
        reject(error);
        return;
      }
      resolve({ code: error === null ? 0 : error.code, stdout, stderr });
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
