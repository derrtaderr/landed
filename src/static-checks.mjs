// The checks that need no adapter call: schema, registry, kind, join keys, safe values.
//
// ONE implementation, used by `check` before any lookup and by `validate` instead of one. Ship-check
// F-08: `validate` knew nothing about registered adapters or join keys, so it called a merged claim
// with no `pr` well formed while `check` resolved the same line `unresolved MALFORMED_CLAIM`. Same
// reason code, two answers, because the idea was implemented twice. A third static rule added
// tomorrow lands in both surfaces at once, or it lands in neither.

import { parseClaims } from './claims.mjs';

// Whitespace, URL structure, a leading slash, a parent-directory hop, or a NUL. Slashes and dots are
// fine on their own: real branch names are full of them.
const UNSAFE_VALUE = /[\s?#&%]|\.\.|^\/|\x00/;

export function unsafeJoinValues(target) {
  const offenders = [];
  for (const [key, value] of Object.entries(target ?? {})) {
    if (key === 'adapter' || typeof value !== 'string') continue;
    if (UNSAFE_VALUE.test(value)) offenders.push(`${key}=${JSON.stringify(value)}`);
  }
  return offenders;
}

// A join key is either a name the target must carry, or a nested array meaning "at least one of
// these". GitHub answers a `pushed` claim about a branch OR about a commit.
export function missingJoinKeys(required, target) {
  const missing = [];
  for (const key of required) {
    if (Array.isArray(key)) {
      if (key.every((alternative) => target[alternative] === undefined)) missing.push(key.join(' or '));
    } else if (target[key] === undefined) {
      missing.push(key);
    }
  }
  return missing;
}

// Everything that can be decided about a well-formed claim without reading any authoritative system.
// Returns [] for a claim that is ready to look up.
export function staticProblems(claim, adapters) {
  const adapter = adapters[claim.target.adapter];

  if (adapter === undefined) {
    return [{
      reason: 'UNKNOWN_ADAPTER',
      detail: `no adapter named ${claim.target.adapter} is registered; the registered ones are ${Object.keys(adapters).join(', ')}`,
    }];
  }

  if (!adapter.kinds.includes(claim.kind)) {
    return [{
      reason: 'KIND_NOT_SUPPORTED',
      detail: `the ${adapter.name} adapter answers ${adapter.kinds.join(', ')}, not ${claim.kind}`,
    }];
  }

  const unsafe = unsafeJoinValues(claim.target);
  if (unsafe.length > 0) {
    return [{
      reason: 'MALFORMED_CLAIM',
      detail: `target value(s) ${unsafe.join(', ')} carry characters that could change the meaning of a request path`,
    }];
  }

  const missing = missingJoinKeys(adapter.requiredKeys?.[claim.kind] ?? [], claim.target);
  if (missing.length > 0) {
    return [{
      reason: 'MALFORMED_CLAIM',
      detail: `target is missing the join key(s) ${missing.join(', ')} that ${adapter.name} needs for a ${claim.kind} claim`,
    }];
  }

  return [];
}

// What `landed validate` prints. Every problem `check` would report without reading anything, at the
// line it is on, and nothing that would need a lookup.
export function validationReport(text, adapters) {
  const { records } = parseClaims(text);
  const problems = [];

  for (const record of records) {
    if (!record.valid) {
      problems.push({ line: record.line, id: record.id, reason: record.reason, detail: record.detail });
      continue;
    }
    for (const problem of staticProblems(record.claim, adapters)) {
      problems.push({ line: record.line, id: record.id, reason: problem.reason, detail: `line ${record.line}: ${problem.detail}` });
    }
  }

  return {
    total: records.length,
    valid: records.length - problems.length,
    problems,
  };
}
