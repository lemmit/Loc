# Agent tools & MCP — one catalog, many transports

> **Status:** PARTIAL — the **generative catalog**, the **MCP stdio server**,
> the **full navigational family** (read + rewrite trios), and the
> **transport-neutral agent loop** have shipped (§8 items 1, 2, 4, 5-engine).
> The `src/tools/` catalog now carries ten tools — generative (`loom_validate` /
> `loom_outline` / `loom_generate` / `loom_apply_patch`), read-nav
> (`loom_find_symbol` / `loom_references` / `loom_hover`, #937), and rewrite-nav
> (`loom_rename` / `loom_quickfix` / `loom_unfold_macro`, returning
> `EditResult`s, #940) — over one shared resolver (`src/api/symbol-resolver.ts`);
> `src/mcp/` + the `packages/ddd-mcp` publish wrapper register it over the
> `@modelcontextprotocol/sdk` stdio transport (#934); the provider-neutral agent
> loop (`src/tools/agent-loop.ts`) drives the validate→repair conversation over
> `callTool` (#946). **Remaining:** LSP-provider correctness (§4c) and the
> **playground agentic chat UI** (§8 item 5-UI).
> **Role:** Pins how Loom exposes its operations as **agent-callable tools**:
> a single transport-neutral **tool catalog** over the `src/api/` toolkit, and
> the transports that surface it (an MCP stdio server for external hosts; direct
> / in-memory dispatch for the in-browser playground chat). Build-plan item 6 of
> [`ai-authoring-loop.md`](./ai-authoring-loop.md).
> **Depends on:** the toolkit core
> ([D-API-TOOLKIT](../../decisions.md#d-api-toolkit--one-transport-neutral-toolkit-core-thin-adapters-per-surface))
> and the diagnostics/patch contracts
> ([`ai-diagnostics-contract.md`](./ai-diagnostics-contract.md)).
> **Decision tag:** pins
> [D-AGENT-TOOLS](../../decisions.md#d-agent-tools--one-tool-catalog-over-the-toolkit-mcp-and-in-browser-are-transports).

---

## 1. The question this answers

"Will the MCP server be usable from the playground? Or are tool calls available
if I add an agentic chat in the playground?"

- An **MCP server** speaks **stdio** (a subprocess) or **Streamable HTTP** — it
  serves agents that run *outside* the browser (Claude Desktop, IDE agents, a CI
  agent). A browser can't spawn a stdio subprocess, so the conventional MCP
  server is **not** what the playground runs.
- The playground doesn't need it. The tool *implementations* are the `src/api/`
  toolkit functions, which are browser-safe and already imported by `web/`. An
  in-browser agentic chat dispatches the model's tool calls **directly** to
  those functions.

The risk is hand-coding the tool schemas twice (stdio server + playground) and
letting them drift — the exact mistake the toolkit refactor fixed one layer
down. So the tools get **one definition**, surfaced by thin transports.

## 2. The shape

```
        src/api/   validate · applyPatches · generate · LSP adapters     ← operations (toolkit)
                                   │
        src/tools/   tool CATALOG: { name, description, inputSchema, handler→toolkit }   ← one source of truth, browser-safe
              ┌────────────────────┼─────────────────────────────┐
        stdio MCP server     in-memory / direct            (future) HTTP
        packages/ddd-mcp     playground agentic chat        remote host
        (Node, external)     (browser, same catalog)
```

- **`src/tools/`** — the catalog. Each entry pairs a JSON-schema'd input with a
  handler that calls the toolkit and returns a contract wire shape. **No MCP
  dependency, no Node-only imports** → browser-safe, so every transport reuses
  it verbatim.
- **MCP stdio server** — a tiny Node entrypoint (`@modelcontextprotocol/sdk`)
  that registers the catalog. Ships as `packages/ddd-mcp` so an external host
  runs it via `npx ddd-mcp` (publish-shaped, like the other `packages/`).
- **Playground** — imports the same catalog and dispatches the LLM's `tool_use`
  calls straight to `handler(args)`. Optionally an **in-memory MCP** transport
  (the TS SDK ships one) links an in-browser client+server built from the same
  catalog, so the playground and Claude Desktop run byte-identical tools — but
  direct dispatch is simpler and the default recommendation.

## 3. Tools are pure and stateless (the load-bearing decision)

Every tool is a **pure function of its inputs** — the model `source` goes in,
a report (or new source) comes out. There is **no server-side model state and
no filesystem side effect.** Consequences:

- The **host owns the working model.** The playground (or the agent driver)
  holds the current `.ddd` string and threads it through each call; the loop is
  `validate(source) → read fixHints/diagnostics → applyPatches(source,…) →
  validate(newSource)`.
- The server is **safe by default** — read-only / functional. Nothing writes to
  disk, so no consent prompts, no sandbox concerns. File emission stays in the
  CLI (`generate system -o`), never in a tool.
- Determinism + browser-safety come for free (they're the toolkit's, inherited).

A stateful "session holds the model" design was considered and rejected: it adds
mutable server state, complicates the browser transport, and buys nothing the
host can't do by holding a string.

## 4. The catalog — two verb families

The catalog has two families over the same engine, sharing one address space
(the `outline` dotted addresses from
[`ai-diagnostics-contract.md`](./ai-diagnostics-contract.md) §5) and the
`loom.*` diagnostic vocabulary, so an agent moves between them without
re-resolving anything.

### 4a. Generative verbs (the authoring loop) — v1

Pure functions of `source`; this is the validate→repair→generate loop.

| Tool | Input | Returns | Kind |
|---|---|---|---|
| `loom_validate` | `{ source }` | `ValidateReport` (coded diagnostics + `outline`) | read |
| `loom_apply_patch` | `{ source, patches: ModelPatch[] }` | `PatchResult` (new source or errors) | pure |
| `loom_generate` | `{ source }` | `GenerateReport` (validation + deployable manifest) | read |
| `loom_outline` | `{ source }` | `Outline` (the address book) | read |

### 4b. Navigational verbs (query / refactor)

Folded from a now-superseded parallel proposal (`language-services-and-agent-tools`).
These wrap Loom's **LSP providers** (`src/language/lsp/`) — the navigation,
hover, and rename engine — behind **by-name** addressing instead of
`(line, character)` tuples, because an LLM has a symbol name, not an offset.
Patches *mutate*; these *query and locally rewrite*.

| Tool | Input | Returns | Kind | Status |
|---|---|---|---|---|
| `loom_find_symbol` | `{ source, symbol, kind? }` | `{ address, range, kind, parent? }` \| `NavError` | read | ✅ |
| `loom_references` | `{ source, symbol }` | `{ locations: NavLocation[] }` \| `NavError` | read | ✅ |
| `loom_hover` | `{ source, symbol }` | `{ markdown }` \| `NavError` | read | ✅ |
| `loom_rename` | `{ source, symbol, newName }` | `EditResult` (edits, **not applied**) \| `EditError` | pure | ✅ |
| `loom_quickfix` | `{ source, code, at? }` | `EditResult` for that diagnostic code \| `EditError` | pure | ✅ |
| `loom_unfold_macro` | `{ source, macro, on }` | `EditResult` \| `EditError` | pure | ✅ |

The whole family ships over one **shared resolver** (`src/api/symbol-resolver.ts`,
pure + browser-safe): the read trio in `src/api/navigate.ts`, the rewrite trio
in `src/api/refactor.ts`, all registered in the catalog. `kind` returns the
node's OWN kind (`property` / `operation` / …), not the address keyword
`addressOf` qualifies plain members under, and the same `kind` value is the
disambiguating filter. Only nodes with their own name are addressable — an
unnamed `create`/`destroy`/`invariant` borrows its entity's name as its address
tail, which would otherwise collide with the entity when resolving `Order`. The
rewrite trio RETURNS an `EditResult` (`{ edits, title? }`); the host applies it
(contract §3: tools never touch the buffer). `EditError` covers the non-symbol
failure modes (`no-fix` for a code without a fix-hint, `cannot-unfold`, plus the
macros a host does carry when the requested one is absent).

**Addressing.** `symbol` is a dotted path — short form (`Order.customerId`) when
unambiguous, fully-qualified (`Sales.Orders.Order.customerId`) otherwise. This
is the **same address space** the `outline` and diagnostic `node` use; an
ambiguous symbol returns a structured `{ error: "ambiguous", candidates: [...] }`,
never a silent pick. Resolution reuses the scope/type-system helpers the
providers already use (`envForNode` / `iterateEntityMembers`).

**Edits are returned, not applied** (contract: tools are pure, §3). `loom_rename`
/ `loom_quickfix` / `loom_unfold_macro` return an LSP `WorkspaceEdit` (via the
shipped `resolvePatchEdits` / `fixHintCodeActions` adapters where a `ModelPatch`
backs the fix); the host applies it to the editor buffer or the model string.
No tool touches the filesystem.

**Quick-fixes are `fixHintFor` providers, not bespoke verbs.** New
diagnostic→fix mappings are added once as `src/language/fix-hints.ts` providers
(emitting a `ModelPatch`), which then flow to *both* `loom_quickfix` *and* the
LSP code-action *and* the agent loop — instead of duplicating each fix in the
provider switch and a parallel agent verb. (The `loom.bare-aggregate-in-type`
fix already works this way; PR #879.)

### 4c. LSP-provider correctness + fix-hint expansion

The navigational verbs are only as correct as the providers they wrap. This
workstream (folded from the superseded `language-services-and-agent-tools`
proposal) is **valuable for the editor regardless of the agent surface**, and
gates the corresponding navigational verb. In-tree under `src/language/lsp/` +
`test/language/lsp/`. Three independently shippable slices:

**S1 — the rename correctness bug (highest priority).** `Operation` is missing
from `isRenameableMember` (`src/language/lsp/member-refs.ts:55`, which returns
`Property | Containment | DerivedProp | FunctionDecl`). Renaming an
`operation close()` declaration rewrites the declaration token but **not** the
`order.close()` call sites (they're `MemberSuffix`/`LValue` tokens the index
can't see), so the user gets a renamed declaration and a flood of "unknown
member" errors on next validate. **Fixed** (PR adds `Operation` to
`isRenameableMember` + a declaration-rename→call-site regression test;
`collectMemberUsages` already handles the `MemberSuffix`/`LValue` arms). Two
**known blind spots remain**, general to *all* member renames (not operation-
specific), tracked for S2: **(a)** receivers the type system can't infer — a
workflow `let w = Repo.getById(...)` binding — aren't resolved, so `w.op()`
call sites are missed; **(b)** initiating a rename *from* an `LValue`-shaped
call-site cursor (`a.b := …` / `this.op(...)`) finds no target because
`memberDeclAt` doesn't resolve `LValue` (renaming from the declaration works).

**S2 — coverage push.** The lowest-tested providers, with the worst gaps:

| Provider | Tests | Worst gap | Status |
|---|---|---|---|
| `ddd-semantic-tokens.ts` | 1 → 2 | operations, repositories, events, type-refs, parameters, member-calls, var refs | **covered** (added type-ref / function / parameter / variable / method-decl / member-method / event / repository cases) |
| `ddd-node-kind.ts` | 0 → 1 | `Deployable → Constructor` is semantically wrong (a deployable is a module) | **fixed + first tests** (`Deployable → Module`) |
| `ddd-rename.ts` / `member-refs.ts` | 5 → 15 | — | cross-ref matrix + shadowing + prepareRename + multi-file covered; **5 bugs FIXED** (operation call-sites, lambda-shadowing, bare-function-call, bare enum-value, qualified enum-value) |
| `ddd-references.ts` | 3 → 8 | — | shadowing + derived + operation-call + bare-function-call + enum-value (bare + qualified) covered; shares `collectMemberUsages`, so all the rename fixes flow through |

> **Rename bugs found writing the cross-ref matrix** — all the operation-rename
> bug's siblings (declaration renames, a use-site left stale; the use-sites are
> NameRefs / soft-keyword tokens resolved by Loom's custom scope/type-system,
> not the cross-reference index). Status:
> - ✅ **lambda-param shadowing** FIXED — renaming a property used to rewrite a
>   same-named lambda *body* ref, corrupting the lambda. `nameRefDecl` trusted
>   `env.resolve` (which doesn't model lambda shadowing); it now guards with
>   `localShadows` first (previously dead-tested).
> - ✅ **bare function call** FIXED — `tax()` rewrites with the declaration now.
>   `env.resolve` doesn't surface a function for a bare head, so `nameRefDecl`
>   falls back to an enclosing-entity member lookup (`iterateEntityMembers`,
>   mirroring `collectLValueUsages`).
> - ✅ **bare enum value** FIXED — `st := Open` rewrites with the declaration.
>   `nameRefDecl` resolves it through the same context-enum scan `lower-expr`
>   uses (a property of the same name still shadows, so no over-collection).
> - ✅ **qualified enum value** `Status.Open` FIXED — the head `Status` is an
>   enum *name* (types as `unknown` as a value expression), so the MemberSuffix
>   path's `stepIntoNode` can't reach the value. `qualifiedEnumValueDecl`
>   resolves the head enum by name, then its `.member` value — pinning the enum
>   explicitly (unlike the bare form's context-order scan). Works from the
>   declaration and from a qualified use site.
> - ✅ **soft-keyword field name `state`** FIXED — `aggregate Order { state:
>   Status }` failed to *parse* (so the `Status` type-ref couldn't rename),
>   because `Property.name` admitted a narrower soft-keyword set than
>   `LooseName` and omitted `state`. `state` is now in `Property.name` (it
>   begins no aggregate/VO/event member, so it's safe there — unlike `contains`,
>   which is why `Property.name` can't just reuse `LooseName` wholesale). Other
>   non-starter `LooseName` keywords (`title`, `body`, `route`, …) can be added
>   the same one-line way if a real field needs them.

Multi-file rename and `prepareRename`-range are also covered (both pass).

Hover failure-path is now covered: an unresolved containment part / repository
aggregate renders `«unresolved: <text>»` (or `«unresolved»` when absent) instead
of the old silent `?`, so a dangling cross-ref reads as a failure in the bubble.

Deployable / module rename is covered too: a system-scoped fixture pins that
renaming a `deployable` rewrites its `targets:` + `against` cross-refs, and
renaming a `subdomain` rewrites its `api … from` reference (both flow through
the index-driven default — they're Langium cross-references, so no member-usage
path is needed). With these, the LSP rename/references/hover coverage backlog
is cleared; the remaining provider work is the MCP-server transport (deferred).

> **Note (LValue blind spot, found while testing).** A statement-position
> member call / assignment target (`this.op(...)`, `a.b := …`) parses as an
> `LValue`, not a `MemberSuffix` — so neither the semantic-token highlighter
> nor `memberDeclAt` (rename-from-cursor) resolves it. Member *declarations*
> rename correctly and `collectMemberUsages` does rewrite LValue usages; the gap
> is only resolving/highlighting *from* an LValue token. Tracked here; affects
> rename-from-call-site and member-call highlighting in statement position.

**S3 — fix-hint expansion.** New quick-fixes are **one `fixHintFor` provider
each** (`src/language/fix-hints.ts`), not switch arms — so each rides
`fixHintCodeActions` into Monaco + VS Code *and* the agent loop (`loom_quickfix`)
for free.

> **Patch-addressing (extended).** A `fixHintFor` provider emits a `ModelPatch`,
> whose `target` must be an **addressable node**. The address space
> (`addressOf` / `buildOutline` / the patch index) now covers contexts,
> aggregates **+ their members**, **value objects + their members**, workflows,
> views, pages, **enums, events, repositories**, and system-level
> **deployables**. `add` containers are nodes with a **free-form `{ member* }`
> body** (context / aggregate / value object) — *not* deployables. The
> **`insert`** op (`before`/`after` a sibling, or **`header-end`** before a
> declaration's `{`) covers header clauses. So:
> - ✅ **`reserved-derived-on-vo`** SHIPPED — `replace` the VO member, dropping
>   `derived` (`display: T = …` is a valid VO field; round-trip clean).
> - ✅ **`es-tph-forced-own-table`** SHIPPED — `insert … position: header-end`
>   adds `inheritanceUsing(ownTable)` to the aggregate header (absent-clause
>   case; the present-clause case needs a clause-replace, which isn't
>   node-addressable — skipped).
> - **`react-deployable-missing-ui`** stays **blocked** — the deployable body is
>   a **positional grammar** (`ui:` has a fixed slot between `serves:` and
>   `hosts:`); `header-end` targets the *header*, not a body slot. Needs a
>   grammar-slot-aware body insert (or config-entry addressing), or an
>   editor-only `TextEdit`. (Deployable was removed from the `add`-container set.)
> - **`seed-id-needs-raw`** stays **blocked** — a `seed` block is **unnamed**, so
>   it has no node address to target at all.

Next batch:

| Diagnostic code | Patch | Status |
|---|---|---|
| `loom.bare-aggregate-in-type` | append ` id` to the type ref | ✅ shipped |
| `loom.reserved-derived-on-vo` | drop the `derived` keyword | ✅ shipped |
| `loom.es-tph-forced-own-table` | `insert header-end inheritanceUsing(ownTable)` | ✅ shipped (absent-clause) |
| `loom.legacy-part-call` / `loom.legacy-vo-call` | rewrite `name(...)` → `name { ... }` | open (positional-arg → named-field rewrite, not mechanical) |
| `loom.criterion-arity` | stub the missing arg with `_` | open |
| `loom.react-deployable-missing-ui` | insert `ui: <name>` in its slot | blocked — positional body slot |
| `loom.seed-id-needs-raw` | `seed {` → `seed raw {` | blocked — `seed` is unnamed |

Each follows the shipped `loom.bare-aggregate-in-type` pattern; gate via
`test/language/fix-hints.test.ts` (model-level) + `test/api/lsp.test.ts`
(editor round-trip). The legacy `DddCodeActionProvider` arms that don't fit the
patch model stay put (`loom.framework-mismatch` single-token replace; `Unfold
macro` is a refactor, not a fix).

**Follow-up refactor — `Fold to macro`** (inverse of the shipped `Unfold macro`):
when members on an aggregate/context match a registered macro's expansion,
offer collapsing them into `with X(...)`. Structural-equality detection,
opt-in per macro (a `foldable` tag so it's only offered for macros that
round-trip cleanly); reuses the structural printer + round-trip gate. Separate
machinery (printer-driven, not patch-driven), so a separate PR.

### 4d. Future (as their toolkit ops land)

| Tool | Input | Returns |
|---|---|---|
| `loom_verify` | `{ source, results }` | per-requirement verdicts |
| `loom_read_model` | `{ source }` | canonical re-printed `.ddd` |
| `loom_list_primitives` | `{}` | the closed page-primitive catalog |

Naming: `loom_<verb>`, snake_case. Input schemas are JSON Schema (MCP requires
it); they're kept in lockstep with the contract types in
`src/diagnostics/contract.ts`.

**Resources & prompts (MCP also has these, future):** expose the model
context-pack (the `.ddd` authoring guide, build-plan item 7) as an MCP
*resource*, and a "build a Loom model" *prompt* — so a host gets the authoring
guidance, not just the verbs.

## 5. Why this directly enables the playground chat

Adding agentic chat to the playground becomes a **UI + LLM-wiring** task with no
new tool logic:

1. Send the conversation to the LLM (Anthropic API tool-use or a local model)
   with the catalog's schemas as the tool definitions.
2. On a `tool_use` block, call `catalog[name].handler(args)` — running the
   toolkit **in-browser** (no network for the tool itself).
3. Return the result; loop until the model stops.
4. Apply an `apply_patch` result to the editor buffer; surface diagnostics via
   the LSP adapters (already shipped) so the model-edit shows squiggles +
   quick-fixes.

The only browser-new concern is **LLM API key / endpoint handling**, which is a
playground settings matter, independent of the tools.

### 5b. Playground chat UI — concrete plan (the remaining ⬜)

The engine is done (`runAgent` in `src/tools/agent-loop.ts`, #946) — it takes an
injected `Complete` and drives the whole `tool_use → callTool → tool_result`
loop, streaming each turn via `onMessage`. So the UI slice is **purely
browser-side**: implement one `Complete`, render the stream, apply edits. No new
tool logic. Architecture map (from the playground audit):

1. **A `Complete` implementation** — a thin `fetch` to the model.
   - **Transport decision (open):** direct Anthropic (`api.anthropic.com` +
     `anthropic-dangerous-direct-browser-access` header, key in `localStorage`)
     vs a bring-your-own base-URL/proxy vs both (Anthropic default, override the
     URL/model). See §7. The loop is agnostic — this is the only place the
     choice lives.
   - Maps the Anthropic Messages API ↔ the loop's `Message` / `ContentBlock`
     shapes (they were modelled to match, so this is near 1:1).
2. **Chat panel** — `web/src/layout/ChatPanel.tsx`, wired into the bottom
   `DevToolsDock` (add `"chat"` to `DockTab` + a tab entry + a render case).
   Mantine UI like the existing `OutputPanel` / `ProblemsPanel`.
3. **Source read/write** — read with `ctx.getSource()`; when a tool returns new
   source (`loom_apply_patch.text`) or the user accepts a rewrite
   (`loom_rename` / `loom_quickfix` / `loom_unfold_macro` `EditResult`), push it
   back via `ctx.onSourceChange(next, "builder")` — the `"builder"` origin path
   pushes into Monaco (`editorHandleRef.setSource`) **without** an echo loop, and
   the LSP re-lints so the model-edit shows squiggles + quick-fixes for free.
4. **API key** — `usePersistedState("loom.apiKey", "")` (the existing
   localStorage hook); a small settings affordance in the panel.
5. **Apply-edits affordance** — `EditResult` edits are *returned, not applied*
   (contract §3), so the panel shows a diff/accept button before splicing them
   into the buffer; `apply_patch` returns whole new source directly.
6. **Tests** — Playwright (`web/e2e/`, the playground's only test surface) with a
   **stubbed `Complete`** (scripted turns) so the chat→tool→editor flow is
   deterministic and offline — no real LLM call in CI. The loop itself is
   already unit-tested in `test/tools/agent-loop.test.ts`.

Risk is contained: the orchestration + the whole tool surface are done and
tested; this slice is a panel + a `fetch` + an apply-to-editor wire.

## 6. Layering & homes

- `src/tools/` imports only `src/api/` (the toolkit) + the contract types →
  browser-safe; sits above the pipeline like `cli`/`api` (not scanned by the
  pipeline-layering invariant, no back-edge).
- `packages/ddd-mcp/` — the Node stdio server; depends on `@loom/core`-style
  access to the catalog + the MCP SDK. Publish-shaped per the existing
  `packages/` story (CLAUDE.md).
- The playground imports `src/tools/` straight from `../src` (the existing
  `web/` → `../src` path).

## 7. Open questions

- **Catalog ↔ schema source.** Generate the JSON Schemas from the TS contract
  types (e.g. a build step) vs. hand-author and pin with a test. Proposal:
  hand-author v1 (small surface) + a completeness test that every catalog entry
  has a schema and a handler; revisit codegen when the surface grows.
- **In-memory MCP vs direct dispatch in the playground.** Direct dispatch is
  simpler; in-memory MCP gives byte-identical parity with external hosts (and a
  conformance test "same tool list over both transports"). Proposal: ship direct
  dispatch; add in-memory MCP only if parity drift becomes a real risk.
- **Streamable-HTTP transport.** A hosted Loom MCP endpoint (for web agents that
  can't run a subprocess) is a later transport over the same catalog; out of
  scope for v1.
- **Multi-file (`import`) models.** The toolkit is single-source today; tools
  inherit that. A `{ files: Record<path,source> }` input is the multi-file
  extension when the toolkit gains project-aware parsing.
- **Write-capable tools.** Kept out of v1 deliberately (tools are
  side-effect-free). If a host ever wants `generate-to-disk`, it's a separate,
  consent-gated tool — not folded into `loom_generate`.

## 8. Build order

1. ✅ `src/tools/` catalog — the **generative family** (`loom_validate` /
   `loom_apply_patch` / `loom_generate` / `loom_outline`, §4a) + `callTool`
   dispatch + a completeness test (every entry has a `loom_*` name, schema, and
   handler; the validate→fix→validate loop composes through `callTool`). The
   shared dependency for both the MCP server and the playground chat.
2. ✅ MCP stdio server registering the catalog. Server core lives in `src/mcp/`
   (a Node-only island over the browser-safe catalog, like `src/cli/`);
   `packages/ddd-mcp/` is the publish wrapper (bin `ddd-mcp` → `out/mcp/main.js`
   + the `@modelcontextprotocol/sdk` dep), paralleling `bin/cli.js` over
   `src/cli/`. Uses the low-level `Server` (raw JSON-Schema `tools/list` +
   `tools/call` → `callTool`); unknown tool / handler throw surface as
   `isError`, not a protocol failure. Smoke-tested via the SDK's in-memory
   transport (list the catalog, dispatch `loom_validate` clean + invalid,
   unknown-tool error) and end-to-end over real stdio.
3. **LSP-provider correctness** (§4c) — fix the operation-rename bug + coverage,
   add quick-fix `fixHintFor` providers. Standalone editor value; gates the
   navigational verbs.
4. ✅ **Navigational family** (§4b) — by-name addressing over the providers,
   on one shared resolver (`src/api/symbol-resolver.ts`).
   - read trio: `loom_find_symbol` / `loom_references` / `loom_hover`
     (`src/api/navigate.ts`).
   - rewrite trio: `loom_rename` / `loom_quickfix` / `loom_unfold_macro`
     (`src/api/refactor.ts`) — return `EditResult`s, not applied.
   Both inherit the MCP + (future) playground transports through the catalog.
5. **Playground agentic chat** — split into engine + UI:
   - ✅ **agent loop** (`src/tools/agent-loop.ts`) — the transport-neutral
     conversation driver: ask the model, run every `tool_use` through the
     catalog's `callTool`, feed the `tool_result`s back, repeat until it stops
     (with a `maxSteps` cap against tool ping-pong). The LLM call is INJECTED
     (`Complete`), so the loop is provider-neutral, pure, browser-safe, and
     unit-tested with a scripted fake (incl. the full validate → apply_patch
     authoring loop). Message/content-block shapes mirror Anthropic's so the
     real client maps 1:1. This is the reference loop every in-process host
     runs (playground today, a headless CLI later); an external MCP host runs
     its own loop, so the MCP server doesn't use it.
   - ⬜ **playground UI** — the chat panel + LLM-wiring (an Anthropic/proxy
     `Complete` implementation) + API-key handling + apply-to-editor. A
     UI + transport task with no new tool logic (web/, Playwright-tested).
