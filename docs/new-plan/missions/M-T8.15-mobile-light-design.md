# M-T8.15 — Mobile light: shed the IDE, keep the app

*Design doc. Status: proposed. Owner-review requested before slice 2.*

The playground does not boot on an iPhone. Four fixes across this session each
made the app measurably lighter and **none of them moved the failure** — it
still dies at the same phase. This doc says why, what the one remaining lever
is, and what mobile should be instead.

The product constraint is fixed by the owner and is not up for trade:

> **the data layer / full app is a must** — a prototype you can only *look* at
> is not worth booting. Preview means a real backend behind it.

So this is not "drop the runtime on mobile". It is: **make the runtime
affordable by deleting everything else from the phone's memory budget.**

---

## 1. What we know (measured, not inferred)

### The failure

`died-in-phase` / `boot:ddl-meta` / `(9 stmts, 1KB)` — four separate field
reports, four different builds, same phase every time. No JS error, no
`pagehide`, no ring entry: the renderer process is *killed*, which is why every
earlier crash report came back empty. The phase marker (a synchronous
`localStorage` write before each risky step, `web/src/util/diagnostics.ts`) is
the only instrument that survives it.

`boot:ddl-meta` is the first `exec()` against PGlite. PGlite 0.4.5 has a lazy
constructor — `new PGlite()` returns in ~0.7 ms and starts nothing. The first
SQL statement is where **Postgres-in-WASM actually starts up**, and that
requires a **128 MB contiguous WASM heap**: `pglite.wasm` declares
`initial = 2048` pages in its memory import. That is a property of the compiled
artifact, not a setting — `initialMemory` can only be raised, and passing a
smaller value fails hard (`LinkError: memory import has 512 pages which is
smaller than the declared initial of 2048`, verified before shipping).

So the boot asks iOS for 128 MB in one piece, on top of whatever the tab is
already holding. On iOS the whole tab — main thread **and every worker** — lives
in one WebContent process against one memory budget. There is no per-worker
allowance to hide in.

### What the tab is already holding

Measured against `origin/main` @ `e1b342a0`, `npm run build` in `web/`:

| | size | when |
|---|---|---|
| `monaco-*.js` | **9.56 MB** | eager, before first paint |
| `index-*.js` (app + **the whole Loom compiler**) | **2.57 MB** | eager |
| `mantine` / `react` / `xyflow` | 0.66 MB | eager |
| **eager JS total** | **12.80 MB** | |
| `build.worker` | 3.11 MB | on generate |
| `extensionHost.worker` | 1.76 MB | with Monaco |
| `ddd-server.worker` (Langium LSP — a *second* compiler) | 1.31 MB | with Monaco |
| `editor.worker` | 0.33 MB | with Monaco |
| `esbuild.wasm` | ~14 MB | on bundle (released before boot on mobile) |
| PGlite assets (jsdelivr) | ~13.9 MB | on boot |
| **PGlite heap** | **128 MB contiguous** | at `boot:ddl-meta` |

Two things in that table are the story.

**Monaco is 75% of eager JS.** It is resident before the user taps Run, and its
parsed/retained heap is a multiple of the 9.56 MB on the wire. It brings three
more worker realms with it.

**The Loom compiler is on the main thread, eagerly.** `index-*.js` contains
chevrotain, Langium and the grammar — confirmed by signature (`chevrotain` ×25,
`loom_validate` ×4 in the built chunk). It gets there through a chain nobody
designed:

```
App.tsx  →  agent/{demo,live,openai-transport,system-prompt}
         →  src/tools/index.js  →  src/api/index.js
         →  src/language/ddd-module + src/ir/{lower,enrich,validate}
```

The agent chat is a *feature*, statically imported for its `runAgentDemo`
symbol, and it drags the entire compiler front-end onto the eager path — a
third resident copy, alongside `build.worker` and `ddd-server.worker`.
`layout/TestsPanel.tsx` does a smaller version of the same thing
(`src/verify/verification.js`).

### Why the four earlier fixes didn't help

