# T1 test-suite findings

What writing the T1 suite (tests/money, tests/static) turned up against `main`. The rule for this suite: a test that shows a real bug is
**not** fixed in server.js here. It is written up below and skipped, with a pointer to this file.

## server.js bugs

**None found.** Every money-path guarantee in brief T1 (a–i) holds on main as written. Each test file was also checked by
mutation (the relevant line of a local copy of server.js was broken and the test had to go red), so a pass means something:

| Mutation (local only, never committed) | Caught by |
|---|---|
| autoExecuteSell floor guard `<=` → `<` | AE1 |
| floorCappedLimitSell rounds to the nearest step instead of up | FL1, FL2 |
| spikeLoopArmOver takes the new peak/stop without `Math.max` | SL1 |
| spikeChase ignores `remainder_resting` | SC4 |
| isVenueRefusal treats 5xx as a refusal | HT4, HT7 |
| `hs` removed from CB_TYPES | CB1 |
| setTrailingStop drops the kept `source` | TS5 |
| mayAutoTrade manual_only check removed | MA2 |

## Tests skipped

### F1: `tests/p0/callers.test.mjs` is stale on main (test problem, not a server.js bug)

- **What:** 8 of its 11 tests fail on current main (V33, V33k, V33x, V44, V35+, LA1, V34, V34b).
- **Why:** it was the one-off proof for the #P0 branch. It compares that branch's server.js with the main of that day ("behaviour
  unchanged from main", "mayAutoTrade is called from no order path", "only these functions changed vs main") and pins the exact
  SQL of that time. Main has moved on as intended: `mayAutoTrade` now has callers, `exec_decisions` gained a `path` column
  (`VALUES ('manual', ?, ?, ?, ...)` instead of `'manual'` inline), loop_audit prints "- no live cycle". Run on main, "this branch" and
  "main" are the same file, so the diff assertions cannot hold.
- **Reproduce:** `git fetch origin main && node tests/p0/callers.test.mjs` → `3/11 passed, 8 FAILED`.
- **Status:** skipped in `tests/run-all.mjs` (listed in `SKIPPED`). `tests/p0/predicate.test.mjs` (46 vectors) still runs and passes.
  The file is left as it is; rewriting it as a main-only test is a separate job.

## CI notes (not bugs; things the PR reviewer should know)

- **Railway waits for GitHub checks.** The production service has `checkSuites: true`: a red check on a main commit would **hold the
  deploy**. So on `push` and `workflow_run` the test step is `continue-on-error`: the job ends green, and a failure is shown as an
  error annotation plus a FAIL line in the run summary. On `pull_request` (which never deploys) a failure makes the check red.
  Railway still waits for the run to finish (about a minute).
- **Batch commits do not trigger `push` workflows.** The Apply Batch Patch workflows push with `GITHUB_TOKEN`, and GitHub does not
  start other workflows from such pushes. Since server.js changes only arrive that way, tests.yml also runs on `workflow_run`
  (after Apply Batch Patch / Apply Patch / Apply Approved Spec complete) against the new head of main.
- **package.json is not touched.** Railway's watch patterns include package.json, so editing it would redeploy. acorn is installed
  by CI into `$RUNNER_TEMP`, outside the repo, and passed in with `ACORN_PATH`.
