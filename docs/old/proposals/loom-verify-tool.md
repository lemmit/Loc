# `loom_verify` — the requirement-verdict agent tool (gated on the sandbox test-runner)

> **Status:** OPEN (proposal), **blocked on a prerequisite**. The pure core it
> would wrap is SHIPPED — `src/verify/` joins a test-results JSON onto the
> traceability/requirements graph and emits per-requirement Definition-of-Done
> verdicts (the `ddd verify --results <json>` CLI, consumed by both the CLI and
> the browser playground). What's missing is not the tool wrapper (a ~30-line
> catalog entry) but the **thing it joins against**: real test-execution results.
> The playground can't yet RUN the emitted suites in-browser, so `loom_verify`
> would have nothing to verify. This proposal records the design and pins the
> dependency so the tool lands the moment the runner exists — rather than shipping
> a tool that can only ever return "no results".
> **Role:** the third verb of the AI authoring loop's `validate → repair → verify`
> triad ([`ai-authoring-loop.md`](./ai-authoring-loop.md)). `loom_validate`
> (compile-time oracle) and `loom_generate` (manifest) shipped; `loom_verify` is
> the runtime-truth oracle.
> **Depends on:** the playground sandbox test-runner
> ([`playground-sandbox-redesign.md`](../plans/playground-sandbox-redesign.md)
> Phase 3 API runner / Phase 4 UI driver — live mission M-T8.6), and `src/verify/`
> (shipped).
> **Scope:** one browser-safe tool over `src/api/` + the runner's results; no
> grammar/IR change.

---

## Problem

An agent editing a Loom model can today answer "does it compile?" (`loom_validate`)
and "what does it deploy to?" (`loom_generate`), but not the question that closes
the loop: **"does this system actually satisfy its stated requirements, per the
tests?"** Loom already models requirements (the `requirement` surface, the
traceability graph) and already has the join that turns test outcomes into
per-requirement verdicts — `ddd verify` produces `.loom/verification.{json,md}`
with a met / unmet / partially-verified verdict per requirement. Exposing that to
the chat agent would let it drive a real Definition-of-Done, not just a green
compile.

## Why it's not just a wrapper (the real blocker)

`verify` is a **join**: `verify(requirementsGraph, testResults) → verdicts`. It
needs the right operand — actual pass/fail data from *running* the emitted test
suites. The CLI gets this from an external test run (`ddd verify --results
results.json`); the runtime doesn't run the suites itself. In the playground the
agent has no way to produce `results.json`: the sandbox can't yet boot the
generated backend and execute its emitted `test`/`test e2e` suites in-browser.
That runner is M-T8.6's Phase 3 (API test runner) / Phase 4 (UI driver). Until it
exists, a `loom_verify` tool could only ever join against an empty result set and
report "unverified" for everything — worse than absent, because it implies a
capability that isn't there.

So the honest sequencing is: **runner first, then the tool falls out cheaply.**

## Proposed surface

Once the runner produces a results JSON in the same shape `ddd verify --results`
consumes:

```
loom_verify(source, results) → VerificationReport
```

- **Input:** the `.ddd` `source` (to rebuild the requirements/traceability graph)
  and the `results` JSON (from the sandbox runner).
- **Output:** a `VerificationReport` wire shape — per-requirement `{ id, status:
  met | unmet | partial, coveringTests, gaps }` plus a rollup — mirroring the
  `.loom/verification.json` artifact, added to `src/diagnostics/contract.ts`.
- **Home:** a browser-safe function in `src/api/` (like `readModel` /
  `listPrimitives`) over the pure `src/verify/` core, then a `loom_verify` entry
  in the shared `src/tools/` catalog — so the MCP server and the playground chat
  both get it for free (D-AGENT-TOOLS).

The agent flow becomes: author → `loom_validate` → (repair) → `loom_generate` →
**run the suites (sandbox)** → `loom_verify(source, results)` → report which
requirements are met and which have gaps → optionally author more tests / fix the
gap → repeat.

## Build plan

1. **(Prerequisite, M-T8.6)** the sandbox test-runner: boot the generated backend
   in-browser (the behavioral tier already boots Hono on PGlite —
   `web/src/testing/*`, `web/src/runtime/ddl.ts`), run the emitted api + unit
   suites, capture a results JSON.
2. `verify()` in `src/api/` — wrap `src/verify/` over `{ source, results }`,
   returning the `VerificationReport` contract shape.
3. `loom_verify` catalog entry (`src/tools/catalog.ts`) + the MCP tool-list pin
   (`test/mcp/server.test.ts`) + a catalog test (`test/tools/catalog.test.ts`).
4. Surface verdicts in the chat (a verdict card, like the tool-call cards) and,
   later, feed unmet requirements back as the next authoring goal.

## Open questions

- **Results format** — reuse the exact `ddd verify --results` JSON schema so the
  CLI and the browser share one shape (preferred), or a runner-native shape
  adapted at the boundary?
- **Where tests run** — in-browser PGlite (fast, no docker, matches the
  behavioral tier) vs an external process the playground can't reach. In-browser
  is the only self-contained option and is the M-T8.6 direction.
- **How the agent triggers a run** — an explicit `loom_run_tests` tool, or does
  `loom_verify` internally drive the runner? Keeping run and verify as separate
  tools mirrors the CLI split (`verify` gates the exit code; it does NOT run the
  suites itself) and keeps `loom_verify` pure.
- **Partial results** — a run that boots but fails to execute some suites: verify
  must distinguish "requirement unmet" from "requirement untested", which the
  `src/verify/` core already models.

## Related

- [`ai-authoring-loop.md`](./ai-authoring-loop.md) — the `validate → repair →
  verify` loop this completes.
- [`playground-sandbox-redesign.md`](../plans/playground-sandbox-redesign.md) —
  the runner prerequisite (M-T8.6).
- `docs/verify.md` — the shipped `ddd verify` semantics.
- Live mission: [`docs/new-plan/T8-dx-tooling-ai.md`](../../new-plan/T8-dx-tooling-ai.md) M-T8.3.
