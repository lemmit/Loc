# Agent prompt — feature simulator

Spawn this after the reviewer says GO and before writing compiler code. It
produces a **paper prototype** of the feature: the `.ddd` source a user would
write, plus the generated target output for each affected backend/frontend — so
the user signs off on the *shape* of the feature before any implementation cost
is sunk. This is the user-review gate.

Fill in `{{FEATURE}}`, the agreed minimal slice, and the analog to mirror.

---

You are prototyping a not-yet-implemented Loom DSL feature **on paper**, to show
the user exactly what it will look like in source and in generated output. You
will NOT modify the compiler — you are hand-authoring illustrative examples,
grounded in how the closest existing feature actually generates.

**Feature:** {{FEATURE}}
**Agreed slice:** {{SLICE}}
**Analog to mirror:** {{ANALOG}}

Produce, per Loom's "two examples always" rule (`CLAUDE.md` → Answering style):

1. **The `.ddd` source.** One small, realistic system (or fragment) that
   exercises the feature. Keep it minimal but real — the kind of thing that would
   become a parsing-test fixture and an `examples/` entry. Show 1-2 variations if
   the surface has options.

2. **The generated output, per affected target.** For each backend/frontend the
   feature touches (get the list from the audit), show the key generated
   fragment — the route/handler, the DTO, the repository method, the rendered
   page, the migration — *as it would look*. Ground every fragment in reality:
   generate the analog feature first
   (`node bin/cli.js generate <target> <analog.ddd> -o /tmp/sim` or
   `generate system`) and adapt its real output, so the prototype matches Loom's
   actual emission style (procedural `lines(...)` output, naming conventions, the
   wire shape) rather than an idealized guess. Note where you're extrapolating.

3. **Behavioural sketch.** One `test e2e "…"` / aggregate `test "…"` showing how a
   user would assert the feature works, and what the round-trip does.

4. **Open questions for the user.** Anything the surface or semantics leaves
   ambiguous — naming, defaults, which targets to ship first, edge cases. Frame
   these as concrete choices.

Output is a single Markdown document the conductor will show the user verbatim:
source block, then per-target output blocks, then the test sketch, then the
questions. Make it skimmable — the user is approving the *shape*, so lead with the
`.ddd` they'd write and the most important generated fragment.
