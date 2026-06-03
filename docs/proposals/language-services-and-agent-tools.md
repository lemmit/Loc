# Language-services follow-ups — rename bugs, coverage gaps, fix-hint expansion

> **Status:** PROPOSED.
> **Role:** Narrow follow-ups on the shipped LSP / editor-adapter work
> ([D-API-TOOLKIT](../decisions.md#d-api-toolkit--one-transport-neutral-toolkit-core-thin-adapters-per-surface)
> slices 5–6 — `src/api/lsp.ts`, `src/language/model-patch.ts`,
> `src/language/fix-hints.ts`, and the `loom.bare-aggregate-in-type`
> quick-fix wired into `DddCodeActionProvider`). Three asks: **(1)** fix
> the silent rename correctness bug for `Operation`, **(2)** close the
> worst test-coverage holes in the language services (rename, references,
> semantic tokens), **(3)** add the next round of `fixHint` providers so
> they ride the existing `fixHintCodeActions` adapter into both Monaco
> and VS Code without per-code provider code.
> **Out of scope:** the agent-tool / MCP surface — already specified by
> [`agent-tools-and-mcp.md`](./agent-tools-and-mcp.md) and grounded on the
> shipped `src/api/` toolkit. This proposal is purely about the
> *language-side* providers and the per-code fix-hint registry that feeds
> them.

---

## 1. The rename bug

`Operation` is missing from `isRenameableMember` in
`src/language/lsp/member-refs.ts:55`:

```ts
return t === "Property" || t === "Containment" || t === "DerivedProp" || t === "FunctionDecl";
```

Consequence: renaming an `operation close()` declaration goes through
`DefaultRenameProvider.rename()` (the index-driven cross-ref path), which
rewrites the declaration token but *not* the `order.close()` call sites
— those are `MemberSuffix` member tokens, invisible to the index. The
user sees the declaration renamed and the calls left dangling, then a
flood of "unknown member" errors on next validate.

No test catches it because `test/language/lsp/lsp-rename.test.ts` covers
only Property in three positions and Aggregate in the cross-ref path.

**Fix.** Add `Operation` to `isRenameableMember`. `collectMemberUsages`
already handles the `MemberSuffix` arm uniformly — verify with a test
that exercises declaration-rename → call-site rewrite.

---

## 2. Coverage gaps — what's untested today

Provider tally as of `origin/main` (post slice 6):

| Provider | LOC | Tests | Worst gap |
|---|---|---|---|
| `ddd-rename.ts` + `member-refs.ts` | 85 + 207 | 4 | Operation rename broken (§1); cross-ref rename tested only for Aggregate; no `prepareRename`, no shadowing, no multi-file. |
| `ddd-references.ts` | 60 | 3 | DerivedProp, FunctionDecl, assignment targets, shadowing, multi-file — all unverified despite being in scope of `collectMemberUsages`. |
| `ddd-semantic-tokens.ts` | 93 | 1 | Operations, repositories, events, entity-parts, containments, chained access, method-vs-property, cross-refs — none exercised. The single test covers 8 ranges. |
| `ddd-hover.ts` | 209 | 10 | Unresolved refs silently render `?` (lines 142, 168). |
| `ddd-completion.ts` | 221 | 9 | Enum value completion broken in chains (`this.statusField.<here>`); no `with <macro>` argument-name completion; no `platform:` value completion. |
| `ddd-signature-help.ts` | 101 | 3 | No operation calls; `activeParam` can misfire on malformed arg CST. |
| `ddd-node-kind.ts` | 88 | 0 | `Deployable → Constructor` is semantically wrong (Constructor implies instantiation; a deployable is a module). |
| `ddd-definition.ts` | 71 | 11 | Solid. |
| `ddd-code-actions.ts` | 93 | 2 | `loom.bare-aggregate-in-type` (slice 6) + `loom.framework-mismatch` (older) + `Unfold macro` refactor. New fixes now ride `fix-hints.ts`, not this file (§3). |

### Tests to add (minimum)

1. **Rename — operation declaration → call sites.** Pins the §1 fix.
2. **Rename — cross-ref categories.** One test per category: module,
   enum (decl + each value), event, repository, deployable,
   value-object-by-name, function-by-bare-call. Each catches a distinct
   index-vs-token gap in `DefaultRenameProvider`.
3. **Rename — multi-file.** Two `.ddd` documents; rename an aggregate
   in file 1, assert every `X id` in file 2 is rewritten. Currently
   unverified despite being the prototypical case.
4. **Rename — `prepareRename` range.** Assert the returned range is
   exactly the identifier token.
5. **Rename — shadowing.** Property `total`; lambda `(total) => …`
   nested in an operation body. Rename the property; assert the lambda
   param is untouched. Exercises `localShadows`
   (`member-refs.ts:124-152`), currently dead code as far as tests are
   concerned.
6. **References — derived / function / assignment / shadowing /
   multi-file.** Symmetric with rename; share fixtures.
7. **SemanticTokens — one test per node kind plus chained access.**
   Bring coverage from 1 → ~12 cases. The lowest-coverage provider by a
   wide margin.
8. **Hover failure path.** Render unresolved refs as `«unresolved»` (or
   similar) instead of `?`; pin with one test.

---

## 3. Fix-hint expansion — feed the existing adapter

The shipped architecture (slice 6) is: each entry in
`src/language/fix-hints.ts` `PROVIDERS` produces a `JsonFixHint` (a
`ModelPatch`); `fixHintCodeActions` in `src/api/lsp.ts` turns them into
LSP `CodeAction`s automatically. Adding a quick-fix is now **one entry
in the providers map**, not a new switch arm in
`DddCodeActionProvider` — and the same hint flows to the agent loop
through the JSON contract for free.

Today `PROVIDERS` has one entry (`loom.bare-aggregate-in-type`). Next
batch, ranked by effort:

| Diagnostic code | Patch shape | Effort |
|---|---|---|
| `loom.reserved-derived-on-vo` | Strip the `derived` keyword from the member declaration. | trivial |
| `loom.seed-id-needs-raw` | Insert `raw` modifier. | trivial |
| `loom.es-tph-forced-own-table` | Remove the offending modifier from the aggregate header. | trivial |
| `loom.legacy-part-call` / `loom.legacy-vo-call` | Rewrite to modern form (the diagnostic message already implies the rewrite). | small |
| `loom.criterion-arity` | Stub missing arg with `_` placeholder. | small |
| `loom.react-deployable-missing-ui` | When exactly one `ui` is in scope, insert `ui: <name>` on the deployable header. | small — needs single-candidate scope lookup |

Each entry follows the `loom.bare-aggregate-in-type` pattern in
`src/language/fix-hints.ts:42-58`: locate the enclosing member, address
it via `addressOf`, build the replacement source, emit a
`{ op: "replace", target, source }` patch. Test via
`test/language/fix-hints.test.ts` (model-level) and
`test/api/lsp.test.ts` (editor-level round-trip).

The two legacy `DddCodeActionProvider` cases that *don't* fit the
fix-hint model stay where they are:

- **`loom.framework-mismatch`** — single-token replace; predates the
  fix-hint registry. Could migrate for consistency, low priority.
- **`Unfold macro`** — refactor (not a quick-fix), no diagnostic; stays
  in the provider.

---

## 4. New refactor — `Fold to macro`

Inverse of the shipped `Unfold macro`. If a sequence of members on an
aggregate / context matches a registered macro's expansion (`softDelete`,
`auditable`), offer collapsing them back into a `with X(...)` clause.
Reuses the structural printer + roundtrip gate already guarding
`Unfold`. Detection via structural equality on the unfolded form,
opt-in per macro (a `foldable: true` tag on the macro definition so
users don't see folds offered for macros that don't roundtrip cleanly).

