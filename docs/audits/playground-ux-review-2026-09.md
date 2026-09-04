# Playground UI/UX review — 2026-09

> Status: **empirical pass — 2026-09-02.** A usability review of the browser
> playground (`web/`) as a first-time and a returning user would meet it:
> desktop at 1440 / 1024 / 800 px and a 390 px phone, driven through a
> production build (`vite preview` of `web/dist/`) with Playwright, plus a
> code read of every pane under `web/src/layout/`, `web/src/builder/`,
> `web/src/workspace/` and `web/src/preview/`.
>
> Companion: [playground-landscape-research-2026-09.md](playground-landscape-research-2026-09.md)
> looks outward at Replit / Lovable / v0 / Bolt, the compiler playgrounds and
> the model-driven tools, and derives the target design the fixes below move
> toward.
>
> Read against `main` @ `5dc8b4e`. Items marked **shipped** landed in the
> same change as this document; everything else is a proposal, ranked by how
> much it costs a user. **When this prose and the cited lines disagree, the
> code wins.**

## 1. Summary

The playground is technically remarkable — a real LSP, generator, bundler,
Postgres and test runner in one tab — and the code is unusually well
commented. The UX, though, is the sum of many feature slices and it shows:
the app assumes the user already knows the Generate → Bundle → Boot contract,
several states describe themselves wrongly, the same concept has three names,
and destructive actions confirm inconsistently. None of that is deep; most of
it is copy, defaults and a few layout constraints.

| Severity | Count | Shipped in this change |
|---|---|---|
| High — blocks or misleads a user | 11 | 4 fully, 2 partly |
| Medium — friction, inconsistency, a11y | 17 | 4 fully, 3 partly |
| Low — polish | 6 | 0 |

What shipped (all under `web/src/`):

- `App.tsx` — the desktop header gets a responsive height (`88 px` below the
  `lg` breakpoint, `48 px` above) so the wrapped toolbar no longer paints over
  the Explorer and editor at laptop widths; a failed backend bundle is now
  reported as a **bundle failure** instead of "this example has no React
  frontend".
- `layout/HeaderBar.tsx` — the error / warning badges are neutral grey at
  zero (a permanently red "0 ERRORS" was a false alarm); disabled Generate /
  Bundle carry a tooltip saying *why* they are disabled; the mobile menu
  spells out "errors" / "warnings" like desktop.
- `layout/PreviewPane.tsx`, `layout/BackendPanel.tsx`, `layout/TestsPanel.tsx`,
  `layout/OutputPanel.tsx`, `layout/ProblemsPanel.tsx` — every empty state
  names the next control the user can actually see (Generate / Bundle / Boot on
  desktop, Run on mobile), shows *Generating… / Bundling… / Starting…* while
  the pipeline runs, drops PGlite / Hono / OPFS from first-contact copy, and a
  `Failed to fetch` bundle now explains that the npm registry was unreachable.
- `layout/BackendPanel.tsx` — **Reset database** is a two-step confirm, with
  the consequence written above the button rather than below it.
- `layout/DevToolsDock.tsx` — the Runtime tab no longer shows a grey dot while
  offline (only red / yellow / green mean anything now).
- `builder/requirements/RequirementsPane.tsx` — the status / verdict / test-
  case badges no longer shrink into `INPRO…` / `UNT…` / `0…` stubs in a
  narrow list (the title truncates instead; in a very narrow list the last
  badge can still clip at the panel edge — wrapping badges onto a second
  line is the proper fix, see M9); the verdict badge explains UNTESTED vs
  UNVERIFIED on hover.

Verification: `npm --prefix web run typecheck` is clean; the production build
was re-run and the header / badge / preview states re-screenshotted at 1440,
1024 and 800 px and 390 px. No e2e spec asserts on any string that changed
(`0 errors` is kept verbatim — only its colour moved; `btn-wipe` keeps its
test id and now reveals `btn-wipe-confirm`).

## 2. How the review was run

