// The claims format, and the validator that refuses a malformed one loudly.
//
// A claim is what an agent SAID it did. Nothing in this file treats a claim as true; its whole
// job is to decide whether the line is well enough formed for the core to look the target up.
// A line that is not gets a reason naming the field, and is carried forward as a record rather
// than dropped, because a claim quietly thrown away is the failure this tool exists to catch.
//
// docs/SPEC.md §3A is the schema.

export const CLAIM_KINDS = ['sent', 'created', 'updated', 'merged', 'pushed', 'executed', 'completed'];

const REQUIRED_FIELDS = ['id', 'at', 'actor', 'kind', 'target'];

function isIsoInstant(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function problemsFor(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return ['a claim is a JSON object'];
  }

  const problems = [];

  for (const field of REQUIRED_FIELDS) {
    if (parsed[field] === undefined) problems.push(`missing required field: ${field}`);
  }

  if (parsed.at !== undefined && !isIsoInstant(parsed.at)) {
    problems.push(`at is not an ISO 8601 instant: ${JSON.stringify(parsed.at)}`);
  }

  if (parsed.kind !== undefined && !CLAIM_KINDS.includes(parsed.kind)) {
    problems.push(`kind is not one of ${CLAIM_KINDS.join(', ')}: ${JSON.stringify(parsed.kind)}`);
  }

  if (parsed.target !== undefined) {
    const target = parsed.target;
    if (target === null || typeof target !== 'object' || Array.isArray(target)) {
      problems.push('target is a JSON object naming an adapter');
    } else if (typeof target.adapter !== 'string' || target.adapter === '') {
      problems.push('target.adapter names the adapter that can answer for this claim');
    }
  }

  return problems;
}

// Parses a JSONL claims file into ORDERED records. Each record is either valid, carrying the
// claim, or invalid, carrying the reason. Blank lines are not records at all, and the line
// number is the real file line so an operator can go straight to it. A file of nothing but
// blank lines produces no records, which is what the EMPTY_CLAIMS refusal reads.
export function parseClaims(text) {
  const records = [];
  const lines = String(text ?? '').split('\n');
  const firstSeenAt = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.trim() === '') continue;
    const line = index + 1;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      records.push({
        line,
        id: null,
        valid: false,
        reason: 'MALFORMED_CLAIM',
        detail: `line ${line} is not valid JSON: ${error.message}`,
      });
      continue;
    }

    const problems = problemsFor(parsed);
    const id = typeof parsed?.id === 'string' ? parsed.id : null;

    if (problems.length > 0) {
      records.push({
        line,
        id,
        valid: false,
        reason: 'MALFORMED_CLAIM',
        detail: `line ${line}: ${problems.join('; ')}`,
      });
      continue;
    }

    // A repeated id is fine when the line is byte-identical, because an append-only claims
    // file gets replayed. The same id carrying DIFFERENT content is two claims wearing one
    // name, and picking either one silently is how a reconciler starts lying.
    const previous = firstSeenAt.get(id);
    if (previous !== undefined && previous.raw !== raw) {
      records.push({
        line,
        id,
        valid: false,
        reason: 'DUPLICATE_CLAIM_ID',
        detail: `line ${line}: id ${id} was already claimed on line ${previous.line} with different content`,
      });
      continue;
    }
    if (previous === undefined) firstSeenAt.set(id, { line, raw });

    records.push({ line, id, valid: true, claim: parsed });
  }

  return { records };
}

// The same findings, without running any adapter. `landed validate` reads this.
export function validationReport(text) {
  const { records } = parseClaims(text);
  return {
    total: records.length,
    valid: records.filter((record) => record.valid).length,
    problems: records
      .filter((record) => !record.valid)
      .map(({ line, id, reason, detail }) => ({ line, id, reason, detail })),
  };
}
