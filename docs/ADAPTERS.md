---
name: landed adapter contract
read_by: any session adding or changing an adapter in src/adapters/, and test/adapter-contract.test.mjs, which enforces every rule below
status: current
date: 2026-09-26
---

# The adapter contract

An adapter answers exactly one question.

> What does the authoritative system say about this target?

It never decides whether a claim matched. `src/reconcile.mjs` does that, and keeping the two
apart is what makes every verdict re-derivable from the receipt stored beside it.

## The four required fields

| Field | Type | Meaning |
|---|---|---|
| `name` | string | The registry key, and the value operators write in `target.adapter`. |
| `kinds` | string[] | The claim kinds this adapter can answer. Every entry is one of the seven in `src/claims.mjs`. A kind not listed resolves to `unresolved` with `KIND_NOT_SUPPORTED`. |
| `requiredKeys` | object | Per kind, the join keys a target must carry. A nested array means *at least one of these*: GitHub's `pushed: ['repo', ['branch', 'commit']]` is satisfied by either. A target missing one is refused BEFORE any lookup runs. |
| `lookup(target, deps)` | async fn | Returns one of the three receipt shapes below. |

## The one optional field

`enumerate(scope, deps)` lists the records in a window, claimed or not, and is what makes the
`executed-never-claimed` verdict possible. An adapter without it never produces that verdict,
which is the honest outcome: a zero from an adapter that cannot look is not the same as a zero
from one that looked.

```js
{ source: { complete, empty, window? }, records: [{ kind, id, startedAt, ... }] }
{ reachable: false, reason }
```

## The three receipt shapes, and nothing else

```js
{ found: true,  source, facts }   // the system has a record, here are its facts
{ found: false, source }          // the system was read and has no such record
{ reachable: false, reason }      // the system could not be read
```

`describeReceipt()` in `src/adapters/index.mjs` is the classifier, and the conformance harness
asserts every registered adapter's answers fall inside it.

### `source` is how an adapter admits what it does not know

| Field | Meaning in the core |
|---|---|
| `complete: false` | The read was truncated, rate limited, or did not span the window asked about. Resolves to `unresolved` / `PARTIAL_READ`, for a found record as well as a missing one. |
| `empty: true` | The source held zero records. Resolves to `unresolved` / `EMPTY_SOURCE`, never to an absence. |
| `window` | What the read actually COVERED. A claim dated outside it resolves to `unresolved` / `CLOCK_SKEW`. Only set it for a window-scoped read; an id-keyed lookup is not bounded by a window and must not report one. |

An adapter that cannot rule out an incomplete read says so here. That is the whole mechanism
by which this tool refuses to inherit green from a failed observation.

### `facts` carries two fields the core reads by name

Everything else in `facts` is the adapter's own vocabulary, reported verbatim into the receipt
file.

| Field | Meaning |
|---|---|
| `id` | The record's identity. Used to tell an unclaimed record from one a claim already covered. |
| `covers` | Ids this one receipt stands for, when it stands for several. n8n's `fires` receipt lists the executions it matched. A receipt that declares no coverage accounts for nothing, which is the safe default. |

## `deps`, so an adapter does no I/O of its own

The CLI builds `deps` and hands the same object to every adapter. An adapter that reached for
the filesystem or a subprocess directly could not be tested against a recorded fixture, and the
keyless demo would stop being keyless.

| Key | Used by |
|---|---|
| `readFile(path) -> string` | n8n, for an export on disk. Throws like `fs.readFileSync`. |
| `exec(file, args) -> { code, stdout, stderr }` | GitHub, for `gh`. Never throws for a non-zero exit. |
| `fetch(url, init)` | n8n, for the optional live REST read. |
| `config` | Per-adapter configuration, keyed by adapter name. |

## Phase 1 adapters

### `n8n`

| Kind | Join keys | Question |
|---|---|---|
| `executed` | `workflowId`, optional `window`, optional `cadence` | Did this workflow fire in this window, how many times, and was it active when it did? |
| `completed` | `executionId` | Did this execution finish, and with what status? |

Reads an executions export (a downloaded JSON file or a saved `/executions` response, either an
array or `{ data: [...] }`). `nextCursor` in the payload means more pages exist, which is an
incomplete read. The `fired-while-inactive` check also needs the workflows export, and without
it the adapter answers `unreachable` rather than assuming the workflow was active.

Live REST is optional, one page, and only attempted when both `LANDED_N8N_URL` and
`LANDED_N8N_API_KEY` are set.

### `github`

| Kind | Join keys | Question |
|---|---|---|
| `merged` | `repo`, `pr` | Is this PR merged, and at what sha? |
| `created` | `repo`, `pr` | Does this PR exist? |
| `pushed` | `repo`, and `branch` or `commit` | Does this branch exist on the remote, or is this commit contained in the default branch? |

Shells out to `gh`, already authenticated on the operator's machine, so no token lives in this
repo or in a receipt. The four failure modes are classified before any answer is given, because
three of them look exactly like "no such record":

| What happened | Answer |
|---|---|
| `gh` is not installed | `reachable: false` |
| `gh` is not authenticated | `reachable: false` |
| The API rate limited the read | `found: false` with `complete: false`, so the core says `PARTIAL_READ` |
| The API answered 404 | `found: false` with `complete: true`. The only genuine absence of the four |

No `enumerate`. "Everything that happened in this repo" is a different shape of question, and
phase 1 does not answer it.

## Adding one

`test/new-adapter.test.mjs` builds a fictional adapter out of nothing but this document and runs
the real core over it, resolving all three states and both verdicts with no core change. That
test is the phase-2 gate: if Gmail or HubSpot needs more than the contract above, it fails
there first.
