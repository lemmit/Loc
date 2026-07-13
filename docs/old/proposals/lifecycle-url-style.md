# Lifecycle URL style — Phase 2 design (`urlStyle` + `routeSlug`)

> **Status:** **SHIPPED** ([D-URLSTYLE](../../decisions.md#d-urlstyle--lifecycle-url-style-on-the-api-body--per-action-routeslug)).
> Reconciles [`lifecycle-operations.md`](./lifecycle-operations.md) Phase 2
> with the **actual** `api` grammar, which differs from that proposal's
> assumption. Phase 1 (kind-tagged `create`/`destroy`, the
> `creates`/`destroys`/`canonical*` IR) shipped in #722; the slice this
> doc designs is live end-to-end (verified 2026-06-10): `urlStyle:` on
> the api body parses + lowers, enrichment stamps `OperationIR.routeSlug`
> per action (`routeSlugFor` in `src/ir/enrich/enrichments.ts`), and
> every backend route emitter consumes it (`snake(op.routeSlug ??
> op.name)` on Hono / .NET / elixir, plus the React API client and the
> OpenAPI emitters) — pinned by `test/ir/lifecycle-url-style.test.ts`.

## Why this doc exists — the proposal is written against a grammar that doesn't exist

`lifecycle-operations.md` §"Grammar / IR / generator integration seams"
specifies the `urlStyle` setting like this:

```
Api:        'api' name=ID 'for' target=[Aggregate] ('{' members+=ApiMember* '}')?
UrlStyleDecl: 'urlStyle' ':' style=('literal' | 'resource')
```

— a **per-aggregate** api with a body. The real grammar
(`src/language/ddd.langium:282`) is:

```
Api: 'api' name=ID 'from' source=[Subdomain:ID];
```

— a **per-subdomain**, body-less one-liner. A deployable binds it via
`api <Subdomain>: <Api>`. Every Phase-2 sub-decision (where `urlStyle`
attaches, what "the api for this aggregate" means, how `routeSlug`
derives) has to be re-derived from the real model. Transcribing the
proposal verbatim would produce a grammar that can't parse a single
existing `.ddd` file. Hence: design first.

The corpus confirms the real shape — every `api` declaration across
`examples/` + `web/src/examples/` is the body-less `api X from Sub`
form (zero brace-bodied apis today), so adding an optional body is
backward-compatible.

## Decisions (requesting D-URLSTYLE)

### 1. `urlStyle` lives on the `api`, as an optional body

```
api SalesApi from Sales { urlStyle: resource }
api CatalogApi from Catalog                       // body omitted ⇒ urlStyle: literal
```

- Default **`literal`** (D-LIFECYCLE-VERB).
- **Why the api, not the deployable:** URL shape is a *contract* concern,
  not a *deployment* concern. Two deployables serving the same api (a
  Hono backend + a React frontend consuming it) must agree on the URL,
  so the setting belongs on the shared contract, not per-process.
- **Why the api, not a system default:** different subdomains can want
  different conventions; a system-wide knob is too coarse. (A system
  default that apis override is a possible v2 nicety — deferred.)
- **Grammar:** a direct optional property, not a `members+=ApiMember*`
  list — there is exactly one api-body setting today, and a flat
  property is simpler. Promote to a members list only when a second
  api-body clause (e.g. exception-less `status` mappings) actually
  lands.

```
Api:
    'api' name=ID 'from' source=[Subdomain:ID]
        ('{' ('urlStyle' ':' urlStyle=('literal' | 'resource'))? '}')?;
```

`resource` becomes a keyword — soft-admit it (and `urlStyle`) in
`LooseName` / `NameRefIdent` so existing field/param names survive
(the `dataSource`/`money` precedent). `literal` is already soft.

### 2. `routeSlug` is a field on each action, derived in enrichment

Post-Phase-1 the aggregate already carries `operations` / `creates` /
`destroys` arrays partitioned by kind. Rather than the proposal's
separate consolidated `agg.lifecycle` shape (which would duplicate that
partition), derive a `routeSlug` **on each `OperationIR`**:

```ts
interface OperationIR {
  // … Phase-1 fields (kind, canonical, name, …)
  /** HTTP path segment, derived in enrichment from the surfacing api's
   *  urlStyle. `undefined` ⇒ canonical action ⇒ bare collection URL
   *  (POST /orders, DELETE /orders/:id). Consumed by Phase-3 emitters;
   *  no backend reads it yet. */
  routeSlug?: string;
}
```

Derivation (per action, given the resolved `urlStyle`):

```
routeSlug =
  canonical            → undefined          // bare collection / canonical id URL
  urlStyle = literal   → name               // verbatim
  urlStyle = resource  → plural(name)       // src/util/naming.ts:plural
```

The HTTP **verb + path skeleton** (POST `/coll`, DELETE `/coll/:id`,
POST `/coll/:id/<slug>`) stays Phase-3 emitter logic keyed on
`kind` + `canonical` + `routeSlug`. Phase 2 only computes the slug.

### 3. The surfacing api is resolved by subdomain

Cardinality (verified): aggregate → one context → one subdomain → the
api(s) `from` that subdomain. Enrichment builds
`urlStyleBySubdomain: Map<subdomainName, urlStyle>` from `sys.apis` and
threads the subdomain's style into `enrichAggregate`, which stamps each
action's `routeSlug`. Top-level contexts (no system, no api) and
subdomains with no api default to `literal`.

**Conflict rule:** if two apis source the same subdomain with *different*
`urlStyle`, enrichment takes the **first declared** and the validator
emits `loom.subdomain-conflicting-urlstyle` (warning). The same-style
case is silent. (This is an edge case — one api per subdomain is the
norm.)

### 4. Output impact: none → no fixture re-baseline

No backend consumes `routeSlug` in Phase 2 — emitters still build slugs
inline as `snake(op.name)` (which equals `snake(routeSlug)` under the
`literal` default). So **generated output is byte-identical** and no
fixture re-baseline is needed. The re-baseline lands in **Phase 3**,
when emitters switch to reading `routeSlug` (and `resource`-style
projects' URLs change) — a coordinated `rebaseline-Lifecycle` moment.

### 5. The verb-name warning is deferred

`lifecycle-operations.md` lists `loom.url-style-naming-warn` — warn when
a verb-shaped name pluralises awkwardly under `resource` (`cancel` →
`/cancels`). **Deferred**: reliable verb detection needs a lexicon;
false positives are user-hostile; the value is a style nudge. Revisit
if `resource` adoption shows real confusion. Not in this slice.

## Implementation plan (one PR)

| Layer | Change |
|---|---|
| Grammar | optional `Api` body with `urlStyle=('literal'\|'resource')?`; soft-admit `resource`/`urlStyle` in `LooseName` + `NameRefIdent`; regen. |
| IR types | `ApiIR.urlStyle: "literal" \| "resource"`; `OperationIR.routeSlug?: string`. |
| Lowering | `lowerApi` reads `a.urlStyle ?? "literal"`. |
| Enrichment | `urlStyleBySubdomain` from `sys.apis`; thread into `enrichContext`→`enrichAggregate` (default `"literal"` for top-level contexts); stamp `routeSlug` on every operation/create/destroy; re-point `canonicalCreate`/`canonicalDestroy` if action objects are rebuilt. |
| Validator | `loom.subdomain-conflicting-urlstyle` (warning) on a subdomain surfaced by ≥2 apis with differing `urlStyle`. |
| Tests | `urlStyle` parse + default; `routeSlug` derivation per kind × {literal, resource}; canonical ⇒ undefined; conflict warning; **a generated-output-unchanged assertion** (or rely on the full suite staying green) to prove zero drift. |

## Open question for sign-off

- **D-URLSTYLE** — ratify §1–§3 (api-body home, per-action `routeSlug`,
  subdomain resolution + first-wins conflict rule). §4/§5 are
  consequences/scoping, not separate decisions.

On ratification: fold §1–§3 into `lifecycle-operations.md` (replacing
its fictional `api … for Aggregate` Phase-2 text) and add D-URLSTYLE to
`docs/decisions.md`.