| fix | shipped | effect on the kill |
|---|---|---|
| release the esbuild bundler before boot | #2422 | none |
| `:memory:` PGlite instead of OPFS on mobile | #2422 | none |
| GC stale OPFS islands at startup (400 → 79.8 MB) | #2420 | none |
| un-eager the LikeC4 chunk (15.87 → 12.80 MB eager) | #2427/#2431 | none |

They were all real (and worth keeping), but each freed single-digit megabytes
against a 128 MB demand. **Monaco + the eager compiler are the only remaining
items large enough to matter**, and they are exactly the two things mobile
does not need.

---

## 2. The reframe

The playground is a desktop IDE that happens to also render at 375 px.
`isDesktop ? <DesktopShell/> : <MobileShell/>` picks a *layout*; both shells
sit under one `App.tsx` that has already imported Monaco, the LSP client and
the compiler by the time the ternary runs. **Mobile pays the full desktop
bill and renders a phone UI.**

What a phone is actually for, per the owner:

- **read the model, make small edits** — not multi-cursor authoring
- **see the app run, with real data** — the whole point
- **(soon) talk to the AI about it** — chat is text, not an IDE

What a phone is *not* for: a visual page builder, a graph modeller, a
requirements matrix, a full LSP with hovers and completions on a soft keyboard.

So mobile should be a **different application built from the same pipeline**,
not a narrow view of the same application.

### Keep / drop

| | mobile-light | why |
|---|---|---|
| Source view + edit | **keep** — plain textarea, monospace, line numbers | editing on a phone is typo-fixes and small blocks; Monaco buys nothing at 375 px |
| Generated-file view | **keep** — read-only, no highlighting (or a ~10 KB highlighter) | you read it, you don't refactor it |
| Problems | **keep** — from `generate`, which already returns diagnostics | the build worker already computes them; the live LSP is redundant here |
| Generate → bundle → **boot** | **keep, unchanged** | the product |
| Preview | **keep, unchanged** | the product |
| Backend / API explorer | **keep** | proves the data layer is live |
| Chat | **keep, lazy** | the near-future reason to open this on a phone at all |
| Monaco + `monaco-languageclient` + 3 worker realms | **drop** | 9.56 MB eager + 3.4 MB of workers |
| Live LSP (`ddd-server.worker`) | **drop** | a second resident compiler for hovers we can't show |
| Builder (craft.js) | **drop** | already lazy; also unusable at 375 px |
| Modeller (xyflow) | **drop** | ditto — and it's *eager* today (0.18 MB, plus what it pulls) |
| Requirements pane | **drop** | desktop analysis surface |
| Tests / Migrations / History / Auth panels | **lazy**, not dropped | occasionally wanted, never on the boot path |

Projected eager JS on mobile: **12.80 MB → ~1.2 MB**, and three worker realms
never spawn. That is the first change in this whole investigation whose size
is comparable to the demand it has to make room for.

---

## 3. How the split works

**Not a second Vite entry.** A `mobile.html` would shed the same bytes but
forks routing, the share-hash contract, the workspace/git layer and the e2e
suite — two apps to keep in step, for a saving code-splitting already gives us.

**Instead: make the desktop subgraph reachable only through `await import()`,
and choose the shell before the first render.**

```
main.tsx
  matchMedia("(min-width: 768px)")        // once, at boot — not a hook
  ├─ desktop → await import("./DesktopApp")   // Monaco, LSP, builder, modeller
  └─ mobile  → await import("./MobileApp")    // textarea, preview, runtime
       both mount <PipelineProvider>  ← the shared core
```

The shared core is what `App.tsx` is today *minus* its shell-specific imports:
workspace/git, the pipeline reducer, the build/bundle/runtime worker clients,
share-hash handling, diagnostics. It has no Monaco and no `src/tools` import.
Shell-specific state (which Monaco model is open; which mobile tab is active)
moves into the shell that owns it.

