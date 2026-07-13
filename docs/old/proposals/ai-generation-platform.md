# Loom as an AI generation platform — vision & strategy

> **Status:** PROPOSED / strategy — no code yet.
> **Role:** Reframes Loom from "a low-code DSL with a compiler" to "an AI
> generation platform that happens to have been built engine-first." Sets the
> product vision (what the platform is and why its architecture makes it
> categorically better than code-first AI builders) and the strategy (where it
> competes, the defensible wedge, sequencing, and business model).
> **Companion docs:** the agent/loop mechanics live in
> [`ai-authoring-loop.md`](./ai-authoring-loop.md); the machine-readable
> interface the agent consumes lives in
> [`ai-diagnostics-contract.md`](./ai-diagnostics-contract.md).
> **Scope:** product/strategy framing across the whole existing pipeline
> (`.ddd` → 10-phase compiler → four backends + `.loom/` bundle). No grammar
> or IR change is required for the thesis; the platform is integration + UX
> over assets that already exist.

---

## 1. The thesis in one paragraph

Every AI app builder shipping today (Lovable, Bolt, v0, and the spec-driven
tools — GitHub Spec Kit, AWS Kiro, Tessl) generates **code directly from
prose**. That single architectural choice is the root of their shared
failure mode: the artifact the model edits — an unbounded pile of generated
code — grows and loses structure, so the AI re-reads its own accumulating
mess, context rots, and the app gets *worse* the bigger it gets. The
industry's own verdict on spec-driven AI is that "spec drift and
hallucination are inherently difficult to avoid" and that it "isn't
deterministic; this poses challenges for upgrades and maintenance." **Loom
changes the artifact the AI edits.** The AI never writes code; it maintains a
compact, typed, validated `.ddd` model, and Loom's deterministic compiler
turns that model into the system. The model is the AI's memory — and because
the model stays small and structured no matter how large the generated
system gets, **the AI's effectiveness does not decay with app size.** That is
the property that separates a demo from a system you run a business on, and
it is an architectural choice a code-first builder cannot retrofit.

---

## 2. Vision

### 2.1 The narrow waist

Loom owns the full hourglass. The `.ddd` model is the narrow waist — the same
shape that made IP the waist of the internet and LLVM IR the waist of
compilers. Above the waist, anything goes; below it, nothing is left to
chance.

```
    ┌──────────┐   ┌──────────┐   ┌──────────┐
    │   CHAT   │   │  VISUAL  │   │   CODE   │     three coequal editors
    │ (AI agent)│   │ (builder)│   │  (.ddd)  │
    └────┬─────┘   └────┬─────┘   └────┬─────┘
         └──────────────┼──────────────┘
                        ▼
                ┌────────────────┐
                │   .ddd MODEL   │   single source of truth (typed, validated)
                └───────┬────────┘
                        │  Loom compiler  (deterministic, governed)
          ┌─────────────┼─────────────┬─────────────┐
          ▼             ▼             ▼             ▼
        Hono          .NET        Phoenix         React
        + migrations + tests + docker + .loom/ audit bundle
```

- **Above the waist** the LLM can be wrong, creative, re-run, or swapped for a
  better model next quarter. Mistakes are cheap because they surface as a
  reviewable model patch, not as code in production.
- **Below the waist** phases ③–⑦ resolve names, types, and contracts once, and
  phases ⑧–⑩ emit byte-identical output every time. The AI cannot introduce
  drift into a route handler because it never writes route handlers — it
  writes `operation debit(amount: Money) { precondition balance.amount >= amount.amount … }`
  and the compiler writes the handler, the same way, forever.

### 2.2 One model, three editors

Loom already has the pieces for three coequal editing modalities converging on
one canonical artifact:

- **Chat (AI agent)** — authors and patches the model through the
  validate/repair loop (see [`ai-authoring-loop.md`](./ai-authoring-loop.md)).
