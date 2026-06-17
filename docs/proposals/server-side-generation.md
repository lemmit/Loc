# RFC: Server-side generation — moving the backend generators off the client

**Status:** Draft / Proposed (vision + architecture). No grammar, IR, or
generator work; the two enabling refactors have shipped (see §3). This doc
captures the destination and the contract; execution is a separate plan.

**Scope:** Move premium multi-backend code generation (.NET / Java / Phoenix /
Python — and the agentic authoring loop and its prompts) **off the browser and
onto a server**, while keeping the language services, the IR, and in-browser
Hono generation client-side. This is the step that turns the *bundle* boundary
(generators code-split out of the main client chunk) into a *trust* boundary
(generators never shipped to the client at all), and it is the technical
substrate for the open-core / paid product split.

Companions / prior art:

- The metadata/generation registry split (PR #1251) — `platform/metadata.ts`
  (client-safe descriptor + ref parsing) vs `platform/registry.ts` (the
  generation half). Pinned by `metadata-boundary.test.ts`.
- The playground bundle code-split (PR #1256) — `build.worker.ts` loads
  `system/index` via a dynamic `import()`; pinned by
  `web-bundle-boundary.test.ts`. **That dynamic-import call site is the exact
  seam this RFC fills.**
- [`agent-tools-and-mcp.md`](./agent-tools-and-mcp.md) /
  [`ai-authoring-loop.md`](./ai-authoring-loop.md) — the transport-neutral
  `src/api/` + `src/tools/` surface a server reuses.

---

## 1. The problem

Loom's moat is the resolved IR + the multi-backend generators (the scarce,
hard-to-replicate part — nobody else emits production .NET / Phoenix / Java /
Python from one model). Two facts make that moat hard to monetise while the
generators run on the client:

1. **Anything shipped to the browser is takeable.** Code-splitting (PR #1256)
   keeps the generators out of the *main* bundle, but the split chunk is still
   served to, and downloadable by, any client. Tree-shaking is a bundle-size and
   layering win, not IP protection.
2. **The agentic authoring loop needs the prompts and the validator together.**
   The prompts that drive `prompt → .ddd` are IP; whoever runs the LLM call sees
   them. Running the loop client-side would ship the prompts. (See the BYOK
   analysis in the design notes: server-side calls keep prompts secret; the
   user's key is handled transiently.)

The resolution is the same for both: **the generators and the agentic loop run
on a server the client calls; the client keeps only what is meant to be free and
inspectable** — the language services, the IR, and the in-browser Hono path.

This is not a rewrite. The one-directional pipeline already makes the front half
(`language/` + `ir/`) registry-free and the generators a cleanly-separable
subtree; the seam is already a `dynamic import()`. This RFC swaps that local
import for a network call.

## 2. The model in one screen

```
            CLIENT (free, inspectable)                 SERVER (closed, gated)
  ┌─────────────────────────────────────────┐   ┌──────────────────────────────┐
  │ language services (LSP, validators)      │   │ generation registry          │
  │ IR: lower → enrich → validate            │   │  → .NET / Java / Phoenix /    │
  │ Hono generation + in-browser run (PGlite)│   │     Python generators         │
  │ visual builder, example gallery          │   │ system compose + migrations   │
  │                                          │   │ agentic loop + PROMPTS        │
  │  POST /generate  ─────────────────────────▶ │  (LLM calls; user key transient)│
  │  { model | source, target, options }     │   │                              │
  │  ◀───────────────────────── { files[] }  │   │ credits meter / auth          │
  └─────────────────────────────────────────┘   └──────────────────────────────┘
```

- The **client** validates and previews entirely on its own (no server round-trip
  for editing), and runs Hono in-browser. It never holds a premium generator.
- The **server** receives a *validated model* (or `.ddd` source), runs the
  premium generators and/or the agentic loop, and returns a file map. It is the
  only place the generators and prompts exist.

The request that crosses the wire is the **model / source + a target**, never the
generator. The response is **plain owned code** — the no-lock-in property is
preserved (the user can take the output and leave; what they pay for is the
*ongoing* ability to (re)generate across stacks, plus hosting/governance).

## 3. What already exists (the seam)

The dynamic-import call sites in `web/src/build/build.worker.ts`:

```ts
const { generateSystems } = await import("../../../src/system/index.js");
//  → wrapGenerate("system", …, () => generateSystems(input.model).files)
```

Stage 2 replaces the `import()` with a transport call behind the same
`wrapGenerate("system", …)` shape:

```ts
const files = await generateOnServer({ model: input.model, target: "system", … });
//  same GenerateResult shape; the worker is otherwise unchanged
```

Everything downstream of `wrapGenerate` (the file map, the diagnostics) is
identical, so the playground UI is untouched. The Hono `"ts"` branch stays
local.

## 4. The generation API contract

A single transport-neutral endpoint over the existing `src/api/` toolkit
(`validate` / `generate` already return wire shapes). Sketch:

```
POST /v1/generate
  body: {
    source: string            // .ddd text (preferred — server re-parses/validates)
            | model: LoomModel // or a pre-lowered model for trusted callers
    target: "system" | "dotnet" | "java" | "elixir" | "python" | "hono"
    options?: { design?, axes?, trace?, … }   // the same knobs the CLI takes
  }
  → 200 { ok: true,  files: Array<{ path, content }>, diagnostics: [] }
  → 200 { ok: false, diagnostics: [...] }          // validation / lowering errors
  → 402 { error: "insufficient_credits" }           // metered tier
  → 401 { error: "unauthenticated" }
```

Design rules:

- **Server re-validates.** Prefer `source` over `model`: the server parses,
  lowers, enriches, and IR-validates before generating, so it never trusts a
  client-supplied IR. (The client still validates locally for instant feedback —
  the two share `src/api/`.)
- **Stateless per request.** The model in, files out; no server-side project
  state required for the core call. Project storage / collaboration is a
  separate, higher tier.
- **Streaming optional.** Large multi-deployable trees may stream file entries;
  v1 can return the whole map.
- **The agentic loop is the same endpoint family** — `POST /v1/author`
  (`{ prompt, source? } → { source, diagnostics }`) runs the generate→validate→
  correct loop server-side, where the prompts live (§6).

## 5. The boundary — what runs where

| Concern | Client (shipped, free) | Server (closed, gated) |
|---|---|---|
| Parse / scope / validate / type-system (LSP) | ✓ | (also, for re-validation) |
| IR lower / enrich / validate | ✓ | ✓ |
| Hono generation + in-browser run | ✓ | — |
| .NET / Java / Phoenix / Python generation | — | ✓ |
| `system` compose + migrations derive | — | ✓ |
| Agentic `prompt → .ddd` loop + **prompts** | — | ✓ |
| LLM calls (BYOK or metered credits) | — | ✓ (key transient) |
| Auth / credits / project storage / governance | — | ✓ |

The line is the one the earlier design work landed on: **the client owns the
build-and-own-locally loop for the free stack; the server owns generating the
scarce stacks, running them, and governing them for a team.**

## 6. Security & IP

- **Generators never reach the client.** Post-Stage-2 the premium generator code
  is server-only — not in any chunk, not downloadable. The `metadata-boundary`
  and `web-bundle-boundary` tests already guarantee they aren't in the front-half
  or main-bundle graphs; the server build is simply where they live.
- **Prompts stay secret.** The agentic loop runs server-side, so the prompts are
  never shipped — the unavoidable "whoever calls the LLM sees the prompt"
  coupling is resolved in the server's favour.
- **User keys are transient.** BYOK: the key is held in-memory for the request,
  never persisted, never logged; recommend a dedicated spend-capped key.
  Metered: prepaid credits fund the inference (cash-positive before spend).
- **Output is owned and portable.** The response is standard code in the user's
  stack — the no-lock-in property holds. Monetisation is on *generating /
  regenerating at scale*, hosting, and governance — not on locking the artifact.

## 7. Deployment shapes

The same server image serves three go-to-market shapes (no code fork):

1. **Hosted SaaS** — the playground/product calls the managed endpoint; credits
   meter inference + premium generation.
2. **On-prem / self-hosted** — regulated buyers run the closed server image
   inside their walls (air-gappable); no source required (a licensed binary, not
   OSS). This is why "on-prem" never needed an open generator.
3. **Local CLI (unchanged)** — `ddd generate` keeps running the full toolchain
   locally for developers who have the package; the server split is a *product*
   surface, not a removal of the CLI.

## 8. Phasing

**Phase 1 — the endpoint + the swap.**
Stand up `POST /v1/generate` over `src/api/` (Node server, reusing the registry +
`system/`). Replace the playground worker's `import("system/index")` with a
`generateOnServer(...)` call behind the same `wrapGenerate("system", …)` shape.
Hono `"ts"` stays local. Exit: playground generates every backend via the server,
output byte-identical to today; `web-bundle-boundary` still green (the dynamic
import is gone, replaced by a fetch — tighten the test to also forbid the dynamic
`import()` once the fetch lands).

**Phase 2 — auth + credits.**
Gate the endpoint: authentication, prepaid-credit metering on premium generation
and the agentic loop, BYOK passthrough. Free tier = Hono local + example gallery;
premium generation = metered.

**Phase 3 — the agentic loop server-side.**
`POST /v1/author` runs prompt→validate→correct with the prompts server-side;
BYOK or metered. This is the "AI builder with a real compiler" product surface.

**Phase 4 — packaging the server.**
A `packages/ddd-server` (or reuse the `ddd-mcp` island pattern) that bundles the
closed server for hosted + on-prem distribution; the client bundle ships without
it.

## 9. Open questions

- **Source vs model on the wire.** Default to sending `.ddd` source (server
  re-validates, never trusts client IR) — but a `model` fast-path for trusted
  first-party callers may be worth it. Likely source-only for v1.
- **Where the Hono line sits.** Hono stays client-side as the free/runnable
  stack. Do we *also* offer server-side Hono generation for parity in the
  metered tier, or keep Hono exclusively local? Leaning: local only (it's the
  giveaway).
- **Offline / CLI parity.** The CLI keeps the full local toolchain. Does the
  *product* ever need an offline premium mode (on-prem covers regulated; what
  about a disconnected laptop)? Probably out of scope — on-prem is the answer.
- **Test strategy for "not in the client at all."** Today's guards check the
  source/static graph. Once generation is a fetch, add a built-bundle assertion
  (grep the produced client chunks for a known premium-generator signature ⇒
  absent) so the *artifact*, not just the import graph, is pinned.
- **Streaming + large trees.** Whole-map response v1; streaming if showcase-scale
  trees pressure payload size.

## 10. Why this is the right shape

The whole point of the two shipped refactors was to make this step *wiring, not
surgery*. The front half is registry-free, the generators are a separable
subtree, and the call site is already an `await import(...)`. Stage 2 swaps a
local dynamic import for a network call — and in doing so converts a
bundle-layering property into the product's actual trust boundary: **the moat
runs on the server, the free/inspectable stack runs on the client, and the line
between them is one HTTP call.**
