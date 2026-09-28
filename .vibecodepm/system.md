---
name: System map
phase: architect
status: confirmed 2026-09-27 (derived by system-map, walked and corrected by the operator; all judgement answers signed)
read_by: system-map reconcile on the operator's weekly schedule; anyone changing where landed writes, what it reaches, or how its verdicts are read
derived_from: landed
---

# System map

Derived from the code by `system-map derive` on 2026-09-27, then confirmed question by question. Every
line is either cited to the code or is a decision the operator made and signed here. Convention: a backticked
name in section 5 is a surface reconcile will look for in the code, so commands are written in plain words there. Reconcile compares this
to the code every week; when the two disagree, one of them is wrong and the report says which lines.

## 1. The map

- **bin** — 1 file, the CLI entry point (bin/landed.mjs:1)
- **scripts** — 1 file, the privacy guard that runs pre-commit and in CI (scripts/privacy-guard.mjs:1)
- **src** — 13 files: claims, ledger, adapters, receipts, report, cli (src/adapters/github.mjs:1)
- bin → src (bin/landed.mjs:2)
- scripts shells out to `git`, via execFileSync, to list tracked files (scripts/privacy-guard.mjs:94)
- src shells out to `gh`, via exec, which is the only way this tool reaches GitHub (src/adapters/github.mjs:69)
- tests: 23 files, excluded from the map (`--include-tests` to include) (test/adapter-contract.test.mjs:1)

## 2. Where state lives

- state lives in local files: `path`, written with writeFileSync, and also at src/receipts.mjs:168 (src/receipts.mjs:58)
- Decision: the state is three things under the operator's `--out` directory, none of them in this repo. Receipts, one JSON per run under `receipts/`; the settled index `settled.json` beside them; and the claims file the operator's hooks append to (`landed append`, src/append.mjs:22). For the maintainer the receipts sit in a scratch directory and the claims file in a git-backed notes repository.
- Decision (2026-09-27): receipts and the settled index are regenerable by re-running the check with recheck against the same claims, so they are not backed up. The claims file is the one thing that cannot be regenerated, so it lives in a git-backed repository and is committed with the records it describes; the output directory stays in scratch.

## 3. Doors and keys

- `LANDED_N8N_API_KEY` is read from the environment via an injected env object, and its name says it is a credential (src/host.mjs:40)
- `LANDED_N8N_URL` is configuration rather than a key, read via an injected env object (src/host.mjs:40)
- Decision (2026-09-27): both n8n variables are for the optional REST path of the n8n adapter. In the maintainer's deployment no n8n instance is wired and both are unset; the adapter reads exported JSON files only. The REST path is available the day one is needed.
- Decision: GitHub is reached with the operator's own `gh` login. This tool holds no GitHub credential of its own and never writes to GitHub; every `gh` call is a read.
- Decision: there is no HTTP route and no authorization check, and that is correct for a local CLI. The doors are the operator's shell and the operator's `gh` session.
- Decision: no key is present in a committed file; the privacy guard refuses commits carrying secrets, emails or phone numbers (scripts/privacy-guard.mjs:1). Build artifacts and logs: none are produced.

## 4. What bills per use

- `git` is run as a subprocess, so whatever it reaches is metered by that system's limits rather than billed here (scripts/privacy-guard.mjs:94)
- `gh` is run as a subprocess, so whatever it reaches is metered by that system's limits rather than billed here (src/adapters/github.mjs:69)
- Decision: nothing here bills. `gh` is bounded by GitHub's API rate limit on the operator's account; a 403 with rate-limit headers resolves to `unresolved`, never to a guess. There is no spend and therefore no cap to set.

## 5. How you find out it broke

- `console.error` records a failure here (scripts/privacy-guard.mjs:142)
- Decision: the tool does not push. Its alert surface is its exit code: 0 clean, 1 findings, 2 refusal, 3 nothing resolved, read by the maintainer's weekly routine, which runs the strict check. Decision (2026-09-27): a contradicted row is paged, not just read: the routine sends a notification naming each contradicted claim the moment the run exits 1, and a standing daily job does the same. Unresolved rows are reported in the weekly readout, not paged.
- Decision: a crash inside a run is an exit code and a printed refusal, not a silent pass; the footer names how many rows were not read this run.

## 6. Blast radius per piece

- **bin** — nothing in this repo imports it, so breaking it breaks only itself, unless it is an entry point (bin/landed.mjs:1)
- **scripts** — nothing in this repo imports it, so breaking it breaks only itself, unless it is an entry point (scripts/privacy-guard.mjs:1)
- **src** — 1 other piece imports it (bin), so breaking it breaks that one too (bin/landed.mjs:2)
- Decision: bin IS the entry point, so breaking bin breaks every run; breaking scripts breaks only the privacy guard, which fails closed (a broken guard blocks the commit, it does not wave it through).

## What the scan could not see

Nothing was refused or unreadable on this run. The structural limits of text extraction still apply: dynamic imports, reflection, generated code, and anything configured outside the repository. Known and accepted: the settled index filename is a constant three functions from its write site, so the scan cites the write line rather than the name.