1. `npm --prefix web run build`, `vite preview`, then a scripted Playwright
   tour: cold load, auto-generate, every dock tab, every Output stream, every
   centre view, workspace popovers, collapsed rails, an injected syntax error,
   Bundle (which fails in the sandbox — usefully, that exercised the failure
   path), then the same tour at 1024 / 800 px and on a 390 × 844 phone.
2. Two parallel code sweeps over the panes, looking specifically for empty
   states, loading states, error copy, naming, a11y labels, destructive
   actions, keyboard support and theme hard-coding.

## 3. Findings

Each finding: what the user experiences, where it lives, the proposed fix.
`web/src/` is elided from paths.

### 3.1 First contact and the pipeline contract

**H1 · The three-step contract is invisible.** *Partly shipped.* Bundle is
disabled until Generate succeeds (`layout/HeaderBar.tsx`), Boot until Bundle
succeeds (`layout/BackendPanel.tsx`), and Boot lives in a dock tab called
Runtime — but nothing on screen says "do these three things in this order".
Mobile collapses them into one **Run** while its empty states told the user
to "Generate and Bundle first". Shipped: tooltips on the disabled buttons and
platform-aware copy everywhere. Proposed: a three-segment pipeline strip in
the header (Generate ✓ · Bundle · Boot) that doubles as the buttons, so the
state and the next action are the same widget on both shells.

**H2 · Desktop header overlapped the workspace below ~1200 px.** *Shipped.*
The toolbar wraps to two rows at laptop widths but the AppShell header was a
fixed 48 px, so row two painted over the Explorer and the doc tabs
(`App.tsx`). Now responsive. Proposed follow-up: move Share link / Import
design pack / workspace-tree into a single overflow menu so the header never
needs two rows.

**H3 · A failed bundle was reported as "This example has no React frontend".**
*Shipped.* When the backend half fails the React half is skipped, and
`reactBundleStatus` mapped a null React result to `absent` (`App.tsx`), so the
Preview header said *no preview* and the pane told the user to pick a
different example. It now reports a failure and points at Output → Bundler.

**H4 · "Failed to fetch" was the whole bundle error.** *Shipped.* The in-browser
npm install surfaces any registry problem as that one string
(`layout/OutputPanel.tsx`), which reads like a bug. The Bundler stream now
explains the likely cause (offline, blocked network, an ad blocker) and the
retry.

**H5 · No onboarding, help, or shortcut sheet.** A new visitor lands on a
seven-tab IDE with no welcome, no "what is a `.ddd`", no link to the docs
site, and the only external links in the UI are an OpenRouter key page and the
crash-report form. Proposed: a dismissible first-run card (three sentences
plus the three steps) persisted in `localStorage`, and a `?` menu in the
header with *Docs*, *Language reference*, *Keyboard shortcuts*, *Report a
problem*.

**H6 · The Builder tab is empty for the default example.** Sales System's
pages come from `scaffold`, which the page builder cannot edit, so the very
first click on *Builder* shows "No page or component with a body: found. Add a
ui { page { … } } block." (`builder/BuilderPane.tsx`). Proposed: detect
scaffolded pages and say so — "This system's pages are generated by
`scaffold`. Unfold a page into source to edit it here" — with an *Unfold*
action that calls the existing unfold-macro code action.

**H7 · Parse-error state dead-ends in all four visual panes.** "Source has
syntax errors — fix them in the editor to use the builder"
(`builder/BuilderPane.tsx`, `builder/system-v2/SystemBuilderV2Pane.tsx`,
`builder/system-v2/OverviewCanvas.tsx`,
`builder/requirements/RequirementsPane.tsx`) with no line number and no way
to get there, although `ctx.diagnostics` is one prop away. Proposed: show the
first error's message and a *Go to line N* button that switches to Source and
reveals the range.

### 3.2 Destructive actions and undo

