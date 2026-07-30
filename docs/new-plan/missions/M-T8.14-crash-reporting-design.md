# M-T8.14 — Playground crash reporting & diagnostics surfacing (design)

> **Status: slices 1–3 implemented; slice 4 deferred as recommended.** See
> `docs/playground.md` → "Crash reporting & diagnostics" for the shipped
> behaviour. Source: `docs/audits/playground-file-mgmt-review-2026-07.md`
> §3.3 — "no crash telemetry at all (static-Pages, no beacon) … 'sometimes crashes'
> reports are currently unfalsifiable". Verified against `main` @ `7938c9b`
> (post-#2287, which added `web/src/PaneErrorBoundary.tsx`).

## Problem

A playground crash is caught but **not described**. Every crash class already
reaches the 12-entry `localStorage["loom.diag"]` ring — both boundaries call
`logDiagnostic` (`ErrorBoundary.tsx:102` → `"react-error"`,
`PaneErrorBoundary.tsx:42` → `"react-error-pane"`), as do the window handlers
(`"window-error"` / `"unhandledrejection"`). But `logDiagnostic` takes **only a
reason string**: a `DiagSnapshot` carries heap, storage estimate, UA, viewport and
hash length — *pressure*, never the **error message, stack, or component stack**,
which go to `console.error` and die with the tab. A maximally cooperative user who
opens Output → Diagnostics and pastes everything hands us a memory reading and the
word `react-error`.

Three gaps compound it:

- **No build identity.** `web/package.json` is `"version": "0.0.0"`, `vite.config.ts`
  has no `define`, `pages.yml` injects no SHA — a report can't say *which deploy*
  crashed, on a site each deploy overwrites (cf. the stale-chunk reload path,
  `ErrorBoundary.tsx:121`).
- **No worker crash class.** `build/client.ts` has `respawn()` but no
  `worker.onerror` — a dead build worker is invisible to the ring.
- **No "you crashed last session" signal.** The ring survives the reload; nothing
  reads it on boot, so the user never learns a report is worth filing.

## Constraints & decisions honored

- **No backend in this mission.** "No beacon" is deliberate and documented in
  `web/src/util/diagnostics.ts:11-13` ("the playground is static (GitHub Pages), so
  there's no backend to beacon to"). Slices 1–3 add **zero** infrastructure.
- **Never exfiltrate model source** — reports carry hashes and shapes only.
- **The BYOK key must never enter a report.** It is `apiKey` inside
  `localStorage["loom.agent.settings"]` (`agent/provider.ts:110`) — the key is *not*
  `AgentSettings` (that's the TS type). A unit test pins the exact string.
- **The surface already exists** — reuse it: Output panel → **Diagnostics** stream
  (`OutputPanel.tsx` `DiagBody`, testids `output-diag-*`) renders the ring
  on-device, and `window.__loomDiag()` reads it.

## Direction

Make the ring **self-sufficient as a bug report**, then give it two exits that cost
nothing to host: the clipboard and a prefilled GitHub issue.

**What is even mappable.** A playground-app stack is **not** `ddd trace`-able:
`.loom/sourcemap.json` maps *generated* app code back to `.ddd` (already surfaced by
the devtools sourcemap panel). The playground's own React crash is plain JS, and
`vite.config.ts` sets no `build.sourcemap`, so the deployed bundle is **minified with
no map** — the report carries minified frames plus the build id, and meaning is
recovered by rebuilding that SHA. (`build.sourcemap: "hidden"` — maps retained as CI
artifacts, never served — is a cheap follow-up knob, not a slice.) A crash *inside
the preview iframe* is a different class: already forwarded to the app log
(`preview/iframe-html.ts:136`) and genuinely sourcemap-mappable. Unchanged here; the
report states which side crashed.

## Slices

### Slice 1 — capture completeness (**S**)

`logDiagnostic(reason, detail?)` gains `detail: { message, stack, componentStack,
pane? }`, **truncated at capture** (message 500 chars, stack 30 frames, component
stack 20). Wire it from both boundaries, both window handlers, and a new
`worker.onerror`/`messageerror` in `build/client.ts` (`"worker-error"`). Add
`build: { sha, builtAt }` to every snapshot via a `define` in `web/vite.config.ts`
fed by `GITHUB_SHA` (fallback `git rev-parse` / `"dev"`). Persist a
`loom.diag.lastCrash` flag (reason + timestamp + build) on any error-class capture.
*Evaluate-then-decide:* a 20-entry in-memory action breadcrumb (`"tab:builder"`,
`"generate"`, `"restore"` — event names only, no arguments) flushed into the crash
snapshot; if instrumenting call sites proves invasive, ship without it — the value
is in the stack, not the trail.

*Acceptance:* a forced pane crash yields a ring entry with message, stack, pane
name and build SHA; a rejected promise and a dead build worker each get their own
class; ring stays capped at 12; `logDiagnostic` still never throws.

### Slice 2 — the report surface (**S/M**)

`web/src/util/crash-report.ts`: `buildCrashReport(snapshots, ctx) → string`
(fenced markdown, deterministic, pure) + `redact(text)`. Both crash fallbacks and
the Diagnostics stream grow **Copy crash report** and **Report on GitHub**; on boot,
when `loom.diag.lastCrash` is set, a dismissible notice ("the playground crashed
last session — view / report") links to Diagnostics and clears the flag.

The GitHub exit uses an **issue form** prefilled *by field id* —
`…/issues/new?template=crash-report.yml&labels=crash-report&report=<encoded>` (a
`?body=` prefill would override a form template wholesale; repro steps stay
human-filled). Budget the encoded URL at **≤6 000 chars**: newest 4 snapshots, first
15 stack frames, append `_(truncated — full report on the clipboard)_`. Copy is
always the complete artifact (clipboard is unbounded).

*Acceptance:* the report contains build SHA, crash class, message, stack, component
stack, UA/viewport, heap/storage, workspace fingerprint; the prefill URL stays under
budget for a saturated ring; a report built from a workspace containing a key-shaped
string and real `.ddd` text contains neither.

### Slice 3 — team-side signal without a beacon (**S**)

The repo has **no `.github/ISSUE_TEMPLATE/` at all** today. Add `crash-report.yml`
(what you were doing, reproducibility, the pasted `report` block, browser) + a
`config.yml` so free-form issues stay available, and the `crash-report` label.
Document the flow in `docs/playground.md` (no diagnostics section exists): Output →
Diagnostics, `window.__loomDiag()`, what a report contains and what it omits.

*Acceptance:* an inbound report is triageable with no follow-up round-trip — build
SHA, crash class and stack structurally present, not prose.

### Slice 4 — opt-in anonymous beacon (**deferred; decision-gated**)

Enumerated, **recommended deferred**. A static site has no first-party endpoint, and
every option imports infrastructure we don't have: a hosted error service
(Sentry-class — free tier, but a third-party processor, a DSN in a public bundle, a
privacy commitment to write); a serverless function (new deploy target, new secret,
new on-call); a GitHub-API auto-file (needs a client-side token — disqualified).
**Do not build.** Revisit only if, after slices 1–3 are live for two release cycles,
we have **fewer than ~3 usable inbound reports** *and* an open crash defect nobody can
reproduce. If ever built: default OFF, explicit toggle, the identical redacted
payload, and one line saying where it goes.

## Privacy / redaction rules (normative)

1. **Never** include `.ddd` or generated source text. Workspace appears only as a
   fingerprint: file count, per-file byte length, truncated SHA-256 per path.
2. **Never** read `localStorage["loom.agent.settings"]` (or any `apiKey`); the
   builder takes an explicit allowlist of inputs, never a storage dump.
3. Redact credential shapes from free text before assembly (`sk-…`, `ghp_…`, bearer
   tokens, `key=`/`token=` params) and strip query/hash from any URL — the share hash
   encodes the model.
4. Keep the UA string (browser/OS triage); no IP, no cookie, no fingerprinting.
5. The report is inert data the user copies. Nothing is sent by the app.

## Test strategy

- **Unit** (`test/playground/crash-report.test.ts`): assembly deterministic and
  complete; truncation budgets hold for a saturated ring; prefill URL <6 000 encoded
  chars; each credential shape redacted; no source text survives; an input carrying
  `apiKey` emits nothing containing it.
- **Unit** (`diagnostics.test.ts`): `detail` truncation, ring cap, `lastCrash`
  set/clear, `logDiagnostic` swallowing a throwing `localStorage`.
- **E2E** — ErrorBoundary has **no coverage today** (`builder-page.spec.ts` only
  asserts the fallback *doesn't* appear). Add a URL crash trigger
  (`?__loomCrash=root|pane`) that throws inside the boundary. It must **not** be
  `import.meta.env.DEV`-gated: `playwright.config.ts` runs `npm run build && npm run
  preview`, so specs execute a production bundle. Spec (network-free lane — add to
  `playground-e2e-no-network.yml`'s spec list): trigger → fallback visible → Copy →
  assert clipboard → reload → "crashed last session" notice → dismiss → gone.

## The one decision point

**Is Slice 4 in scope at all, or is "the clipboard is the transport" the standing
answer?** Everything above is written for the second. Slices 1–3 are independently
valuable and add no infrastructure; approving them does not commit to a beacon, and
the deferral criterion is deliberately falsifiable.
