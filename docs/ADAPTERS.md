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

## The two optional fields

### `enumerate(scope, deps)`

Lists the records in a scope, claimed or not, and is what makes the `executed-never-claimed` verdict
possible. An adapter without it never produces that verdict, which is the honest outcome: a zero from
an adapter that cannot look is not the same as a zero from one that looked.

```js
{ source: { complete, empty, window? }, records: [{ kind, id, subject, startedAt, ... }] }
{ reachable: false, reason }
```

`scope` is `{ from, to, subjects }`. `subjects` is the list of subject values to enumerate, or `null`
for all of them. Filter on it: the core also drops records outside the list, but doing it here keeps
the filter next to the field it reads.

Every record carries `subject`, which is how the core scopes and suppresses without knowing what an
n8n workflow is.

### `subjectKey`

The target key naming what a claim is ABOUT. n8n declares `workflowId`. The core reads it to scope
enumeration to the subjects the claims named, and to suppress a subject whose own claim came back
unresolved. An adapter that declares no subject key cannot be scoped, so it is only enumerated under
`--enumerate all`.

This exists because of decision D2. Without it, one claim on a busy instance reported every other
subject's records, every hour, forever.

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
| `window` | What the read was EXPLICITLY BOUNDED to. A claim dated outside it resolves to `unresolved` / `CLOCK_SKEW`. Set it only when the read really was bounded, such as a query with a date filter. Neither of the phase 1 adapters sets it: an export file and an unfiltered REST page cannot attest to the range they were taken over, and inferring it from the earliest and latest record present made a live read refuse a perfectly good claim. See SPEC §5.4. |

An adapter that cannot rule out an incomplete read says so here. That is the whole mechanism
by which this tool refuses to inherit green from a failed observation.

### `facts` carries two fields the core reads by name

Everything else in `facts` is the adapter's own vocabulary, reported verbatim into the receipt
file.

| Field | Meaning |
|---|---|
| `kind` | The SHAPE of the record: `pull_request`, `branch`, `commit`, `execution`, `fires`, `message`. The core matches it against the claim's kind through `RECEIPT_SHAPES_BY_KIND`, and a claim handed a shape it cannot read resolves `unresolved RECEIPT_SHAPE_MISMATCH` rather than being graded on whatever field happens to be present. This is the fix for the finding that blocked the first ship-check. |
| `id` | The record's identity. Used to tell an unclaimed record from one a claim already covered. |
| `covers` | Ids this one receipt stands for, when it stands for several. n8n's `fires` receipt lists the executions it matched. A receipt that declares no coverage accounts for nothing, which is the safe default. |
| `subject` | On an enumerated record, what it belongs to, in the same vocabulary as `subjectKey`. |

**An adapter reports an unknown as an unknown.** n8n's `active` is `true`, `false`, or `null` for "the
export does not say", and the core turns `null` into `unresolved ACTIVE_FLAG_UNKNOWN`. Reading an
absent flag as `false` manufactured a red exactly as reading it as `true` would have manufactured a
green (F-02).

## `deps`, so an adapter does no I/O of its own

The CLI builds `deps` and hands the same object to every adapter. An adapter that reached for
the filesystem or a subprocess directly could not be tested against a recorded fixture, and the
keyless demo would stop being keyless.

| Key | Used by |
|---|---|
| `readFile(path) -> string` | n8n, for an export on disk. Throws like `fs.readFileSync`. |
| `exec(file, args) -> { code, stdout, stderr, spawn_error? }` | GitHub, for `gh`. Never throws for a non-zero exit. |
| `fetch(url, init)` | n8n, for the optional live REST read. |
| `config` | Per-adapter configuration, keyed by adapter name. |

**`exec` separates a failure to START from an exit code.** A process that ran and exited carries a
numeric `code`; a process that never started carries `code: null` and a `spawn_error` string. Node
puts both in the same field, which is why a missing `gh` used to report "gh exited ENOENT" instead of
"gh is not installed" (W-3). An adapter classifying a failure reads `spawn_error` first.

