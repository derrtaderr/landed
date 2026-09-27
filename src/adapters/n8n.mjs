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
//      when more pages exist, and since it pages backwards in time, an operator who exports the
//      most recent page and asks about an older window gets one. That is what `complete: false`
//      is for, and it is the ONLY thing that sets it. An earlier version also inferred coverage
//      from the extent of the records it held and refused a window those records did not span;
//      a live REST read then came back PARTIAL_READ for a perfectly good claim because the first
//      execution happened to be fifteen minutes in. The extent of the records present is not the
//      extent of what was looked at, and an export carries no metadata saying which, so this
//      adapter claims neither.
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

    // No read here reports a `source.window`, because neither an export file nor an unfiltered
    // REST page can attest to the range it was taken over. `source.window` in the contract is for
    // an adapter whose read is EXPLICITLY bounded and can say so.
    const source = { complete: !truncated, empty: rows.length === 0 };

    // An execution id is the most specific join there is, so it wins whenever it is present. It
    // used to require workflowId to be ABSENT, which sent a `completed` claim carrying both ids
    // (which is what an n8n hook naturally has) down the workflow-window branch. Ship-check F-01.
    if (target.executionId !== undefined) {
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

    return {
      source: { complete: !truncated, empty: rows.length === 0 },
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
