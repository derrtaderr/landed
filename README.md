# landed

A scheduled reconciler that joins what an agent CLAIMED against what actually LANDED in the
authoritative system, and resolves every claim to exactly one of three states.

```
matched | contradicted | unresolved
```

An agent says it sent the email, merged the PR, or completed the run. `landed` goes and asks the
system that would know, joins the two records, and names the disagreement. Nothing in it decides
whether an agent is trustworthy. It decides whether two records agree.

## Why

Every row below was reported by the operator who got burned, and every one was found by a customer
or by eyeball, weeks late.

| What was claimed | What had happened |
|---|---|
| Run `COMPLETED`, `ok: true` | `status: 403` rendered beside it, while the agent drafted refund claims |
| "approved by Guardian and has been sent successfully" | Nothing arrived, in the builder's own live demo |
| Campaign accepted 40 leads, HTTP 200 | No senders attached, so none sent |
| Workflow inactive | Fired anyway |
| One trigger, one run | Two runs 14 seconds apart |
| PR parked | GitHub had merged it the day before |

One sentence from those threads is the whole design:

> A claim is not evidence the thing landed.

And one more, which is why this is a scheduled reconciler rather than a linter:

> Two records that disagree, found by eyeball. A standing check joins them hourly and the
> disagreement stops being something a customer has to teach you about.

## Try it

You need Node 20 or newer. There is nothing to install, no API key, and no network call.

```console
$ git clone https://github.com/derrtaderr/landed.git
$ cd landed
$ npm test
$ node bin/landed.mjs demo --out /tmp/landed-demo
```

The demo runs against a recorded corpus, so it produces the same result on your machine as on
anyone else's. Every workflow, repo and branch in it is invented.

<!-- verified-block: demo -->
```console
$ node bin/landed.mjs demo --out /tmp/landed-demo
landed 2026-09-26T11:00:00.000Z

  7 contradicted claims
  4 unresolved claims
  2 matched claims
  2 orphaned claims
  2 runs nobody claimed

  c-2         contradicted  n8n     FIRED_WHILE_INACTIVE
      wf-202 fired 1 time(s) while its active flag was false (first at 2026-09-26T10:05:00.000Z)
  c-3         contradicted  n8n     DOUBLE_FIRE
      wf-203 fired twice 14s apart (e-3001 then e-3002), inside the 15s double-fire window
  c-4         contradicted  n8n     CLAIMED_COMPLETED_BUT_FAILED
      execution e-4001 has status error
  c-5         contradicted  github  CLAIMED_MERGED_NOT_MERGED
      example-org/example-repo#41 is open, not merged
  c-7         contradicted  github  ORPHANED_CLAIM [orphaned-claim]
      github read its source and has no record for repo=example-org/example-repo branch=lane/never-pushed
  c-8         contradicted  n8n     COUNT_VS_CADENCE
      wf-207 fired 1 time(s) in the window; the declared cadence expects 2
  c-12        contradicted  n8n     ORPHANED_CLAIM [orphaned-claim]
      n8n read its source and has no record for workflowId=wf-206
  c-9         unresolved    n8n     CLOCK_SKEW
      the claim is dated 2026-09-26T09:30:00.000Z, outside the window it reports on (2026-09-26T10:00:00.000Z to 2026-09-26T11:00:00.000Z)
  c-10        unresolved    -       MALFORMED_CLAIM
      line 10: kind is not one of sent, created, updated, merged, pushed, executed, completed: "delivered"
  c-11        unresolved    gmail   UNKNOWN_ADAPTER
      no adapter named gmail is registered
  (unclaimed) unresolved    n8n     ENUMERATION_SUPPRESSED
      n8n did not enumerate wf-208, because the claim about it could not be resolved; its runs cannot be attributed either way
  c-1         matched       n8n     FIRED_AS_CLAIMED
      wf-201 fired 1 time(s) in the window (e-1002)
  c-6         matched       github  MERGED
      example-org/example-repo#38 is merged at 4f1c9ab6d2e30517c8a1b4d9f0e6a2c37b58d194
  (unclaimed) unclaimed     n8n     EXECUTED_NEVER_CLAIMED [executed-never-claimed]
      n8n ran e-1001 (wf-201) at 2026-09-26T09:58:00.000Z; no claim accounts for it
  (unclaimed) unclaimed     n8n     EXECUTED_NEVER_CLAIMED [executed-never-claimed]
      n8n ran e-6001 (wf-206) at 2026-09-26T10:55:00.000Z; no claim accounts for it

  receipt   /tmp/landed-demo/receipts/2026-09-26T11-00-00-000Z.json
  7 contradicted, 4 unresolved, 2 matched, out of 15 joined records

  Every line above was read from the system of record, not from what an agent said.
```

