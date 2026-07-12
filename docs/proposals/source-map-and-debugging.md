# Proposal — Source maps & cross-target debugging

> Status: **IN PROGRESS — phases 0–7 shipped; phase 8's pure cores AND
> the protocol shell's remap layer shipped; only the full delegating
> target-debugger proxy remains.** This doc consolidates the whole
> debugging endeavour: one provenance substrate (the *Origin spine*)
> threaded `.ddd` → IR → emitted output, and a family of debug features
> layered on top of it — a generic `.loom/sourcemap.json`, a `ddd trace`
> stack-trace translator, native per-target debug info (Source Map v3 /
> `#line`+PDB / JSR-45 SMAP), LSP source↔target navigation, and DAP
> breakpoints in `.ddd`. The Origin spine, `.loom/sourcemap.json` (all
> backends), `ddd trace` (column-aware), LSP source↔target nav, statement
> + char/expression granularity, Source Map v3 sidecars, .NET `#line`→PDB,
> Java JSR-45 SMAP, node strippable-boot debug wiring, the `ddd
> breakpoints` CLI, **both** pure DAP resolution cores
> (`resolveSetBreakpoints` forward + `remapStackFrames` reverse, in
> `src/dap/`), and now the **`ddd-dap` protocol shell's remap layer**
> (Milestone 27: `packages/ddd-dap` + `src/dap-server/`'s
> `LoomDebugSession extends DebugSession`, whose `initialize`/
> `setBreakpoints`/`stackTrace` handlers wire the two shipped cores over
> an fs-loaded `.loom/sourcemap.json`, unit-tested by invoking the
> handlers directly plus a real stdio smoke test against the generated
> `examples/showcase.ddd` map) have all landed on `main`. What remains is
> the **full delegating target-debugger proxy** — spawning/proxying the
> target's own debugger (`js-debug`/`coreclr`/JDWP) for `launch`/`attach`/
> `continue`/`stepIn`/… and remapping only line/scope on top. It is
> deferred deliberately: its payoff (an editor driving live
> breakpoints/stepping against a running backend) can only be verified by
> driving an actual `js-debug`/`coreclr`/JDWP session in an interactive
> editor, which the headless CI/sandbox can't do — so it is a reviewed
> next step, not abandoned. See the phase table (§9) for the per-phase
> shipped state.
>
> **This is a committed platform pillar, not a minimum-viable slice.** The
> full arc — through char-level fidelity and live DAP debugging — is the
> deliverable; we do **not** gate the ambitious phases behind "a consumer
> asked for it." The phasing below is **dependency ordering, not a
> priority cut**: every phase is on the roadmap, each is independently
> shippable, and each names its own gate. Sequencing exists so value lands
> continuously while we build toward the whole thing.

## 1. North star

A Loom developer sets a breakpoint **in `main.ddd`**, runs
`docker compose up`, and execution pauses *on the `.ddd` line* —
regardless of which backend served the request. Domain values show up in
Loom terms. Any crash, anywhere in the generated stack, produces a stack
trace in **`.ddd` coordinates**, not TypeScript/C#/Elixir ones.

We commit to that end state for every target the runtime allows. Live
breakpoint-and-step debugging lands natively on the targets whose runtimes
have a remap-aware debugger (JS, .NET, JVM). Python and Elixir don't expose
a native remap hook, so they don't get identical *live stepping* — but they
are **not** relegated to static post-mortem: an enhanced trace path
(traceback-rewriting import hook on Python; `@file`/line annotations on the
BEAM) makes their runtime errors surface in `.ddd` coordinates *as they
happen*, and `ddd trace` covers everything else. No target is left at
"read the generated code and guess." The plan sequences so value lands
continuously, but the expensive fidelity is **in scope**, not optional.

## 2. Why it doesn't exist today — two boundaries drop the position

The IR is deliberately position-free, and emission is anonymous string
concatenation. Source location is discarded at *two* points, and every
debug feature has to defeat both:

1. **Lowering (AST→IR).** No IR node in `src/ir/types/loom-ir.ts` carries
   its originating `$cstNode`/offset/line. `$cstNode` is read at exactly
   two lowering sites and thrown away everywhere else:
   - `provSiteFor` (`src/ir/lower/lower-expr.ts` ~1839) — reads
     `$cstNode.offset`/`.length` for `provenanced` write-sites only
     (`ProvSite`, `loom-ir.ts` ~2639).
   - `cstText()` (`src/ir/lower/lower-types.ts` ~559) — reads
     `$cstNode.text` (a *string*, no offset) for invariant/uniqueKey/test
     display snippets.