- **Visual builder** — the surface the README already names ("the model, a
  visual builder, and full ownership").
- **Code (`.ddd`)** — the power-user escape hatch.

The round-trip is feasible because `src/language/print/` already prints
IR → canonical `.ddd`. The AI reads back a *canonical* model rather than
free-form text; the visual builder renders the same model; a developer can
drop to the DSL. All three are bidirectional, all on one artifact. No
code-first builder can offer this, because they have no clean intermediate
model — only code.

### 2.3 The model is the memory — no context rot

This is the load-bearing vision claim, and it follows from Loom's existing
~1:6–1:13 source-to-generated ratio:

> No matter how large the generated system gets — four stacks, hundreds of
> routes, a real domain — the thing the AI reasons over stays small,
> structured, and clean (hundreds of model lines, not thousands of code lines
> per stack). The AI's effectiveness does not decay with app size.

Code-first builders move *complexity into the AI's context*, where it can only
be handled probabilistically and degrades. Loom moves complexity *into a
compiler*, the one place it can be handled deterministically. This is the
real answer to the "70% problem" (AI builds a slick prototype, then you are
stuck debugging code nobody understands): there is no 4,000-line code surface
to get lost in — there is a 300-line model and a compiler.

### 2.4 The living app

Current AI builders are one-shot generators with a chat bolted on; each
request mutates an opaque codebase. Loom-as-platform is a **continuous
modeling environment**: the app *is* the model, and every interaction — AI,
drag, or DSL — is a reviewable, revertible, git-tracked model edit. This
unlocks what code-first builders structurally cannot do:

- **Safe evolution.** "Add soft-delete to every aggregate" is a one-line
  capability/macro on the model (`src/macros/stdlib/softDelete/`) that the
  compiler propagates across all four stacks consistently — not a 40-file AI
  refactor you pray about.
- **Regeneration without fear.** New backend? Flip `platform:`. New design
  pack? Swap it. The AI never has to re-understand the app, because the
  understanding lives in the model, not in the AI's degrading context.
- **History that means something.** The model's diff is *why the system
  changed*, not just which bytes moved.

### 2.5 Governance — the enterprise unlock

Enterprises are blocked from shipping AI-built software because they cannot
audit it. Loom is the only AI platform where *auditable-by-construction* and
*AI-authored* coexist: the model already carries `requirement → solution →
test → code` traceability (`docs/traceability.md`), `provenanced` value
lineage (`docs/provenance.md`), and per-requirement verdicts via `ddd verify`.

> "An AI built this system, and here is the machine-checked proof that every
> requirement is implemented, tested, and that this computed value came from
> this rule." No other AI platform can produce that sentence.

---

## 3. Why this is categorically better than code-first AI builders

| Capability | Code-first AI builders | **Loom AI platform** |
|---|---|---|
| Behaviour as app grows | degrades (context rot, 70% wall) | **stable — AI edits a compact model** |
| Maintain / evolve later | reprompt → different code | **edit model → exactly-derivable diff** |
| Output stacks | one (usually React + Node) | **four, proven contract-equivalent** (`docs/conformance.md`) |
| Correctness | hope | **type-checked + conformance-gated** |
| Review surface | thousands of code lines | **hundreds of model lines** |
| Auditability | none | **traceability + provenance built in** |
| Editing modalities | chat only | **chat + visual + code, one model** |
| Ownership | improving (some emit real code) | **total — plain code, no runtime** |

The defensible headline: **"Bolt builds you a prototype you'll throw away.
Loom builds you a system you'll run for ten years — because the AI maintains a
model, not a mess."**

---

## 4. Strategy

### 4.1 The competitive landscape, honestly

Five clusters compete for the same budget. Loom's profile is a deep, narrow
spike, not a broad platform:

- **Enterprise model-driven low-code** (OutSystems, Mendix) — win on breadth,
  on-ramp, ecosystem; lose on lock-in (proprietary runtime, "can't take the
  code elsewhere") and cost (OutSystems enterprise ≈ $36k/yr, AO-based,
  "complicated and unpredictable"). Loom is the *answer to the question they
  create*, not a like-for-like replacement today.
- **Internal-tool builders** (Retool, Appsmith, Budibase) — win on
  time-to-first-tool; structurally capped on domain logic and ownership ("you
  cannot export the code"). Different game; small overlap.
- **AI app builders / spec-driven** (Lovable, Bolt, v0; Spec Kit, Kiro,
  Tessl) — win on on-ramp and hypergrowth (Bolt ≈ $40M ARR in 6 months,
  Lovable ≈ $20M ARR in 2 months); lose on determinism, maintenance,
  multi-stack, and audit. **This is the cluster Loom both competes with and
  completes.**
- **Model/codegen frameworks** (JHipster, Amplication, Wasp, Redwood, Encore)
  — Loom's true peers. None combine deterministic multi-backend *with proven
  contract parity* + DDD depth + built-in governance. Stronger engine; near-zero
  market presence.
- **Backend-as-projection** (Hasura, Supabase, Directus) — domain logic lives
  *outside* the schema projection; Loom is the inverse (logic inside the
  aggregate). Small overlap, clean talking point.

### 4.2 The defensible whitespace

Strip every axis a competitor already wins and the uncontested intersection
is precise:

> **A deterministic, ownership-preserving, AI-authored generator for
> domain-rich systems that must satisfy an auditor — across more than one tech
> stack.**

No competitor occupies all of it: AI builders have determinism = 0 and
governance = 0; OutSystems/Mendix have ownership = 0 and multi-stack = 0;
JHipster/Wasp/Amplication have governance = 0 and DDD depth ≈ 0;
Hasura/Supabase have domain-logic depth ≈ 0. That intersection is
**regulated, engineering-led, domain-heavy systems** (fintech, healthtech,
govtech, insurance, supply-chain) — a well-funded niche where traceability and
provenance are line items, not nice-to-haves, and where consumer-grade AI
builders cannot follow.

### 4.3 The inversion that makes the strategy work

Loom's worst competitive axis is its on-ramp: a human must hand-write a typed
DDD DSL. **The moment a machine writes the DSL, that weakness disappears — and
the deterministic compiler, Loom's best axis, becomes the scarce asset.**
Anyone can prompt an LLM; almost nobody can build a deterministic,
multi-backend, conformance-proven compiler with governance baked in. The AI
layer removes the adoption barrier; the compiler is the moat.

Every property of Loom that looks like over-engineering for a hand-authored
DSL — the determinism discipline, the conformance harness, the governance
artifacts, the platform-neutral IR, the in-browser compiler — is *exactly*
what you would build if your real goal were a trustworthy AI generation
platform. The missing piece is not the hard part. It is the cockpit.

### 4.4 Emphasis — platform-first, both motions (pinned: D-AI-EMPHASIS)

Three coherent paths were on the table: **A — IR-first** (`@loom/core` as the
engine other AI builders embed), **B — mass-market platform**, **C — vertical
platform** (the regulated/domain-heavy niche). The pinned decision
([D-AI-EMPHASIS](../../decisions.md#d-ai-emphasis--loom-leads-as-a-platform-mass-market-land--regulated-expand-ir-embedding-deferred))
is **B + C**: Loom leads as a first-party platform across both motions, with A
deferred to a later channel.

1. **B is the funnel.** A free/low tier for the broad "describe an app" market
   is the distribution and brand engine. It is winnable *not* on UX polish
   alone but on the genuine differentiators — model-as-memory (no context rot
   as the app grows), determinism (maintainable/upgradable output),
   multi-stack, and code ownership. The pitch is "AI apps that don't collapse
   at scale and that you own," not "a prettier Bolt."
2. **C is the revenue.** The regulated/engineering niche is where pricing power
   lives — governance/conformance/provenance reporting, private backends,
   hosted `verify`, SLA'd determinism. B lands these users; C expands them.
3. **A is deferred, not dropped.** IR-embedding is a later channel/partnership
   play, reachable *from* a proven platform; the reverse climb (embedded engine
   → owns the customer) is much harder.

This is a GTM/narrative choice, not an architecture fork: B, C, and A all run
the *same* validate/repair/verify loop over model patches, so the wedge demo
(§6) advances all of them and committing to B+C keeps A open at zero technical
cost.

**Honest caveat (carried from the decision).** B+C is the highest-prize *and*
highest-cost path, and leans hardest on Loom's weakest muscle — consumer AI UX
and the capital/team to compete on it. It is justified only if (a) the on-ramp
is made cheap so the engine carries the UX (grammar-constrained `.ddd` +
context-pack, [`ai-authoring-loop.md`](./ai-authoring-loop.md) §5) and (b) the
wedge demo (§6) is proven first. If funding/team for B does not materialise,
fall back to **C-only** (vertical-first) rather than A — keep the direct
customer.

### 4.5 Business model

- **Open-core the waist, monetize the guarantees.** `@loom/core` (compiler +
  DSL) open and embeddable to drive adoption; charge for what the niche
  actually pays for — governance/conformance/provenance reporting, private
  backends, hosted `verify`, SLA'd determinism, team/collaboration.
- **Fixes the no-lock-in revenue problem.** "You own the code" undercuts the
  per-seat runtime tax that funds OutSystems/Mendix. The AI framing solves it:
  you do not rent the runtime, you rent the **continuous authoring + guarantee
  loop** — recurring and sticky precisely because the model is the living
  source of the business's software.
- **Two buyers:** prosumer/startup ("AI-build a real product you actually own
  and can maintain") and regulated enterprise ("AI-build systems you can put
  in front of an auditor"). Pricing power lives in the second, where
  competitors cannot follow.

---

## 5. Risks and honest reads

1. **The on-ramp becomes the whole battle, and it is Loom's weakest muscle.**
   The engine is world-class; the AI cockpit, prompt quality, preview UX, and
   polish are what users feel — and Bolt/Lovable are exceptional there with
   huge head starts. *Mitigation:* IR-first (§4.4) avoids fighting on this
   axis until it is de-risked.
2. **LLMs may author `.ddd` poorly** (scarce training data). *Mitigation:* the
   grammar is closed and small → grammar-constrained decoding is tractable
   (unlike constraining "write an app"); plus a context-pack, few-shot, or a
   small fine-tune, backed by the typed repair loop. This is the technical
   make-or-break; see [`ai-authoring-loop.md`](./ai-authoring-loop.md) §5.
3. **Frontier models get good enough at raw multi-file code** that determinism
   matters less for simple apps. *Mitigation:* determinism's value is
   maintenance, upgrades, and audit — a non-determinism problem that does not
   shrink with model capability — and the model-as-memory advantage compounds
   with *complexity*, exactly where code-first builders break.
4. **Platform execution surface is large** (auth, billing, collaboration,
   hosting, support, growth) and the project reads as small/early. *Mitigation:*
   IR-first needs none of that; it buys time and revenue to build the cockpit.

---

## 6. The wedge — what to build first

One demo de-risks both strategies, and it is mostly assembly of parts that
already exist (the in-browser compiler, the conformance harness, the `.loom/`
bundle):

> **"Talk to it → owned, multi-stack, audited app," end-to-end in the browser
> playground:** the user describes a domain in prose → the AI authors `.ddd`
> through Loom's validate/repair loop → the compiler emits Hono + .NET + React
> with the conformance harness green → the diff the user reviews is *the
> model*, and the `.loom/` audit bundle is the kicker.

If that lands — an AI authoring a *model* that compiles to four
proven-equivalent stacks with an audit trail, the AI never touching code — you
have simultaneously proven the platform's core loop and the IR's value. The
concrete build plan and the loop mechanics are specified in
[`ai-authoring-loop.md`](./ai-authoring-loop.md); the machine-readable
contract the agent consumes is specified in
[`ai-diagnostics-contract.md`](./ai-diagnostics-contract.md).

---

## 7. Open questions

- ~~**Platform vs. IR emphasis at launch.**~~ **Resolved — pinned as B+C**
  (platform-first across mass-market land + regulated expand, IR-embedding
  deferred) in
  [D-AI-EMPHASIS](../../decisions.md#d-ai-emphasis--loom-leads-as-a-platform-mass-market-land--regulated-expand-ir-embedding-deferred);
  see §4.4. Open sub-question: the B/C balance of *initial* spend (how much
  mass-market growth before niche monetisation) stays a judgement call pending
  the wedge demo.
- **How much DDD altitude to expose to the AI.** Full DDD (aggregates,
  invariants, workflows) is the depth moat but raises authoring difficulty;
  a "scaffold-first, deepen-on-request" gradient may be the right default.
- **Visual builder ownership of the model.** Confirm the builder reads/writes
  the *same* canonical model the AI and DSL do (it must, for the three-editor
  vision to hold).
- **Where the agent runs.** In-browser (`web/` imports `../src`) for latency
  and privacy vs. server-side for larger models — likely both, with the
  compiler always client-side as the fast repair oracle.