Twelve claims went in. Some agreed, some disagreed, some could not be decided, and one row has no
claim id at all because it is a run nobody claimed. Every outcome names the rule that produced it
and carries the detail in the authoritative system's own words.

What the corpus is showing you, case by case:

| Row | What the fixture does |
|---|---|
| `c-2` | A workflow whose `active` flag is false, and which fired anyway |
| `c-3` | The same workflow firing twice 14 seconds apart, which is the reported bug exactly |
| `c-4` | An execution an agent called `COMPLETED` with `ok: true`, whose real status is `error` |
| `c-5` | A PR the lane record says was merged. GitHub says it is open |
| `c-7` | A branch an agent said it pushed. GitHub answers 404 |
| `c-8` | A workflow that ran once against a declared cadence of twice |
| `c-9` | A claim dated before the window it reports on, so the agent's clock and its own window disagree |
| `c-10` | A claim whose `kind` is not in the closed set, refused by name rather than dropped |
| `c-11` | A claim for an adapter phase 1 does not have. Named, not silently skipped |
| `c-12` | A claim that the export ran before 10:30. It ran at 10:55, so the claim is orphaned |
| `(unclaimed)` | That 10:55 run itself: a run of a workflow this operator watches, inside the reconciled window, that no claim accounts for |

## The three states, and why the third one exists

| State | When |
|---|---|
| `matched` | The receipt exists and its facts agree with the claim. |
| `contradicted` | Both records were read, and they disagree. |
| `unresolved` | The join could not be made. Everything unknown lands here. |

Plus two named verdicts, which are contradictions with a name worth grepping for:
`orphaned-claim` (claimed, and a complete read of a non-empty source has no such record) and
`executed-never-claimed` (a record the adapter enumerated that no claim covers).

**`unresolved` is the load-bearing state.** A reconciler that cannot say "I could not tell" will
eventually say "it landed" about something it never looked at. These five states each resolve to
`unresolved` or to a refusal, and `test/false-green.test.mjs` is what keeps them there:

| State | Reason code |
|---|---|
| The claims file is empty | `EMPTY_CLAIMS`, a refusal, exit 2 |
| The export holds zero records | `EMPTY_SOURCE` |
| The adapter could not be read | `ADAPTER_UNREACHABLE` |
| The read was truncated or rate limited | `PARTIAL_READ` |
| The claim is dated outside the window it reports on, or outside a bounded read | `CLOCK_SKEW` |

The second one is the one that looks most like good news. Zero executions in an export is
indistinguishable from a failed export, so an absence is only evidence when the source returned
something. That is the difference between `EMPTY_SOURCE` and `orphaned-claim`.

## Your own claims

A claim is one line of JSON, appended by whatever already knows what your agents did: a hook, a
trace, a workflow's last node.