2. **Emission.** `src/util/code-builder.ts` is the whole mechanism:
   `lines(...)` flattens and `join("\n")`s anonymous strings. Once
   concatenated a segment is indistinguishable; every backend returns a
   bare `Map<path, string>`.

The `{ path, span }` byte-offset capture in `ProvSite`/`loomsnap.ts` and
the synthetic-node `OriginToken` (`src/macros/api/define.ts` ~121) are the
only existing scaffolding — the generated-side half is greenfield.

## 3. Prior art — this is a solved pattern, per target

"Generated code runs, but the debugger shows the *original* source" is not
a JS trick. Every compiled target ships a mechanism for it, most older
than JS source maps:

| Target family | Mechanism | Precedent |
|---|---|---|
| JS/TS | **Source Map v3** (`//# sourceMappingURL`) — consumed natively by the Node inspector & browser devtools | TypeScript, CoffeeScript, Dart, Kotlin/JS, ClojureScript |
| .NET | **`#line` directives → PDB.** C# 10 *enhanced* them to carry line **and column** spans specifically so DSLs that generate C# map precisely; `#line hidden` steps over glue | Razor / Blazor debug back to `.razor`/`.cshtml`; source generators |
| JVM | **JSR-45 SMAP** in the `SourceDebugExtension` class attribute — maps bytecode lines to a *non-Java* source file | JSP (its reason to exist), Kotlin, Scala; Haxe has an open request for its JVM target |
| Native (C/C++) | `#line` → DWARF; gdb/lldb open the original file | Nim, Vala, early C++ frontends |
| Python | *no native `#line`* — weak spot | (fallback: trace translation) |
| Elixir/BEAM | line info exists; non-Elixir remap is non-standard | (fallback: trace translation) |

Two lessons shape the design:

- **You almost never write a bespoke debugger.** JSP debugging is 20+
  years old and needed *zero* custom debug UI — just the SMAP attribute
  plus the JVM's existing JDWP. The editor already speaks DAP to
  `js-debug` / the .NET debugger / JDWP. Loom's job is to **emit each
  target's native debug metadata**, not to build a debugger.
- **Haxe is the closest analog** (one language, N targets) and its answer
  is exactly "per-target native format": source maps for JS, JSR-45 for
  the JVM. We follow the same shape.

## 4. The substrate — the Origin spine

One reference type, threaded from AST through IR to output. It is a
**chain**, which is what makes macros and synthesis tractable:

```ts
// src/ir/types/origin.ts
type SourceRef  = { kind: "source";  path: string; span: { start: number; end: number } };
type MacroRef   = { kind: "macro";   macro: string; call: SourceRef; inner?: OriginRef };
type DerivedRef = { kind: "derived"; reason: string; from?: OriginRef };
type OriginRef  = SourceRef | MacroRef | DerivedRef;
```

- **`span` is byte offsets**, identical to `ProvSite`/`loomsnap` — the
  lingua franca. Line/column is derived on demand by a `LineIndex` over
  the source text, only at the boundary that needs it (v3 VLQ, LSP,
  `ddd trace` output). Storing offsets keeps the IR compact and matches
  existing capture.
- **`MacroRef`** points a scaffolded node at the `with scaffold(...)` call
  site (a real `SourceRef`); `resolve()` walks to the nearest `SourceRef`
  so "where do I break" always terminates in `.ddd` text.
- **`DerivedRef`** covers auto-`findAll`, `wireShape`, and other pure
  derivations — nodes that legitimately have *no* source. The debugger
  labels these "synthetic (auto-findAll)" rather than lying about a line.

### Where it lives