**H8 · Confirmation is inconsistent, and native.** *Partly shipped.* Seven
sites use `window.confirm` / `window.prompt` (`workspace/WorkspaceSwitcher.tsx`
rename + delete, `workspace/WorkspaceDrawer.tsx`, `layout/SourceFilesTree.tsx`
×2, `App.tsx` example import, `builder/system-v2/SystemBuilderV2Pane.tsx`
layout reset) while History's *Restore* uses a proper inline confirm and the
mobile drawer has an inline rename. Meanwhile **Reset database** (shipped:
now two-step), **Clear stored data & retry** (`layout/BackendPanel.tsx`), and
deleting a whole aggregate / context / subdomain from the model canvas
(`builder/system-v2/ConstructNode.tsx`) had *no* confirmation — but resetting
node positions did. Proposed: one `ConfirmAction` component (inline for small
things, modal for workspace delete with the file count named), used by every
site; confirm declaration deletes; drop the confirm on layout reset.

**H9 · No undo from any visual surface.** Page-builder deletes, model-canvas
deletes and requirement edits splice source with no Undo button; the only
path is switching to Source and pressing Ctrl+Z, and on mobile `PlainEditor`
assigns `textarea.value` which wipes even that (`editor/PlainEditor.tsx`).
Proposed: an *Undo* button in each pane's chrome bound to the editor model's
undo stack; craft.js history for the canvas.

**H10 · Edits fail silently in the model builder.** The idiom
`const next = …; if (next != null) apply(next)` turns a refused mutation into
a dead click (`builder/system-v2/SystemBuilderV2Pane.tsx` ×8,
`builder/system-v2/AddPalette.tsx`); rename snaps back on an invalid
identifier with no message; the refusal line reads "Apply produced invalid
source — not written" with nothing actionable (`builder/refusal.tsx`).
Proposed: route every mutation through `applyOrRefuse`, name the construct
and the reason in the refusal, and disable palette entries whose prerequisite
is missing with the reason as tooltip.

**H11 · Canvas work is lost without warning.** Page-builder edits are
uncommitted until *Apply to source*; switching pages remounts the craft
editor and a source change re-seeds the tree, both discarding in-flight work
with no dirty flag (`builder/page/PageBuilder.tsx`). Requirements forms
likewise drop a dirty form when another row is clicked
(`builder/requirements/RequirementsPane.tsx`). Proposed: dirty flag +
confirm on navigation, or auto-apply with the existing debounce.

### 3.3 Mobile

**M1 · The bottom tab bar is two rows.** Nine tabs in a `grow` list wrap on a
390 px phone (`layout/MobileShell.tsx`), spending ~200 px of the viewport and
breaking the thumb-bar idiom. Proposed: four primary tabs (Code, Preview,
Runtime, Output) plus **More**, which opens a sheet with Tests, Migrate,
History, Agent, Auth. Keep the `mobile-tab-*` test ids on the sheet items.

**M2 · Mobile empty states named desktop controls.** *Shipped.* Preview,
Runtime and Tests said "Generate", "Bundle" or "click Boot" on a shell whose
only button is Run.

**M3 · Header menu contents are unprioritised.** The kebab holds the error /
warning badges, Bundle, Copy share link, Live mode, Import design pack and
the workspace tree with equal weight (`layout/HeaderBar.tsx`). Proposed:
badges become a status line at the top, Bundle disappears (Run covers it),
and Import / workspace tree move under a "Workspace" heading.

### 3.4 Status, naming and copy

**M4 · Zero-count badges were red and yellow.** *Shipped.* "0 ERRORS" in red
sat in the header permanently; the Runtime tab showed a grey dot while
offline. Colour now appears only when there is something to look at.

**M5 · Empty states without a next step.** *Shipped.* "Not generated yet.",
"No bundle yet.", "No diagnostics.", Preview's "Generate a system-mode source
first" shown *while* the auto-generate was running, and Tests' "declares no
test blocks" shown before anything had been generated.