```json
{"id":"c-0001","at":"2026-09-26T14:00:00.000Z","actor":"lane-runner","kind":"merged",
 "target":{"adapter":"github","repo":"example-org/example-repo","pr":41},
 "evidence":{"printed":"approved and merged successfully"}}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique per claim. The same id with different content is refused, never silently overwritten. |
| `at` | yes | ISO 8601 instant the claim was made. |
| `actor` | yes | Which agent or workflow said it. |
| `kind` | yes | One of `sent`, `created`, `updated`, `merged`, `pushed`, `executed`, `completed`. A closed set. |
| `target` | yes | `adapter`, plus the join keys that adapter needs. |
| `evidence` | no | What the agent showed as its proof. Carried into the receipt, and never treated as true. |

Check the file's shape before wiring anything, and note that a malformed claim is reported rather
than dropped:

<!-- verified-block: validate -->
```console
$ node bin/landed.mjs validate --claims fixtures/claims.jsonl
landed validate fixtures/claims.jsonl

  11 claims well formed
  1 claim refused

  line 10   c-10      MALFORMED_CLAIM
      line 10: kind is not one of sent, created, updated, merged, pushed, executed, completed: "delivered"

  A refused claim is never dropped. It resolves to unresolved, with this reason.
```

Then run the real thing. `validate` consults no adapter; `check` does.

```console
$ node bin/landed.mjs check --claims claims.jsonl --out landed \
    --n8n-executions exports/executions.json \
    --n8n-workflows exports/workflows.json
```

`node bin/landed.mjs report --out landed` re-renders the newest receipt without re-reading
anything, which is what you want at 9am when the run happened at 3am.

### Exit codes, because this is built for cron

| Code | Meaning |
|---|---|
| `0` | The run ran, every claim resolved, and nothing disagreed |
| `1` | Findings: something is contradicted |
| `2` | A refusal: no claims file, nothing in it, an unwritable `--out`, or a flag that makes no sense |
| `3` | Nothing resolved: every claim came back `unresolved`, so the authoritative side was not read |

**Pass `--strict` from cron.** It promotes ANY unresolved claim to exit 3, not just a run where
everything was unresolved. A lost credential must never share an exit code with a quiet healthy
hour, and the exit code is the only thing cron reads.

Unclaimed runs are reported in their own section and do not set the exit code, because nobody
claimed them and so no claim is wrong.

`demo` always exits 0. Its corpus contains contradictions on purpose, so a non-zero demo would
read as a broken install rather than as a working one.

### Receipts, and what a second run does

Every run writes `<out>/receipts/<instant>.json`: the verdict per claim AND the adapter response
that produced it, so any verdict can be re-derived rather than believed. The run's inputs are
stored too, with every credential-shaped key stripped.

A claim that `matched` in an earlier receipt is carried forward on the next run and not looked up
again, so an hourly cron reports what is new instead of restating every agreement it has ever
reached. `--recheck` re-verifies it from the adapter anyway. A contradiction is never carried: it
is still true and still unfixed, so it appears every run until the world changes.

## Adapters

Two in phase 1. Each answers one question, *what does the authoritative system say about this
target*, and neither one decides whether a claim matched. `docs/ADAPTERS.md` is the contract.

### `n8n`

| Kind | Join keys | Question |
|---|---|---|
| `executed` | `workflowId`, optional `window`, optional `cadence` | Did this workflow fire in this window, how many times, and was it active when it did? |
| `completed` | `executionId` | Did this execution finish, and with what status? |

Reads an executions export: a JSON file you download, or a saved `/executions` response. Live REST
is optional, and only attempted when both `LANDED_N8N_URL` and `LANDED_N8N_API_KEY` are set. Three
named checks run over the fires it finds: `fired-while-inactive`, `double-fire` (same workflow
twice within 15 seconds by default) and `count-vs-cadence`.

The cadence comes from your claim rather than from the workflow export, and `docs/SPEC.md` §5.1
says why: an n8n schedule lives in an untyped node-parameters blob whose shape moves between
trigger types and versions, so parsing it is a guess that fails silently on the next release.

### `github`

| Kind | Join keys | Question |
|---|---|---|
| `merged` | `repo`, `pr` | Is this PR merged, and at what sha? |
| `created` | `repo`, `pr` | Does this PR exist? |
| `pushed` | `repo`, and `branch` or `commit` | Does this branch exist on the remote, or is this commit contained in the default branch? |

Shells out to `gh`, which must already be authenticated, so no token lives in this repo or in a
receipt. Of the four ways that call can end, only one is an absence:

| What happened | Answer |
|---|---|
| `gh` is not installed | `unreachable` |
| `gh` is not authenticated | `unreachable` |
| The API rate limited the read | an incomplete read, so `unresolved` / `PARTIAL_READ` |
| The API answered 404 | a genuine absence, and the only one of the four |

### Phase 2

Gmail (was this message really in Sent) and HubSpot (does this record exist) drop in behind the
same contract with no core change. `test/new-adapter.test.mjs` is the proof: it builds a fictional
adapter out of nothing but `docs/ADAPTERS.md`, runs the real core over it, and resolves all three
states and both verdicts. If a phase 2 adapter needs more than the contract, that test fails
first.

## The schedule

There is no daemon, and there will not be one. The schedule belongs to the operating system,
which already knows how to restart things.

<!-- verified-block: watch -->
```console
$ node bin/landed.mjs watch
landed watch

  This is not a daemon, and it will not become one. A reconciler that only runs when someone
  remembers to run it is the problem this tool exists to solve, so the schedule belongs to the
  operating system, which already knows how to restart it.

  crontab -e, hourly, on the hour:

    0 * * * * cd /path/to/your/claims && /usr/local/bin/node /path/to/landed/bin/landed.mjs check --strict --claims claims.jsonl --out landed --n8n-executions exports/executions.json --n8n-workflows exports/workflows.json >> landed/check.log 2>&1

  launchd (macOS), the same thing, in ~/Library/LaunchAgents/ai.landed.check.plist:

    <?xml version="1.0" encoding="UTF-8"?>
    <plist version="1.0"><dict>
      <key>Label</key><string>ai.landed.check</string>
      <key>ProgramArguments</key><array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/landed/bin/landed.mjs</string>
        <string>check</string><string>--strict</string>
        <string>--claims</string><string>/path/to/claims.jsonl</string>
        <string>--out</string><string>/path/to/landed</string>
      </array>
      <key>StartCalendarInterval</key><dict><key>Minute</key><integer>0</integer></dict>
      <key>StandardOutPath</key><string>/path/to/landed/check.log</string>
      <key>StandardErrorPath</key><string>/path/to/landed/check.err</string>
    </dict></plist>

    launchctl load ~/Library/LaunchAgents/ai.landed.check.plist

  Both recipes pass --strict on purpose. Exit 1 means something disagreed and exit 3 means
  nothing could be read at all, which is the case that used to exit 0 and look like a quiet
  hour. Pipe the output wherever your team reads alarms; a finding nobody sees is the state this
  tool was built to end.
