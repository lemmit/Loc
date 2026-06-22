# Authoring the Loom Language Reference

This is the **contract** every chapter in `docs/language-reference/` follows.
The goal: one self-contained page per group of language features, each
feature shown as a *triple* — what it is, the `.ddd` you write, and the
real generated output on each platform that emits it.

Read this before editing any `NN-*.md` chapter.

## Voice

Per `CLAUDE.md`: **lead with the answer, cut the obvious, show don't
describe.** Every feature carries **two examples minimum** — the Loom
(`.ddd`) source *and* the generated target output. A short snippet beats
a paragraph. No "in this section we will…" preamble.

## Chapter anatomy

Each chapter is one `.md` file. Structure:

```md
# <N>. <Chapter title>

<One-paragraph orientation: what surface this chapter covers and when you reach for it.>

> **Grammar:** `RuleName`, `RuleName2` · **Validators:** `loom.some-code` · **Docs:** [`foo.md`](../foo.md)

## <Feature A>

<1–3 sentences: what it is and the rule that admits it.>

​```ddd
<minimal .ddd source that isolates this feature>
​```

<Optional: one sentence pointing at the salient line of output.>

::: tabs <group>
== node
​```ts
<real generated output, excerpted>
​```
== dotnet
​```csharp
…
​```
::: end

## <Feature B>
…
```

## The platform-tabs block

The lowering examples use a custom block the docs build renders as a
tabbed picker. Tabs sharing a **group** name switch together across the
whole page and persist (pick `node` once, every backend example
follows).

```
::: tabs backend
== node
​```ts
…
​```
== dotnet
​```csharp
…
​```
::: end
```

Rules:
- Open with `::: tabs <group>`, close with `::: end` (own line).
- Each tab starts with `== <label>` on its own line; the body below is
  full markdown (usually one fenced code block, but prose + multiple
  blocks are allowed).
- **Group names** — use exactly these so cross-page sync works:
  - `backend` for backend output. Tab labels: `node`, `dotnet`, `java`, `python`, `elixir`.
  - `frontend` for frontend output. Tab labels: `react`, `vue`, `svelte`, `angular`.
  - `pack` when the axis is design pack (`mantine`, `shadcn`, `mui`, `chakra`, `vuetify`, …).
  - Pick a descriptive group for anything else (e.g. `inheritance` for TPH-vs-TPC SQL).
- **Only include tabs for platforms that actually emit something for the
  feature.** A backend-only feature has no `frontend` group; a
  frontend-only feature (page primitive) has no `backend` group. If a
  platform has an *honest* gap (a `loom.*` validator forbids it), say so
  in one line instead of faking output — do not invent a tab.

## Sourcing the generated output — REAL output only

Examples are **generated**, never hand-waved. Workflow:

1. Write the minimal `.ddd` into a scratch file (e.g. `/tmp/feat.ddd`).
   Reuse the curated fixtures in `examples/` / `web/src/examples/` when
   one already isolates the feature.
2. Generate:
   ```bash
   node bin/cli.js generate system /tmp/feat.ddd -o /tmp/out
   ```
   For a single backend you can also use `generate ts|dotnet`. For the
   full multi-deployable tree use `generate system`.
3. Open the emitted file under `/tmp/out/<deployable>/…`, copy the
   **relevant fragment** (not the whole file), and paste it into the tab.
   Excerpt aggressively — show the lines the feature produces, elide the
   rest with `// …`.
4. Pick the fixture's deployables so every platform you want a tab for is
   actually emitted. The fastest way to get all five backends is a
   `system` with one deployable per platform, or generate the same `.ddd`
   once per platform pin.

If running codegen for a platform is impractical for a given feature,
prefer **fewer accurate tabs over more invented ones**. Accuracy is the
whole point — these pages double as generator documentation.

## Cross-linking

- Link sibling chapters by relative path: `[Expressions](05-expressions.md)`.
- Link the existing deep-dive docs where they exist
  (`../workflow.md`, `../auth.md`, …) rather than restating them.
- Keep the `> Grammar / Validators / Docs` callout under the H1 accurate;
  it is the chapter's "front matter".

## Scope discipline

- This is a **reference**, not a tutorial. One feature, one isolated
  example, move on.
- Don't document unshipped behaviour. Verify against fresh `main` — grep
  the emitter, not your memory.
- When a feature genuinely spans backends with divergent output, that
  divergence **is** the content — show both tabs side by side.