**M6 · Jargon in first-contact copy.** *Partly shipped.* "Click Boot to spin
up PGlite + the generated Hono app", "saved in your browser (OPFS), keyed by
the source hash" (`layout/BackendPanel.tsx`), "the React app calls into
PGlite via the runtime worker" (`layout/PreviewPane.tsx`), "the playground's
`ddd snapshot`" (`layout/MigrationsPanel.tsx`), "The canonical JSON-on-the-
wire DTO" (`builder/system-v2/OverviewCanvas.tsx`), "dev-stub"
(`layout/AuthConfigPanel.tsx`). Shipped for Runtime and Preview. Proposed:
finish the sweep; keep the technology names in a *Details* disclosure.

**M7 · One concept, three names.** The dock tab is *Runtime*, the Output
stream is *Backend logs*, the test id is `backend-status`, the file is
`BackendPanel.tsx`; the centre tabs are *Builder* / *Model* but the panes call
themselves "the builder" and "the model builder", the breadcrumb root is
*Model*, and mobile shortens Requirements to *Reqs*; the same precondition is
phrased "Bundle + Boot first", "Boot the backend to run" and "Generate and
Bundle first" in three places. Proposed: a one-page vocabulary (Runtime /
Page builder / Model / Requirements; Generate / Bundle / Boot; Run on mobile)
and a sweep.

**M8 · Migrations tab contradicts itself.** The diff auto-runs on tab open
but the empty state says "Click 'Refresh diff'"; the baseline picker is
labelled "live vs"; the Refresh button shows only a spinner while loading
(`layout/MigrationsPanel.tsx`). Proposed: "Comparing the live source with
*Last save*…" as the loading line, "Compare with" as the label, keep the
button label during loading.

**M9 · Verdicts are raw IR enums.** VERIFIED / FAILING / UNTESTED /
UNVERIFIED in caps with no legend (`layout/TestsPanel.tsx`,
`builder/requirements/RequirementsPane.tsx`). Shipped: hover text in
Requirements. Proposed: sentence case and a one-line legend above the list.

