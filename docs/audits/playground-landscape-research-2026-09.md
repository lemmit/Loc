# What a Loom playground should look like — landscape research, 2026-09

> Status: **research pass — 2026-09-02.** Companion to the
> [playground UX review](playground-ux-review-2026-09.md), which audited what
> ships today. This document looks outward: how the AI app builders (Replit,
> Lovable, v0, Bolt, Base44, Firebase Studio / AI Studio, Figma Make, Stitch),
> the compiler playgrounds (Compiler Explorer, the TypeScript playground,
> StackBlitz, CodeSandbox, the Rust / Go / Svelte / Elm / Gleam playgrounds,
> Mermaid Live, Val Town, Langium's own playground) and the model-driven and
> low-code tools (Structurizr, Context Mapper, JetBrains MPS, Prisma, dbdiagram,
> Wasp, Encore, Amplication, Retool, Appsmith, Bubble, Mendix, OutSystems)
> present the same problems Loom's playground has to solve, what published UX
> guidance says about human-AI tools, and what of it transfers to a
> **language-first** harness where the artifact is a `.ddd` model rather than a
> chat transcript.
>
> Every product claim below was checked against a live source (official docs,
> changelogs, or a credible review) in the first days of September 2026; the
> links are inline. Products move monthly — treat the *patterns* as durable and
> the feature checkboxes as a snapshot.

## 1. The one-paragraph answer

The three families converge on the same shell — **a conversation or editor on
the left, a live preview on the right, everything else behind tabs** — but they
differ in what the *unit of work* is. AI builders make the **chat turn** the
unit: every turn is a version, a diff, a credit, a restore point. Compiler
playgrounds make the **source buffer** the unit: compile on keystroke, output
side by side, a permalink that never dies. Model-driven tools make the
**model** the unit: one compile-time model feeds diagrams, docs, API explorers,
migrations and validation. Loom is the third kind wearing the clothes of the
first two, and its playground should say so: **the `.ddd` model is the
checkpoint, the diff, the thing you share, and the thing the agent is allowed
to touch.** Everything the AI builders had to bolt on to make chat safe
(plans, receipts, restore points, "what changed" summaries, loop detection)
falls out naturally when the artifact is a small, validated, diffable text
file — provided the playground shows it that way.

## 2. What each family solved

### 2.1 AI app builders — the chat-turn is the unit

Layout is uniform: chat left, preview right, code behind a toggle
([Lovable editor](https://docs.lovable.dev/features/projects/editor.md),
[v0 changelog](https://v0.app/changelog),
[Bolt code view](https://support.bolt.new/building/using-bolt/code-view.md),
[Replit preview](https://docs.replit.com/replit-workspace/workspace-features/preview),
[Base44 first prompt](https://docs.base44.com/Getting-Started/starting-from-your-first-prompt.md)).
The first screen is a single prompt box with template chips and attachment
menus. Ten things are now table stakes across nearly all of them:

1. **Plan / discuss before build**, priced cheaper than building. Lovable
   renders the plan as a document whose sections you highlight and re-prompt,
   with a word-level diff ([plan mode](https://docs.lovable.dev/features/plan-mode.md));
   Bolt's plan mode costs ~90% fewer tokens
   ([Bolt](https://support.bolt.new/best-practices/plan-mode.md)); Firebase
   Studio generated an editable **App Blueprint** before any code
   ([Firebase](https://firebase.google.com/docs/studio/get-started-ai)); Base44's
   Discuss mode carries a visible 0.3-credit price tag
   ([Base44](https://docs.base44.com/Building-your-app/AI-chat-modes.md)).
2. **Progress as activity cards** with an expandable tool timeline and a
   per-turn file diff (Lovable's Timeline / Changes tabs,
   [agent mode](https://docs.lovable.dev/features/agent-mode.md)); v0 shows the
   screenshots its agent takes while testing and asks clarifying questions as
   single/multi-select *inside the prompt form* ([v0](https://v0.app/changelog)).
3. **Every turn is a restorable version**, with per-message preview/restore
   icons in the chat and an explicit warning that the database is *not* rolled
   back — Replit is the only one whose checkpoints capture files, chat, config
   and optionally the DB, with "time travel" for the database
   ([Replit checkpoints](https://docs.replit.com/features/version-control/checkpoints-and-rollbacks),
   [Bolt rollback](https://support.bolt.new/building/using-bolt/rollback-backup.md)).
4. **Branches / drafts / forks** with their own chat and preview (Lovable
   Drafts, Base44 Branches with "Merge to main", Replit's parallel task copies
   on a Kanban board
   ([Agent 4](https://replit.com/blog/whats-changed-agent3-to-agent4))).
5. **Select an element, then prompt**, plus a **credit-free direct-manipulation
   tier**: v0's Design Mode edits Tailwind/shadcn props without spending
   credits, Lovable's preview toolbar has Select / Edit text / Draw / Comment
   modes ([Lovable toolbar](https://docs.lovable.dev/features/visual-edit)),
   Figma Make stages property edits until "Apply" creates a version
   ([Figma](https://help.figma.com/hc/en-us/articles/35710574222487-Beyond-the-basics-Using-Figma-Make)).
6. **Draw or annotate on the preview and batch-send** (v0 numbered
   annotations, Replit Design Canvas, Base44 Canvas of every page as a live
   frame, AI Studio annotation mode
   ([AI Studio](https://ai.google.dev/gemini-api/docs/aistudio-build-mode))).
7. **Device frames, open-in-tab, embedded console/network** — Replit embeds
   Eruda devtools with JS eval and element selection.
8. **A backend panel**: table grid, SQL editor, users, secrets, logs
   ([Lovable Cloud](https://docs.lovable.dev/features/cloud.md); v0's DB Studio
   drafts SQL from a description).
9. **One-click publish** with a visibility step (public / password / org), a
   pre-publish security scan, custom domains; GitHub two-way sync and ZIP.
10. **Visible cost per message, a free or rate-limited "fix this" button, and
    pause-on-exhaustion** — because the dominant complaint everywhere is
    credits burned in fix loops (Bolt "rewrites the entire file… and still
    fails to fix the original problem", [Superdesign](https://superdesign.dev/blog/bolt-review);
    v0 "$300 to try to fix a simple parser bug", [Superdesign](https://superdesign.dev/blog/v0-review);
    Base44 at 2.8/5 on Trustpilot for the same reason).

The failure modes are as uniform as the layout: **loss of work** (v0 exports
missing files after 30+ prompts; Figma Make "deleted 90% of my project… cannot
be reverted",
[forum](https://forum.figma.com/report-a-problem-6/figma-make-just-deleted-90-of-my-project-2-weeks-of-work-gone-cannot-be-reverted-48358)),
**silent failure** (Lovable's inverted RLS across 170+ apps; "zero error
boundaries → silent white screens",
[getautonoma](https://getautonoma.com/blog/vibe-coding-failures)), **the agent
lying about state** (Replit's agent deleted a production database during a
code freeze and claimed rollback was impossible,
[The Register](https://www.theregister.com/2025/07/21/replit_saastr_vibe_coding_incident/)),
and **context loss** between turns that turns every fix into a regression
([Afterbuild](https://afterbuildlabs.com/platforms/lovable-developer/problems/stop-burning-credits)).
The remedies the vendors shipped afterwards — dev/prod database separation,
chat-only planning mode, one-click whole-project restore — are all things a
deterministic generator gets for free.

### 2.2 Compiler playgrounds — the source buffer is the unit

The best of them are defined by **immediacy and permanence**. Compiler Explorer
recompiles on every keystroke, needs no sign-in, and promises its links live
forever — it rescued 12,000 legacy short links rather than let them die
([Godbolt](https://xania.org/202505/compiler-explorer-urls-forever)). Its
signature feature is the **colour-mapped correspondence** between a source line
and the output it produced, with hover in either pane flashing the other
([CE docs](https://github.com/compiler-explorer/compiler-explorer/blob/main/docs/WhatIsCompilerExplorer.md)).
The TypeScript playground's redesign answered "the playground feels limited"
with compressed share URLs that carry only non-default options, an in-app
examples menu with read-tracking dots, an Errors sidebar, a `.JS` / `.D.TS`
output selector and a plugin API
([TS blog](https://devblogs.microsoft.com/typescript/announcing-the-new-typescript-website/),
[handbook](https://www.typescriptlang.org/_playground-handbook/examples.html)).
Svelte shows output as **tabs of kinds** (Result / JS / CSS / AST) with a
compiler-options panel beside the output; Rust does the same with ASM / LLVM
IR / MIR / HIR / WASM and hyperlinks every error code to the error index
([rust-playground](https://github.com/rust-lang/rust-playground/pull/896)). Elm
invests in **prose diagnostics with hints and doc links** and points learners
at the playground to read them
([InfoQ](https://www.infoq.com/news/2020/01/elm-learn-syntax-error-message/)).
Val Town's redesign was driven by two complaints — "what does Run do?" and
"where are my logs?" — and answered with **separate Save vs Run, Run
specialised per handler type, and logs inside the editor**
([Val Town](https://blog.val.town/editor-redesign)). Mermaid Live keeps state
in the URL hash *and* localStorage, has a History panel of auto-snapshots, a
read-only `/view` link, and an Autosync toggle for expensive renders
([mermaid-live-editor](https://github.com/mermaid-js/mermaid-live-editor)).
Langium's own playground — grammar, content, syntax tree, all client-side — is
the thinnest of the set: no examples, no persistence, no output beyond the AST
([TypeFox](https://www.typefox.io/blog/langium-playground/)). Loom's playground
already exceeds it; the gap to the leaders is presentation, not capability.

Table stakes for a compiler playground: a real editor with the real LSP and a
Problems list that jumps to source with error codes linked to docs; output as
per-kind / per-file tabs, not one blob; auto-compile with a toggle plus
`Ctrl/⌘-Enter`, and a visible status light per phase with "what actually ran";
a short share link that never dies plus a full-state hash fallback and a
read-only embed; localStorage autosave plus a history panel; an examples menu
organised by concept and addressable by URL; a settings drawer with the
important dropdowns first; a discoverable shortcut sheet and in-app handbook;
an honest small-screen mode. Source↔output correspondence is the
differentiator rather than table stakes — and Loom already has the data for it
in `.loom/sourcemap.json` and `ddd breakpoints`.

### 2.3 Model-driven and low-code tools — the model is the unit

This is Loom's actual family, and it has learned some expensive lessons:

- **Text is truth; layout is a cache.** Structurizr shut its browser workspace
  editor in 2022 and is "solely a text-based modelling tool"
  ([Structurizr](https://structurizr.com/help/workspace-editor)); its shadow
  `workspace.json` of node positions desyncs constantly. Eraser's answer is a
  draggable overlay that **resets on a significant code edit**
  ([Eraser](https://docs.eraser.io/docs/draggable-edits-beta)); LikeC4 stores
  layout as a hash comment next to the view *in the text file*
  ([LikeC4 #343](https://github.com/likec4/likec4/discussions/343)). Mermaid
  Chart's whiteboard is the only real two-way click-through — node ↔ code —
  and only for flowcharts ([Mermaid](https://mermaid.ai/docs/guides/whiteboard)).
- **Custom structured editors lose.** Darklang abandoned its "no syntax errors"
  Fluid editor — half the codebase, "users frustrated not being able to type
  the code they wanted" — for an LSP and VS Code
  ([Darklang](https://blog.darklang.com/an-overdue-status-update/)). JetBrains
  MPS users report the projectional editor "feels alien" for days
  ([MPS FAQ](https://www.jetbrains.com/help/mps/mps-faq.html)). Wasp dropped
  its DSL for `.wasp.ts` in May 2026 because IDE tooling reached "roughly 80%"
  at enormous cost while TypeScript's tooling is free; "language was never the
  moat, it's having a high-level understanding of your entire app at compile
  time" ([byteiota](https://byteiota.com/wasp-dsl-typescript-pivot/)). **Editor
  quality for the DSL is existential**, and Loom's Langium LSP is exactly the
  right bet — the playground must show it off, not hide it.
- **Migrations as plan → review → apply, with a hash-addressed history.**
  Prisma 8 prints a DDL preview, classifies operations Additive / Destructive /
  Data, refuses to apply when the database's schema-hash marker mismatches,
  and Prisma Studio renders a migration as **added models green, changed amber,
  untouched dimmed** with the executed SQL beside it and the migration id in
  the URL ([Prisma mental model](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/mental-model),
  [Studio migrations](https://www.prisma.io/blog/prisma-studio-migrations-view)).
  Loom's `MigrationsIR` and `--allow-destructive` gate are the same data.
- **A model-derived live dashboard next to `run`.** Encore's dev dash renders a
  Flow diagram (services, pub/sub, RPC edges) that updates as you type, a
  Service Catalog with always-current API docs, an API Explorer with params
  pre-filled from types, traces and a DB explorer
  ([Encore Flow](https://encore.dev/docs/platform/observability/encore-flow)).
  Loom's `.loom/` bundle (mermaid, LikeC4, wire-spec, traceability, AsyncAPI)
  is the same idea shipped as files — the playground shows them as a file tree.
- **Validation that blocks the irreversible with an escape hatch.** Bubble's
  Issue Tracker counter hides at zero and blocks deploy
  ([Bubble](https://manual.bubble.io/help-guides/getting-started/navigating-the-bubble-editor/tools/the-issue-tracker));
  OutSystems TrueChange lists broken references and blocks publish; Mendix's
  Errors pane has Error / Warning / Deprecation toggles, sortable columns and
  double-click-to-navigate ([Mendix](https://docs.mendix.com/refguide/errors-pane/));
  Structurizr lets you override the severity of every inspection per element
  ([inspections](https://docs.structurizr.com/workspaces/inspections)); Context
  Mapper ships quick fixes *and* eleven semantic refactorings (split aggregate,
  extract bounded context) as code actions
  ([Context Mapper](https://contextmapper.org/docs/getting-started/)).
- **Drill-down as navigation.** Structurizr double-clicks into the next C4
  level, shows a glyph on elements that have docs / decisions / children, and
  uses `Space` for quick navigation
  ([Structurizr navigation](https://docs.structurizr.com/ui/diagrams/navigation));
  dbdiagram has a global **detail-level** switch (all columns / keys / headers)
  ([dbdiagram](https://community.dbdiagram.io/t/feature-release-diagram-detail-levels/2275)).
  Retool's Explorer + State browser and Appsmith's Inspect Entity give a
  dependency graph per widget with click-through to the query
  ([Retool](https://docs.retool.com/apps/concepts/debug-tools),
  [Appsmith](https://www.appsmith.com/blog/debugging-your-app-in-appsmith-with-the-appsmith-debugger-part-1)).
- **Generated code: show it, diff it, link it back.** Wasp hides its output
  ("debugging generated code takes getting used to"); Amplication ships it as
  a pull request ("INSANE amount of files",
  [hamrodev](https://hamrodev.com/blog/programming/i-tried-amplication-so-you-dont-have-to-here-is-my-experience)).
  Both are complaints. The right shape is a browsable tree, a diff against the
  previous generate, and a link from every file back to the `.ddd` span that
  produced it.
- **Trace-driven development** survived Darklang's editor rewrite: send a real
  request first, it lands in a 404 list, create the handler from it, live
  values render beside every expression, side-effecting calls get an explicit
  replay button ([Darklang traces](https://docs.darklang.com/discussion/trace-driven-development)).
  Loom's preview already routes every fetch through the runtime worker; the
  traces exist, they just aren't shown next to the operation that handled them.

### 2.4 What the UX literature adds

The human-AI guidance is consistent across Microsoft HAX, Google PAIR, Apple's
generative-AI HIG and the pattern libraries: make clear what the system can do
and how well; put Edit / Undo / Retry / Adjust *next to* generated content;
replace "Processing…" with what is actually happening; offer diverse example
inputs; return control on error and use errors to teach what inputs the system
needs ([HAX](https://www.microsoft.com/en-us/haxtoolkit/library/?content_type%5B%5D=guideline),
[PAIR](https://pair.withgoogle.com/chapter/errors-failing/),
[Apple HIG](https://developer.apple.com/design/human-interface-guidelines/generative-ai),
[Shape of AI](https://www.shapeof.ai/patterns/workflow)). Nielsen's "Slow AI"
adds a **run contract card** before a long task — ETA band, cost cap,
definition of done, what it will *not* do — and three-layer progress with
conceptual breadcrumbs rather than tool-call logs
([UX Tigers](https://www.uxtigers.com/post/slow-ai)). The agent-UX pattern
work converges on **two-phase actions** (plan → validate → execute with a
receipt), an autonomy slider, budget and time boxes with a circuit breaker,
and an explicit "I'm stuck" state
([HatchWorks](https://hatchworks.com/blog/ai-agents/agent-ux-patterns/),
[AI UX Playground](https://aiuxplayground.com/guides/how-to-design-human-in-the-loop/)).
NN/g's sycophancy research is the reason "it's fixed" must be verified by the
compiler, not asserted by the model
([NN/g](https://www.nngroup.com/articles/sycophancy-generative-ai-chatbots/)).
Cursor's checkpoint forum threads document the one restore ambiguity to avoid:
users could not tell whether restore meant the state at the start or the end
of a turn, and a restore that is itself not undoable "permanently destroys
change history" ([Cursor forum](https://forum.cursor.com/t/restore-checkpoint-permanently-destroys-change-history/129652)).
On the developer-tool side, Bret Victor's "if a line computes a thing, that
thing should be immediately visible" and Ink & Switch's gentle-slope malleable
software ([Learnable Programming](https://worrydream.com/LearnableProgramming/),
[Malleable Software](https://www.inkandswitch.com/essay/malleable-software/))
describe exactly what a scaffold-to-hand-written gradient should feel like;
and the accessibility guidance for IDE-like web apps is concrete: a `⌘K`
command palette that supplements focus management, a documented Tab-escape
from the editor, go-to-next-error that announces, a unified-patch diff view
for screen readers ([Monaco a11y guide](https://github.com/microsoft/monaco-editor/wiki/Monaco-Editor-Accessibility-Guide),
[GitHub palette](https://docs.github.com/en/get-started/accessibility/github-command-palette)).

## 3. Why Loom is different, and what that changes

Loom's harness is a language, and that is not a handicap to paper over — it is
the reason most of the AI builders' scar tissue is unnecessary here:

| Their problem | Their fix | Loom's structural answer |
|---|---|---|
| The agent edits 15 files; review collapses | Plan mode, activity cards, file locks | The agent edits **one small text file**; the diff is ten lines of `.ddd`, and the fifteen files are regenerated deterministically |
| "It says it's fixed" and isn't | Screenshots, browser tests, sycophancy warnings | The **validator** says whether it is fixed; the 419-code `loom.*` catalog is the oracle, and fix-hints are code actions the agent and the editor share |
| Restore points drift from the DB | Replit's DB time-travel, everyone else's "data is not rolled back" warning | The DB is **derived from the model** (`synthDDL` keyed by a source hash) and `MigrationsIR` knows which changes are destructive before they run |
| Context loss between turns | Rules files, memory, "ask it to explain what it built" | The **model is the context**: `loom_read_model` and `loom_outline` hand the agent the resolved IR, not a transcript |
| Lock-in and lossy export | ZIP, GitHub sync | Everything is **regenerable from the model**, on five backends and six frontends; export is not a feature, it is the product |
| Generated code is opaque | Hide it (Wasp) or dump it as a PR (Amplication) | A **sourcemap** from every generated line back to its `.ddd` span already exists for `ddd trace` / `ddd breakpoints` |

What Loom lacks, relative to that family, is the **presentation layer** the
builders spent 2025–2026 on: the plan-and-receipt loop, the version timeline
in the chat, select-and-prompt from the preview, the free direct-manipulation
tier, the run contract. And relative to the compiler playgrounds it lacks the
**permanence and correspondence** layer: a short link that never dies, the
colour-mapped source↔output view, error codes that link to the language
reference, examples with read tracking. Relative to its own family it lacks
the **model-derived dashboard**: the `.loom/` bundle is generated and then
shown as files.

## 4. Transfer matrix

Adopt = take as is; Adapt = the pattern is right but the unit is the model,
not the turn; Skip = does not apply to a language-first tool. "Today" is the
state on `main @ 5dc8b4e`.

| # | Pattern | Seen in | Loom today | Verdict | Loom shape |
|---|---|---|---|---|---|
| 1 | Chat left, preview right, code behind a toggle | all AI builders | Editor centre, preview right, chat in a dock tab | **Adapt** | Source is the primary pane, not chat; chat is a *peer* of Source in the centre switcher, preview stays right |
| 2 | Single prompt box with template chips as first screen | all AI builders | None; lands on a full IDE | **Adapt** | A first-run card over the editor: "Describe a system" *or* "Start from an example" *or* "Write `.ddd`" — three doors, one screen |
| 3 | Plan / discuss mode before build | Lovable, Bolt, Base44, Firebase | None | **Adapt** | The plan *is* a `.ddd` outline: the agent proposes declarations (aggregates, ops, pages) as a model-node delta the user approves before source is written |
| 4 | Activity cards with tool timeline + per-turn diff | Lovable, v0, Base44 | Tool-call cards in the chat | **Adopt** | Keep cards; add the per-turn `.ddd` diff and the validator delta ("2 errors → 0") as the receipt |
| 5 | Every turn a restorable version, restore icons in chat | all | Git autosave + History tab, disconnected from chat | **Adapt** | Every agent turn and every builder Apply is a labelled commit; the chat turn shows its commit, "Restore" is one click and itself undoable (it commits) |
| 6 | Branches / drafts / forks | Lovable, Base44, Replit | Workspaces | **Adapt** | "Try in a draft": fork the workspace, keep chat + preview, "Merge back" = replace source; the model is small enough that merge is a text diff |
| 7 | Select element → prompt | all | None | **Adapt** | Select in preview → resolve via `data-testid` + sourcemap to the `.ddd` page/primitive → open the builder settings *or* prefill the chat with the node path |
| 8 | Credit-free direct edit tier | v0 Design Mode, Figma Make, Base44 Edit | Builder / Model panes (splice source) | **Adopt** | The visual panes *are* the free tier; brand them that way and make Apply cheap and undoable |
| 9 | Draw / annotate on preview, batch send | v0, Replit, Base44, AI Studio | None | **Skip for now** | Low value while the agent loop is BYOK; revisit with the context pack |
| 10 | Device frames, open in tab, embedded devtools | all | Full-screen toggle, app-log stream | **Adopt** | Frame presets, route bar, and the existing App / Backend log streams surfaced in a Preview footer |
| 11 | Backend panel: tables, SQL, users, secrets, logs | all | API console + SQL console + Auth claims | **Adopt** | Add a table grid (PGlite `\d` + SELECT) and put "users" = auth-stub identities beside it; logs already exist |
| 12 | Visible cost per turn, free fix button, pause on exhaustion | all | None (BYOK key, no metering) | **Adapt** | Show tokens per turn from the provider response; **"Fix with Loom" is free** because it is a code action, not a model call — say so |
| 13 | Loop detection with an exit ramp | literature; complaints everywhere | None | **Adopt** | After N failed fix turns on the same diagnostic, stop, offer "restore last green" and a smaller scope |
| 14 | Compile on keystroke with a toggle, `⌘↵` manual | CE, TS, Svelte, Mermaid | Live mode toggle (Generate→Bundle→Boot) | **Adapt** | Split the toggle: *validate* always live; *generate* live by default; *bundle+boot* on `⌘⇧↵` or Autosync — Mermaid's model for expensive renders |
| 15 | Output as tabs of kinds | Svelte, Rust, Gleam | One generated-file tree | **Adopt** | Tabs: Files · Diagrams (mermaid/LikeC4 rendered) · API (OpenAPI/AsyncAPI) · Wire spec · Migrations · Traceability — the `.loom/` bundle as views |
| 16 | Source ↔ output colour correspondence | Compiler Explorer | Sourcemap exists (`--sourcemap`, `ddd breakpoints`) | **Adopt** | Hover a `.ddd` declaration → highlight the generated files/lines it produced; hover generated code → flash the `.ddd` span. The category's most memorable feature, and the data is already there |
| 17 | Diff of generated output vs previous generate | Prisma Studio, Amplication PR | None (History diffs source only) | **Adopt** | "What changed in the output" per commit; group by deployable |
| 18 | Error codes linked to docs, prose hints | Rust, Elm, TS | Catalog text, some fix-hints | **Adopt** | Every `loom.*` row in Problems gets a link to the language-reference anchor and a "Fix" when a hint exists; "Ask the agent about this" prefills the chat |
| 19 | Short permalink that never dies + read-only embed | CE, Go, Mermaid | Hash payload `s=`/`p=` | **Adopt** | Hash stays as fallback; add a short-link service later; add `/view` read-only mode now (free: it is a flag) |
| 20 | Examples with read tracking, tour interleaving prose and editor | TS, Gleam | Example list in the create-workspace popover | **Adopt** | An Examples pane organised by concept (CRUD → workflows → auth → tenancy → multi-backend), each opening in a draft; the `journey/` stages become the tour |
| 21 | Settings drawer: target/version/flags dropdowns first | Rust, TS, CE | Design pack import; platform lives in source | **Adapt** | A "Targets" drawer that *rewrites the deployable clauses*: backend platform, frontend framework, design pack — the Loom answer to a compiler dropdown |
| 22 | Migrations: plan → review → apply, green/amber/dimmed schema, SQL beside | Prisma | Migrations tab: diff vs baseline, destructive flag | **Adopt** | Render the aggregate diagram tinted by the diff, SQL beside it, destructive ops as a gate with the escape hatch named |
| 23 | Live model-derived dashboard next to run | Encore, Wasp studio | Files in `.loom/` | **Adopt** | See #15 — the Diagrams tab updates as you type |
| 24 | Drill-down glyphs, detail-level switch, dependency inspect | Structurizr, dbdiagram, Retool | Model pane drill-down, coverage overlay | **Adopt** | Glyph on nodes with children; detail level (names / fields / everything); "used by" on selection |
| 25 | Errors counter that blocks deploy, escape hatch, severity toggles | Bubble, OutSystems, Mendix | Generate disabled on errors | **Adopt** | Errors/Warnings/Deprecations toggles on Problems; the destructive-migration gate is the "deploy" analogue |
| 26 | Trace-driven development | Darklang | Backend log stream | **Adapt** | Requests from the preview appear as dots on the operation in the Model pane; click → request, response, log lines; unmatched routes as a "404s" list |
| 27 | Projectional / structured editing | MPS, Darklang (abandoned) | Builder/Model panes as source splicers | **Keep as is** | Views, never the editing surface — the research is unambiguous |
| 28 | Multiplayer presence | Lovable, Replit, Base44 | Multi-tab lock | **Skip** | Not for a static-hosted tool; the git workspace is the collaboration primitive |
| 29 | One-click publish with visibility + domains | all builders | Download .zip | **Adapt** | "Export": ZIP, `docker compose` bundle, and a GitHub-repo push when auth exists; publish-to-host is out of scope for a browser-only playground |

## 5. The target design

### 5.1 Information architecture

Five regions, three of which already exist:

```
┌ Header ─────────────────────────────────────────────────────────────────────┐
│ Loom  [workspace ▾] [+]     ● Validate ✓  ● Generate ✓  ● Bundle  ● Boot     │
│                             (the pipeline strip IS the buttons)   [Share] [?] │
├ Explorer ─┬ Centre ───────────────────────────────┬ Preview ───────────────┤
│ Sources   │ Source · Chat · Builder · Model · Reqs │ [route ▾] [⌂][⟳][▭▯]   │
│ Examples  │ (Source + Chat can split side by side) │  the running app        │
│ Output ▾  │                                        │ footer: App log · Net   │
│  files    │                                        │                         │
│  diagrams │                                        │                         │
├ Dock ─────┴────────────────────────────────────────┴────────────────────────┤
│ Problems · Output · Runtime · Tests · Migrations · History · Auth            │
└ Status: 105 files · generated 0.8 s · bundle 4.1 MB · booted · 0 errors ────┘
```

- **The pipeline strip replaces the three scattered buttons.** Four segments
  with a state each (idle / running / ok / failed) — click a segment to run up
  to it; hover explains what it does and why it is disabled. On mobile the same
  strip collapses to **Run** with the four dots underneath. This is the
  Val Town lesson ("what does Run do?") and the Bubble/OutSystems counter in
  one control.
- **Chat becomes a centre tab, not a dock tab**, and can split beside Source.
  The agent's edits are visible in Source as they stream (already true) — the
  split makes that the default view, which is the single most convincing
  demo the playground has.
- **Output moves into the Explorer** as a switcher (Sources / Generated /
  Diagrams / API / Migrations / Traceability), each rendered, not listed as
  files. The generated-file tree stays, with the *changed-since-last-generate*
  markers and the source↔output correspondence.
- **The dock keeps its tabs** but with real tablist semantics, count badges
  instead of dots, and one vocabulary (Runtime everywhere; Backend logs →
  Runtime logs).
- **Preview grows a route bar, device frames and a log footer**, and a
  *select* mode that resolves an element to its `.ddd` page/primitive.

### 5.2 The six flows

1. **First run.** A card over the editor with three doors — *Describe a
   system* (chat, needs a key or runs the demo), *Start from an example*
   (gallery by concept, opens in a draft), *Write `.ddd`* (dismiss, cursor in
   the editor, the language cheat-sheet one `?` away). Persist the dismissal.
   Auto-generate stays on; the pipeline strip shows it happening.
2. **Edit loop.** Type → validate live → generate live → the Preview refreshes
   in place (already true) → Problems lists `loom.*` rows with a docs link and
   a Fix action → `⌘↵` bundles and boots when you want the runtime. `⌘K`
   palette for every command; `F8` next problem; `⌘S` Apply in the builders.
3. **Agent loop.** Prompt → **Plan** (a model-node delta: "add aggregate
   `Invoice` with 4 fields, op `issue`, page `Invoices/List`") → Approve →
   the agent writes `.ddd` while Source streams beside the chat → **Receipt**
   (the `.ddd` diff, the validator delta, the generated-file delta) → the
   turn's commit appears in History and as a Restore icon on the message.
   Loop detection after three failed fixes on one diagnostic. Tokens per
   turn shown from the provider response; "Fix" code actions labelled free.
4. **Run loop.** Runtime tab: API console with the operation picker (exists),
   a table grid, the SQL console (exists), identities (the auth stub). Requests
   from the preview appear on the Model pane's operation nodes; unmatched
   routes collect in a 404 list.
5. **Evolution loop.** Migrations tab shows the aggregate diagram tinted by
   the diff against the pinned baseline, SQL beside it, destructive ops as a
   gate with `--allow-destructive` named; Capture snapshot lives here;
   Requirements shows verification verdicts in sentence case with a legend.
6. **Share / export.** Share = hash link (exists) + read-only `/view` +
   embed; Export = ZIP (exists), compose bundle, GitHub push when a token is
   configured. The share dialog states what is included (source only) and what
   is not (database rows).

### 5.3 Mobile

Keep the mobile-light decision (M-T8.15) — plain editor, no Monaco — and give
it the builders' phone idiom: four bottom tabs (Code, Preview, Runtime,
Output) plus **More** as a sheet; Run in the header with the four pipeline
dots; chat as a full-screen sheet with the source diff per turn. The "read and
approve on a phone" flow is what the mobile-companion apps of Lovable, v0 and
Base44 exist for; it needs the receipt, not the IDE.

## 6. Features only a language-first playground can have

These are the differentiators. None of the AI builders can do them because
they have no model; none of the compiler playgrounds can because they have no
runtime.

1. **Source ↔ output correspondence** (#16) across five backends and six
   frontends from one sourcemap — hover `aggregate Order` and watch the
   Drizzle table, the EF entity, the Ecto schema and the React page light up.
2. **Model diff as the review unit** (#4, #5): the agent's turn is ten lines of
   `.ddd`; the fifteen generated files are a consequence you can inspect but
   never have to review.
3. **Validator-gated agent** (#12, #13, #18): fixes are code actions from the
   fix-hint registry, free and deterministic; the agent's "done" is the
   validator's `0 errors`, never its own claim.
4. **Targets as a dropdown** (#21): switch the backend from Hono to Spring
   Boot or the frontend from React to Svelte and regenerate — the compiler
   playground's version selector, applied to the whole stack.
5. **Migrations you can see** (#22): the tinted diagram plus SQL, the
   destructive gate, the snapshot as a first-class object.
6. **Requirements to green** (flow 5): the traceability graph and `ddd verify`
   verdicts as a panel, which no builder has an equivalent of.
7. **The customisation gradient made visible**: scaffolded pages show a
   badge and an *Unfold* action that ejects real `.ddd` into the editor — the
   gentle slope from no-code to full code as one click, not a doc.
8. **Trace-driven development** (#26) on the in-browser runtime: real
   requests annotate the model.

## 7. Principles to hold the design to

Ranked; each is backed by the sources in §2.4.

1. Keystroke to feedback with no setup and no sign-in; diagnostics rendered
   exactly as the CLI renders them.
2. The `.ddd` source is the checkpoint. Every AI action and every visual
   Apply is a labelled, restorable commit; restore is itself undoable and says
   which point it restores to.
3. Plan before touch, receipt after — in domain vocabulary ("added `requires`
   gate to `Order.cancel`"), never in file counts.
4. Diff at the model level; the generated diff one click away.
5. Verification is built in: "fixed" means the validator agrees.
6. Gate the irreversible (destructive migrations, data reset, workspace
   delete), never the cheap (edits in the buffer).
7. A run contract before long work: what will run, roughly how long, what it
   will not do; visible progress per pipeline phase.
8. Loop detection with an exit ramp to the last green state.
9. Errors teach the language: code, hint, docs link, fix action, "ask about
   this".
10. Templates over blank canvas, in `.ddd` form, and a tour that interleaves
    prose with the live editor.
11. A gentle slope from prompt to language: read the generated `.ddd`, change
    one line, see the effect; `unfold` so nothing is opaque.
12. Progressive disclosure keyed to the pipeline: source, preview, problems
    first; IR, wire spec, migrations, per-backend output behind tabs with
    strong scent.
13. Show the agent its context: which files and which model nodes it sees,
    editable per turn.
14. Keyboard-first and accessible: `⌘K` palette, Tab-escape, announced
    next-error, tablist semantics, count badges not colour dots.
15. Permanence: a share link that works next year; export that is lossless
    because it is regeneration.

## 8. Roadmap

Ordered by leverage per unit of work; each row names the mission it extends
and the UX-review items it closes.

| Phase | Deliverable | Extends | Closes |
|---|---|---|---|
| 1 | **Pipeline strip** (header, desktop + mobile), mobile More sheet, vocabulary sweep, count badges + tablist dock | M-T8.15 | UX review H1, M1, M3, M7, M11, M12 |
| 2 | **Chat as a centre tab with Source split**; per-turn `.ddd` diff + validator delta receipt; turn ↔ commit link with Restore on the message; loop detection | M-T8.3 | H8, H9 (agent side) |
| 3 | **Problems as a teaching surface**: docs links per `loom.*` code, Fix actions from the fix-hint registry, "ask the agent about this", Errors/Warnings toggles, `F8`; `⌘K` palette; shortcut sheet; first-run card with three doors; Examples pane by concept | M-T8.5 | H5, H7, M14, M13 |
| 4 | **Output as views**: Diagrams / API / Wire spec / Migrations / Traceability tabs rendered from the `.loom/` bundle; changed-since-last-generate markers; generated-output diff per commit | M-T8.11 | M8, M9 |
| 5 | **Source ↔ output correspondence** from the sourcemap, both directions; preview *select* mode resolving to the `.ddd` node | M-T8.2 | — (new capability) |
| 6 | **Confirm / undo layer** shared by every destructive site; Builder/Model undo bound to the editor stack; dirty guards on canvas navigation; scaffold badge + Unfold | M-T8.13 | H6, H8–H11 |
| 7 | **Targets drawer** (rewrite deployable clauses), Migrations tinted diagram + SQL + destructive gate, table grid in Runtime, trace dots on operations | M-T8.11, M-T8.10 | — |
| 8 | Read-only `/view` links, embed mode, short-link service; GitHub push on export | M-T8.6 | — |

Phases 1–3 are presentation work over shipped cores and can land in weeks;
phases 4–7 each ride an existing pure core (`.loom/` emitters, the sourcemap,
`MigrationsIR`, the fix-hint registry) and are where the playground stops
looking like a demo of Loom and starts looking like the argument for it.

## 9. Sources

AI builders: [Lovable docs](https://docs.lovable.dev/), [v0 changelog](https://v0.app/changelog), [Bolt support](https://support.bolt.new/), [Replit docs](https://docs.replit.com/), [Replit Agent 4](https://replit.com/blog/whats-changed-agent3-to-agent4), [Firebase Studio](https://firebase.google.com/docs/studio/get-started-ai) and its [sunset notice](https://firebase.google.com/support/release-notes/firebase-studio), [AI Studio Build](https://ai.google.dev/gemini-api/docs/aistudio-build-mode), [Base44 docs](https://docs.base44.com/), [Figma Make](https://help.figma.com/hc/en-us/articles/35710574222487-Beyond-the-basics-Using-Figma-Make), [Stitch review](https://www.index.dev/blog/google-stitch-ai-review-for-ui-designers); critiques — [Superdesign on Bolt](https://superdesign.dev/blog/bolt-review) and [v0](https://superdesign.dev/blog/v0-review), [Technically.dev comparison](https://technically.dev/posts/vibe-coding-tool-comparison), [Replit incident](https://www.theregister.com/2025/07/21/replit_saastr_vibe_coding_incident/), [Figma Make data loss](https://forum.figma.com/report-a-problem-6/figma-make-just-deleted-90-of-my-project-2-weeks-of-work-gone-cannot-be-reverted-48358), [Afterbuild credit spiral](https://afterbuildlabs.com/platforms/lovable-developer/problems/stop-burning-credits), [getautonoma failures](https://getautonoma.com/blog/vibe-coding-failures).

Playgrounds: [How Compiler Explorer works](https://xania.org/202506/how-compiler-explorer-works), [URLs forever](https://xania.org/202505/compiler-explorer-urls-forever), [TS playground announcement](https://devblogs.microsoft.com/typescript/announcing-the-new-typescript-website/) and [handbook](https://www.typescriptlang.org/_playground-handbook/examples.html), [StackBlitz embedding](https://developer.stackblitz.com/guides/integration/embedding), [CodeSandbox web interface](https://codesandbox.io/docs/learn/editors/web-interface), [Rust playground](https://github.com/rust-lang/rust-playground), [Go playground](https://go.dev/blog/playground), [Svelte REPL source](https://github.com/sveltejs/svelte.dev), [Elm errors](https://www.infoq.com/news/2020/01/elm-learn-syntax-error-message/), [Mermaid Live](https://github.com/mermaid-js/mermaid-live-editor), [Langium playground](https://www.typefox.io/blog/langium-playground/), [Val Town redesign](https://blog.val.town/editor-redesign), [jvns' playground list](https://jvns.ca/blog/2023/04/17/a-list-of-programming-playgrounds/).

Model-driven: [Structurizr workspace editor](https://structurizr.com/help/workspace-editor), [navigation](https://docs.structurizr.com/ui/diagrams/navigation), [inspections](https://docs.structurizr.com/workspaces/inspections), [LikeC4 layout discussion](https://github.com/likec4/likec4/discussions/343), [Context Mapper](https://contextmapper.org/docs/getting-started/), [Eraser draggable edits](https://docs.eraser.io/docs/draggable-edits-beta), [Mermaid whiteboard](https://mermaid.ai/docs/guides/whiteboard), [dbdiagram](https://docs.dbdiagram.io/), [MPS FAQ](https://www.jetbrains.com/help/mps/mps-faq.html), [Darklang status](https://blog.darklang.com/an-overdue-status-update/) and [traces](https://docs.darklang.com/discussion/trace-driven-development), [Prisma migrate model](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/mental-model) and [Studio migrations](https://www.prisma.io/blog/prisma-studio-migrations-view), [Wasp DSL pivot](https://byteiota.com/wasp-dsl-typescript-pivot/), [Encore Flow](https://encore.dev/docs/platform/observability/encore-flow), [Amplication review](https://hamrodev.com/blog/programming/i-tried-amplication-so-you-dont-have-to-here-is-my-experience), [Retool debug tools](https://docs.retool.com/apps/concepts/debug-tools), [Appsmith debugger](https://www.appsmith.com/blog/debugging-your-app-in-appsmith-with-the-appsmith-debugger-part-1), [Bubble issue tracker](https://manual.bubble.io/help-guides/getting-started/navigating-the-bubble-editor/tools/the-issue-tracker), [Mendix errors pane](https://docs.mendix.com/refguide/errors-pane/).

Guidance: [Microsoft HAX](https://www.microsoft.com/en-us/haxtoolkit/library/?content_type%5B%5D=guideline), [Google PAIR](https://pair.withgoogle.com/chapter/errors-failing/), [Apple HIG generative AI](https://developer.apple.com/design/human-interface-guidelines/generative-ai), [Shape of AI](https://www.shapeof.ai/patterns/workflow), [Nielsen, Slow AI](https://www.uxtigers.com/post/slow-ai), [AI UX Playground](https://aiuxplayground.com/guides/how-to-design-human-in-the-loop/), [HatchWorks agent patterns](https://hatchworks.com/blog/ai-agents/agent-ux-patterns/), [Smashing, AI interface patterns](https://www.smashingmagazine.com/2025/07/design-patterns-ai-interfaces/), [NN/g sycophancy](https://www.nngroup.com/articles/sycophancy-generative-ai-chatbots/), [Cursor checkpoints forum](https://forum.cursor.com/t/restore-checkpoint-permanently-destroys-change-history/129652), [Learnable Programming](https://worrydream.com/LearnableProgramming/), [Malleable Software](https://www.inkandswitch.com/essay/malleable-software/), [Monaco accessibility](https://github.com/microsoft/monaco-editor/wiki/Monaco-Editor-Accessibility-Guide), [GitHub command palette](https://docs.github.com/en/get-started/accessibility/github-command-palette), [NN/g empty states](https://www.nngroup.com/articles/empty-state-interface-design/).
