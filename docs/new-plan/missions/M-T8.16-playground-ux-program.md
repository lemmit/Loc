# M-T8.16 → M-T8.23 — Playground UX program

*Program doc. Status: minted 2026-09-02; nothing below is in flight. One
design record for eight missions so that the sequencing, the shared
vocabulary and the shared acceptance bar live in one place; each mission
also has its own entry in [`T8-dx-tooling-ai.md`](../T8-dx-tooling-ai.md).*

Sources: [`playground-ux-review-2026-09.md`](../../audits/playground-ux-review-2026-09.md)
(the 34-finding audit of what ships, with the first fix batch already landed —
findings are cited below as **H1…H11 / M1…M20 / L1…L6**) and
[`playground-landscape-research-2026-09.md`](../../audits/playground-landscape-research-2026-09.md)
(the outward look at the AI app builders, the compiler playgrounds and the
model-driven tools — cited as **§4 #n** for its transfer matrix and **§5** for
the target design). Read both before picking a mission; this doc does not
restate their evidence.

---

## 0. The thesis, in one paragraph

The playground's capability is ahead of every product surveyed — a real LSP,
generator, bundler, Postgres and test runner in one tab — and its presentation
is behind all of them. The research's finding is that the AI builders spent
2025–26 bolting on plans, receipts, restore points and loop detection to make
*chat* a safe unit of work, while Loom's unit of work is already a small,
validated, diffable text file. So the program is not "add features": it is
**make the `.ddd` model visibly the checkpoint, the diff, the context and the
thing the agent touches**, and give the pipeline, the diagnostics and the
generated output the presentation layer the leaders have. Every mission below
rides a shipped core (`src/api/`, the fix-hint registry, `MigrationsIR`, the
sourcemap, the `.loom/` emitters, the git workspace); none adds a language
feature.

## 1. Priorities and the order

Ranked by *user cost removed per unit of work*, then by what unblocks what.
P1 is reserved for the two missions in the "silent failure / lost work" class
the plan's README puts first; the rest are P2 product ROI and P3 polish.

| # | Mission | Size | Pri | Wave | Closes |
|---|---|---|---|---|---|
| M-T8.16 | Pipeline strip, one vocabulary, honest dock | M | P1 | 1 | H1, M1, M3, M4, M7, M11, M12, M16 |
| M-T8.17 | Confirm / undo layer + the silent no-op drain | M | P1 | 1 | H8, H9, H10, H11, M15 |
| M-T8.18 | Problems as a teaching surface, `⌘K`, first run | M | P2 | 2 | H5, H7, M14, M13 (dock) |
| M-T8.21 | Visual-pane empty states + the scaffold gradient | S | P2 | 2 | H6, H7 (panes), M13, M17 |
| M-T8.22 | Runtime & evolution surfaces | M | P2 | 2 | M8, M9, M10, M18, M19 |
| M-T8.19 | Agent loop: plan → receipt → checkpoint | L | P2 | 3 | §4 #3, #4, #5, #12, #13 |
| M-T8.20 | `.loom/` as views, output diff, source ↔ output correspondence | L | P2 | 3 | §4 #15, #16, #17, #23, #24 |
| M-T8.23 | Targets drawer, read-only links, export | M | P3 | 3 | §4 #19, #21, #29; L1–L6 residue |

**Waves are file-disjoint by construction** so agents can run in parallel:

- Wave 1 — M-T8.16 owns `layout/HeaderBar.tsx`, `layout/DevToolsDock.tsx`,
  `layout/MobileShell.tsx`, `layout/DesktopShell.tsx` (header/dock only),
  `main.tsx`; M-T8.17 owns `workspace/*`, `layout/SourceFilesTree.tsx`,
  `layout/BackendPanel.tsx` (the reset/clear buttons), `builder/**` (mutation
  paths and pane chrome), `editor/PlainEditor.tsx`, `layout/HistoryPanel.tsx`
  (restore).
- Wave 2 starts when wave 1 merges (M-T8.18 needs the dock tablist and the
  header `?` slot from 16; M-T8.21 needs the confirm/undo primitives from 17).
- Wave 3 is the IA change (chat as a centre tab) and the two data-heavy
  surfaces; they need M-T8.3's transport and M-T8.2's sourcemap fan-out, both
  `partial` on `main`.

