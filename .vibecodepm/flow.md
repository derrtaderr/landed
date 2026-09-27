---
name: landed flow map
read_by: vibecodepm:ship-check and any session adding a CLI verb, an adapter or a state to this repo, before the first edit
status: current — matches the build on lane/row65-landed-core after ship-check wave 1
phase: 1
wave: 2
date: 2026-09-26
supersedes: the wave 1 map, whose exit-code table and single-list result view this replaces
---

# Flow map — landed phase 1

What a first-time user does, what they see, and what happens when it goes wrong. A gap between
this file and the build is a finding, not a detail, so it changes in the same commit as the code
that stales it.

## Who walks this

An operator who has been burned once. Something claimed it sent, merged or completed, it hadn't,
and they found out from a customer weeks later. They have Node, they probably have `gh`, and they
will give the repo about five minutes before deciding whether it is real.

## Entry points

Two, and the first one needs nothing.

```
git clone https://github.com/derrtaderr/landed.git
cd landed
npm test
node bin/landed.mjs demo --out /tmp/landed-demo
```

No install step, because there are no dependencies. No credential, because the demo replays a
recorded corpus and the recorded `exec` refuses any call it has no recording for.

The second entry point is the operator's own data:

```
node bin/landed.mjs append --claims claims.jsonl --actor lane-runner --kind merged \
  --target '{"adapter":"github","repo":"example-org/example-repo","pr":41}'
node bin/landed.mjs validate --claims claims.jsonl
node bin/landed.mjs check --strict --claims claims.jsonl --out landed \
  --n8n-executions exports/executions.json --n8n-workflows exports/workflows.json
node bin/landed.mjs report --out landed
node bin/landed.mjs watch
```

`append` is how a hook writes a claim: one validated line in one atomic write. It is the only write
`landed` makes outside `--out`.

`node bin/landed.mjs` with no verb prints usage and exits 2, so a user who guesses wrong is told
what the verbs are rather than left with a blank screen.

## Happy path

1. An agent, hook or workflow appends a claim to `claims.jsonl`.
2. `check` parses the file. Every line becomes a record, valid or not.
3. Each valid claim is routed to the adapter its target names, and refused before any lookup if
   the target cannot be joined.
4. The adapter reads the authoritative system and returns a receipt.
5. The core resolves the claim to `matched`, `contradicted` or `unresolved`, deciding on the claim's
   KIND and refusing to grade it against a receipt of a shape that kind cannot read.
6. The adapter enumerates the subjects the claims named, over the windows those claims asked about,
   and any record no claim covered becomes an `unclaimed` row in its own section. A subject whose own
   claim could not be resolved is not enumerated at all.
7. A receipt file and a settled index are written, the table is printed, and the exit code says
   whether anything disagreed, whether nothing could be read, or whether the run was refused.

## Every state

| State | What the user sees |
|---|---|
| `matched` | A row, and nothing to do. Carried on the next run and marked `carried`. |
| `contradicted` | A row naming the reason code and the detail in the authoritative system's own words. Exit 1. Never carried, because it is still true. |
| `unresolved` | A row naming what could not be established. Exit 3 if every claim is unresolved, or under `--strict`. |
| `unclaimed` | A row under its own "unclaimed runs" heading, with no claim id. Carried once reported. Does not set the exit code. |
| `orphaned-claim` | A contradiction whose detail names the join keys that were looked for. |
| `executed-never-claimed` | The verdict on an `unclaimed` row. |
| Refusal | No claims file, nothing in it, an unwritable `--out`, a flag that makes no sense. Exit 2, no receipt written. |

### Exit codes

| Code | When |
|---|---|
| `0` | Ran, every claim resolved, nothing disagreed |
| `1` | Something is contradicted |
| `2` | A refusal |
| `3` | Nothing resolved: every claim unresolved, or `--strict` and any claim unresolved |

`demo` always exits 0 and says so in its own output, because its corpus disagrees on purpose.

## Recovery paths

| What went wrong | What the user is told |
|---|---|
| No `--claims` | `check needs --claims <file>` |
| The claims file does not exist | The path that was tried |
| The claims file is empty | `EMPTY_CLAIMS`, and that a run with nothing to join is not a healthy run |
| A malformed claim | The line number and the field, in `validate` and again as an `unresolved` row |
| An unknown flag, or `--flag=value` | Refused by name, with the spelling that works |
| No n8n export configured | `unreachable`, naming the flags and the two environment variables |
| No workflows export, so no active flag | `unreachable`, saying the fired-while-inactive check needs it |
| `gh` missing or unauthenticated | `unreachable`, naming which. Read from the spawn error, not from stdout |
| `gh` rate limited (429) | An incomplete read, resolved `unresolved` / `PARTIAL_READ` |
| The repo 404s or cannot be read | `unresolved` / `REPO_UNREACHABLE` for every claim on it, rather than contradicting them all |
| A `pushed` branch was deleted at merge | `matched` / `MERGED_AND_BRANCH_DELETED`, not an alarm |
| A workflows export with no `active` key | `unresolved` / `ACTIVE_FLAG_UNKNOWN` |
| A claim whose own window it is dated outside | `unresolved` / `CLOCK_SKEW` |
| A repeated flag, or `--flag=value` | Refused by name, with the spelling that works |
| `--help`, on any verb | Usage, exit 0 |
| `report` with no receipt yet | Told to run `check` or `demo` first, exit 2 |
| Every row unreadable | The footer says how many were not read and why, and does NOT claim they were |

## What wave 2 changed here

One new entry point (`append`), one new exit code (3, for a run that resolved nothing), one new row
class (`unclaimed`, in its own section), and ten new recovery paths, every one of them a case where
the build used to give a confident wrong answer rather than say it did not know. Nothing about the
happy path moved.

## What the user cannot do in phase 1

Reconcile Gmail or HubSpot claims. Run `landed` as a daemon. See any of this in a browser. Have
`landed` fix, retry or re-send anything: it reads and reports, and every write it makes is inside
`--out`.
