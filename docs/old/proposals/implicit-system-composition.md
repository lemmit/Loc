# Implicit system composition — top-level domain members across files

> **Status:** PARTIAL — Tiers 1 & 2 shipped. Every system-scoped member —
> `subdomain` / `context` (Tier 1) and the deployment shape `deployable` /
> `storage` / `resource` / `channelSource` / `ui` / `theme` / `user` / `api`
> / `layout` / `test e2e` (Tier 2) — may be declared at the top level of any
> `.ddd` file in the import graph; `lowerProject` composes them all into the
> project's single `system`. A project can be split file-per-subdomain with
> the deployment in its own file. Implementation: `lowerProject` /
> `lowerSystem(sys, extraMembers)` in `src/ir/lower/lower.ts`, grammar
> `ModelMember += Subdomain | … | TestE2E`, validator
> `loom.top-level-domain-needs-single-system`. Gate:
> `test/language/parsing/top-level-subdomain.test.ts`. The Acme ERP example
> is split onto it (`main.ddd` = `system AcmeErp { user theme }`; subdomains
> + `deploy.ddd` are top-level).

## Problem

Stage A of [`../plans/multi-file-source.md`](../plans/multi-file-source.md)
states the goal as *"one system per project, **contexts in their own
files**, shared value-objects / enums at the root level."* Only the
shared-types half shipped. The domain half is blocked by two things:

1. **`subdomain` / `ui` / `deployable` / … are `SystemMember`-only** in
   the grammar, so they cannot appear at a file's top level. A bare
   `context` parses at top level but lowers into the legacy *loose
   contexts* bucket (`RawLoomModel.contexts`), which the orchestrator
   never hosts — `collectContextsFor` (`src/system/index.ts`) reads
   `sys.subdomains` only.
2. **Nothing composes a single project system across files.** Multiple
   `system { }` blocks `flatMap` into multiple *independent* generated
   trees; there is no fold.

The practical cost: the whole domain of a system must live in one file.
The Acme ERP example's `main.ddd` is ~1.1k lines for this reason.

`system { }` is doing two unrelated jobs — (a) naming + holding the
system singletons (`theme`, `user`), and (b) being a syntactic container
for the domain. Job (b) is pure boilerplate for the common single-system
project.

## Proposed surface

A project composes into **exactly one** system. Its name and singletons
come from a single `system Name { … }` block; the domain and (Tier 2)
the deployment may be written at the top level of *any* file and are
folded into that system.

```
main.ddd     system AcmeErp { theme {…} user {…}
                  storage primary { type: postgres }
                  resource salesState { for: Sales, kind: state, use: primary }
                  deployable coreApi { platform: node, contexts: [Sales, Inventory] … }
                  ui BackOffice with scaffold(subdomains: [Sales, Inventory]) { … } }
sales.ddd       subdomain Sales { context Sales { … } }
inventory.ddd   subdomain Inventory { context Inventory { … } }
governance.ddd  requirement / solution / testCase
shared/*.ddd    valueobject / enum / component   (already supported)
```

Cross-file references already resolve through Langium's global scope
(`deployable … contexts: [Sales]`, `resource … for: Sales`, `test e2e …
against coreApi`), so the only missing machinery is the **fold**.

### Resolution rule (one project = one system)

| `system { }` blocks in the import graph | Top-level `subdomain`/`context` |
|---|---|
| exactly **1** | folded into that system |
| **0** | legacy loose-context mode (today's behaviour) — top-level `subdomain` is an error (`loom.top-level-domain-needs-single-system`) |
| **>1** | true multi-system project: top-level domain members are ambiguous → error; nest them explicitly |

## Lowering semantics

The fold happens at the **AST level, pre-lowering**, so the existing
`user`/`permissions` threading in `lowerSystem` is reused verbatim — a
top-level `subdomain` is lowered through the same path as a nested one,
with the project system's `user` block in scope. This is the crux: an IR-
level fold would lower sibling-file subdomains *before* the `user` block
(declared in another file) is known, leaving `currentUser` unresolved.

- `composeProject(models)` scans every document for the lone `System`
  node and every top-level `Subdomain` / `BoundedContext` node.
- `lowerSystem(sys, extraDomainMembers)` folds the sibling-file members
  in alongside `sys.members`; the `user` pre-pass already runs first.
- `lowerProject(models)` = compose + lower + merge the non-domain
  top-level members (VOs / enums / components / requirements). The multi-
  file entry points (`cli/main.ts`, `web/src/build/build.worker.ts`, the
  playground loader) call it; `lowerModel(model)` composes the single-
  document case so single-file callers are unchanged.

No target-IR or orchestrator change is needed: once every subdomain lands
in the one `SystemIR.subdomains`, `collectContextsFor` works as-is.

## Validation

- `loom.top-level-domain-needs-single-system` — a top-level `subdomain`
  with zero or many `system` blocks in the project.
- Existing duplicate-name checks (subdomain, context, deployable) already
  span the workspace via the index; they apply unchanged.

## Tier 2 (SHIPPED)

The remaining `SystemMember`s (`deployable`, `storage`, `resource`,
`channelSource`, `ui`, `theme`, `user`, `api`, `layout`, `test e2e`) are
also `ModelMember`s and fold the same way, so the *deployment* can live in
its own `deploy.ddd`. `lowerSystem` takes a generalised
`extraMembers: SystemMember[]` and runs every member-kind pass over
`[...sys.members, ...extraMembers]`, so a top-level `user` / `theme` is
picked up by the same pre-pass, a top-level `deployable` by the same
deployable pass, etc. The composition validator fires for any top-level
foldable member (not just `subdomain`); a bare top-level `context` stays
exempt (legacy loose-context mode with zero systems).

> **`user` / `theme` are singletons.** A composed (single-system) project
> admits at most one `user { }` and one `theme { }`, wherever in the import
> graph they are written (nested in the system or top-level).  A second one
> is rejected — `loom.duplicate-user-block` / `loom.duplicate-theme-block`
> (`checkProjectSingletons`).  Multi-system projects are out of scope (each
> system carries its own singletons).

## Open questions

- **Zero-system synthesis.** Should a project with top-level domain +
  deployment but *no* `system Name` synthesise one (name from the entry
  file)? Tier 1 says no (keep an explicit `system Name` for the docker-
  compose project name); revisit with Tier 2.
- **`ui … with scaffold(subdomains: [...])`** referencing a subdomain in
  another file already resolves by name; no change, but worth a gate test
  once Tier 2 moves `ui` out of the system block.
