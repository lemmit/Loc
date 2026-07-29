# Playground modeller audit — 2026-07-29

> **Status note:** the Part-1 upgrade needs and the *visibility* half of the
> Part-2 gaps (read-only rendering + authz badges + workflow member picker)
> were addressed on this same branch (PR #2290) immediately after this
> audit. Part 3's wave-4 items — full *editing* surfaces for the newly
> visible constructs, property modifiers, operation params/gates, and the
> UI-level surface — remain open follow-on missions. The findings below are
> the pre-fix snapshot.

Snapshot-in-time audit of the browser playground's visual builders
(`web/src/builder/`) against the language surface on `main` @ `2f5deb8`.
Four surfaces were audited: the page builder (`builder/page/`), the two
model builders (`builder/system/` v1 flat graph + inspector,
`builder/system-v2/` drill-down graph), and the requirements pane
(`builder/requirements/`). Every claim below carries a file reference;
the load-bearing ones were re-verified by hand against the source.

Two questions drove the audit: **what needs upgrading** (drift and bugs in
what the modeller already does) and **what are the gaps** (language
constructs that cannot be seen or edited visually at all).

One reassuring negative first: the modeller emits **no removed syntax**.
All add-templates use the current colon forms (`platform: node`,
`type: postgres`); nothing emits `persistedAs(...)` parens, `module`,
`view`, or a `scaffold` declaration. The recently reverted
`write(...)`/`readonly when` field gates (#2254 → reverted #2257) never
reached the modeller, so there is nothing to rip out. And the i18n/a11y
work (M-T1.11 etc.) added **no grammar surface** — extraction, validators,
and runtime only — so it demands nothing from the modeller.

---

## Part 1 — Upgrade needs (drift/bugs in existing capability)

### 1.1 v1 graph never renders context nodes (bug)

`NodeKind` declares `"context"`, `COLUMN_ORDER` reserves a column for it,
and `NODE_KIND_TO_REF` maps it — but the first-pass switch in
`web/src/builder/system/model.ts:119-131` has **no `case "BoundedContext"`**.
Context nodes are never created, and the `deployable → context` edges
derived at `model.ts:160` are silently dropped by the `has()` guard at
`:136`. Verified by hand. Smallest, highest-confidence fix in this audit.

### 1.2 Whole-construct reprints drop comments and formatting

`builder/edit-engine.ts:3-10` promises "everything outside — comments,
blank lines, hand-spacing — is byte-preserved". That contract only holds
*outside* the spliced node. Five mutators reprint the **whole construct**
via `printStructural` — `fields.ts:209-216` (whole aggregate/VO/event on
any field add/delete/retype), `infra-props.ts:26-34`, `find-params.ts:70-78`
(whole repository), `deployable-bindings.ts:67-78` (whole deployable),
`page/state-fields.ts:94-96` — and `src/language/print/print-structural.ts`
has **zero comment handling**. Adding one field to an aggregate deletes
every `//` and `/* */` comment inside it and re-canonicalises the layout.
Related: `printSubdomain` (`print-structural.ts:299-308`) reorders
`permissions` blocks ahead of `contexts` regardless of source order.

### 1.3 Field retype silently drops generic ctors and unions

`buildTypeRef` in `fields.ts:157-158` hardcodes `ctors: []` and
`alternatives: []`. Retyping a field whose type used `paged` / `envelope`
/ `option` or an anonymous union (`A or B`) **silently loses** that part
of the type. (Untouched fields are safe — their `TypeRef` object is
reused.) The type picker also cannot *express* any of these forms, nor
`Self id`, `slot`, `action(...)`, or entity part types.

### 1.4 `setDeployableUi` destroys the compose-block `ui:` form

`deployable-bindings.ts:100` unconditionally sets `d.uiCompose = undefined`,
converting a `ui: W { … }` compose binding into the sugar form. The picker
is hidden for compose bindings (`uiKind`, `:55-60`) but the setter is still
reachable and lossy.

### 1.5 `fields.ts` commit skips the output re-parse guard

Unlike its siblings (`infra-props.ts:33`, `find-params.ts`,
`deployable-bindings.ts:77`), `commit` in `fields.ts:209-216` does not
re-parse the spliced output before returning it. Verified by hand. Low
risk (the input is parse-guarded and the output is printer-produced), but
it is the one strategy-(b) mutator that can hand back a broken file.

### 1.6 Page builder: 14 of 55 walker primitives collapse to opaque blobs

`page/model.ts` `SPECS` knows 41 primitives; the current stdlib
(`src/util/walker-primitive-names.ts`) has 53 layout + 2 sub = 55.
Missing (verified by grep — none of these names appear in `page/model.ts`):

> `Section`, `Sticky`, `MultilineField`, `SelectField`, `FileUpload`,
> `Bold`, `Italic`, `InlineCode`, `FileLink`, `ProvenanceInfo`,
> `CodeBlock`, `Icon`, `DestroyForm`, `For`

Each renders as a dimmed un-editable `Opaque` box. The costly ones:

- **`For`** — the comprehension container: an entire list-render subtree
  becomes one text blob.
- **`DestroyForm`** — the fourth form primitive; the other three
  (`CreateForm`/`OperationForm`/`WorkflowForm`) are supported.
- **`FileUpload`/`FileLink`** — the M-T1.2 `File` feature (landed across
  all five backends + six frontends) has zero page-builder presence.
- **`SelectField`/`MultilineField`** — everyday form fields.

Also: the recent M-T1.1 `Table`/`Column`/`QueryView` args (`sortKey:`,
`sortDir:`, `page:`, `pageSize:`, `filter:`, `serverPaged:`,
`Column(sortable:, field:)`, `QueryView(paged:)`) survive round-trips via
the passthrough-props mechanism (`model.ts:303-310`) but have no
structured editing. And `SUB_PRIMITIVES` (`Tab`, `Column`, `QueryView`,
`Modal`) are editable but absent from the add palette (`model.ts:175-176`).

### 1.7 Statement editor: 2 of 9 statement forms are structured

`body.ts:96-125` structures only `assign` and `call`/`emit` rows;
`ForStmt`, `IfLetStmt`, `MatchStmt`, `ReturnStmt` all fall to a verbatim
text row (`StmtNode.tsx:42-48` tints `precondition`/`requires`/`let` by
leading-keyword sniffing only). The effect-form `match` statement is now
load-bearing (variant unions, `match await` in actions) and deserves
structuring; `for`/`if let`/`return` follow.

### 1.8 Expression editor: 10 of 20 grammar alternatives are raw text

Structured: binary/unary/paren/lit/call/member/lambda/blockLambda/ternary/
match/builder/object. Raw (opaque `printExpr` text leaf): `TemplateStr`,
`ListLit`, `MoneyLit`, `NowExpr`, `AwaitExpr`, `PrimitiveConversion`,
`RetrievalLiteral`, `IdRef`, `NameRef`, `ThisRef` (`expr-model.ts:69-109`).
The first seven are genuine authoring surfaces (template strings and
list literals especially).

### 1.9 Workflow bodies: only the primary `create` is editable

`body.ts:47-68` resolves a workflow body to
`creates.find(c => !c.name) ?? creates[0]` only. Statements inside
`handle` / `on` / `apply` members are invisible to the editor — while
`context-edges.ts:37-45` *does* traverse them for edge derivation, so v2
draws edges into bodies the user cannot open. Three independent copies of
the "primary create" lookup exist (`body.ts:56-57`, `emit-event.ts:14-17`,
`expr-slots.ts:183-189`) — consolidate when fixing.

### 1.10 Future-drift trap: `printStructural` throws on unknown members

`print-structural.ts:288-289` throws on an unhandled member type. Today
the switch is complete, but the strategy-(b) mutators (1.2) reprint whole
constructs — so the next grammar member added without a printer arm makes
a field-add **throw inside the browser**. (The printer itself is pinned by
`print-completeness.test.ts`; the risk is the window between grammar and
printer landing, and any builder-local emitters — `page/model.ts emitBody`,
`expr-model.ts emitExpr`, `requirements/printers.ts` — which are
hand-mirrored and *not* pinned by any completeness test.)

### 1.11 Minor defects

- `system/model.ts:212-241` — duplicate `case "action"` in `typeLabel`;
  second arm unreachable.
- `view-graph.ts:909-938` — `findEntityPart` takes the first name match
  across all aggregates (collision hazard acknowledged in the comment).
- `SystemBuilderV2Pane.tsx:610-620` — containment nodes get rename but
  no delete; no containment add or retype exists either.
- Deletion (`spliceNode(…, "")`) never cleans up dangling references.

---

## Part 2 — Gaps: constructs with no visual presence at all

Verified by `$type`-string absence across `web/src/builder/`. Grouped by
how much recent language investment they represent.

### 2.1 The authorization layer (highest-value gap)

The entire authz surface — the largest recent language investment — has
**zero** modeller presence:

- `permissions { … }` blocks, including the brand-new
  `permission X implies Y` / `implies [A, B]` closure (#2240, 2026-07-27).
- `policy { … }` read ladders — `allow [write] local|deep|global on Agg`
  and the new negative-authz `deny [write] on Agg` rules (runtime-gated
  in #2259).
- `policy Name(params): bool` named policy functions.
- `requires <expr>` gates: not editable on operations, finds, workflows
  `create`/`handle`, or pages (the find inspector edits params and the
  `where` filter, but not the `requires` ladder; the operation inspector
  edits neither `requires` nor `when`).
- `mask unless <expr>` on properties — shipped across all five backends
  this window; the field editor is name+type only, so masks are preserved
  on reprint but invisible and uneditable.
- `AuthBlock` (`auth { oidc { … } }`), `UserBlock`, `TenancyDecl`.

### 2.2 Aggregate members and modifiers

- `create` / `destroy` / `apply` — entirely absent (no render, no edit).
- `with X` capability clauses — never surfaced (preserved by reprint
  only). That hides `auditable`, `softDeletable`, `tenantOwned`,
  `tenantRegistry`, `versioned` *and* every scaffold macro
  (`with scaffold(...)`, `crudish`, `softDelete`) from the visual surface.
- `unique (a, b)`, `filter <expr>`, `stamp onCreate|onUpdate`,
  `implements X`, in-aggregate `test` blocks — absent.
- Header modifiers: `abstract`, `extends Base`, `crossTenant`,
  `persistedAs:`, `shape:`, `inheritanceUsing:` — not editable.
- Property modifiers: `check <expr> [message]`, `sensitive(...)`,
  `provenanced`, access modifiers (`immutable`/`managed`/`token`/
  `internal`/`secret`), defaults (`= expr`) — not editable (preserved on
  reprint).
- `EntityPart` is reachable only by drilling a containment; cannot be
  added, and containments themselves cannot be added, deleted, or retyped.
- Operation `params`, return type, `private`, `extern`, `audited` — not
  editable.

### 2.3 Context-level declarations

No node, no add, no edit for: **`Projection`** (including the new
query-time `from`/`join`/`select` clauses, landed across all five
backends), **`DomainService`**, **`Channel`**, **`Criterion`**,
**`Retrieval`**, **`PayloadDecl`** (payload/command/query/response/error
records and discriminated unions), **`CommandHandler`/`QueryHandler`**,
**`Seed`**, **`EnumDecl`** (read as a type-option source only — never a
node, no way to add/edit cases), `FilterDecl`/`StampDecl`/
`ImplementsDecl` at context scope, and context-level `test` blocks.

### 2.4 System-level declarations

Absent: `Resource` (objectStore/queue/api/mailer bindings + `IndexSpec`),
`ChannelSource`, **`TimerSource`** (cron/`every 15s` — the `DURATION`
surface), **`Migration` blocks** (the M-T2 rename/backfill/table-rename
data-evolution ledger), `Capability` declarations, `Layout`, `ThemeBlock`,
`TestE2E`, top-level `FunctionDecl`, `Component` at model scope.

### 2.5 UI surface beyond the page body

The page builder edits `body:` and `state { }` only. No visual surface
for: `Store` (+ `persist:`), `Area` nesting, `MenuBlock` / per-page
`menu { }` meta, `UiNotification` (`on Channel.Event`), `UiApiParam` /
`UiChannelParam`, `UiFunction`, page props (`route:`, `title:`,
`requires`, `layout:`, `description:`, `ogImage:`, `canonical:`),
`ActionDecl` handlers (raw statement text inside handler slots only —
`model.ts:395`), and `match await`.

---

## Part 3 — Suggested priority order

1. **Fix the v1 `BoundedContext` bug** (1.1) — one `case` line.
2. **Page-builder primitive catch-up** (1.6) — 14 specs; `For`,
   `DestroyForm`, `FileUpload`, `SelectField`, `MultilineField` first.
   Consider a completeness test pinning `SPECS` against
   `walker-primitive-names.ts` so the next primitive can't land without a
   spec or an explicit pin — same pattern as
   `walker-stdlib-completeness.test.ts`.
3. **Authz-layer visibility** (2.1) — even read-only rendering of
   `permissions`/`policy` blocks and `requires`/`mask` badges on
   operations/finds/fields would make the biggest new language area
   stop being invisible; editing can follow.
4. **Comment-preserving edits** (1.2) — either comment-aware reprint in
   `printStructural` or narrower splices in the five strategy-(b)
   mutators; plus the `fields.ts` re-parse guard (1.5).
5. **Type builder: ctors + unions** (1.3) — at minimum *preserve* on
   retype instead of dropping.
6. **`match`/`for`/`if let`/`return` statement structuring** (1.7) and
   workflow `handle`/`on`/`apply` bodies (1.9).
7. **New-construct nodes in v2** (2.3/2.4) — render `projection`,
   `domainService`, `channel`, `payload`, `criterion`, `timerSource`,
   `migration` as read-only nodes first (the `buildViewGraph` default arm
   at `view-graph.ts:1199-1203` already anticipates "opt-in node-detail
   comes later").

Also noted in passing (out of modeller scope): `CLAUDE.md` still
describes the reverted `write(...)`/`readonly when` write gates as
shipping — stale as of #2257.