This is the one *new* refactor the proposal asks for; everything else
is fixes or test coverage on existing surfaces.

---

## 5. Build plan

Three independently shippable slices, in order:

**S1 — Rename bug + minimum rename coverage** (highest priority).
§1 fix + tests 1, 4, 5 from §2. Single narrow PR. Wedges the silent
correctness bug before it bites a user.

**S2 — Coverage push.** Tests 2, 3, 6, 7, 8 from §2. Independent of S1
but easier to land second so the rename fixture from S1 is available
to reuse.

**S3 — Fix-hint batch.** Two or three entries from §3 per PR; each one
is one provider + one fix-hints test + one LSP test. The fold-to-macro
refactor (§4) is a separate PR — different machinery (printer-driven,
not patch-driven).

---

## 6. Non-goals

- **No new LSP capability.** Code lens, inlay hints, document
  highlight, document symbol, workspace symbol — all out of scope.
- **No new agent-tool surface.** Covered by
  [`agent-tools-and-mcp.md`](./agent-tools-and-mcp.md). The fix-hints
  added in §3 ride that catalog automatically (they're already in the
  `loom_validate` report's `diagnostics[].fixHint`).
- **No formatter.** The structural printer exists for unfold/fold; a
  full-document formatter is a separate question.
- **No `DddCodeActionProvider` redesign.** Slice 6 settled the
  per-code-switch-arm question by routing fixes through `fix-hints.ts`
  + the adapter. Only legacy entries and refactors stay in the
  provider.
