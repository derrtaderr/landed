// The adapter registry and the contract every adapter satisfies.
//
// An adapter answers ONE question: what does the authoritative system say about this target?
// It never decides whether a claim matched. That is src/reconcile.mjs, and keeping the two
// apart is what makes a verdict re-derivable from the receipt stored beside it.
//
// docs/ADAPTERS.md is the prose. test/adapter-contract.test.mjs applies this contract to every
// adapter registered below, so an adapter added tomorrow is covered the moment it lands.

import { n8n } from './n8n.mjs';
import { github } from './github.mjs';

export const ADAPTER_CONTRACT_FIELDS = ['name', 'kinds', 'requiredKeys', 'lookup'];

// The only three receipt shapes there are.
//
//   found        { found: true,  source, facts }   the system has a record, here are its facts
//   absent       { found: false, source }          the system was read and has no such record
//   unreachable  { reachable: false, reason }      the system could not be read
export const RECEIPT_SHAPES = ['found', 'absent', 'unreachable'];

export function describeReceipt(receipt) {
  if (receipt === null || typeof receipt !== 'object') return null;
  if (receipt.reachable === false) return typeof receipt.reason === 'string' ? 'unreachable' : null;
  if (receipt.found === true) return 'found';
  if (receipt.found === false) return 'absent';
  return null;
}

export const adapters = { n8n, github };
