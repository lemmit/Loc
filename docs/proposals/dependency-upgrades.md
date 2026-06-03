# Dependency upgrades — pending work & audit status

> **Status:** NOTE / backlog. Captures the deferred dependency upgrades and the
> current `npm audit` picture so the next person doesn't re-derive it. Nothing
> here is urgent — everything outstanding is **build/dev-time only**; none of it
> ships in the MCP server runtime or in generated apps.

## TL;DR

| Dep | Now | Latest | Status |
|---|---|---|---|
| `vitest` / `@vitest/coverage-v8` | **4.1** | 4.1 | ✅ done (#951) — bumped 2→4, cleared both critical advisories |
| `langium` / `langium-cli` | 3.3 | 4.2 | ⬜ **deferred** — foundational major; clears the remaining audit items |
| `lodash-es` | 4.17.21 | 4.17.21 (EOL) | ⬜ blocked on langium 4 (no patched lodash exists) |

`npm audit` went **14 → 8** with the vitest bump. The remaining **8 (3 high, 5
moderate)** all come through `chevrotain → langium → langium-cli` and only clear
with the langium 4 migration below.

## Why the remaining 8 can't be `audit fix`-ed

- The highs are **lodash** advisories (`_.template` code injection,
  `_.unset`/`_.omit` prototype pollution). `lodash-es@4.17.21` is already the
  **newest** release — lodash is effectively EOL and these advisories have **no
  patched version**. An `overrides` pin can't help (there is nothing newer to
  pin to).
- lodash is a transitive dep of **chevrotain** (used during grammar
  processing), which Langium pulls in. So the only way to drop it is for
  Langium/chevrotain to stop depending on it — i.e. upgrade Langium to a major
  that did so (4.x).
- All of it runs at **`langium:generate` / parse time**, never at runtime in a
  generated backend or the MCP server. Real-world exploitability in this repo's
  usage is negligible.

`npm audit fix --force` would force the langium 3→4 bump (below) *and* re-apply
the vitest bump in one shot — which is why we don't run it blind.

## The deferred upgrade: Langium 3.3 → 4.2

This is the one real piece of pending work. It's a **foundational** bump — the
parser, AST types, scoping, validation registry, and LSP service wiring all sit
on Langium — so it is a deliberate, separately-planned migration with its own
testing, **not** an audit-fix slip-in.

What it would touch / things to check when it's scheduled:

- **`npm run langium:generate`** output (`src/language/generated/`) — the AST /
  reflection / grammar emit shape may change; regenerate and eyeball the diff.
  `langium-generated.yml` gates determinism.
- **Service container API** (`src/language/ddd-module.ts`) — `createDddServices`,
  the module/shared-module split, and any `inject`/override signatures.
- **Scope + linking** (`src/language/ddd-scope.ts`) — the custom scope provider
  is the most likely breakage point (Loom's cross-aggregate constraint rides on
  it).
- **Validation registry** (`src/language/validators/*`) — `ValidationChecks` /
  `registerValidationChecks` signatures.
- **LSP providers** (`src/language/lsp/*`) — base-class method signatures
  (`DefaultRenameProvider`, `AstNodeHoverProvider`, `DefaultReferencesProvider`,
  etc.) the navigational toolkit leans on.
- **Reflection helpers** (`AstUtils`, `GrammarUtils`, `CstUtils`) — import paths
  / names occasionally move across Langium majors.
- **`langium/test`** helpers (`parseDocument`, `expectFindReferences`,
  `expectHover`) used across `test/language/lsp/*`.

Suggested approach: a dedicated branch, `langium:generate` + `tsc -b` first to
surface the API breaks, then walk the suite. Expect the bulk of the churn to be
mechanical (import moves, signature tweaks) plus a careful pass on the scope
provider. **Gate: the full `npm test` suite + `langium-generated.yml`
determinism must stay green.** When it lands, `npm audit` should reach **0** (it
drops the chevrotain/lodash chain).

## Other notes

- **`engines.node`** is now `>=20` (vitest 4's floor; CI runs Node 22). Keep
  these aligned on future tooling bumps.
- **`@modelcontextprotocol/sdk`** (`packages/ddd-mcp`) is current and clean — it
  contributed **zero** audit findings. (Earlier session notes wrongly blamed it;
  the warnings were always the langium/vitest stacks.)
- **`vite`/`esbuild`** are transitive under vitest now; the vitest 4 bump pulled
  fixed versions. No direct dependency to manage.
