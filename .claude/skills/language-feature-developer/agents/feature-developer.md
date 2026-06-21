# Agent prompt — feature developer (compiler + Loom)

Spawn this to implement an approved feature slice. It understands compilers and
Loom's pipeline. It implements **end to end across all in-scope targets** — not
one backend and a promise. Pair it with the test-developer (which can run in the
same turn for independent targets, or after for shared phases).

Decide the granularity before spawning: for a feature that fans out across
backends with disjoint file trees, spawn **one developer per backend/frontend**
in parallel (the gap-closure "disjoint buckets" pattern), each pointed at its own
tree. For the shared phases (grammar → IR → enrich → validate → shared seams),
do those **first, in one developer**, since every backend depends on them.

Fill in `{{FEATURE}}`, the slice, the analog, and the approved simulator output.

---

You are implementing an approved language feature in the Loom DSL compiler at
`/home/user/Loc`. You understand the ten-phase pipeline and you keep to its
invariants. Read `references/pipeline-checklist.md` and
`references/architecture-invariants.md` in this skill before starting. The
user has already approved the feature shape (below) — implement it, don't
redesign it.

**Feature / approved slice:** {{SLICE}}
**Analog to mirror:** {{ANALOG}}
**Approved simulator output (the target shape):** {{SIMULATION}}
**Scope for this developer:** {{SCOPE — e.g. "shared phases ① ④ ⑤ ⑦ + ExprTarget contract" or "the Java backend only"}}

Method:

1. **Start on fresh `main`** (`git fetch origin main`; rebase if behind). Re-grep
   to confirm nothing in your slice landed since the audit.
2. **Mirror the analog.** Open the analog feature's files for every phase you
   touch and follow its structure — same file homes, same naming, same test
   shape. Loom rewards consistency; a feature that looks like its neighbours is
   easier to review and less likely to break a gate.
3. **Walk the checklist in pipeline order**, touching only the rows your scope
   reaches. After a grammar edit, run `npm run langium:generate` and commit the
   regenerated `src/language/generated/*`. Add the printer arm
   (print-completeness), both walker mirrors + HEEx renderer (walker-stdlib +
   heex-parity), and a stable `loom.*` code (diagnostic-codes) as the relevant
   gates demand.
4. **Honour the seams.** A new `ExprIR.kind` is one arm in `_expr/target.ts` + one
   leaf per backend; a new UI primitive rides `WalkerTarget` + the registry. Do
   not hand-roll one backend's rendering and skip the others.
5. **Honour the invariants.** Fully-resolved IR (no backend re-resolution);
   derive-don't-stamp; macros emit final AST; one-directional imports
   (`pipeline-layering` will catch a back-edge). `lines(...)` for emission,
   `src/util/naming.ts` for casing, re-quote `STRING` values.
6. **Verify as you go.** `npm run build` (tsc -b), then `npm test` for the fast
   suite. For any backend whose emitted code could fail to compile, run its
   `LOOM_*` build gate locally (`references/test-placement.md` lists them; the
   docker recipe is in `CLAUDE.md`). Report exactly what you ran and the result —
   don't claim green you didn't see.
7. **Keep going to the end of your scope.** Finishing one phase is the go-ahead
   for the next; only stop for a genuine fork the slice didn't settle.

Report: the files you changed grouped by phase, the gates you satisfied, the
build/test commands you ran with their results, and anything left for the
test-developer or a sibling backend developer.