`origin?: OriginRef` on a shared `Traceable` base mixed into the
**structural** IR nodes (context / aggregate / operation / field / page /
view / workflow). *Not* a `WeakMap` side-table (identity is fragile across
the enrich clone and it doesn't serialize), and — per this repo's own
"store a fact only when it's a non-derivable input" rule — origin *is*
genuinely un-derivable input, so an inline field is the correct call, not
a "stamp we should have derived."

Expressions (`ExprIR`) and statements (`StmtIR`) get `origin` only when the
finer granularity tiers land (§5), keeping the field optional and the
common case cheap.

### Where it's captured

- **Real nodes** — in the per-declaration-kind lowerers
  (`lower-members.ts`, `lower.ts`, …) at the point they already read the
  AST node, reusing `provSiteFor`'s `$cstNode.offset` read.
- **Macro nodes** — the `OriginToken` already tags synthesized AST nodes
  with `{ macroName, callNode }` but is dropped at lowering. Capture it
  *before* that boundary: lowering reads the token and emits a `MacroRef`
  instead of a `SourceRef`.

## 5. Granularity tiers — the cost dial

The sequencing lever — **not** a scope cut. All three levels are the
target; **statement/char fidelity is the platform-grade end state**, and
construct-granular is simply the first shippable increment on the way, not
a stopping point. Sequenced cheapest-first so each tier ships value:

1. **Construct-granular** *(Phase 1).* "This region of `LoginSession.ts`
   ← aggregate `Identity.Auth.LoginSession` at `main.ddd:12`." Achieved by
   **bracketing the existing per-construct emit loops** — the backend
   orchestrators (`generate<X>ForContexts`) already iterate contexts →
   aggregates → operations and append linearly. A `TracedBuilder` wraps
   each top-level append: record `(origin, lineStart, lineCount)`. **No
   change to `lines()`, no change to the `render*` functions** — a handful
   of call sites per backend. Enough for `ddd trace` frame resolution and
   file-level LSP nav.
2. **Statement-granular** *(Phase 4).* `origin` on `StmtIR`; `render-stmt`
   anchors each statement's line. Unlocks *meaningful* breakpoints (break
   on a line inside an operation body) and useful `#line`/SMAP.
3. **Char/expression-granular** *(Phase 7).* `origin` on `ExprIR` +
   span-tracking through `lines()`. Column-precise maps and DAP variable
   mapping. The expensive tier — sequenced last because of its
   dependencies, but a committed deliverable, not a maybe.

## 6. The consumers (features)

### A. `.loom/sourcemap.json` — the generic artifact (all backends)

Bidirectional, emitted by a new `src/system/sourcemap.ts` sibling of the
other `.loom/` artifacts. Forward: generated file range → `OriginRef`.
Reverse: Loom construct → all its output ranges across every target.

```jsonc
{
  "version": 1,
  "sources": ["main.ddd"],
  "files": {
    "AuthApi/src/domain/LoginSession.ts": [
      { "target": [40, 58], "origin": { "kind": "source", "path": "main.ddd", "span": [210, 540] },
        "construct": "Identity.Auth.LoginSession" },
      { "target": [88, 96], "origin": { "kind": "derived", "reason": "auto-findAll" } }
    ],
    "CartUi/src/pages/CartPage.tsx": [
      { "target": [12, 61], "origin": { "kind": "macro", "macro": "scaffold",
        "call": { "path": "main.ddd", "span": [1200, 1240] } } }
    ]
  }
}
```

### B. `ddd trace` — stack-trace translation (all backends, highest value/cost)

Pure consumer of `sourcemap.json`. The universal debugging win — works for
*every* target because it's just a lookup, no runtime integration:

```
$ ddd trace crash.log
  at LoginSession.ts:47   →  Identity.Auth.LoginSession.start   (main.ddd:14)
  at repository.ts:88     →  auto-findAll [synthetic]
  at CartPage.tsx:31      →  scaffold(Cart) [macro]             (main.ddd:22)
```

### C. Native target debug info — "debug the `.ddd`" per target

The debugger shows `.ddd`, not generated code — the JSP/Razor experience.
Each target emits its own dialect off the same spine:

