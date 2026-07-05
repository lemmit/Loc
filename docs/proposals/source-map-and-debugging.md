# Proposal — Source maps & cross-target debugging

> Status: **PROPOSED.** No code yet. This doc consolidates the whole
> debugging endeavour: one provenance substrate (the *Origin spine*)
> threaded `.ddd` → IR → emitted output, and a family of debug features
> layered on top of it — a generic `.loom/sourcemap.json`, a `ddd trace`
> stack-trace translator, native per-target debug info (Source Map v3 /
> `#line`+PDB / JSR-45 SMAP), LSP source↔target navigation, and — as the
> far horizon — DAP breakpoints in `.ddd`. The phases are independently
> shippable; each names its own gate.

## 1. North star

A Loom developer sets a breakpoint **in `main.ddd`**, runs
`docker compose up`, and execution pauses *on the `.ddd` line* —
regardless of which backend served the request. Domain values show up in
Loom terms. Any crash, anywhere in the generated stack, produces a stack
trace in **`.ddd` coordinates**, not TypeScript/C#/Elixir ones.

Fully realized, that state is only reachable for the targets whose
runtimes have a remap-aware debugger (JS, .NET, JVM). Python and Elixir
get the *post-mortem* half — trace translation — which is ~80 % of the
day-to-day value for a fraction of the cost. The plan is built so that
value lands early and the expensive last mile is optional.

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

The single biggest cost lever. Three levels, sequenced cheapest-first:

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
3. **Char/expression-granular** *(Phase 8).* `origin` on `ExprIR` +
   span-tracking through `lines()`. Needed for column-precise maps and DAP
   variable mapping. The expensive tier — deferred until a consumer
   demands it.

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
| Python | — (no native `#line`) | falls back to **B** |
| Elixir | — (non-standard remap) | falls back to **B** |

### D. LSP source↔target navigation

Reuses `src/language/lsp/` + the vscode extension. "Go to generated code"
from a `.ddd` construct and the reverse, off `sourcemap.json`. Only needs
construct-granularity — cheap value. The existing `unfold-macro` action
proves the seam.

### E. DAP — breakpoints in `.ddd` (far future)

The richest consumer, and mostly *not* new debugger work: with §C in place
the editor drives the target's existing debugger, and the adapter's job is
line/scope remap. Realistic only for JS + .NET + JVM; needs char-granular
(§5.3) for variable inspection. Named here so it's a deliberate "later,"
not a surprise.

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

Dependency-ordered, value-weighted. Each phase is independently shippable
behind `--sourcemap` and names its gate.

| # | Phase | Deliverable | Depends on | Effort |
|---|---|---|---|---|
| 0 | **Origin spine** | `OriginRef` type; `origin?` on structural IR; capture in lowering + macro pre-lowering | — | Medium |
| 1 | **`sourcemap.json`** | `TracedBuilder` bracket in each orchestrator; `src/system/sourcemap.ts`; `--sourcemap` flag | 0 | Medium |
| 2 | **`ddd trace`** | CLI stack-trace translator (all backends) | 1 | Small |
| 3 | **LSP nav** | source↔target "go to generated code" | 1 | Medium |
| 4 | **Statement granularity** | `origin` on `StmtIR`; line-anchored `render-stmt` | 0 | Medium |
| 5 | **Source Map v3 (JS)** | `.map` + `sourceMappingURL` for the 4 JS backends | 1, 4 | Small–Med |
| 6 | **.NET `#line` + Java SMAP** | enhanced `#line` → PDB; JSR-45 injector | 4 | Med / Med–Hard |
| 7 | **Char/expression granularity** | `origin` on `ExprIR`; span-tracking `lines()` | 4 | Large |
| 8 | **DAP** | adapter reusing target debuggers (JS/.NET/JVM); scope remap | 5, 6, 7 | Large |

Phases **0 → 1 → 2** are the core investment and already deliver
cross-backend post-mortem debugging. **3** is cheap in-editor value off the
same base. **4** is the hinge that makes **5/6** useful. **7/8** are the
optional last mile.

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
- **Open — formatter ordering.** Does map-build run after Biome on
  generated TS, or do we re-anchor via markers post-format? (§8)
- **Open — Java SMAP injection.** Post-`javac` class rewrite vs a javac
  plugin vs shelling to Kotlin's tooling. (§6C)

## 11. Non-goals

- Char-level precision from day one (deferred to §5.3 / Phase 7).
- Native step-debugging for Python/Elixir (trace-tier only; §3).
- Debugging the *compiler* itself — pipeline/IR introspection is a
  separate concern (`unfold`, AST printer, per-phase dumps already exist).
- Reformatting or prettifying generated output — the map anchors to bytes
  as emitted.