**M10 · Diagnostics stream shows internals.** `react-error`,
`unhandledrejection`, `hash 341b` (`layout/OutputPanel.tsx`,
`LastCrashNotice.tsx`). Proposed: map reasons to sentences ("A panel crashed
while rendering") and keep the raw key in the copied report only.

### 3.5 Accessibility and keyboard

**M11 · Status by colour alone.** The 7 px dots on dock tabs, Output streams
and agent tool calls have no text, `title` or ARIA (`layout/DevToolsDock.tsx`,
`layout/OutputPanel.tsx`, `layout/ChatPanel.tsx`). Proposed: a count badge
("2") instead of a dot where there is a count, and a visually-hidden label
otherwise.

**M12 · Dock tabs are buttons, not tabs.** `UnstyledButton`s with no
`role="tab"`, no `aria-selected`, no arrow-key navigation
(`layout/DevToolsDock.tsx`). Proposed: Mantine `Tabs` with the same test ids.

**M13 · Icon-only glyph controls without labels.** ✎ × ↑ ↓ ƒ ⋯ ⇄ in
`builder/system-v2/ConstructNode.tsx`, `builder/system-v2/StmtNode.tsx`,
`builder/system/BodyEditor.tsx`, `builder/BuilderPane.tsx`,
`builder/page/StatePanel.tsx`; `+` rendered as a `span` with `role="button"`
in `layout/SourceFilesTree.tsx`; explanations placed in `title` on
non-focusable elements (`layout/HeaderBar.tsx` Live switch,
`layout/WorkspaceLockBanner.tsx`); a `Tooltip` wrapping a *disabled*
`ActionIcon` that can never show (`builder/requirements/RequirementsPane.tsx`).
`builder/system/ExpressionEditor.tsx` labels every one of its icons — apply
that convention everywhere and use a small inline SVG set instead of unicode.

**M14 · No keyboard shortcuts for the core loop.** The whole app has two
handlers: Ctrl+Enter in the SQL console and Esc for pseudo-fullscreen.
Proposed: Ctrl/Cmd+Enter = Generate (Run on mobile), Ctrl/Cmd+Shift+Enter =
Bundle+Boot, Ctrl/Cmd+S = Apply in the builders, Delete on a selected canvas
node, Esc = deselect / close; `?` opens the sheet from H5.

**M15 · Mouse-only rows.** The requirements master list and its links are
clickable `Box` / `Text` with no role or `tabIndex`
(`builder/requirements/RequirementsPane.tsx`); screenshot proofs are bare
`<Image onClick>` (`layout/TestsPanel.tsx`).

### 3.6 Theme and layout

**M16 · The dark palette is hard-coded but not forced.** ~108 uses of
`dark.N` / `--mantine-color-dark-N` plus literal white text, while
`main.tsx` sets `defaultColorScheme="dark"` rather than `forceColorScheme` —
a viewer whose stored Mantine scheme is light gets white-on-white panels.
Proposed (cheapest first): `forceColorScheme="dark"` today; migrate to
`--mantine-color-body` / `default-border` / `light-dark()` tokens over time.

**M17 · Truncation clips the wrong end.** File paths truncate the filename
and keep the directory (`layout/HistoryPanel.tsx`,
`layout/MigrationsPanel.tsx`). Proposed: middle-ellipsis and a full-value
tooltip.

### 3.7 Loading and error paths

**M18 · Loading states with no failure branch.** History's commit-changes
expansion has no `.catch`, so a failure shows "Loading changes…" forever
(`layout/HistoryPanel.tsx`); the migrations baseline list swallows errors
into an empty list (`layout/MigrationsPanel.tsx`); the pack list vanishes on a
failed read (`workspace/WorkspaceTree.tsx`); test discovery runs esbuild per
suite with no progress or cancel (`layout/TestsPanel.tsx`); the coverage
overlay and wire-shape inspector swallow errors into "n/a"
(`builder/system-v2/OverviewCanvas.tsx`). Proposed: an error row with a Retry
in each, and a per-suite progress line for discovery.

**M19 · Raw runtime text with no pointer.** A 500 from the booted backend
shows an opaque body with no "see Runtime logs"; a boot error dumps a stack
(`layout/BackendPanel.tsx`); TS transform errors render verbatim
(`layout/TestsPanel.tsx`). Proposed: one line of interpretation + a link to
the right Output stream above the raw text.

**M20 · Console noise on every load.** The LSP worker logs dozens of "An
error occurred while resolving reference to 'X': AST node has no document"
errors while the starter workspace loads. Not user-visible, but it is the
first thing a developer opening DevTools sees, and it may hide a real
cross-file linking race (`lsp/workspace-lsp-sync.ts`). Worth a separate look.

### 3.8 Low

- **L1** Read-only mode is explained in three places with three affordances
  (`layout/WorkspaceLockBanner.tsx`, `layout/HistoryPanel.tsx`,
  `layout/SourceFilesTree.tsx`).
- **L2** Mermaid viewer zooms on plain wheel, hijacking scroll; the zoom row
  appears only after render, shifting layout (`preview/doc-viewers.tsx`).
- **L3** "Exit full screen (Esc)" on touch devices (`preview/Preview.tsx`).
- **L4** *Download proofs* and the Output *Clear* buttons appear and vanish,
  shifting the toolbar (`layout/TestsPanel.tsx`, `layout/OutputPanel.tsx`).
- **L5** *Run demo* silently becomes *Replay demo*; Clear is the only reset
  (`layout/ChatPanel.tsx`).
- **L6** Header emphasis: *Import design pack* is the loudest control in the
  header while being the least used; *Live* has a title-only explanation.

## 4. Suggested order

1. **Pipeline strip + mobile More sheet** (H1, M1, M3) — one design, both
   shells, removes most of the copy branching shipped here.
2. **Confirm/undo layer** (H8–H11) — one component, ~12 call sites.
3. **Onboarding card + `?` menu + shortcuts** (H5, M14).
4. **Vocabulary + jargon sweep** (M6, M7, M8, M9, M10).
5. **A11y pass** (M11–M13, M15) and `forceColorScheme` (M16).
6. Builder empty states for scaffolded systems and parse errors (H6, H7).