| Backend | Emit | Consumed by |
|---|---|---|
| Hono / React / Vue / Svelte | Source Map v3 + `//# sourceMappingURL` | Node inspector, browser devtools |
| .NET | enhanced `#line (a,b)-(c,d) "main.ddd"` in generated `.cs` → PDB | .NET debugger (VS / `netcoredbg`) |
| Java | JSR-45 SMAP injected into `SourceDebugExtension` (post-`javac` step, Kotlin's path) | JDWP / any JVM debugger |
| Python | traceback-rewriting import hook (`sys.settrace` / `linecache` patch) → `.ddd` frames at runtime | debugpy post-mortem + **B** |
| Elixir | `@file` + line annotations so BEAM stack entries report `.ddd` | `IEx`/logger + **B** |

### D. LSP source↔target navigation

Reuses `src/language/lsp/` + the vscode extension. "Go to generated code"
from a `.ddd` construct and the reverse, off `sourcemap.json`. Only needs
construct-granularity — cheap value. The existing `unfold-macro` action
proves the seam.

### E. DAP — breakpoints in `.ddd` (committed pillar)

The richest consumer, and mostly *not* new debugger work: with §C in place
the editor drives the target's existing debugger, and the adapter's job is
line/scope remap. This is the headline platform capability — set a
breakpoint in `.ddd`, run the stack, step in your own language — and it is
**on the roadmap, not a someday**. Native live debugging targets JS + .NET
+ JVM (the remap-aware runtimes); it needs char-granular origins (§5.3) for
variable inspection, which is why it sequences last, not because it's
optional. The `ddd-dap` adapter ships as a workspace alongside `ddd-mcp`.

**Milestone 27 shipped the REMAP LAYER**, honestly scoped short of the
paragraph above's full picture: `packages/ddd-dap` (the publish wrapper,
mirroring `packages/ddd-mcp`) + `src/dap-server/` (the Node-only island,
mirroring `src/mcp/`) register a `LoomDebugSession extends DebugSession`
(`@vscode/debugadapter`) whose `initializeRequest` / `setBreakPointsRequest`
/ `stackTraceRequest` handlers wire `resolveSetBreakpoints` /
`remapStackFrames` over an fs-loaded `.loom/sourcemap.json`
(`src/dap-server/load-map.ts`, reusing the exact `JSON.parse` `ddd trace`
already uses — no second hand-rolled wire parser). `session.ts` itself stays
`fs`-free (the map + a `readSource` accessor are constructor-injected), so
it is unit-tested by invoking the handlers directly
(`test/dap/session.test.ts`) — including a real round trip over
`examples/showcase.ddd`'s `requires currentUser.role == "admin"` guard,
closing the loop through the fs loader too. A manual stdio smoke test
(hand-framed DAP messages piped through `packages/ddd-dap/bin.js`) confirmed
the same round trip end-to-end over the real protocol wire format.

**What did NOT ship, and remains the sole open frontier**: the full
DELEGATING target-debugger proxy this section's opening paragraph describes
— actually spawning/proxying `js-debug` / `coreclr` / JDWP for `launch` /
`attach` / `continue` / `stepIn` / … and remapping only line/scope on top of
a live session. `stackTraceRequest`'s raw frames are supplied through a test
seam (`fetchRawFrames`, overridden by the unit test) rather than a real
target debugger, precisely because that full proxy needs a live editor +
running target debugger to build and verify — unavailable headless. This is
the one piece of §6E's north star that stays editor-verified, not a
regression from what was scoped.

## 7. Macros & synthetic nodes

- **Scaffolded pages / capability-cloned members** → `MacroRef` at the
  `with …` call site. A breakpoint on generated scaffold code lands on the
  scaffold call in `.ddd`; `unfold` remains the way to see the expansion
  as real source.
- **Auto-derived nodes** (`findAll`, `wireShape`, associations) →
  `DerivedRef`. Honestly labeled "synthetic," never mapped to a bogus
  line — the same discipline as the "derive, don't stamp" rule.

## 8. Correctness & test strategy

- **Opt-in flag `--sourcemap`** (and `#line`/SMAP behind it). Default
  **off** → the existing byte-identical fixtures and the walker/expr
  byte-identical gates are untouched. Turning it on is additive
  (sidecar files + comment directives).
- **Round-trip conformance** (`test/system/sourcemap.test.ts`): over the
  corpus, assert (1) every traced region resolves to a real `.ddd` span or
  a macro/derived chain terminating in one; (2) the mapped span's text
  matches the construct it claims; (3) a coverage floor — ≥ N % of emitted
  domain files carry ≥ 1 mapping.
- **v3 validity**: emitted `.map` parses as a valid Source Map v3 and its
  decoded mappings point inside `sources`.
- **Formatter interaction** (open question, §10): the map must be computed
  against the *final* emitted bytes. If generated TS is later run through
  Biome, a pre-format offset map is stale.

## 9. Phased roadmap

**Dependency-ordered, not priority-ranked — every row is committed.** Each
phase is independently shippable behind `--sourcemap` and names its gate;
the ordering is what unblocks what, so value lands continuously while we
build the full arc through DAP.