**Already shipped (2026-09-02, the audit's own PR)** and therefore *not* in
any mission: responsive header height (H2), correct bundle-failure reporting
and the registry-unreachable hint (H3, H4), neutral zero-count badges and no
grey Runtime dot (M4 half), disabled-button tooltips (H1 half), platform-aware
empty states with progress text (M2, M5), the two-step Reset database (H8
part), non-shrinking Requirements badges (M9 part).

## 2. Shared rules for every mission in the program

1. **Verify-first.** Each mission names the finding it closes; re-read the
   finding's file:line on fresh `main` before building — three of the audit's
   findings were partly fixed by the audit's own PR and more may land from
   other tracks.
2. **Every user-visible string goes through one vocabulary.** M-T8.16 adds
   `web/src/layout/vocabulary.ts` (`RUNTIME`, `GENERATE`, `BUNDLE`, `BOOT`,
   `RUN`, the pipeline-stage labels, the pane names). Later missions import
   from it; a new literal "Backend logs"/"Reqs"/"spin up PGlite" in a `.tsx` is
   a review reject.
3. **Test ids are a public contract.** `btn-generate`, `btn-bundle`,
   `btn-boot`, `devtools-tab-*`, `mobile-tab-*`, `output-stream-select`,
   `doc-tab-*`, `workspace-*`, `btn-wipe` are used by ~35 Playwright specs.
   A mission that moves a control keeps its id on the new element and says so
   in the PR body; a mission that removes one lists the specs it edits.
4. **Gates are the no-network Playwright lane plus headless unit tests.** The
   per-PR lane (`web/e2e/editor.spec.ts`, `source-files.spec.ts`,
   `crash-reporting.spec.ts`, `bundle-starts.spec.ts` and siblings that need
   no registry) is where each mission adds its spec; anything that bundles or
   boots goes to the heavy lane and must not be the only proof. Pure logic
   (loop detection, receipt folding, vocabulary, confirm reducer) gets a
   `test/playground/*.test.ts`.
5. **Mutation-prove the gate** (CLAUDE.md rule): the PR body states which
   assertion failed with the fix reverted.
6. **Theme.** Until M-T8.16 slice 4 lands, no new `dark.N` literals; use
   `var(--mantine-color-default-border)` / `--mantine-color-body` /
   `light-dark()` in every new line.
7. **Design defaults are owner-overridable at draft-PR review.** The decisions
   in §4 are the recommended answers; a mission proceeds on them unless the
   draft PR review says otherwise.

---

## 3. The missions

### M-T8.16 — Pipeline strip, one vocabulary, honest dock — **M** · P1

**Why first.** H1 is the audit's root finding: the Generate → Bundle → Boot
contract is invisible, the three controls live in three places, mobile has a
different verb, and the dock's colour dots carry status nobody can read. Every
later mission writes copy that names these stages; fixing the vocabulary
first stops the copy branching the audit's own PR had to ship.

**Slices** (each one PR, in order):

1. **`PipelineStrip`** (`web/src/layout/PipelineStrip.tsx`). Four segments —
   *Validate · Generate · Bundle · Boot* — each with a state from
   `PipelineState` (`idle` / `running` / `ok` / `failed` / `blocked`), a
   count where one exists (errors on Validate, files on Generate, size on
   Bundle), and a click that runs *up to* that stage (`runGenerate`,
   `runBundle`, `runBoot`, or the existing `runFull` cascade truncated).
   Hover on a blocked segment explains the blocker in one sentence. Replaces
   the header's Generate / Bundle buttons and the Runtime header's Boot on
   desktop; on mobile the header keeps **Run** and the strip renders as four
   dots under it. Keeps `btn-generate` / `btn-bundle` / `btn-boot` on the
   segments. The **Live** switch becomes a segment-level "auto" toggle with a
   visible label ("Auto-run on edit"), which is §4 #14's split: validate is
   always live, generate follows the toggle, bundle + boot never auto-run
   unless the toggle is on (today's behaviour preserved).
2. **Vocabulary module + sweep.** `vocabulary.ts`; rename the dock tab
   `Runtime` everywhere (`backend-status` test id stays), the Output stream
   "Backend logs" → "Runtime logs", mobile "Reqs" → "Requirements" (shorten
   the segmented control by icon+label instead), "Migrate" → "Migrations";
   one phrasing for every precondition. Files: `layout/OutputPanel.tsx`,
   `layout/MobileShell.tsx`, `layout/TestsPanel.tsx` (the three
   precondition strings), `layout/DevToolsDock.tsx`.
3. **Honest dock.** `DevToolsDock` becomes a Mantine `Tabs` (role=tablist,
   arrow keys, `aria-selected`) with the same `devtools-tab-*` ids; the 7 px
   dots become count badges where a count exists (Problems: N errors; Tests:
   N failed; Migrations: N destructive) and a `VisuallyHidden` label
   otherwise; the Output stream select gets the same treatment. Mobile:
   four primary tabs (Code, Preview, Runtime, Output) plus **More**, a
   bottom sheet holding Tests / Migrations / History / Agent / Auth with the
   existing `mobile-tab-*` ids on the sheet rows (M1).
4. **Header overflow + theme.** Share link, Import design pack and the
   workspace tree move under one `⋯` menu on desktop so the header never
   needs two rows (the responsive height from the audit PR stays as the
   fallback); `main.tsx` switches to `forceColorScheme="dark"` (M16's cheap
   half) with a one-line comment that the token migration is M-T8.23's
   residue.

**Acceptance.** `web/e2e/pipeline-strip.spec.ts` (no-network lane): after
load, Validate=ok and Generate=ok with the file count; Bundle=blocked with the
tooltip text before Generate on an errored source; injecting a syntax error
flips Validate to failed with the count and Generate to blocked; on the
390 px viewport the strip renders as dots and **More** opens the sheet.
Existing specs pass unchanged except id relocations listed in the PR.
`test/playground/vocabulary.test.ts` greps `web/src/**/*.tsx` for the retired
literals and fails on a hit (a ratchet, like the walker-stdlib pin).

**Not in scope.** Any change to what the stages *do*; the agent tab; the
builder panes.

### M-T8.17 — Confirm / undo layer + the silent no-op drain — **M** · P1

**Why P1.** H8–H11 are the "lost work" class: seven native dialogs, unconfirmed
declaration deletes on the model canvas, no undo from any visual surface, and
mutations that silently no-op. The builders surveyed all learned this the hard
way (Figma Make's unrecoverable delete, the Cursor restore threads).

**Slices:**

1. **`ConfirmAction`** (`web/src/util/confirm.tsx`): one component with two
   shapes — inline (button → "Yes, …" / Cancel, the pattern the audit PR gave
   Reset database) and modal (title, consequence sentence, an optional
   type-to-confirm for the workspace delete, naming the file count). Replace
   the seven `window.confirm` / `window.prompt` sites
   (`workspace/WorkspaceSwitcher.tsx` rename → inline `TextInput` like the
   mobile drawer; delete → modal; `workspace/WorkspaceDrawer.tsx`;
   `layout/SourceFilesTree.tsx` ×2; `App.tsx` example import → modal listing
   the files it drops; `builder/system-v2/SystemBuilderV2Pane.tsx` layout
   reset → *no* confirm). Add confirms where they are missing: "Clear stored
   data & retry" (`layout/BackendPanel.tsx`), declaration deletes on the
   model canvas (`builder/system-v2/ConstructNode.tsx` → the pane's
   `deleteByAstType`), store / menu / state-field deletes in
   `builder/BuilderPane.tsx` and `builder/page/StatePanel.tsx`. History's
   restore confirm says what is replaced and that restore is itself a commit
   (`layout/HistoryPanel.tsx`).
2. **Undo everywhere.** An *Undo* / *Redo* pair in the chrome of Builder,
   Model and Requirements bound to the Monaco model's undo stack through
   `editorHandleRef` (the panes already write through
   `pushEditOperations`, so the stack is correct — it is just unreachable);
   `⌘Z` while a pane has focus routes there. `editor/PlainEditor.tsx` stops
   assigning `textarea.value` for external writes and uses
   `setRangeText`/`execCommand("insertText")` so the native stack survives.
3. **Dirty guards.** Page builder: a dirty flag on the craft tree; switching
   page or a live re-seed while dirty asks (inline) or auto-applies when the
   candidate parses (owner default: **ask**). Requirements: selecting another
   row with a modified form asks. Builder and canvas Apply become cheap
   enough to make "Apply on every change" a future toggle, not this mission.
4. **The silent no-op drain.** Every `const next = …; if (next != null)
   apply(next)` in `builder/system-v2/SystemBuilderV2Pane.tsx` (8 sites) and
   `builder/system-v2/AddPalette.tsx` routes through `applyOrRefuse`; the
   refusal line (`builder/refusal.tsx`) names the construct and the reason
   and offers *Show candidate* (a read-only diff of the rejected source);
   rename on an invalid identifier shows the rule inline instead of snapping
   back; palette entries whose prerequisite is missing render disabled with
   the reason as the tooltip (on a wrapper, not the disabled button).

**Acceptance.** `test/playground/confirm.test.ts` (reducer + the seven sites'
props), `web/e2e/destructive-actions.spec.ts` (no-network): deleting a source
file shows the inline confirm and cancels cleanly; deleting an aggregate on
the canvas requires the confirm; Undo in Builder reverts an Apply and the
Source tab shows the reverted text; the requirements dirty guard fires.
Mutation proof: remove the confirm on canvas delete → the spec fails on the
"aggregate still present after Cancel" assertion.

**Not in scope.** craft.js history for intra-canvas moves (M-T8.21 may add it);
any change to the git autosave cadence.

### M-T8.18 — Problems as a teaching surface, `⌘K`, first run — **M** · P2

**Why.** H5 (no onboarding, no help, no shortcuts), H7 (diagnostics dead-end),
M14 (two keyboard handlers in the whole app). The compiler playgrounds
(Rust, Elm, TS) show that error rows linking to docs and a discoverable
shortcut sheet are table stakes; the AI builders show the first-screen
three-door pattern.

**Slices:**

1. **Problems rows.** Each `loom.*` row in `layout/ProblemsPanel.tsx` gets a
   code chip, a docs link (anchor into `docs/language-reference/` — add a
   `codeDocsUrl(code)` in `src/diagnostics/` beside the catalog, gated so a
   code without an anchor renders no link rather than a 404), a **Fix**
   action when `fix-hints.ts` has a provider (it is the same
   `resolvePatchEdits` the editor's code actions use), and *Ask the agent*
   which prefills the chat with the diagnostic. Errors / Warnings toggles
   (Mendix's pane); `F8` / `⇧F8` next/previous problem with the message
   announced (`aria-live`). Click already jumps; keep it.
2. **Command palette.** `⌘K` / `Ctrl+K` over every action the ctx exposes
   (run stages, switch panes, open dock tabs, workspace ops, export, help),
   fuzzy, recent-first. Owner default: **`@mantine/spotlight`** (same
   major as `@mantine/core`, ~10 KB) rather than hand-rolling; the palette
   is a supplement to focus management, not a replacement (Monaco keeps
   its own `F1`). Shortcut sheet on `?` (outside inputs) listing: `⌘↵`
   Generate, `⌘⇧↵` Bundle + Boot, `⌘S` Apply in the visual panes, `F8`,
   `Esc` deselect / close, `⌘K`; the Monaco Tab-escape documented.
3. **First run + help.** A dismissible card over the editor on a workspace
   that has never been edited: three doors — *Describe a system* (focuses the
   chat; runs the scripted demo when no key is configured), *Start from an
   example* (opens the examples pane), *Write `.ddd`* (dismisses, focuses the
   editor). Persisted per browser. A `?` header menu: Docs, Language
   reference, Keyboard shortcuts, Report a problem (the existing crash-report
   form). Examples become a pane (Explorer switcher, or a modal on mobile)
   organised by concept — CRUD → workflows → auth → tenancy → multi-backend →
   frontends — with the TS-playground read-tracking dot; each opens in a new
   workspace (today's create-from-example flow) so the current one is never
   overwritten without the M-T8.17 confirm.
4. **Parse-error dead-ends (panes).** The four visual panes' "Source has
   syntax errors" state shows the first diagnostic and a *Go to line N*
   button that switches to Source and reveals the range (H7). Shared
   component; M-T8.21 reuses it.

**Acceptance.** `web/e2e/problems-and-help.spec.ts` (no-network): an
injected `loom.unknown-name` renders a Fix action that applies; `F8` moves the
cursor; `⌘K` → "Generate" runs generate; the first-run card shows on a fresh
profile and not after dismissal; `?` opens the sheet.
`test/system/diagnostic-docs-anchors.test.ts`: every `codeDocsUrl` target
resolves to an existing anchor in `docs/` (a ratchet — codes without docs are
listed, and the list may only shrink).

### M-T8.21 — Visual-pane empty states + the scaffold gradient — **S** · P2

**Why.** H6: the Builder tab is empty for the default example because its
pages are scaffolded, and the copy tells the user to write a `ui { page }`
block. The customisation gradient (`docs/customization-gradient.md`) is
Loom's central promise and the playground currently hides it.

**Slices:**

1. **Scaffold awareness.** `BuilderPane` (and the page picker) detect pages
   synthesised by `scaffold` (via `classifyPage` / the macro origin the
   expander records) and render them as read-only rows with a *scaffolded*
   badge and an **Unfold** action that invokes the LSP unfold-macro code
   action (`src/language/lsp/unfold-macro.ts`) through the editor handle,
   then selects the now-real page. Empty-state copy for a system with no
   pages at all offers *Add a page* (the model builder's `+` palette) instead
   of syntax.
2. **Drill-level empty states** in the model builder become a centred card
   with a *Back to {parent}* button; the Overview empty state names
   `subdomain`, not `module`; "Select a node" gains one sentence of guidance.
3. **Icon labels.** Replace the unicode glyph buttons (✎ × ↑ ↓ ƒ ⋯ ⇄ ƒx) in
   `builder/system-v2/ConstructNode.tsx`, `StmtNode.tsx`,
   `builder/system/BodyEditor.tsx`, `builder/BuilderPane.tsx`,
   `builder/page/StatePanel.tsx` with a tiny inline-SVG set (the codebase
   already inlines Tabler paths in `preview/Preview.tsx`) and per-action
   `aria-label`s, following `builder/system/ExpressionEditor.tsx`'s
   convention; the requirements master list rows become buttons with
   keyboard activation (M15); path truncation switches to middle-ellipsis
   with a tooltip (M17).
4. **Detail level** in the Model pane (names / fields / everything —
   dbdiagram's switch) and a "used by" line on selection.

**Acceptance.** `web/e2e/builder-scaffold.spec.ts` (no-network): the Sales
System Builder tab lists scaffolded pages; Unfold on `Orders/List` produces a
`page List` in Source and the builder canvas mounts it. Axe-style check that
no `button` in the builders lacks an accessible name (a small script over the
rendered DOM in the spec, or `@axe-core/playwright` if the owner accepts the
dev dependency).

### M-T8.22 — Runtime & evolution surfaces — **M** · P2

**Why.** M8/M9/M10/M18/M19 plus §4 #22, #26 — the model-driven family's
strongest patterns (Prisma's tinted migration diff, Encore's model-derived
dashboard, Darklang's traces) are all cheap here because the data exists.

**Slices:**

1. **Migrations.** Loading line "Comparing the live source with *Last
   save*…", label "Compare with", button label kept while loading; the
   aggregate diagram tinted by the diff (added green / changed amber /
   untouched dimmed) beside the SQL; destructive operations rendered as a
   gate that names `--allow-destructive` and the data it would drop; capture
   snapshot stays here. Extends M-T8.11 rather than replacing it.
2. **Verdicts.** Sentence case and a one-line legend (Verified / Failing /
   Untested = no test case covers it / Unverified = covered, not yet run) in
   `layout/TestsPanel.tsx` and `builder/requirements/RequirementsPane.tsx`;
   badges wrap onto a second line in a narrow list instead of clipping.
3. **Runtime tab.** A *Tables* sub-view (PGlite `information_schema` →
   table list → first 50 rows, read-only) beside API and Database; the
   identities from the auth stub shown as a *Users* strip; every response
   error and boot error gets one line of interpretation and a link to the
   right Output stream above the raw text (M19).
4. **Traces on the model.** Requests dispatched from the preview (already
   tee'd into `backendLog` with method + path) are matched to operations
   (route table from the OpenAPI spec the Runtime tab already fetches) and
   rendered as a count on the operation node in the Model pane; click →
   the last request/response; unmatched paths collect in a *404s* list on
   the Runtime tab.
5. **Loading states with a failure branch** for history commit-changes, the
   migrations baseline list, the pack list and test discovery (a per-suite
   progress line and a cancel); the Diagnostics stream maps
   `react-error` / `unhandledrejection` / `hash 341b` to sentences.

**Acceptance.** Headless: `test/playground/route-match.test.ts` (path → op),
`test/playground/migration-tint.test.ts` (diff → tint map). Heavy lane
addition to `web/e2e/runtime.spec.ts`: after boot, Tables lists `products`,
a `GET /products` from the API console shows `1` on the `findAll` node.

### M-T8.19 — Agent loop: plan → receipt → checkpoint — **L** · P2

**Why.** §4 #3–#5, #12, #13 — the builders' table stakes for an agent
surface, which Loom can do better because the unit is the model. Depends on
M-T8.3's transport (shipped) and coordinates with its context-pack residue.

**Slices:**

1. **Chat as a centre tab** beside Source / Builder / Model / Requirements,
   with a *Split* toggle that shows Chat and Source side by side (the default
   when the agent is running). The Agent dock tab becomes a shortcut to it.
   Mobile: a full-screen sheet.
2. **Plan step.** Before writing source the agent returns a *model-node
   delta* — declarations to add/change/remove, from `loom_outline` of the
   candidate — rendered as a checklist the user approves, edits (remove a
   line) or rejects; only then does the turn write `.ddd`. Owner default:
   plan is **on** for the first turn of a conversation and for any turn the
   model marks as structural, off for follow-ups, with a toggle.
3. **Receipt.** Each turn ends with the `.ddd` diff (unified, collapsible),
   the validator delta ("2 errors → 0"), and the generated-file delta
   (`+3 −0 ~7`, expandable to paths); the tool-call cards fold under it.
   Tokens per turn from the provider's `usage` field when present.
4. **Turn ↔ commit.** Each agent turn and each visual Apply commits with a
   label (`agent: <first line>` / `builder: <page>`); the message shows a
   *Restore* icon that restores that commit *as a new commit* (so restore is
   undoable — the Cursor lesson); History's timeline shows the same labels.
   Restore says which point it restores to (end of turn N).
5. **Loop detection.** Three consecutive fix turns that leave the same
   diagnostic code on the same node stop the loop with an "I'm stuck" card:
   restore last green, narrow the ask, or open the Problems row. *Fix*
   code actions are labelled *free* in the UI because they are deterministic
   patches, not model calls.

**Acceptance.** Headless: `test/playground/agent-receipt.test.ts` (fold a
transcript + two source versions → receipt shape), `agent-loop-guard.test.ts`
(the stop condition). `web/e2e/agent-live.spec.ts` extended through the
scripted `__loomAgentComplete` seam: plan approval gates the write; restore
from a message reverts Source and adds a History row.

### M-T8.20 — `.loom/` as views, output diff, source ↔ output correspondence — **L** · P2

**Why.** §4 #15–#17, #23–#24 — the category's most memorable feature
(Compiler Explorer's colour mapping) and the model-driven family's live
dashboard, both over data the generator already emits. Depends on M-T8.2's
sourcemap fan-out being enabled in the build worker for every generate (it is
opt-in on the CLI today).

**Slices:**

1. **Explorer switcher** grows Diagrams (mermaid `.mmd` rendered through the
   existing `preview/doc-viewers.tsx`, live on each generate), API (the
   OpenAPI endpoint list grouped by aggregate; AsyncAPI channels), Migrations
   (the M-T8.22 view), Traceability (`traceability.md` rendered) — the
   `.loom/` bundle as views, files still browsable under Generated.
2. **Changed-since-last-generate** markers on the generated tree (the build
   worker returns per-file hashes; compare with the previous result) and a
   *What changed in the output* diff per History commit, grouped by
   deployable.
3. **Correspondence.** Build worker always records the sourcemap; hovering a
   `.ddd` declaration in Monaco highlights the generated files it produced
   in the tree and, when one is open, the lines (a Monaco decoration on the
   viewer); hovering generated code flashes the `.ddd` span. Colour-mapped
   per declaration on request (a toggle), godbolt-style.
4. **Preview select mode.** A *Select* toggle in the preview footer; a click
   posts the element's `data-testid` through the sandbox bridge; the
   playground resolves it via the sourcemap to the page/primitive and opens
   the Builder settings for it, or prefills the chat with the node path.

**Acceptance.** Headless: `test/playground/correspondence.test.ts` (sourcemap
→ decoration ranges both ways). No-network e2e: hovering `aggregate Product`
in Source highlights ≥ 3 generated files; the Diagrams view renders `er.mmd`
after generate.

### M-T8.23 — Targets drawer, read-only links, export — **M** · P3

**Why.** §4 #19, #21, #29 and the L-tier residue. Polish and reach, after the
core loops are right.

**Slices:**

1. **Targets drawer.** A header control that lists the system's deployables
   with their platform / framework / design pack as dropdowns and rewrites
   the clauses through `applyPatches` (the same node-addressed patch surface
   `ddd patch` uses) — the compiler playground's version selector applied to
   the stack. Unsupported-in-browser targets keep the existing "files only"
   note.
2. **Read-only `/view` links and embed.** A `view=1` hash flag renders the
   playground without chrome and without the writer lock; an `embed` flag
   drops the dock. The share dialog states what the link carries (source
   only, no rows). A short-link service is **deliberately out of scope** —
   the site is static; record the decision here and revisit if link length
   becomes a field complaint.
3. **Export.** ZIP (exists) + a `docker compose` README in the ZIP root;
   GitHub push is deferred until a token story exists (note the decision).
4. **Theme tokens.** Migrate the ~108 `dark.N` literals to semantic tokens so
   `forceColorScheme` can be dropped; L1–L6 from the audit (read-only mode
   explained once; mermaid wheel-zoom on Ctrl only; touch Esc hint; stable
   toolbar buttons; demo button labels; header emphasis).

**Acceptance.** No-network e2e: switching the frontend target from React to
Vue rewrites the deployable clause and regenerates; `#view=1` renders without
the header and refuses edits; light scheme renders legibly (a screenshot spec
with a contrast threshold).

**Shipped 2026-09-03 — PR #2775**, four slices as written.  Two decisions were
taken as the defaults above prescribe, and are recorded here so a later agent
does not re-open them by accident:

* **Short links: out of scope, confirmed.**  §5 rules out a server and the
  site is static, so a shortener has nowhere to live.  The `#view=1` /
  `#embed=1` flags ride the same hash as the payload, and the share dialog
  states the absence (`SHARE.noShortener`) rather than leaving a long URL
  looking like an oversight.  Revisit only on a field complaint about length,
  and only together with §5.
* **GitHub push: out of scope, confirmed.**  It needs a token story a static
  site has nowhere to keep.  The two supported ways out of the tab stay the
  ZIP — which now carries a root `README.md` on running the tree with
  `docker compose`, derived from the emitted compose file — and the share link.

**One residue is deliberately NOT closed here: L5** (the Agent demo button
silently becoming *Replay demo*).  It lives in `layout/ChatPanel.tsx`, which
**M-T8.19** owns while that mission is in flight; editing it from here would
collide on the same lines.  That file also holds the single waiver in the theme
ratchet (`test/playground/theme-tokens.test.ts`) — its six remaining raw shades
migrate, and the waiver is deleted, under M-T8.19.  The waiver is a ratchet: it
fails once the file is clean, so it cannot be forgotten.

---

## 4. Decisions the owner may override at draft-PR review

| Decision | Recommended default | Why |
|---|---|---|
| Palette library | `@mantine/spotlight` | Same major as core, keyboard/a11y done; hand-rolling repeats it |
| Chat placement | Centre tab with Split, dock tab as shortcut | The research's strongest demo is source streaming beside chat |
| Plan step default | On for the first turn and structural turns | Bolt/Lovable data: plan mode is where credits stop burning |
| Dirty canvas on page switch | Ask (inline), not auto-apply | Auto-apply of an unparseable candidate would hit the refusal line mid-switch |
| Layout-reset confirm | Remove | Cosmetic and undoable; confirming it while deletes did not was the audit's clearest inversion |
| Short links | Out of scope | Static hosting; hash links + `/view` cover sharing |
| `forceColorScheme` now, tokens later | Yes | One line closes a live white-on-white defect; the migration is 108 sites |
| `@axe-core/playwright` dev dep | Accept | The only way to gate "every builder button has a name" without a hand-rolled walker |

## 5. What this program does not do

- No language or generator changes. Every mission consumes `src/api/`,
  `src/diagnostics/`, the sourcemap and the `.loom/` emitters as they are; a
  gap found there is filed on its own track.
- No server. Short links, GitHub push, telemetry and multiplayer are out; the
  static-site constraint stands (M-T8.14's beacon decision applies).
- No mobile IDE. M-T8.15's mobile-light decision holds; mobile gets the
  strip, the sheet, the chat sheet and the receipt — read-and-approve, not
  edit-everything.