```

## What it will not do

- **No model, anywhere.** The join is deterministic, and `test/no-model.test.mjs` pins it. A
  verdict that depended on a sampled answer would be one more claim rather than a check on claims.
- **No writes outside `--out`.** `landed` reads the authoritative systems and reports. It does not
  fix, retry, re-send or repair anything.
- **No daemon, no UI.** See above.
- **No real data in the repo.** Every fixture is synthetic. `npm run privacy` refuses any email at
  a domain that is not reserved for documentation, any phone-shaped string outside `fixtures/`, and
  any absolute home path anywhere.

## Development

```console
$ npm test          # node --test over test/**/*.test.mjs
$ npm run privacy   # the tracked-tree privacy guard
```

Every console block in this README marked `verified-block` is executed by `test/readme.test.mjs`
and compared with the real output byte for byte, so a README that goes stale fails the suite in
the commit that staled it.

| Document | What it holds |
|---|---|
| `docs/SPEC.md` | Scope, the settled decisions, the prior art, the divergences and the gate set |
| `docs/ADAPTERS.md` | The adapter contract, in enough detail to write one |
| `.vibecodepm/flow.md` | Entry points, the happy path, every state, every recovery path |
| `.vibecodepm/metrics.md` | The activation event, and how it is measured without telephoning anywhere |
