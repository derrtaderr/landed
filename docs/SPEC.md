---
name: landed phase 1 spec
read_by: any session touching src/, test/ or the adapter contract in this repo, and the reviewer of lane/row65-landed-core, before the first edit
status: current — describes the build on lane/row65-landed-core after ship-check wave 1
date: 2026-09-26
wave: 2 (post-ship-check; §6 holds the decided contract and every finding's resolution)
---

# landed — phase 1

A scheduled reconciler that joins what an agent CLAIMED against what actually LANDED in the
authoritative system, and resolves every claim to exactly one of three states.

```
matched | contradicted | unresolved
```

## 1. Why this exists

Every item below was reported by the operator who got burned, and every one was found by a
customer or by eyeball, weeks late.

| What was claimed | What had happened | Source |
|---|---|---|
| Run `COMPLETED`, `ok: true` | `status: 403` rendered beside it, while the agent drafted refund claims | n8n community, 2026-09 |
| "approved by Guardian and has been sent successfully" | Nothing arrived, in the builder's own live demo | n8n community, 2026-09 |
| Campaign accepted 40 leads, HTTP 200 | No senders attached, so none sent | n8n community, 2026-09 |
| Workflow inactive | Fired anyway | n8n issue #39444 |
| One trigger, one run | Two runs 14 seconds apart | n8n issue #35251 |
| One run per webhook | 2-3 runs per webhook after an import | n8n issue #31837 |
| Lane record: PR `parked` | GitHub had merged it the day before | this vault, 2026-09-25 |

Two sentences from the thread carry the whole design.

> A claim is not evidence the thing landed.

> Two records that disagree, found by eyeball. A standing check joins them hourly and the
> disagreement stops being something a customer has to teach you about.

## 2. Scope

**In, phase 1.** A claims format and validator. A join core producing three states plus two
named verdicts. Two adapters, n8n and GitHub. A receipt file per run with idempotency. A
`report` renderer. A keyless `demo`. A privacy guard. A cron/launchd recipe for `watch`.

**Out, explicitly.** Gmail and HubSpot adapters (phase 2, and the contract is fixed here so
they need no core change). Any daemon. Any UI. Any model call anywhere. Sending, writing,
retrying or repairing anything in the authoritative system — `landed` reads and reports, and
never acts.

## 3. Decisions

### A. Claims are input, in one format

A JSONL file the operator's hooks, traces or agents append to. One claim per line.

```json
{"id":"c-0001","at":"2026-09-26T14:00:00.000Z","actor":"lane-runner","kind":"merged",
 "target":{"adapter":"github","repo":"octocat/Hello-World","pr":1},
 "evidence":{"printed":"PR merged"}}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique per claim. A repeat of an `id` with different content is a refusal, not an overwrite. |
| `at` | yes | ISO 8601 instant the claim was made. |
| `actor` | yes | Which agent or workflow said it. |
| `kind` | yes | One of `sent`, `created`, `updated`, `merged`, `pushed`, `executed`, `completed`. Closed set. |
| `target` | yes | `adapter` plus the join keys that adapter needs. |
| `evidence` | no | What the agent showed as proof. Carried into the receipt, never trusted as truth. |

A malformed claim resolves to `unresolved` with a reason naming the field, and is never
dropped silently. `landed validate` reports the same findings without running any adapter.

### B. Adapters answer one question

*What does the authoritative system say about this target?* Three shapes, and nothing else:

```
{ found: true, facts: {...} }      the system has a record, here are its facts
{ found: false, source: {...} }    the system was read and has no such record
{ reachable: false, reason }       the system could not be read
```

Adapters never interpret. They do not decide `matched`. The core does. An adapter that
cannot rule out that its read was incomplete says so in `source.complete: false`, and the
core turns that into `unresolved`, never into an absence.

**Contract fields** (pinned by `test/adapter-contract.test.mjs`, applied to every registered
adapter by one harness, so an adapter added tomorrow is covered the moment it is registered):

| Field | Purpose |
|---|---|
| `name` | Registry key, and the value of `target.adapter`. |
| `kinds` | The claim kinds this adapter can answer. A kind it does not list is `unresolved`. |
| `requiredKeys` | Per kind, the join keys a target must carry. Drives validation. |
| `lookup(target, deps)` | Returns one of the three shapes above. |
| `enumerate(scope, deps)` | Optional. Lists records in a window, which is what makes `executed-never-claimed` possible. An adapter without it simply never produces that verdict. |

`test/new-adapter.test.mjs` builds a fictional adapter out of nothing but this contract and
runs the real core over it, with no core change, which is the phase-2 proof.

**Phase 1 adapters.**

*n8n* reads an executions export (a JSON file the operator downloads, or a saved `/executions`
REST response). Live REST is optional behind `LANDED_N8N_URL` + `LANDED_N8N_API_KEY`. It
answers: did execution X run; did workflow W fire inside window T; how many times; and did W
fire while its `active` flag was false, which needs the workflow list export too. Three named
checks: `fired-while-inactive`, `double-fire` (same workflow twice within N seconds, default
15, because the reported bug was 14), `count-vs-cadence`.

*GitHub* shells out to `gh`, already authenticated on the operator's machine. A missing,
unauthenticated or rate-limited `gh` is `reachable: false`, never an absence. It answers: does
PR N exist, is it merged, what is the merge SHA, does branch B exist on origin, is commit C on
the default branch.

### C. Three states, two named verdicts, and the false-green table

| State | When |
|---|---|
| `matched` | The receipt exists and its facts agree with the claim's KIND. |
| `contradicted` | Both records were read and they disagree. |
| `unresolved` | The join could not be made. Everything unknown lands here. |

Plus one row class that is not a claim state at all, added by decision D2: `unclaimed`, for a record
the authoritative system holds that no claim accounts for.

| Verdict | When |
|---|---|
| `orphaned-claim` | Claimed, and a complete read of a non-empty source, inside a PRESENT container, has no such record. |
| `executed-never-claimed` | A record the adapter enumerated, inside the scope the claims named, that no claim covers. Carries state `unclaimed`. |

**The claim's kind decides, and only the kind.** `RECEIPT_SHAPES_BY_KIND` in `src/reconcile.mjs`
says which receipt shapes can answer which kind, and a kind handed a shape it cannot read resolves
`unresolved RECEIPT_SHAPE_MISMATCH`. This is the fix for the one finding that blocked the first
ship-check: a `completed` claim carrying both `executionId` and `workflowId` was routed to the n8n
workflow-window branch, `interpret` dispatched on the receipt's shape before it read the claim, and
an errored execution came back `matched FIRED_AS_CLAIMED` at exit 0.

**GREEN IS EARNED.** These five states are table-tested in
`test/false-green.test.mjs`, and each resolves to `unresolved` or a refusal. None may ever
produce `matched`.

| # | State | Resolution | Reason code |
|---|---|---|---|
| 1 | Empty claims file | Refusal, exit non-zero, no receipt of health | `EMPTY_CLAIMS` |
| 2 | Empty source (the export has zero records) | `unresolved` | `EMPTY_SOURCE` |
| 3 | Adapter unreachable | `unresolved` | `ADAPTER_UNREACHABLE` |
| 4 | Partial read (export truncated, `gh` rate-limited) | `unresolved` | `PARTIAL_READ` |
| 5 | Clock skew (the claim's own instant falls outside the window it reports on, or outside a read the adapter explicitly bounded) | `unresolved` | `CLOCK_SKEW` |

An empty source is the one that looks most like good news and is not. Zero executions in an
export is indistinguishable from a failed export, so absence is only evidence when the source
returned something. That is the difference between #2 and `orphaned-claim`.

### C.1 Exit codes

Decided by the orchestrator after ship-check F-07, whose finding was that a run which lost its export
path or its `gh` credential exited 0, and that the cron recipe the tool printed did not pass
`--strict`. The exit code is the only thing cron reads.

| Code | Meaning |
|---|---|
| `0` | The run ran, every claim resolved, and nothing disagreed |
| `1` | Findings: something is contradicted |
| `2` | A refusal: no claims file, nothing in it, an unwritable `--out`, a flag that makes no sense |
| `3` | Nothing resolved: every claim this run actually READ came back `unresolved`; carried rows do not count as read (gate-time correction N-5, 2026-09-27) |

`--strict` promotes ANY unresolved claim to exit 3, and the `watch` recipe passes it in both the
cron and the launchd form. A lost credential must never share an exit code with a quiet healthy hour.

Unclaimed runs do not set the exit code (D2). They are reported in their own section, and a run whose
only finding is an unclaimed run exits 0. That is a deliberate consequence of an unclaimed run
contradicting no claim; if it should alarm, that is a decision to revisit with a flag rather than by
overloading exit 1.

### C.2 The false-green table

### D. Receipts and idempotency

Each run writes `<out>/receipts/<timestamp>.json`: the verdict per claim, the adapter
responses that produced it, and the run's inputs. Re-running over the same claims is
idempotent. A claim `matched` in a prior receipt is carried, not re-reported as new;
`--recheck` re-verifies it from the adapter anyway.

`landed report` renders the latest receipt as a table plus a one-line summary. `landed watch`
prints a cron and launchd recipe and exits. It is not a daemon.

### E. Keyless demo

`landed demo --out <dir>` runs the whole pipeline on recorded fixtures, with no network and no
credentials, and shows one of each state, both named verdicts, a fires-while-inactive n8n case
and a "PR claimed merged, GitHub says open" case. It writes nothing outside `--out` and
destroys nothing.

### F. No LLM anywhere

The join is deterministic. There is no model call in the engine, and
`test/no-model.test.mjs` pins that.

### G. Privacy and fixtures

Every fixture is synthetic: invented workflow names, invented repos, `example.com` and
`.test` addresses. No real customer, recipient, client or employer data.
`scripts/privacy-guard.mjs` scans tracked files and refuses:

- any email address whose domain is not in the synthetic allowlist, anywhere;
- phone-number-shaped strings outside `fixtures/`;
- absolute home-directory paths, anywhere.

The third rule is here because a prior lane in this vault shipped personal paths into a public
tree. The guard's own source and its test are the only skipped paths, and the skip list is
pinned by the test so it cannot grow quietly.

### H. Repo stays private

Visibility is not changed by this lane. The flip is a separate human decision.

## 4. Prior art read before building

| Repo / tool | What it is | Why it is not this |
|---|---|---|
| `Cyberweasel777/agent-action-receipt-spec` | A signed receipt FORMAT for agent actions | A format for what an agent asserts. There is no reconciler, and nothing reads the authoritative system back. `landed` consumes claims of any shape through one validator and joins them against the system of record. |
| `GiGurra/george` | Empty, 0 stars | Nothing to read. |
| Guardian / verifier / reconciler (the thread's own tools) | Private, unpublished | Referenced by their authors in the threads above. None is installable, so none is prior art a stranger can use. |

The gap phase 1 fills: the join. A claim and a receipt both exist in these systems today, and
nothing stands between them on a schedule.

## 5. Divergences from the dispatch, with reasons

1. **Cadence is declared on the claim, not parsed from the workflow export.** `count-vs-cadence`
   needs an expected fire count. An n8n workflow's schedule lives in an untyped node-parameters
   blob whose shape varies by trigger type and version, so parsing it is a guess that fails
   silently on the next n8n release. The operator states the cadence they expect on the claim
   target (`cadence: {expected_fires}` or `{every_seconds}`), because that is the thing the
   operator actually knows. A claim asking for the check without a cadence is `unresolved`, not
   a default.
2. **`orphaned-claim` carries state `contradicted`, not a fourth state.** The dispatch names
   three states and two verdicts. An absence in a complete, non-empty source is two records
   disagreeing, so it belongs under `contradicted` with the verdict naming which way it
   disagreed. ~~`executed-never-claimed` is `contradicted` for the same reason.~~ RETIRED by
   decision D2 (§6): an unclaimed run is its own row class and section, not a contradiction of
   any claim, and it is excluded from exit 1. Kept struck through so the lineage reads.
3. **The privacy guard refuses non-allowlisted emails everywhere, not only outside `fixtures/`,**
   and adds home-path detection. Stricter than asked, same cost.
4. **Clock skew is a property of the CLAIM, not of the source's record extents.** Found by the
   live REST read on 2026-09-26. The n8n adapter first inferred its coverage from the earliest and
   latest execution it held and refused any window those records did not span. Against a real
   server that returned everything it had, a perfectly good claim came back `PARTIAL_READ` because
   the first execution landed fifteen minutes into the window. The extent of the records present is
   not the extent of what was looked at, and neither an export file nor an unfiltered REST page
   carries metadata saying which. So `complete` now depends only on truncation (`nextCursor`), no
   phase 1 adapter reports a `source.window`, and skew is checked where it is actually knowable:
   a claim whose `at` falls outside the window it reports on, beyond a one-minute lag tolerance,
   because a claim is written after the work it describes. `source.window` stays in the contract for
   an adapter whose read IS explicitly bounded, and the false-green table still covers it.
5. ~~**A run that resolved nothing prints a warning, and still exits 0 without `--strict`.**~~
   RETIRED by decision D1 (§6, §8): such a run exits 3. The paragraph below is the wave-1 reasoning,
   kept for lineage; the contract is §8. The
   dispatch ties the non-zero exit to `--strict`, so the exit code is unchanged. But a check that
   lost its credential and a check with nothing to report must not look identical, so the output
   says which. See §7.

## 6. Wave 2: the decided contract, and what changed

An independent ship-check blocked the first PR. `.vibecodepm/ship-check.md` holds the record. The
orchestrator settled four contract questions, and this section is where they live.

### D1. Exit codes

See §3C.1. A fourth code, 3, for "nothing resolved", and `--strict` promotes any unresolved claim to
it. **Reason:** exit 0 on a lost credential is the same false green the whole row exists to forbid,
one level up. The tool was printing a warning in a place cron does not read.

### D2. Enumeration is scoped and separate

`executed-never-claimed` is not a contradiction of any claim. It is its own row class (`unclaimed`),
in its own section, counted apart, excluded from the exit code, and carried across runs once
reported. The scope is the subjects the claims named, read through the adapter's `subjectKey`, over
the windows those claims asked about; `--enumerate all` widens it. A subject whose own claim could
not be resolved is not enumerated at all, and the skip is reported as `ENUMERATION_SUPPRESSED`.

**Reason:** three separate wrongs came from treating an unclaimed run as a contradiction. Omitting
`--n8n-workflows` turned one unresolved claim into seven false contradictions, because a receipt with
no facts accounted for nothing. An operator claiming one workflow on a busy instance got every other
workflow's runs, every hour, with no way to scope or suppress them. And a row that was never carried
alarmed identically forever.

### D3. A 404 is an absence only when the container is proven present

GitHub classification runs on the spawn error, the exit code and the HTTP status. Never on body text.
A 404 on anything inside a repository triggers a read of the repository itself: if that fails, every
claim on it is `unresolved REPO_UNREACHABLE`. A `pushed` claim whose branch is gone asks whether a PR
from it was merged, and reports `matched MERGED_AND_BRANCH_DELETED` when one was.

**Reason:** a successful `compare` returns up to 250 commit messages, so scanning stdout for "Not
Found" produced false absences on ordinary repositories. And GitHub answers 404 for a repo that does
not exist, for a private repo the token cannot see, and for a branch deleted at merge, which is the
normal end of healthy work. A current absence can only contradict a past claim when the container is
present; without that, "it is not there now" and "you cannot see it" are the same sentence.

### D4. Cadence stays declared on the claim

`count-vs-cadence` is a consistency check against **the operator's declared expectation**, not a
schedule check. The claim carries `cadence: {expected_fires}` or `{every_seconds}`, and the detail
text says so.

Two things follow, and both are stated here because they bound what the check is worth:

1. **The claim writer must be the operator's hook, not the agent being checked.** An agent that
   declares its own expected cadence and then reports against it is grading itself. §3A's rule about
   who appends the claims file is the same rule, and the README says it in the operator's words.
2. **Schedule parsing from the workflow export is phase 2.** An n8n schedule lives in an untyped
   node-parameters blob whose shape moves between trigger types and versions. Until that is parsed,
   `count-vs-cadence` cannot tell a wrong declaration from a wrong schedule.

**The window is HALF-OPEN, `[from, to)`,** pinned by a test at both edges. With both edges inclusive,
an hourly workflow over a one-hour window fired twice against a declared cadence of one, and every
healthy schedule was contradicted forever. Half-open makes consecutive windows partition time instead
of overlapping at every boundary.

### What else wave 2 changed

| Finding | Resolution |
|---|---|
| F-02 | An absent or non-boolean `active` key reports `null` and resolves `ACTIVE_FLAG_UNKNOWN`. Reading it as inactive manufactured a red exactly as reading it as active would have manufactured a green. |
| F-08 | `src/static-checks.mjs` is the one implementation of every check that needs no lookup. `validate`, `check` and `append` all call it, so they cannot disagree. |
| F-10 | A claim with no window is read against six hours either side of its own instant, and the result carries the window and its source. A windowless claim used to match a fire three days older than itself. |
| F-11 | Fires are deduplicated by execution id before double-fire detection, because an export assembled from overlapping pages lists the same run twice and two copies are 0 seconds apart. |
| W-1 | The trust footer prints only when every rendered row was read from a reachable source on this run. Otherwise it says how many were not, and which reason codes. `report` says it rendered a stored receipt. |
| W-3 | `hostExec` separates a failure to START (`spawn_error`) from an exit code, so "gh is not installed" fires. |
| m-1 | A window that is not an object, does not parse, or runs backwards is a malformed claim. It used to slip past the skew check, because NaN compares false everywhere, and then produce a false orphaned-claim. |
| m-2 | A join key value carrying whitespace or URL structure is refused before any call, and a record naming a different branch than the claim is `RECEIPT_TARGET_MISMATCH`. |
| m-3 | A repeated flag is refused; `--help` prints usage at exit 0. |
| m-4 | `report` exits 0 when it rendered and 2 when there was nothing to render, replacing a dead ternary. |
| m-5 | An unwritable `--out` is a one-line refusal at exit 2 rather than an uncaught stack at exit 1, and two receipts in one instant get a suffix. |
| m-6 | A `settled.json` index beside the receipts replaces re-parsing every receipt ever written, with `--since` to bound the claims read. The old scan survives as a repair path. |
| m-7 | Claims and unclaimed runs are counted and rendered separately; the `--strict` hint prints only when not strict. |
| m-8 | Any ISO 8601 offset is accepted. A bare local time is still refused, because an instant with no zone is not an instant. |
| m-9 | `running`, `waiting` and `new` are `unresolved STILL_RUNNING`. A reason code must not disagree with the fact printed beside it. |

One more, found by reading the demo's own output rather than by a test: a claim keyed by execution id
named no subject but its DEFAULT window still widened the enumeration scope by six hours. The scope
now comes only from claims that named a subject.

### Recorded as follow-ups, not in this wave

Schedule parsing from workflow exports; receipt pruning beyond the settled index; a `--recheck` flip
report naming what changed; n8n live REST against a hosted instance.

## 7. Gate set, per area

Every one of these runs before the PR, and its exit code is reported.

| Area | Gate |
|---|---|
| Whole suite | `npm test` (`node --test "test/**/*.test.mjs"`) |
| Demo, keyless | `node bin/landed.mjs demo --out /tmp/landed-demo` exits 0 |
| Privacy | `node scripts/privacy-guard.mjs` exits 0 |
| README freshness | the README-claims test inside `npm test`, which executes every `verified-block` and compares stdout byte for byte |
| Syntax, every module | `node --check` over every tracked `.mjs` |

Freshness is coupled in the commit, not in a checklist: README example blocks, the demo's
expected output, `.vibecodepm/flow.md` and `.vibecodepm/metrics.md` change in the same commit
as the code that staled them.

## 8. The open question, answered

Wave 1 asked whether a run whose every claim is `unresolved` should exit non-zero without
`--strict`. The orchestrator's answer is D1: it exits **3**, with or without `--strict`, and
`--strict` promotes any unresolved claim to the same code. The question is closed.