## Phase 1 adapters

### `n8n`

| Kind | Join keys | Question |
|---|---|---|
| `executed` | `workflowId`, optional `window`, optional `cadence` | Did this workflow fire in this window, how many times, and was it active when it did? |
| `completed` | `executionId` | Did this execution finish, and with what status? |

`subjectKey` is `workflowId`. An `executionId` in the target wins the routing whenever it is present,
because an execution id is the most specific join there is; requiring `workflowId` to be ABSENT is
what sent a `completed` claim carrying both ids down the wrong branch.

**Windows are half-open, `[from, to)`.** The instant at `from` belongs to this window and the instant
at `to` belongs to the next. With both edges inclusive, an hourly workflow over a one-hour window
fired twice against a declared cadence of one (F-09).

Fires are deduplicated by execution id before the core sees them, because an export assembled from
overlapping pages lists the same run twice and two copies are 0 seconds apart (F-11).

Reads an executions export (a downloaded JSON file or a saved `/executions` response, either an
array or `{ data: [...] }`). `nextCursor` in the payload means more pages exist, which is an
incomplete read and the only thing that makes one. Since n8n pages backwards in time, an operator
who exports the most recent page and asks about an older window gets exactly that refusal. The `fired-while-inactive` check also needs the workflows export, and without
it the adapter answers `unreachable` rather than assuming the workflow was active.

Live REST is optional, one page, and only attempted when both `LANDED_N8N_URL` and
`LANDED_N8N_API_KEY` are set.

### `github`

| Kind | Join keys | Question |
|---|---|---|
| `merged` | `repo`, `pr` | Is this PR merged, and at what sha? |
| `created` | `repo`, `pr` | Does this PR exist? |
| `pushed` | `repo`, and `branch` or `commit` | Does this branch exist on the remote, or is this commit contained in the default branch? |

Every call goes through `gh api`, because `gh api` reports an HTTP STATUS and the higher-level verbs
report English. `gh` is already authenticated on the operator's machine, so no token lives in this repo
or in a receipt.

Classification reads the spawn error, then the exit code, then the HTTP status in **stderr**. It never
reads a response body. A successful `compare` returns up to 250 commit messages, and scanning stdout
for "Not Found" made an ordinary repository look like an absence (F-05).

| What happened | Answer |
|---|---|
| `gh` did not start | `reachable: false`, from `spawn_error` |
| HTTP 401 | `reachable: false`: not authenticated |
| HTTP 403 | `reachable: false`. A rate limit, a SAML-protected org and a missing scope are indistinguishable from here, and none is an absence |
| HTTP 429 | `found: false` with `complete: false`, so the core says `PARTIAL_READ` |
| HTTP 404 | an absence **only once the container is proven present** |
| Any other status, or none | `reachable: false` |

**The container proof (D3).** GitHub answers 404 for a repo that does not exist, for a private repo the
token cannot see, and for a branch deleted at merge. So a 404 on anything inside a repository triggers
a read of the repository itself:

| Case | Answer |
|---|---|
| The repo cannot be read | `reachable: false`, and the core resolves `REPO_UNREACHABLE` |
| A `pushed` branch is gone and a PR from it was merged | `found: true` with `present: false` and `merged_in_pr`, which the core resolves `matched MERGED_AND_BRANCH_DELETED` |
| A `pushed` branch is gone, the repo is readable, no PR from it merged | `found: false`, so `contradicted [orphaned-claim]` |

A current absence can only contradict a past claim when the container is present. The head-ref query
uses the repository's own owner, so a PR opened from a fork is not matched this way in phase 1.

No `enumerate`. "Everything that happened in this repo" is a different shape of question, and
phase 1 does not answer it.

## Adding one

`test/new-adapter.test.mjs` builds a fictional adapter out of nothing but this document and runs
the real core over it, resolving all three states and both verdicts with no core change. That
test is the phase-2 gate: if Gmail or HubSpot needs more than the contract above, it fails
there first.
