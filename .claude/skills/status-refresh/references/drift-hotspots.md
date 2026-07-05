# Drift hotspots — the claims that rot fastest, and the code that proves them

The claims most likely to be stale, each paired with the **single authoritative
location** to check it against. The discipline is constant: a doc claim is only
verifiable if you can name the file that proves it true or false. Re-derive from the
cited line on **fresh `main`** — never from memory or from another doc.

## Table of contents

1. [Backend / frontend COUNT — the #1 drift (the N-backend-era freeze)](#1-backendfrontend-count)
2. [SHIPPED / PARTIAL / PROPOSED status tags](#2-status-tags)
3. [Per-feature target lists ("works on node/dotnet/phoenix")](#3-per-feature-target-lists)
4. [Version pins ("net8", "Spring Boot 3.5", "stack v2")](#4-version-pins)
5. ["Feature X is gated / silent" claims](#5-gate-claims)
6. [Worked examples from this session's live finds](#6-worked-examples)

---

## 1. Backend / frontend COUNT

**The single highest-yield class.** Prose written when there were three backends
never updates itself when a fourth and fifth land. This is the "3-backend-era freeze"
#1407 named.

**Authoritative location:** `src/platform/registry.ts` — the `platforms` map. Today
it registers:

- **5 backends:** `node` (Hono — bareword resolves to `honoV5Platform`, the v5 default
  lane), `dotnet`, `java`, `python`, `elixir` (vanilla Ecto/Phoenix).
- **4 frontends:** `react`, `vue`, `svelte`, `angular` (plus `static`/`vite` aliasing
  to `react`).

Anything in the docs saying "three backends", "four targets", "the React frontend"
(singular), "node/dotnet/phoenix/react", or "three DB backends" is a freeze candidate.
Grep, then check each hit against the registry map:

```
rg -n "three (DB )?backends|four (backends|frontends|targets)|the React frontend\b|node/dotnet/phoenix|node, dotnet, (phoenix|elixir)\b" docs/ CLAUDE.md experience_gathered.md
```

Note CLAUDE.md itself opens with the correct count ("Five backends … and four
frontends … are supported") — so it's a good cross-check, but don't assume every doc
inherited that fix. The proposals corpus is where the freeze lingers.

## 2. Status tags

**Authoritative location:** the grammar + IR + emitter for the feature. The README
legend defines the contract:

| Tag | Means | How to verify |
|---|---|---|
| **SHIPPED** | Lives on `origin/main` | The grammar rule + IR node + at least the primary emitter exist and are wired. |
| **PARTIAL** | Some phases shipped | The shipped phases emit; the remaining ones are named in the doc and absent from code. |
| **PROPOSED** | No code yet | No grammar/IR/emit artifact — grep finds only the proposal doc. |

The drift direction is almost always **a status that's behind the code** — a header
saying "PROPOSED" or "not yet started" while the emitter already exists. The plan
doc's maintenance rule calls this out by name: "A status header that says 'not yet
started' while the emitter exists costs the next agent hours." To check a "PROPOSED"
claim, grep the grammar and IR for the feature's keyword; if it's there, the tag is
stale. The README table rows carry inline `(#1388, 2026-06-20 audit)` style
provenance — a row with no recent audit annotation against a feature that's clearly
landed is a refresh target.

## 3. Per-feature target lists

A doc that says "shipped on node/dotnet/phoenix" or a parity matrix with only
`node/dotnet/phoenix/react` columns is frozen at the old target set even when the
feature has since landed on java/python/vue/svelte/angular.

**Authoritative location:** for "does backend X emit feature Y," the emitter under
`src/generator/<platform>/` (grep for the construct). For the *honest* gate ("Y is
deliberately unsupported on X"), the validator gate set — see §5. **This is the
boundary with `parity-auditor`:** building the full who-emits-what matrix is *its*
job. For a status refresh, you're checking whether a doc's stated target list matches
reality — cite the registry for the column set, and if a specific cell's claim is in
doubt, hand the deep emitter check to `parity-auditor` rather than redoing it.

## 4. Version pins

Audit docs that record versions go stale the instant a bump lands, because the bump
touches the emitter, not the audit. **Trust the on-disk emitter pin, never the audit
doc.**

**Authoritative locations:**
- Frontend stack versions → the `stacks/` directory listing + `stacks/<id>/*.hbs`.
- Backend pins → `src/generator/<plat>/pins.ts`, `src/platform/hono/v5/pins.ts`, the
  `renderCsproj` / `SPRING_BOOT_VERSION` / `JAVA_VERSION` / `renderPyproject` /
  `renderMixExs` emitters, and `postgres:NN` in `src/system/index.ts`.

This is also `dependency-upgrade`'s territory — when a *bump* is the task, that skill
owns it and updates the audit. For a refresh, you're catching the audit doc that a
past bump left behind. See §6 for the live `stack-versions-audit.md` example.

## 5. Gate claims

A doc saying "feature X errors on backend Y" (honest gap) or "X silently breaks on Y"
(silent gap) is checkable against the validator.

**Authoritative location:** `src/ir/validate/checks/*` (esp. `system-checks.ts`,
`structural-checks.ts`) and `src/language/validators/*`. The pattern is a
`const FOO_BACKENDS = new Set([...])` / `LIMITED_FAMILIES = new Set([...])` literal
wired into a `validate…` function that raises a `loom.*` code. To check a gate claim:

```
rg -n "_BACKENDS|_CAPABLE|_FAMILIES|new Set\(\[" src/ir/validate/checks/system-checks.ts src/ir/validate/checks/structural-checks.ts
rg -n "loom\.[a-z-]+" src/ir/validate/checks/system-checks.ts
```

The drift here is a doc still listing a backend as a gap after the gate was widened to
include it (see F1 in §6). The deep silent-vs-honest classification is
`parity-auditor`'s discipline — for a refresh, you're confirming whether the doc's
gate claim still matches the set literal.

---

## 6. Worked examples (live finds this session)

These three were confirmed against the actual files this session — proof the surface
is drifty and a model for the verify-then-classify loop.

### F1 — "Python capability-filter silent gap" is already FIXED in code

The backend-parity audit's flagship Finding F1 listed Python as a silent gap for
capability filters. But on fresh `main`:

```
src/ir/validate/checks/system-checks.ts:1004
  const LIMITED_FAMILIES = new Set(["node", "elixir", "java", "python"]);
```

Python **is** in the gate set — F1 is fixed. **Classification: stale.** The audit doc
is a point-in-time snapshot; the `new Set` literal is the contract. A refresh flips
the F1 row (or marks it resolved with a dated note) and does *not* "re-open" the gap.
This is the exact case where prose and the cited line disagree and the code wins.

### Stale version audit — `stack v2` / mantine@v9 / "defer net8"

`docs/audits/stack-versions-audit.md` still references a **`stack v2` (mantine@v9)**
that does not exist on disk — `ls stacks/` returns only `v1`, `v3`, `sv1`, `vue1`,
`ng1`. The same doc lists .NET as "**defer until 2026-11** (.NET 8 is LTS)" and Spring
Boot at 3.5, while the emitters are already on `net10.0` and Spring Boot `4.1.0`.
**Classification: stale.** Fix to the on-disk reality (and note this overlaps with
`dependency-upgrade`'s update step — that skill bumps and updates the audit; a refresh
catches the audit that a past bump left stale).

### Stale `computeExports` comment after the Langium 4 rename

Langium 4 renamed `computeExports` → `collectExportedSymbols` (#1430). The method is
correctly renamed in code (`src/language/ddd-scope.ts:186` overrides
`collectExportedSymbols`), but a doc-comment at **`src/language/ddd-scope.ts:100`**
still says "Built here (not in `computeExports`) because…", teaching the dead name.
**Classification: stale (a residual code-comment — Mode B concept-scrub territory).**
This is exactly the §15 lesson: the symbol was renamed for you; the *prose mentioning
the old name* is the lingering 80%. Fix the comment to `collectExportedSymbols`.

> Note the meta-point: a stale **code comment** is still a docs-only fix — you're
> editing prose, not behaviour. That stays inside the skill's docs-only rule. What
> you must *not* do is change the code the comment describes to match a doc.
