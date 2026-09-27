---
name: landed flow map
read_by: vibecodepm:ship-check and any session adding a CLI verb, an adapter or a state to this repo, before the first edit
status: current — matches the build on lane/row65-landed-core
phase: 1
date: 2026-09-26
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
node bin/landed.mjs validate --claims claims.jsonl
node bin/landed.mjs check --claims claims.jsonl --out landed \
  --n8n-executions exports/executions.json --n8n-workflows exports/workflows.json
node bin/landed.mjs report --out landed
node bin/landed.mjs watch
```

`node bin/landed.mjs` with no verb prints usage and exits 2, so a user who guesses wrong is told
what the verbs are rather than left with a blank screen.

## Happy path

1. An agent, hook or workflow appends a claim to `claims.jsonl`.
2. `check` parses the file. Every line becomes a record, valid or not.
3. Each valid claim is routed to the adapter its target names, and refused before any lookup if
   the target cannot be joined.
4. The adapter reads the authoritative system and returns a receipt.
5. The core resolves the claim to `matched`, `contradicted` or `unresolved`.
6. The adapter enumerates its window, and any record no claim covered becomes
   `executed-never-claimed`.
7. A receipt file is written, the table is printed, and the exit code says whether anything
   disagreed.

## Every state

| State | What the user sees |
|---|---|
| `matched` | A row, and nothing to do. Carried forward silently on the next run. |
| `contradicted` | A row naming the reason code and the detail in the authoritative system's own words. Exit 1. |
| `unresolved` | A row naming what could not be established. Exit 1 only under `--strict`. |
| `orphaned-claim` | A contradiction whose detail names the join keys that were looked for. |
| `executed-never-claimed` | A row with no claim id, naming the record nobody claimed. |
| Refusal | No claims file, or no claims in it. Exit 2, no receipt written. |

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
| `gh` missing or unauthenticated | `unreachable`, naming which |
| `gh` rate limited | An incomplete read, resolved `unresolved` / `PARTIAL_READ` |
| `report` with no receipt yet | Told to run `check` or `demo` first, exit 2 |

## What the user cannot do in phase 1

Reconcile Gmail or HubSpot claims. Run `landed` as a daemon. See any of this in a browser. Have
`landed` fix, retry or re-send anything: it reads and reports, and every write it makes is inside
`--out`.