This works only if the boundaries are *honest*, and honesty here has failed
three times already (the `manualChunks` hazard — grouping a scope into one
chunk means one static import promotes the whole group). So the boundary gets
a gate, not a convention: `web/scripts/check-eager-chunks.mjs` already walks
the emitted static-import graph and fails on promoted chunks. It gains a
**hard byte budget for the mobile entry** — if mobile's eager graph exceeds
~2 MB, CI fails and names the importer. A budget is the only form of this rule
that can't rot.

---

## 4. Slices

Each lands on its own, each is measurable, and the first two are worth doing
even if the boot still fails afterwards.

| # | change | measure |
|---|---|---|
| **1** | Lazy the agent + verify imports: `src/tools` / `src/api` / `src/verify` reachable only via `await import()`. Pure de-eagering, both surfaces. | eager JS drops by the compiler's share of `index-*.js` |
| **2** | Mobile source editor + file viewer without Monaco (`<textarea>` + read-only viewer). Monaco reachable only from the desktop subgraph. | Monaco leaves mobile's eager graph |
| **3** | Mobile problems from `generate` instead of the live LSP; `ddd-server.worker` not spawned on mobile. | one worker realm fewer |
| **4** | Entry split in `main.tsx` (`DesktopApp` / `MobileApp` over a shared pipeline core); Builder / Modeller / Requirements unreachable from mobile. | mobile eager ≤ 2 MB |
| **5** | Budget gate: `check-eager-chunks.mjs` fails over the mobile entry's byte total. Mutation-proved by re-adding a static Monaco import and watching it fail. | the gate fails when reverted |

Slices 1–3 are independent; 4 depends on 2–3; 5 depends on 4.

---

## 5. How we'll know

The oracle is the one instrument that survives a renderer kill: **the phase
marker has to move past `boot:ddl-meta`.** Anything else — smaller bundles,
faster paint — is a proxy.

That gives three honest outcomes, and the design is worth landing under all
three:

1. **It boots.** The headroom was the problem; mobile-light is the fix.
2. **It gets further** (`boot:ddl-apply`, `boot:create-app`). The budget was
   the problem and there is more to shed — next targets are the generated
   bundle's own footprint and the PGlite asset fetch.
3. **It still dies at `boot:ddl-meta`.** Then 128 MB is simply more than this
   device will give a web page, whatever else we do — and *that* is a real
   finding, reached honestly, which redirects the work to a server-side
   runtime rather than to more trimming. Slices 1–4 remain correct on their
   own merits (a phone shouldn't download a 9.56 MB editor to read code).

**No claim that this fixes the boot is made until a phase marker says so.**
Four "this should help" fixes have already failed that test.

---

## 6. Rejected

- **UI-only mobile (mock data, no backend).** Ruled out by the owner: the data
  layer is the point of testing a prototype.
- **Mark the runtime desktop-only.** Same reason. It also gives up before the
  one lever big enough to matter has been pulled.
- **Second Vite entry / separate mobile app.** Sheds the same bytes for a
  permanent two-app maintenance cost; code-splitting is the cheaper form of
  the same boundary.
- **Shrink PGlite.** The 128 MB is declared by the compiled `.wasm`. Rebuilding
  Postgres-in-WASM with a smaller heap is upstream work with a different risk
  profile; revisit only if outcome 3 above lands.
- **Keep Monaco, load it lazily on mobile.** Once loaded it stays resident for
  the session, and the session is exactly when boot happens. Lazy is not the
  same as absent.

---

## 7. Notes for whoever picks this up

- `web/src/util/diagnostics.ts` — phase markers. Add a marker before any new
  risky step; the ring cannot see a process kill, only the marker can.
- `web/scripts/check-eager-chunks.mjs` — the eager-graph walker. Read the
  comment block first; it lists the three times this class of bug has shipped.
- The measurement recipe: `npm run build` in `web/`, then
  `node scripts/check-eager-chunks.mjs`. It prints eager vs. total.
- iOS gives one memory budget to the tab *and all its workers*. Moving work
  into a worker does not buy headroom here — only deleting it does.
