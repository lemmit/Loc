# Showcase coverage campaign — bug report

Running list of bugs surfaced while driving `examples/showcase.ddd` to 100%
language-feature coverage (see PR #1623 / branch `claude/showcase-parity-ci-0qtvxc`).

**Policy for this campaign:** when extending the showcase surfaces a bug
(a backend that crashes, throws, `# TODO`s, or diverges on valid `.ddd`),
we **record it here and keep going** — we do *not* fix it in this branch.
Each entry is a separate follow-up. Bugs are confirmed by either the local
`generate system` / lower+IR-validate gate, or by the `conformance-full`
behavioural leg (triggered via the `run-conformance` label).

Severity legend: **S1** crash/codegen-throw on valid input · **S2** silent
cross-backend divergence (parity break) · **S3** honest gap (validator
rejects a feature on some target) · **S4** test-infra / measurement.

---

## Confirmed

### BUG-001 — walker-primitive coverage detector measured the wrong AST field — **S4 (fixed in this PR)**

`test/conformance/showcase-completeness.test.ts → invokedNames()` collected
`node.name`, but a UI primitive invocation (`Avatar { "P" }`) parses as a
`BuilderCall` whose name lives on **`type`**, not `name`. So every primitive
was reported uncovered even when used: the guard showed **20/48** covered when
the true figure was **36/48**. Without this fix "100% primitive coverage" is
unmeasurable. Fixed here (the detector now reads `BuilderCall.type`) because
it's the measurement the campaign depends on; logged for the record.

---

## Pending verification (need `conformance-full` / per-backend boot)

_None yet — populated as new features land and the behavioural leg runs._
