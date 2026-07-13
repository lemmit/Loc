# `with` vs `implements` — one keyword per kind

**Status:** PROPOSED
**Related:** [`capabilities.md`](../../capabilities.md),
[`typed-capabilities.md`](./typed-capabilities.md),
[`scaffold-macros.md`](../../scaffold-macros.md).

## Problem

`with <X>` and `implements <X>` are **synonyms** for capability
application — both resolve through the macro expander's document-wide
inventory and perform the same splice (`ImplementsDecl`, `ddd.langium:1120`;
both handled on one path, `lower-capabilities.ts:100`). Meanwhile `with`
*also* applies macros. So the surface has two spellings for one behavior and
no rule for which to use:

```ddd
aggregate Invoice with tenantOwned { … }
aggregate Invoice implements tenantOwned { … }   // identical result
```

That is a pure "which do I use, do they differ?" surprise with no upside.

## Proposal — assign each keyword to a kind

Give the two keywords **distinct, non-overlapping jobs** by the *kind* of
thing applied:

- **`implements <Capability>`** — capabilities only (the declared
  pure-mixins: `auditable`, `softDeletable`, `tenantOwned`, `versioned`,
  user `capability {}`).
- **`with <Macro>`** — macros only (the AST-emitting functions: `crudish`,
  `softDelete`, `scaffold*`).

This is not arbitrary — it lands on a real semantic axis:

| | `implements` | `with` |
|---|---|---|
| applies | capabilities | macros |
| reads as | **identity** — "is-a" | **procedure** — "built-with" |
| nature | declarative, constrained (fields + `filter` + `stamp`) | imperative, unconstrained (emits anything) |
| carries args | no (pure mixins) | yes (`with scaffold(subdomains: […])`) |
| emits | a marker interface (`class Invoice implements ITenantOwned`) | whatever the macro builds |

`implements tenantOwned` reads like — and *emits as* — a marker interface,
so the keyword mirrors its output. `with crudish` reads as "build this with
these generators." The pairing designed to be used together becomes legible:

```ddd
aggregate Order implements softDeletable with softDelete { … }
//              └─ capability: fields+filter ─┘  └─ macro: behavior ─┘
```

## Before / after

```ddd
// today — synonyms mixed in one `with` (showcase.ddd:356, :424):
aggregate Build with crudish, versioned { … }
aggregate Squad with crudish(updateOnly: true), softDeletable { … }

// after — each keyword owns one kind:
aggregate Build with crudish implements versioned { … }
aggregate Squad with crudish(updateOnly: true) implements softDeletable { … }
```

## Enforcement is almost free

The expander **already** classifies each name (capability vs macro) when it
resolves the inventory. The validator just checks the keyword matches the
kind and emits a fix-it:

- `with tenantOwned` → *"`tenantOwned` is a capability — use `implements`."*
- `implements softDelete` → *"`softDelete` is a macro — use `with`."*

A wrong pairing stops being a silent synonym and becomes a helpful error.

## Grammar

- **`implements`** — allow a comma list so it matches `with`'s ergonomics:
  `implements auditable, tenantOwned` (today `ImplementsDecl` is a single
  `cap=ID`). It stays admissible at both aggregate- and context-member
  position (context-scope propagation is unchanged).
- **`with`** — unchanged shape (a `MacroCall` list), now *validated* to
  resolve only to macros.

## Migration

A mechanical, deterministic codemod: for every name in a `with` clause that
the expander classifies as a **capability**, move it to an `implements`
clause on the same host. No judgment calls — the expander already draws the
line, so the codemod reads its classification.

## Open questions

1. **`implements` position — load-bearing, resolve before implementing.**
   `ImplementsDecl` is a **member** today (`ddd.langium:1120`), inside the
   body. But the headline before/after examples (`aggregate Build with
   crudish implements versioned { … }`) put it as a **header clause** beside
   `with` — which the grammar does **not** admit today. Since that
   left-to-right read is the proposal's ergonomic payoff, the grammar must be
   extended to allow `implements` in header position (a comma-list, like
   `with`), and a Langium-ambiguity check must confirm `with … implements …`
   parses cleanly before the `{`. If header-adjacency turns out ambiguous,
   the proposal falls back to `implements` staying a member — and the
   examples must be rewritten to reflect that. Not a soft "open" item.
2. **Deprecation window** — hard cutover (codemod + validator error), or a
   release where `with <capability>` warns before it errors?
