# Traceability — requirements, solutions, test cases

Loom can describe *why* the domain model looks the way it does and *what
verifies it*, alongside the model itself. Three analytical artifacts sit
above the domain and reference it **one-directionally** — the generated
code stays clean (no `implements` back-links):

- **`requirement`** — a generalised work item (`UserStory`, `UseCase`,
  `AcceptanceCriteria`, `BusinessReq`) with an optional `parent` for
  hierarchy.
- **`solution`** — the design rationale ("talkback") for a requirement;
  it `entitles` the concrete code symbols it legitimises.
- **`testCase`** — `verifies` a requirement and `covers` the code symbols
  it exercises.

Executable tests (`test` / `test e2e`) back-link to a test case via
`verifies`, completing the chain
`Requirement → Solution → TestCase → test → Code`.

## Surface

```loom
requirement US-001 {
  type: UserStory
  title: "User can log in"
  status: InProgress        // Draft | Approved | InProgress | Done
  priority: 1
}

requirement AC-001 parent US-001 {
  type: AcceptanceCriteria
  title: "Valid credentials grant access"
}

system Shop {
  module Identity {
    context Auth {
      aggregate LoginSession {
        operation start() {}
        test "successful login" verifies TC-001 {}
      }
    }
  }
  deployable AuthApi { platform: node  modules: Identity }
}

solution SOL-001 for US-001 {
  title: "Login handled by the LoginSession aggregate"
  entitles [
    Identity.Auth.LoginSession.start,
    AuthApi
  ]
}

testCase TC-001 verifies AC-001 {
  title: "Successful login"
  covers [ Identity.Auth.LoginSession.start ]
}
```

### Identifiers

Requirement / solution / test-case names are **ticket-style ids** —
`US-001`, `AC-001`, `SOL-001`, `TC-001` — hyphen-and-digits permitted and
preserved verbatim (leading zeros included). Plain identifiers
(`Login`, `US001`) are also accepted.

### Code references

`entitles` and `covers` take **qualified cross-references** into the
domain model — `Module.Context.Aggregate.operation`,
`Module.Context.Aggregate`, a `deployable`, an `api`, a `workflow`, a
`view`, etc. They resolve through Loom's qualified-name index, so they
get full IDE support: go-to-definition, find-references, rename, and
edit-time validation. They are not magic strings.

The qualified name omits the enclosing `system` (so a reference reads the
same regardless of which system ships the symbol); deployables and apis,
which are direct children of `system`, resolve by their bare name.

### Relations summary

| Relation | Direction | Keyword |
|---|---|---|
| Hierarchy | Requirement → Requirement | `parent` |
| Justification | Solution → Requirement | `for` |
| Verification | TestCase → Requirement | `verifies` |
| Entitlement | Solution → code symbol | `entitles [...]` |
| Coverage | TestCase → code symbol | `covers [...]` |
| Execution | `test` / `test e2e` → TestCase | `verifies` |

## Generated documentation

`ddd generate system <file> -o <out>` emits a set of derived views under
`<out>/.loom/` (same status as `domain.mmd` / `wire-spec.json` — derived,
not contracts; regenerated every build):

| Artifact | Content |
|---|---|
| `traceability.md` | The spec: requirement tree with each requirement's solution, tests, and covered code; the solution and test-case catalogues. |
| `coverage.md` | Code coverage, requirement coverage (rolled up through child requirements), and solution coverage, each with an overall percentage. |
| `gaps.md` | User stories without a solution, requirements without tests, referenced code without a covering test, test cases without an executable test. |
| `traceability-matrix.md` | Requirements × test cases and code × test cases grids. |
| `traceability.mmd` | A Mermaid graph of the full chain (`Requirement → Solution → Code`, `TestCase → Code`). |
| `traceability.json` | Machine-readable index + coverage summary, for CI gates and external tooling. |

These are emitted only when the source declares at least one
requirement / solution / test case, and once per build at the output
root (the artifacts are model-global — a solution or test case may
reference code across systems).

## Coverage semantics

- **Code coverage** — a referenced code symbol is *covered* when at least
  one `testCase` `covers` it. The denominator is the union of all
  symbols any solution `entitles` or any test case `covers`.
- **Requirement coverage** — a requirement is *covered* when a test case
  verifies it directly **or** verifies one of its (transitive) child
  requirements. So a test on an `AcceptanceCriteria` counts toward its
  parent `UserStory`.
- **Solution coverage** — the fraction of a solution's `entitles`
  symbols that are covered by some test case.

## Verification — Definition of Done

Coverage says a requirement *has* a test; **verification** says that test
*passed*. Given the results of actually running the executable tests,
`computeVerification` (`src/verify/verification.ts`) rolls each test case up to
a status and each requirement up to a verdict:

| Verdict | Meaning |
|---|---|
| `VERIFIED` | every test case for the requirement (and its children) ran and passed |
| `FAILING` | a backing test failed |
| `UNVERIFIED` | the requirement has test cases, but their tests didn't all run |
| `UNTESTED` | no test cases verify the requirement or any child |

The join is by `(suite, name)`: each executable test's name is the DSL string
emitted verbatim as `it("…")` / `[Fact(DisplayName="…")]` / `test("…")`, and
its `suite` is the aggregate name (unit tests) or `"<System> e2e"` (e2e tests)
— so unit-test names that repeat across aggregates still attribute correctly.
The function is pure and shared by both front-ends below.

### In the playground

The **Tests** panel shows a live **Requirements** rollup: as you run unit /
API / UI tests, each requirement's verdict badge updates in place. It reads
`.loom/traceability.json` (which carries an `execTests` provenance list) and
joins it against the panel's results — no extra step.

### In CI — `ddd verify`

```bash
ddd verify <file.ddd> --results <results.json> [--out <dir>] [--require-all] [--min <pct>] [--json]
```

`results.json` is `{ "version": 1, "results": [{ "name": "...", "status": "pass"|"fail"|"skip", "suite": "..." }] }`
— produced from your runner's JSON report (vitest `--reporter=json`, `dotnet
test` trx, Playwright JSON). The command writes
`.loom/verification.{md,json,mmd}` (the `.mmd` is a verdict-colored
requirements graph) and gates the exit code:

- exit `0` — gate passes;
- exit `1` — a requirement is `FAILING` (default), or below `--min`, or not all
  `VERIFIED` under `--require-all`;
- exit `2` — bad input (parse/validation error, missing or malformed results).