| # | Phase | Deliverable | Depends on | Effort | Status |
|---|---|---|---|---|---|
| 0 | **Origin spine** | `OriginRef` type; `origin?` on structural IR; capture in lowering + macro pre-lowering | — | Medium | ✅ Shipped |
| 1 | **`sourcemap.json`** | `TracedBuilder` bracket in each orchestrator; `src/system/sourcemap.ts`; `--sourcemap` flag | 0 | Medium | ✅ Shipped (all backends) |
| 2 | **`ddd trace`** | CLI stack-trace translator (all backends) | 1 | Small | ✅ Shipped (column-aware) |
| 3 | **LSP nav** | source↔target "go to generated code" | 1 | Medium | ✅ Shipped |
| 4 | **Statement granularity** | `origin` on `StmtIR`; line-anchored `render-stmt` | 0 | Medium | ✅ Shipped |
| 5 | **Source Map v3 (JS)** | `.map` + `sourceMappingURL` for the 4 JS backends | 1, 4 | Small–Med | ✅ Shipped |
| 6 | **.NET `#line` + Java SMAP** | enhanced `#line` → PDB; JSR-45 injector | 4 | Med / Med–Hard | ✅ Shipped (both) |
| 7 | **Char/expression granularity** | `origin` on `ExprIR`; span-tracking `lines()` | 4 | Large | ✅ Shipped |
| 8 | **DAP** | `ddd-dap` adapter reusing target debuggers (JS/.NET/JVM); scope remap; Python/Elixir enhanced-trace | 5, 6, 7 | Large | 🟡 Pure cores + protocol shell's REMAP LAYER shipped (node debug wiring + strippable boot; `ddd breakpoints` CLI; `translateBreakpoint`, `resolveSetBreakpoints`, `remapStackFrames` in `src/dap/`; Milestone 27 — `packages/ddd-dap` + `src/dap-server/`'s `LoomDebugSession` wiring both cores over `initialize`/`setBreakpoints`/`stackTrace`, unit-tested headlessly) — only the **full delegating target-debugger proxy** (spawning/proxying `js-debug`/`coreclr`/JDWP for `launch`/`attach`/stepping) remains, deferred as editor-only-verifiable |

Phases **0 → 1 → 2** are the core investment and already deliver
cross-backend post-mortem debugging. **3** is in-editor navigation off the
same base. **4** is the hinge that makes **5/6** precise. **7 → 8** carry
it to char-level maps and live `.ddd` breakpoints — the platform headline.
None of this is an "optional last mile": the arc is the deliverable, the
numbering is just the order the dependencies allow.

```
0 ──┬── 1 ──┬── 2  (ddd trace)
    │       └── 3  (LSP nav)
    └── 4 ──┬── 5  (v3 JS) ─────┐
            └── 6  (.NET/Java) ─┼── 8 (DAP)
        7 (char) ───────────────┘
```

## 10. Decisions to pin (candidate D-tags)

- **D-ORIGIN-STORE** — inline `origin?` on structural IR nodes, not a
  side-table. (§4)
- **D-ORIGIN-OFFSETS** — byte offsets in the IR; line/col derived at the
  serialization boundary. (§4)
- **D-SM-OPTIN** — source-map emission is opt-in (`--sourcemap`), default
  off, to preserve byte-identical gates. (§8)
- **RESOLVED — formatter ordering.** Moot: there is no post-emission
  reformatting step in this pipeline. `test:biome-gen` runs `biome lint`
  (a check, never `--write`/`format`) against generated output, and
  nothing in the write path reformats emitted bytes afterward — the bytes
  a recorder measures are the bytes written to disk. See
  [`../plans/span-tracking-emission.md`](../plans/span-tracking-emission.md)
  §5 (phase 7 slice 2). (§8)
- **RESOLVED — Java SMAP injection.** Shipped (phase 6b) as the
  **post-`javac` class-rewrite** option: the generated Gradle build emits
  an ASM-based `injectSmap` task (`finalizedBy("injectSmap")` on
  `compileJava`) that writes the JSR-45 `SourceDebugExtension` SMAP into
  each compiled `.class` — no javac plugin, no Kotlin tooling. See
  `src/generator/java/emit/program.ts` (`injectSmap` task registration)
  and the phase-6b notes in `docs/plans/`. (§6C)

## 11. Non-goals

Char-level fidelity and DAP are **in scope** (Phases 7–8) — they are not
listed here. What's genuinely out of scope:

- **Char-level precision *before its dependencies*** — it ships in Phase 7,
  after the spine and statement tier, not on day one. In scope, later in
  sequence.
- **Native live *stepping* for Python/Elixir** — their runtimes expose no
  remap hook, so they get enhanced runtime-trace fidelity (§6C) rather than
  breakpoint-and-step. This is a runtime limit, not a descoping.
- **Debugging the *compiler* itself** — pipeline/IR introspection is a
  separate concern (`unfold`, AST printer, per-phase dumps already exist).
- **Reformatting or prettifying generated output** — the map anchors to
  bytes as emitted.
