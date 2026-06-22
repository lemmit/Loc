# Verify

`ddd verify` joins a JSON of test-execution results onto the requirements graph and stamps every requirement with a Definition-of-Done verdict. It is the last link in Loom's quality chain:

```
requirement  →  solution  →  testCase  →  test / test e2e  →  ddd verify  →  DoD verdict
 (work item)   (rationale)   (verifies)   (executable)        (the join)    VERIFIED / FAILING / …
```

The graph already knows which `testCase`s verify each `requirement` and which runnable `test`s back each `testCase` (that's [`traceability.md`](traceability.md)). `verify` is the runtime overlay: it answers "did those tests actually pass?". It **does not run any suite** — you run them with your own runner, then feed the results in.

## The command

```bash
ddd verify <file.ddd> --results <results.json> [--out <dir>] [--require-all] [--min <pct>] [--json]
```

| Flag | Effect |
|---|---|
| `--results <file>` | **required** — the test-results JSON (contract below). |
| `--out <dir>` | output dir for the `.loom/` artifacts (default: the `.ddd` file's directory). |
| `--require-all` | fail the gate unless *every* requirement is `VERIFIED`. |
| `--min <pct>` | fail if the verified percentage is below `<pct>`. |
| `--json` | also print `verification.json` to stdout. |

It writes `.loom/verification.{json,md,mmd}`, prints a one-line summary, and **gates the exit code**:

- exit `0` — gate passes;
- exit `1` — a requirement is `FAILING` (default), or verified % is below `--min`, or not all requirements are `VERIFIED` under `--require-all`;
- exit `2` — bad input: the `.ddd` failed to parse/validate, there were no `requirement` declarations, or the results file was missing or malformed.

```console
$ ddd verify shop.ddd --results out/results.json
Verified 3/5 requirements (1 failing, 1 unverified, 0 untested).
Verification gate failed: 1 requirement(s) failing.
$ echo $?
1
```

Because it only gates and never runs suites, the CI shape is: run your tests → emit their JSON → `ddd verify`. The pure rollup (`computeVerification`, `src/verify/verification.ts`) is dependency-free (no fs, no Langium, no `Date`), so the browser playground's **Tests** panel uses the same function to update verdict badges live — see [`traceability.md`](traceability.md#in-the-playground).

## The `results.json` contract

A top-level `results` array of normalized outcomes. One row per executed test:

```json
{
  "version": 1,
  "results": [
    { "name": "successful login",        "status": "pass", "suite": "Account" },
    { "name": "rejects bad password",    "status": "fail", "suite": "Account" },
    { "name": "lists open orders",       "status": "skip", "suite": "Order"   },
    { "name": "checkout happy path",     "status": "pass", "suite": "Shop e2e" }
  ]
}
```

| Field | |
|---|---|
| `name` | **required** — the DSL `test` / `test e2e` string, verbatim as the runner reports it (`it("…")` / `[Fact(DisplayName="…")]` / `test("…")`). |
| `status` | **required** — `"pass"` \| `"fail"` \| `"skip"`. |
| `suite` | optional disambiguator. Unit-test names are unique only *within* an aggregate, so the join is by `(suite, name)`. `suite` must match the runner's reported suite exactly: the **aggregate name** for a unit test, `"<System> e2e"` for an api/ui e2e test. |
| `kind` | optional, informational. |

You produce this from your runner's report (vitest `--reporter=json`, `dotnet test` trx, Playwright JSON, or the playground harness's own `TestResult`). The only top-level shape `verify` requires is `{ results: [...] }`.

**Join rules** (`outcomeFor` / `worst`): a result is matched to an executable test by exact `(suite, name)`; a `suite`-less result is attributed only when its bare `name` is unambiguous. Of several runs of one test, the **most pessimistic** wins (`fail > skip > pass`). Results that match no declared executable test are surfaced under `diagnostics.unknownTests` but never scored.

## The verdict model

The rollup is two levels. Each `testCase` first collapses its backing tests to a **status**:

| `TestCaseStatus` | When |
|---|---|
| `VERIFIED` | every backing test ran and passed. |
| `FAILING` | any backing test failed. |
| `UNVERIFIED` | a backing test was skipped or had no matching result (`missing`) — but none failed. |

Each `requirement` then rolls up its test cases (its own *and* its transitive children's, already flattened in the traceability index) to a **verdict**:

| `RequirementVerdict` | Glyph | When |
|---|---|---|
| `VERIFIED` | ✅ | the requirement has test cases and *all* of them are `VERIFIED`. |
| `FAILING` | ❌ | any backing test case is `FAILING`. |
| `UNVERIFIED` | 🟡 | it has test cases, but they didn't all run/pass (no failures). |
| `UNTESTED` | ⚪ | no test case verifies it or any child. |

`FAILING` dominates `UNVERIFIED` dominates `UNTESTED` — a single failure colors the requirement red. These four states are the only ones a requirement can be in.

## The emitted artifacts

`verify` writes three files into `<out>/.loom/` (see the full bundle in [`loom-artifacts.md`](loom-artifacts.md)):

- **`verification.json`** — the machine-readable `VerificationIR`: per-test-case status + backing detail, per-requirement verdict with `testCaseIds` / `failingTestCaseIds`, a `summary` count, and `diagnostics`.
- **`verification.md`** — the human report.
- **`verification.mmd`** — a verdict-colored Mermaid requirements graph (nodes tinted by verdict, parent→child edges).

`verification.json`:

```json
{
  "version": 1,
  "testCases": {
    "TC-001": { "status": "VERIFIED", "backing": [{ "name": "successful login", "status": "pass" }] },
    "TC-002": { "status": "FAILING",  "backing": [{ "name": "rejects bad password", "status": "fail" }] }
  },
  "requirements": {
    "US-001": { "verdict": "FAILING", "testCaseIds": ["TC-001", "TC-002"], "failingTestCaseIds": ["TC-002"] }
  },
  "summary": { "verified": 3, "failing": 1, "untested": 0, "unverified": 1, "total": 5 },
  "diagnostics": { "unknownTests": [], "unmappedTestCases": [] }
}
```

`verification.md`:

```markdown
# Verification

_Generated by Loom. Derived view — do not edit._

Verified **60%** of requirements — 3 verified, 1 failing, 1 unverified, 0 untested (of 5).

## Requirements

- ❌ **US-001** (FAILING) User can sign in — failing: `TC-002`
  - ✅ **AC-001** (VERIFIED) Valid credentials are accepted
  - ❌ **AC-002** (FAILING) Bad password is rejected — failing: `TC-002`

## Test cases

| Test case | Status | Backing tests |
| --- | --- | --- |
| `TC-001` | VERIFIED | successful login (pass) |
| `TC-002` | FAILING | rejects bad password (fail) |

## Diagnostics

_No unknown results._
```

## Related

- [`traceability.md`](traceability.md) — the requirement / solution / test-case graph and the coverage report (does a requirement *have* a test); verification is the runtime overlay (did it *pass*).
- [`loom-artifacts.md`](loom-artifacts.md) — the full `.loom/` artifact bundle, including these `verification.*` files.
- `ddd snapshot` is a separate provenance command (`<out>/.loom/snapshots/`) and is unrelated to the verify gate; see [`provenance.md`](provenance.md).
