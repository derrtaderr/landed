// The n8n adapter.
//
// It reads an executions export: a JSON file the operator downloads, or a saved `/executions`
// REST response. Live REST is optional and only attempted when a URL and a key are both
// configured. Either way the adapter reports what the export SAYS, and never whether a claim
// was honest.
//
// Three things it is careful about, because all three were false-green states in the wild:
//
//   1. An export of zero executions is not evidence that nothing ran. It reports `source.empty`
//      and the core turns that into `unresolved`.
//   2. A read that stopped early cannot rule anything out. n8n's response carries `nextCursor`
//      when more pages exist, and an export whose coverage does not span the window asked about
//      is equally incomplete. Both report `source.complete: false`.
//   3. The `active` flag lives in the workflows export, not the executions export. Without it
//      the fired-while-inactive check cannot run, and saying so is the honest answer; assuming
//      `active: true` would manufacture a green.

const KINDS = ['executed', 'completed'];

function unreachable(reason) {
  return { reachable: false, reason };
}

function rowsOf(payload) {
  if (Array.isArray(payload)) return { rows: payload, nextCursor: null };
  if (Array.isArray(payload?.data)) return { rows: payload.data, nextCursor: payload.nextCursor ?? null };
  return null;
}

async function loadExport(which, deps) {
  const config = deps.config?.n8n ?? {};

  if (config.url !== undefined && config.apiKey !== undefined) return loadFromRest(which, config, deps);

  const path = which === 'workflows' ? config.workflowsPath : config.executionsPath;
  if (path === undefined) {
    return {
      error: `no n8n ${which} export is configured; pass --n8n-${which} <file>, or set LANDED_N8N_URL and LANDED_N8N_API_KEY`,
    };
  }

  let text;
  try {
    text = deps.readFile(path);
  } catch (error) {
    return { error: `cannot read the n8n ${which} export at ${path}: ${error.message}` };
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return { error: `the n8n ${which} export at ${path} is not valid JSON: ${error.message}` };
  }

  const parsed = rowsOf(payload);
  return parsed === null
    ? { error: `the n8n ${which} export at ${path} is neither an array nor a { data: [...] } response` }
    : parsed;
}

// The optional live path. Deliberately one page: a live read that silently stopped at page one
// and called itself complete would be the same lie as a truncated file.
async function loadFromRest(which, config, deps) {
  if (typeof deps.fetch !== 'function') {
    return { error: 'a live n8n read needs a fetch implementation, and none was provided' };
  }

  const url = `${String(config.url).replace(/\/+$/, '')}/api/v1/${which}`;

  let response;
  try {
    response = await deps.fetch(url, { headers: { 'X-N8N-API-KEY': config.apiKey, accept: 'application/json' } });
  } catch (error) {
    return { error: `the n8n API at ${url} could not be reached: ${error.message}` };
  }

  if (!response.ok) return { error: `the n8n API at ${url} answered ${response.status}` };

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { error: `the n8n API at ${url} did not return JSON: ${error.message}` };
  }

  const parsed = rowsOf(payload);
  return parsed === null ? { error: `the n8n API at ${url} returned an unexpected shape` } : parsed;
}

// What the export actually covers, taken from the records themselves rather than from what the
// operator meant to download.
function coverage(rows) {
  const instants = rows
    .map((row) => Date.parse(row.startedAt))
    .filter((value) => !Number.isNaN(value))
    .sort((a, b) => a - b);
  if (instants.length === 0) return null;
  return { from: new Date(instants[0]).toISOString(), to: new Date(instants.at(-1)).toISOString() };
}

function spans(covered, asked) {
  if (covered === null || asked === undefined) return true;
  return Date.parse(covered.from) <= Date.parse(asked.from) && Date.parse(covered.to) >= Date.parse(asked.to);
}

function withinWindow(instant, window) {
  if (window === undefined || window === null) return true;
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return false;
  return at >= Date.parse(window.from) && at <= Date.parse(window.to);
}

function statusOf(row) {
  if (row.status !== undefined) return row.status;
  return row.finished === true ? 'success' : 'unknown';
}

export const n8n = {
  name: 'n8n',
  kinds: KINDS,

  // `executed` asks about a workflow over a window. `completed` asks about one execution, so it
  // is keyed by id and no window bounds the read.
  requiredKeys: { executed: ['workflowId'], completed: ['executionId'] },

  async lookup(target, deps) {
    const executions = await loadExport('executions', deps);
    if (executions.error !== undefined) return unreachable(executions.error);

    const rows = executions.rows;
    const truncated = executions.nextCursor !== null && executions.nextCursor !== undefined;

    if (target.workflowId === undefined && target.executionId !== undefined) {
      // An id-keyed read reports NO window. Reporting the export's coverage here would make a
      // claim dated outside it look like clock skew when the exact record was in hand.
      const source = { complete: !truncated, empty: rows.length === 0 };
      if (rows.length === 0) return { found: false, source };

      const row = rows.find((candidate) => String(candidate.id) === String(target.executionId));
      if (row === undefined) return { found: false, source };

      return {
        found: true,
        source,
        facts: {
          kind: 'execution',
          id: String(row.id),
          workflowId: String(row.workflowId ?? ''),
          status: statusOf(row),
          startedAt: row.startedAt ?? null,
          stoppedAt: row.stoppedAt ?? null,
          mode: row.mode ?? null,
        },
      };
    }

    const covered = coverage(rows);
    const source = {
      complete: !truncated && spans(covered, target.window),
      empty: rows.length === 0,
      ...(covered === null ? {} : { window: covered }),
    };

    if (rows.length === 0 || source.complete === false) return { found: false, source };

    const fires = rows
      .filter((row) => String(row.workflowId) === String(target.workflowId))
      .filter((row) => withinWindow(row.startedAt, target.window))
      .map((row) => ({ executionId: String(row.id), startedAt: row.startedAt, status: statusOf(row) }));

    if (fires.length === 0) return { found: false, source };

    const workflows = await loadExport('workflows', deps);
    if (workflows.error !== undefined) {
      return unreachable(`${workflows.error} — and the fired-while-inactive check needs it`);
    }

    const workflow = workflows.rows.find((candidate) => String(candidate.id) === String(target.workflowId));
    if (workflow === undefined) {
      return unreachable(`workflow ${target.workflowId} is not in the workflows export, so its active flag is unknown`);
    }

    return {
      found: true,
      source,
      facts: {
        kind: 'fires',
        workflowId: String(target.workflowId),
        name: workflow.name ?? null,
        active: workflow.active === true,
        fires,
        // What this receipt stands for, so the core can tell an unclaimed run from one this
        // claim already covered without knowing what an n8n execution is.
        covers: fires.map((fire) => fire.executionId),
      },
    };
  },

  // What ran in the scope, claimed or not. This is what makes `executed-never-claimed` possible
  // for n8n.
  async enumerate(scope, deps) {
    const executions = await loadExport('executions', deps);
    if (executions.error !== undefined) return { reachable: false, reason: executions.error };

    const rows = executions.rows;
    const truncated = executions.nextCursor !== null && executions.nextCursor !== undefined;
    const covered = coverage(rows);

    return {
      source: {
        complete: !truncated && spans(covered, scope),
        empty: rows.length === 0,
        ...(covered === null ? {} : { window: covered }),
      },
      records: rows
        .filter((row) => withinWindow(row.startedAt, scope))
        .map((row) => ({
          kind: 'execution',
          id: String(row.id),
          workflowId: String(row.workflowId ?? ''),
          startedAt: row.startedAt ?? null,
          status: statusOf(row),
        })),
    };
  },
};
