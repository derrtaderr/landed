---
name: landed phase 1 spec
read_by: any session touching src/, test/ or the adapter contract in this repo, and the reviewer of lane/row65-landed-core, before the first edit
status: current — describes the build on lane/row65-landed-core
date: 2026-09-26
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
| `matched` | The receipt exists and its facts agree with the claim. |
| `contradicted` | Both records were read and they disagree. |
| `unresolved` | The join could not be made. Everything unknown lands here. |

| Verdict | When |
|---|---|
| `orphaned-claim` | Claimed, and a complete read of a non-empty source has no such record. |
| `executed-never-claimed` | A record the adapter enumerated that no claim covers. |

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

A run whose every claim is `unresolved` exits non-zero under `--strict`. An unreachable
authoritative side is never converted into green.

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
   disagreed. `executed-never-claimed` is `contradicted` for the same reason.
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
5. **A run that resolved nothing prints a warning, and still exits 0 without `--strict`.** The
   dispatch ties the non-zero exit to `--strict`, so the exit code is unchanged. But a check that
   lost its credential and a check with nothing to report must not look identical, so the output
   says which. See §7.

## 6. Gate set, per area

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

## 7. Open question for review

**Should a run whose every claim is `unresolved` exit non-zero without `--strict`?** Today it
exits 0, per the dispatch. That is a run which read nothing from the authoritative side, and in
cron it is indistinguishable by exit code from a healthy quiet hour. The output says so plainly
and `--strict` makes it fatal, so nothing is hidden; but the default may be the wrong one, and
changing it is a decision about the contract rather than a bug fix.
