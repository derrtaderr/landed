---
name: landed metrics
read_by: vibecodepm:ship-check before any landed release, and any session changing what a run reports
status: current — matches the build on lane/row65-landed-core after ship-check wave 1
phase: 1
wave: 2
date: 2026-09-26
---

# Metrics — landed phase 1

## Activation event

**A second `check` run against the operator's own claims, from a schedule.**

Not the demo, and not the first manual run. The whole thesis is that a standing check turns a
disagreement into something the operator learns before a customer does, and a tool run once by
hand has not done that. The second scheduled run is the first moment the tool is doing its job.

## How it is measured

Without a server, and without telephoning anywhere. Every number below is readable from the
operator's own `<out>/receipts/` directory, which is the same place the tool already writes.

| Signal | Where it is read |
|---|---|
| Activation | Two or more receipts whose `inputs.mode` is not `demo`, at least an hour apart |
| Standing, not one-off | Receipt instants spaced at a regular interval |
| Findings that mattered | A `contradicted` result in receipt N that is absent from receipt N+1: something got fixed |
| Noise | The same `unresolved` reason code in every receipt, which means a gate nobody can satisfy |
| Coverage | Distinct `adapter` values and distinct `kind` values across the receipt set |
| Whether the run could see anything | A receipt whose `summary.matched` and `summary.contradicted` are both 0. Since wave 2 that is exit 3, so cron sees it too |
| Whether enumeration is scoped usefully | `summary.unclaimed` staying flat while `new_findings` falls: rows are being carried rather than re-alarmed |

`summary.new_findings` exists for the same reason: an hourly run whose output restates every
agreement it has ever reached is output nobody reads, and the count makes that visible. Since wave 2
it counts carried unclaimed runs as not-new too, so the number answers "what changed" rather than
"what is true".

`settled.json` beside the receipts is what makes all of this cheap to read: one small file with the
matched claims and the unclaimed runs already reported, rather than a scan of every receipt ever
written.

## Week-one numbers worth having

| Number | Target | Why this one |
|---|---|---|
| Time from clone to a demo that shows a contradiction | under two minutes | The five-minute audience in the flow map |
| Claims a first real run joins | 5 or more | Fewer means the claims-writing side was not wired |
| Contradictions found in the first week | 1 or more | Zero means either the systems agree, or the joins are too loose to catch anything. Both need looking at, and the receipt set says which |
| `unresolved` share after the first week | under a quarter | A higher share means the exports are stale or the targets are wrong, not that the systems are healthy |

## The number the ship-check added

**Rows not read from the system of record, per run.** The footer prints it, and it is the number that
makes every other number above trustworthy. A run of twelve rows where four were unreadable is not a
run of twelve joins, and the tool used to print one trust sentence that said it was.

## The number this tool must never report

**A green run it did not earn.** `unresolved` exists so that "we could not tell" never gets
counted as "it landed", and the five false-green states in `test/false-green.test.mjs` are the
table that keeps it that way. If a future change makes any of those five produce `matched`, every
number above becomes decoration.
