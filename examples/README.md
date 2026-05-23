# `examples/` — test-fixture DSL inputs

These `.ddd` files are the **stable source inputs consumed by the test
suite, the CLI smoke scripts, and the reference docs**. They are wired
into ~40 references across `test/`, `.github/workflows/`, `web/scripts/`,
and `docs/`. Treat them as fixtures: keep them stable and minimal, and do
not edit them for demo or marketing reasons.

| File | Primary consumers |
|---|---|
| `acme.ddd` | generator/system/IR tests, `phoenix-build.yml`, `generated-react-build.yml`, parsing, capture-baseline |
| `acme-order-explicit.ddd` | `order-explicit-equivalence`, `scaffold-expander` |
| `acme.md` | `README.md` (prose companion to `acme.ddd`) |
| `sales.ddd` | `generator-ts` tests, `smoke-runtime.mjs`, npm mirror |
| `banking.ddd` | generator tests |
| `inventory.ddd` | generator tests |
| `roster.ddd` | `generated-build` (TS tsc + tsup); minimal fixture covering `Id<X>[]` join tables and `this.<refColl>.contains(...)` queries |
| `sales-ui.ddd` | `docs/page-metamodel.md` |
| `provenance.ddd` | `docs/language.md` |

**Showcase / playground examples live elsewhere** — under
`web/src/examples/`, curated for breadth and surfaced in the playground
dropdown. The two sets are intentionally disjoint; nothing here should be
duplicated there.
