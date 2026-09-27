---
name: landed ship-check
phase: ship-check
status: draft
read_by: vibecodepm:gtm before any launch planning, and the next ship-check run on this repo, which picks up the open findings below
date: 2026-09-26
reviewer: row65_reviewer (independent; wrote no code)
target: lane/row65-landed-core @ d63fe42, PR derrtaderr/landed#1
---

decision: BLOCK
hard_gate: no claim may resolve `matched` while the adapter receipt it is graded against carries a fact that disagrees with the claim's kind. Concretely, F-01 below must be fixed with a table test that feeds a `completed` claim carrying both `executionId` and `workflowId` against an errored execution and asserts `contradicted`. F-02 through F-05 are the important tier and should land in the same pass or be written into SPEC §5 as accepted phase 1 behaviour with their reason codes.
success_window: carried from metrics.md, week one after the flip: clone-to-contradiction under two minutes, 5+ claims joined on the first real run, 1+ contradiction found, unresolved share under a quarter.

# Ship-check — landed phase 1

Walked against `.vibecodepm/flow.md` (status: current) and `.vibecodepm/metrics.md` (status: current). Neither was draft. No `system.md`, so the security surface was checked cold at the gate.

## Numbers reproduced (worktree, 2026-09-26)

| Gate | Result |
|---|---|
| `npm test` | 210 tests, 210 pass, exit 0 |
| `node scripts/privacy-guard.mjs` | 42 tracked files, nothing to report, exit 0 |
| `node bin/landed.mjs demo --out <tmp>` | exit 0 |
| `node --check` over every tracked `.mjs` | all pass |
| model/SDK grep over `src/`, `bin/` | only hit is the n8n REST `fetch` |
| fixture scan (emails, phones, home paths, client/company names) | only `mail@people.acme.test` (synthetic, in the guard's own test) |
| git history secret scan | clean |
| fresh clone | 308K, 42 files, all tool/docs/fixtures/tests; no dev exhaust |

## Flows walked

Entry point 1 (clone, `npm test`, `demo`) with Node only and no `gh` on PATH. Entry point 2 (`validate`, `check`, `report`, `watch`) on invented claims against the fixture exports, first without `gh`, then with an authenticated `gh`. Recovery paths: no verb, unknown verb, unknown flag, `--flag=value`, missing claims file, empty claims file, `report` before any run, unwritable `--out`.

## Blocking finding

**F-01 — a `completed` claim that names both `executionId` and `workflowId` is graded as an `executed` claim and comes back `matched` while the execution's own status is `error`.**
`src/adapters/n8n.mjs:130` routes to the single-execution branch only when `workflowId` is absent; `src/reconcile.mjs:107` dispatches on `facts.kind === 'fires'` before looking at `claim.kind`, so `checkFires` runs and never reads status. The receipt written beside the verdict shows `fires[0].status: "error"`. An n8n hook has both ids in hand and will naturally write both. This is the false green the row exists to forbid, and no test covers it.

Reproduce:
```
{"id":"a-1","at":"2026-09-26T10:51:00.000Z","actor":"x","kind":"completed","target":{"adapter":"n8n","executionId":"e-4001","workflowId":"wf-204"}}
node bin/landed.mjs check --claims a.jsonl --out out --n8n-executions fixtures/n8n/executions.json --n8n-workflows fixtures/n8n/workflows.json
→ a-1  matched  n8n  FIRED_AS_CLAIMED   (exit 0; receipt facts.fires[0].status = "error")
```

## Important findings (wrong on realistic input)

- **F-02** `src/adapters/n8n.mjs:177` `active: workflow.active === true`: a workflows row with no `active` key is read as inactive, so every fire becomes `contradicted FIRED_WHILE_INACTIVE`. The file's own comment says assuming `true` would manufacture a green; assuming `false` manufactures a red. Honest answer is `unresolved`.
- **F-03** `src/reconcile.mjs:300-303` builds the "accounted for" set from `result.receipt.facts`; a claim whose lookup came back `unreachable` (workflows export missing, or the workflow id absent from it) has no facts, so its own executions are reported `contradicted [executed-never-claimed]`. Omitting `--n8n-workflows` turns one unresolved claim into seven false contradictions and exit 1.
- **F-04** `src/reconcile.mjs:314-317` enumeration scope is the union of claim windows across the whole export, not restricted to claimed workflows, and contradictions are never carried. An operator who claims one workflow on a busy instance gets every other workflow's runs as `executed-never-claimed` every hour, forever, with no way to scope or suppress it.
- **F-05** `src/adapters/github.mjs:31-42` classifies on stdout+stderr regardless of exit code. A successful `gh api` whose JSON body contains "Not Found" (a commit message on the branch tip, a repo description) becomes a false `orphaned-claim`; "authentication" becomes `unreachable`; "rate limit" becomes `PARTIAL_READ`. The `compare` endpoint used for `pushed`+`commit` returns up to 250 commit messages, so this fires on ordinary repositories.
- **F-06** `src/adapters/github.mjs:42` a 404 is treated as the one genuine absence, but GitHub answers 404 for a private repo the token cannot see, and for a branch deleted at merge. Both resolve `contradicted [orphaned-claim]`. The ADAPTERS table ("the only genuine absence of the four") is false for the private case, and the merged-then-deleted branch is the normal lifecycle of a `pushed` claim, so it will alarm hourly on healthy work.
- **F-07** `src/cli.mjs:124-127` plus the `watch` recipe at `src/cli.mjs:203`: a run whose every claim is `unresolved` exits 0 without `--strict`, and the documented cron line has no `--strict`. Losing the export path or the `gh` credential is exit 0 under the recipe the tool prints. The output warns; the exit code, which is the only thing cron reads, does not. SPEC §7 asks; the answer is that the default violates the row's own rule.
- **F-08** `src/claims.mjs:116` `validate` knows nothing about join keys or registered adapters, so it reports a claim with no `pr` as well formed while `check` resolves the same line `unresolved MALFORMED_CLAIM`. Same reason code, two answers.
- **F-09** `src/reconcile.mjs:93-98` with `src/adapters/n8n.mjs:102`: `every_seconds` derives `floor(span/every)` while the window is inclusive at both ends, so an hourly workflow over a one-hour window fires twice and is `contradicted COUNT_VS_CADENCE` expecting one. Separately, `expected_fires` lets the claimant grade itself (declared 1, fired 1, should have fired 4: `matched`). Acceptable for phase 1 only if SPEC says the check is a consistency check against the operator's stated expectation, not a schedule check.
- **F-10** `src/adapters/n8n.mjs:153-158` an `executed` claim with no window matches any fire of that workflow in the export, including one three days older than the claim. `at` is never used to bound the fires.
- **F-11** `src/adapters/n8n.mjs:153` fires are not deduplicated by execution id, so an export assembled from overlapping pages reports `DOUBLE_FIRE` 0s apart for the same id.

## Minor findings

- `src/reconcile.mjs:34` a window that does not parse passes the skew check (`NaN → true`) and then yields a false `orphaned-claim` because the adapter finds no fires inside it.
- `src/reconcile.mjs:134` `PRESENT_ON_REMOTE` never compares the returned branch name to the claimed one; a claimed branch `main?per_page=1` matched as `main`, which also shows claim content reaching the API path unsanitized (GET only, low impact).
- `src/cli.mjs:87-96` a repeated flag silently keeps the last value (`--claims a --claims b` drops `a`), against the usage text's "no invocation can quietly become a different one". `check --help` is refused as an unknown flag.
- `src/cli.mjs:181` `report` exit is a dead ternary `? 0 : 0`.
- `src/receipts.mjs:25-27` an unwritable `--out` is an uncaught stack trace with exit 1, the same code as "findings"; two runs in one instant overwrite one receipt.
- `src/receipts.mjs:33-47` every run parses every receipt ever written; a 50MB claims file produced a 482MB receipt in 11s at 2.8GB RSS. No `--since`, no pruning, no append-only mode.
- A byte-identical duplicate claim id produces two identical rows in the output.
- `completed` on a still-running execution is `CLAIMED_COMPLETED_BUT_FAILED`; the code name says failed when the fact says running.
- `at` accepts only the `Z` form of ISO 8601; the docs say "ISO 8601 instant".

## Axis verdicts

| Surface | Invocation | Comprehension | Persistence | Recovery | Waste |
|---|---|---|---|---|---|
| `demo` | pass | pass | pass | pass | pass |
| `validate` | pass | pass (but see F-08) | n/a | pass | pass |
| `check` | pass | fail (F-01, F-03, F-04 mislead) | pass (receipt per run) | fail (F-07 exit 0 on lost credential) | fail (F-04 restates every hour) |
| `report` | pass | pass | pass | pass | pass |
| `watch` | pass | pass | n/a | fail (recipe omits `--strict`) | n/a |

## Instrumentation

metrics.md measures from receipts only. Confirmed in code: `inputs.mode: 'demo'` at `src/demo.mjs:68` and absent for `check`; `summary.new_findings` at `src/reconcile.mjs:414`; per-row `adapter` and `kind` at `src/reconcile.mjs:177-178`; receipt instant in the filename at `src/receipts.mjs:16`. Wired.

## Package audit

Fresh clone of the branch: 308K, 42 tracked files, every one under `src/ test/ docs/ fixtures/ bin/ scripts/ .vibecodepm/` or a root manifest. No renders, caches, env files or receipts in the box (`landed/` is gitignored and the builder's demo output stayed untracked). Fixtures synthetic. Clean.

## Security surface

Secrets: env only; receipts strip `key|token|secret|password` keys (`src/run.mjs`); the n8n key travels as a header, not argv. Egress: one `fetch` to the configured n8n URL (HTTPS not enforced) and `gh` subprocesses. Untrusted input: claim fields reach the GitHub API path unsanitized (minor above); nothing is executed through a shell. Least privilege: reads only. Data at rest: receipts contain adapter facts and absolute export paths under `--out`, disclosed. Fail direction: the false-green table fails closed; F-01 is the one path that fails open.

## Stranger walk (user-advocate, fresh clone, Node only then with gh)

Reviewer re-ran each of these before recording it.

- **W-1 (BUILD, high)** `src/report.mjs:78` prints "Every line above was read from the system of record" unconditionally: after a run where every row was `ADAPTER_UNREACHABLE`, after `report` (which reads nothing), and beside a `carried ... not re-read` row. The product's one trust sentence was false on four screens.
- **W-2 (BUILD, high)** a repo that does not exist (`example-org/example-repo`) came back `contradicted [orphaned-claim]` with `source.complete: true, empty: false` from a single 404. Same class as F-06; a private repo the token cannot see looks identical.
- **W-3 (BUILD, medium)** with `gh` absent the detail is `gh exited ENOENT: ` (`src/host.mjs:16-22` puts the spawn error in `code`, `src/adapters/github.mjs:33` only looks for ENOENT in stdout/stderr, so the "not installed" branch never fires). flow.md Recovery promises "naming which"; the n8n row beside it names the fix and this one does not.
- **W-4 (BUILD, medium)** `src/report.mjs:70-72` prints "Run with --strict to make that a non-zero exit" while the run IS under `--strict` (renderer has no strict flag).
- **W-5 (MAP, medium)** `demo` exits 0 with seven contradictions; README's exit table and flow.md step 7 say 1 means contradicted; the reason lives only in a code comment at `src/cli.mjs:189`.
- **W-6 (BUILD, medium)** `check --help` → `unknown flag: --help`, exit 2, no usage; flow.md promises "the spelling that works".
- **W-7 (BUILD, low)** `report` output is byte-identical to `check` and never says it is a re-render or which of N receipts it chose.
- **W-8 (low)** header counts unclaimed rows as "contradicted claims"; `(unclaimed)` label is reused for an unparseable JSON line; `validate` footer about refused claims prints with zero refusals; README says `npm test` but a Node-only machine has no `npm` and `node --test` is never offered.

Matched the map: no verb, missing file, no `--claims`, empty file (exit 2, no receipt dir), `--claims=x` refusal, `report` before any run, malformed lines in `validate` and as `unresolved` rows, n8n export missing naming flags and env vars, carry-forward announcing `--recheck`. Axes: invocation good bar `--help`; comprehension mixed (W-1, W-3, W-4); persistence good; recovery weak for GitHub; waste minimal.
