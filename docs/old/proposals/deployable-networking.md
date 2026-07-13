# Deployable networking — ports, `serves … at`, and the playground

**Status:** proposal, unadopted.
**Scope:** how deployables expose apis on the wire — port allocation,
per-api routing prefixes, frontend wiring, compose emission, and
playground topology.
**Not in scope (yet):** backend-to-backend service discovery (peer URLs,
peer auth). Designed-around, not designed-in; see "Forward
compatibility" at the bottom.

---

## 1. Problem

The DSL today treats apis as opaque projections of a subdomain and
treats `deployable` as the only place networking exists — but the
networking surface on `deployable` is thin and has silent failure
modes:

- **Port collisions are silent.** Two `platform: node` deployables that
  both omit `port:` both resolve to `3000` (the platform default). The
  validator does not flag this; compose simply fails to start.
- **No api-level URL identity.** A deployable can `serves: SalesApi,
  CatalogApi`, but there's no way to express that the two apis live at
  distinct path prefixes inside that backend. The frontend gets a
  single `API_BASE_URL` and the backend mounts everything at `/`.
- **The frontend deployable's `targets:` is the only signal of "which
  backend".** This is fine for single-target frontends but makes the
  multi-api case awkward, because the natural per-api routing
  information has nowhere to live.
- **The playground supports exactly one Hono + one React.**
  `PrepareInput` in `web/src/engine/runtime-engine.ts` is hardcoded:
  `honoEntry: string`, `reactEntry?: string`. Multi-deployable systems
  cannot be run in the browser at all.

End goal: generated code carries proper port/URL parameters, dockerfiles
and compose are wired correctly, and the playground accepts
multi-deployable systems (initially one frontend + N backends).

---

## 2. Current state (auditable)

### 2.1 Grammar (`src/language/ddd.langium`)

```langium
// Deployable, lines 107–150 (relevant clauses):
('contexts'    ':' '[' contextRefs+=[BoundedContext:ID] (',' ...)* ']' ','?)?
('dataSources' ':' '[' dataSourceRefs+=[DataSource:LooseName] (',' ...)* ']' ','?)?
('targets'     ':' targets=[Deployable:LooseName] ','?)?
('serves'      ':' serves+=[Api:ID] (',' serves+=[Api:ID])* ','?)?
(uiSugar=UiSugarBinding | uiCompose=UiComposeBinding | uiBlock=UiBlockBinding)?
('port'        ':' port=INT ','?)?
```

- `serves:` is a flat list of api refs — no path information.
- `port:` is an optional bare integer — no defaulting at the grammar
  level.
- `targets:` is a single deployable ref. There is no multi-target form.
- `UiSugarBinding` (`ui: ShopUI`) and `UiComposeBinding` (`ui: ShopUI
  { Sales: shopApi, … }`) are mutually exclusive; compose form binds
  each UI api parameter to a deployable individually.

### 2.2 IR (`src/ir/types/loom-ir.ts`)

```ts
DeployableIR {
  name: string;
  platform: Platform;
  platformRef: string;
  contextNames: string[];
  dataSourceNames: string[];
  port: number;                  // always populated; defaulted at lower-time
  targetName?: string;
  design?: string;
  auth?: { required: boolean };
  uiName?: string;
  uiFramework?: string;
  serves: string[];              // ← flat api-name list
  uiBindings: UiParamBindingIR[];
  favicon?: string;
}
```

### 2.3 Platform defaults (`src/platform/*`)

| Platform           | `defaultPort` |
|--------------------|---------------|
| `hono`             | 3000          |
| `react`            | 3001          |
| `dotnet`           | 8080          |
| `phoenixLiveView`  | 4000          |
| (fallback)         | 3000          |

`defaultPortFor()` in `src/ir/lower/lower.ts:862` falls back to 3000 for
unknown platforms and applies the default whenever `port:` is omitted.

### 2.4 Compose emission (`src/system/index.ts:310–388`)

- One service per deployable, slug = `serviceSlug(d.name)`.
- Port mapping `${d.port}:${shape.internalPort}` (shape from
  `platform.composeService(...)`).
- Inter-service URLs: only `DATABASE_URL` style env vars wired by each
  platform's `composeService()`; no peer-deployable URLs surfaced.

### 2.5 Frontend wiring (`src/generator/react/index.ts:70–82`)

```ts
const target = sys.deployables.find((d) => d.name === deployable.targetName);
const apiBaseUrl = options.apiBaseUrl ?? `http://localhost:${target?.port ?? 8080}`;
// → src/api/config.ts bakes apiBaseUrl as the default.
```

Runtime cascade in `api/api-config.hbs`:
`window.__LOOM_API_BASE__` → `import.meta.env.VITE_API_BASE_URL` → baked
default. One knob, one origin.

### 2.6 Consumers of `targets:` / `deployable.targetName`

- `src/generator/react/index.ts:78` — compute `apiBaseUrl`.
- `src/platform/react.ts:18` — same purpose, for compose env injection.
- `src/ir/enrich/enrichments.ts:511–512` — react `targets:` module-name
  inheritance (a frontend inherits its target backend's module
  catalogue for stable routing names).
- `src/system/likec4.ts:46` — the architecture diagram's
  `frontend → backend` "calls" arrow.

This is why `targets:` cannot simply be deleted in favour of the
`UiComposeBinding` — module inheritance and the architecture diagram
both consume it, and both are valuable independently of URL wiring.

### 2.7 Playground (`web/src/engine/runtime-engine.ts`)

```ts
interface PrepareInput {
  files: VirtualFile[];
  dependencies: DependencySet;
  honoEntry: string;       // hardcoded singular
  reactEntry?: string;     // hardcoded singular
}
```

Multi-deployable systems are inexpressible. Anything more than one
backend silently runs the first one.

---

## 3. The proposal

Four orthogonal changes. The first three each ship independently; the
fourth depends on the second.

### 3.1 Port allocation: manual + collision validator + hybrid auto-fill

**Grammar:** unchanged (`port:` stays optional).

**New validator** (`src/language/validators/deployable-ports.ts`,
phase ④):

- Two deployables with the same *declared* `port:` →
  `loom.port-collision` (cites both source locations).
- A declared `port:` that equals another deployable's resolved default
  (its platform's `defaultPort` when that deployable omits `port:`) is
  also a collision. Catches the silent-clash case.
- Reserved/system port range (<1024) → `loom.port-reserved` warning.

**Lowering** (`src/ir/lower/lower.ts`, around line 850):

1. Pass 1 — copy declared ports verbatim. They are immovable.
2. Pass 2 — for each deployable without a declared port, in declaration
   order, scan from its platform's `defaultPort` upward and take the
   first unclaimed slot.
3. Record `portWasDeclared: boolean` on `DeployableIR` (consumed by the
   `.loom/` traceability bundle and by future port-stability tooling).

**Determinism:** declaration order + per-platform default + claimed set
fully determines the assignment. Re-running generation yields the same
ports. Adding a new deployable at the *end* of the source does not
shift any existing port; adding one in the middle can shift later
auto-filled ports — explicit `port:` is the way to pin.

**Allocation density:** scan +1 at a time (3000, 3001, …) rather than
spacing (3000, 3010, …). Spacing makes manual overrides safer but URLs
uglier; pinning is the recommended override path.

### 3.2 `serves … at` — per-api routing prefixes

**Grammar (`src/language/ddd.langium`):**

```langium
// replaces the current `serves+=[Api:ID] (',' serves+=[Api:ID])*` line
('serves' ':' serves+=ServeBinding (',' serves+=ServeBinding)* ','?)?

ServeBinding:
    api=[Api:ID] ('at' path=STRING)?;
```

**Default `path` resolution** (in lowering, not grammar — so that
omitted paths still produce predictable output):

- One api served → `"/"`.
- N apis served → `"/{kebab(api.name minus trailing 'Api' suffix)}"`
  (so `SalesApi` → `/sales`, `CatalogApi` → `/catalog`).

**Validator additions:**

- `loom.serve-path-shape` — path must start with `/`, no trailing `/`
  (except the bare `/` mount).
- `loom.serve-path-duplicate` — paths within one deployable are unique.
- `loom.serve-path-overlap` — no path is a prefix of another (`/api`
  and `/api/v1` reject).

**IR (`src/ir/types/loom-ir.ts`):**

```ts
type ServeBindingIR = { api: string; path: string };

DeployableIR.serves: ServeBindingIR[];  // ← was string[]
```

**Backend route mounting:**

Each per-api router is generated exactly as today (handlers,
validation, repositories — completely unaware of where it sits in the
URL space). The orchestrator (`src/index.ts` for hono;
equivalents elsewhere) mounts each one under its
`ServeBindingIR.path`:

```ts
// hono
app.route("/sales",   salesApi);
app.route("/catalog", catalogApi);
```

For a single-api deployable that defaults to `path: "/"`, the mount
becomes `app.route("/", salesApi)` and the byte-for-byte output is
identical to today.

### 3.3 Frontend wiring — single runtime knob, per-api paths baked at gen-time

The frontend keeps one `API_BASE_URL` runtime knob — the *origin* of
the target backend. Per-api `at` paths are baked into the generated
api-client files at generation time, because (a) the frontend has a
single target, and (b) the path of an api inside a backend doesn't
change at runtime.

```ts
// src/api/config.ts — unchanged shape
export const API_BASE_URL: string =
  fromWindow ?? fromEnv ?? "http://localhost:3000";

// src/api/sales-api.ts — `at: "/sales"` baked into BASE
const BASE = `${API_BASE_URL}/sales`;
export async function listOrders() { return (await fetch(`${BASE}/orders`)).json(); }
```

The runtime cascade
(`window.__LOOM_API_BASE__` → `VITE_API_BASE_URL` → baked default) is
unchanged. The shape of the runtime config is unchanged. Only the
generated client functions change — they prepend `at`-paths.

### 3.4 `targets:` vs `ui: ShopUI { … }` — disambiguation

`targets:` and `UiComposeBinding` both encode "which backend serves
this frontend's apis", and in single-target mode they're redundant.

**Resolution (proposed):**

- Keep `targets:` as the canonical declaration. It's the source of
  truth for module inheritance (`enrichments.ts:511`), the architecture
  diagram (`likec4.ts:46`), and the frontend's `API_BASE_URL`.
- Prefer `ui: ShopUI` (sugar form) over `ui: ShopUI { … }` (compose
  form) in the single-target case. In sugar form, every UI api
  parameter resolves through `targets:` automatically.
- Validator (new): if `UiComposeBinding` is used, every binding's
  deployable ref must equal `targets:`. The compose form is the
  escape hatch reserved for the day multi-target arrives — until then,
  it is allowed but redundant, and the validator points users at the
  sugar form.

This is what removes the awkwardness flagged in the working example
(every binding repeating `shopApi`).

### 3.5 Playground topology — one in-browser Hono with N mounted backends

**`PrepareInput` grows** (`web/src/engine/runtime-engine.ts`):

```ts
interface PrepareInput {
  files: VirtualFile[];
  dependencies: DependencySet;
  backends: Array<{
    deployable: string;       // "shopApi"
    entry: string;            // bundle entrypoint
    mountPath: string;        // "/" when single backend; "/<slug>" for multi
  }>;
  reactEntry?: string;
}
```

**Engine stitching:** bundle each backend independently; mount them all
on one root Hono instance:

```ts
const root = new Hono();
for (const b of bundles) root.route(b.mountPath, b.app);
```

**Frontend wiring in the playground:**

- `window.__LOOM_API_BASE__` is set to the playground's own origin +
  the target deployable's mount path.
- The frontend's per-api `at`-paths nest inside, so
  `fetch('${API_BASE_URL}/sales/orders')` resolves to:
  *playground origin → shopApi mount (`/`) → `/sales` router → handler*.

This deliberately collapses what would be N processes in compose into
one Hono in the browser. It does not model OS-level isolation between
backends and it does not model per-backend ports — neither of which
matter in the browser. It models *routing topology*, which is the
thing that affects the generated code.

**Multi-backend prep:** when backend-to-backend lands later, each
mounted backend is reachable from any other through the same root
Hono — peer URLs become `'/' + peerSlug + peerMountPath` in the
playground vs. `'http://' + peerSlug + ':' + peerPort` in compose.
The generator wires a `__LOOM_PEER_BASES__` map (or env-var equivalent)
that's populated per-runtime, same shape both sides.

---

## 4. End-to-end annotated example

```ddd
system Shop {
  subdomain sales {
    context Sales {
      aggregate Order    { id: OrderId, customer: CustomerId, total: Money }
      aggregate Customer { id: CustomerId, name: String }
    }
  }
  subdomain catalog {
    context Catalog {
      aggregate Product { id: ProductId, name: String, price: Money }
    }
  }

  // Apis are pure projections — no URLs, no ports.
  api SalesApi   from sales
  api CatalogApi from catalog

  storage shopDb { type: postgres, instance: db }
  dataSource salesState   { for: Sales,   kind: state, use: shopDb, schema: "sales"   }
  dataSource catalogState { for: Catalog, kind: state, use: shopDb, schema: "catalog" }

  ui ShopUI {
    api Sales:   SalesApi
    api Catalog: CatalogApi
    // pages elided
  }

  // EDGE BACKEND — multi-api on one process, per-api routing prefixes.
  deployable shopApi {
    platform: node
    contexts: [Sales, Catalog]
    dataSources: [salesState, catalogState]
    serves: SalesApi at "/sales", CatalogApi at "/catalog"
    port: 3000
  }

  // FRONTEND — single target, sugar UI binding.
  // `ui: ShopUI` (no braces) resolves every UI api param through `targets:`.
  // `port:` omitted → auto-fill picks 3001 (react default is free).
  deployable shopWeb {
    platform: react
    targets: shopApi
    ui: ShopUI
  }
}
```

**Lowered deployables:**

```ts
[
  { name: "shopApi", platform: "hono", port: 3000, portWasDeclared: true,
    contextNames: ["Sales", "Catalog"],
    dataSourceNames: ["salesState", "catalogState"],
    serves: [
      { api: "SalesApi",   path: "/sales"   },
      { api: "CatalogApi", path: "/catalog" },
    ],
  },
  { name: "shopWeb", platform: "react", port: 3001, portWasDeclared: false,
    targetName: "shopApi", uiName: "ShopUI",
    uiBindings: [
      { name: "Sales",   source: "shopApi" },   // synthesised from `targets:` (sugar form)
      { name: "Catalog", source: "shopApi" },
    ],
    serves: [],
  },
]
```

**Generated `docker-compose.yml`:** unchanged structure. The host-port
maps to platform internal-port; per-api `at` paths live inside the
backend process, not in compose:

```yaml
services:
  shop_api:
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: "postgres://postgres:postgres@db:5432/shop_api"
  shop_web:
    ports: ["3001:80"]
    environment:
      VITE_API_BASE_URL: "http://shop_api:3000"   # origin only
```

**Generated backend `src/index.ts` (hono):**

```ts
const app = new Hono();
app.get("/ready", (c) => c.text("ok"));
app.route("/sales",   salesApi);
app.route("/catalog", catalogApi);
export default app;
```

**Generated React client:**

```ts
// src/api/config.ts
export const API_BASE_URL: string =
  (globalThis as any).__LOOM_API_BASE__ ??
  (import.meta as any).env?.VITE_API_BASE_URL ??
  "http://localhost:3000";

// src/api/sales-api.ts
const BASE = `${API_BASE_URL}/sales`;
export async function listOrders() { ... }

// src/api/catalog-api.ts
const BASE = `${API_BASE_URL}/catalog`;
export async function listProducts() { ... }
```

**Playground**: one in-browser Hono with `shopApi` mounted at `/`,
React bundle's `__LOOM_API_BASE__` injected to the playground origin.

---

## 5. Migration of existing `.ddd` sources

All four changes are designed to be additive:

| Existing source                                | Behaviour after change |
|---|---|
| `serves: SalesApi`                             | path defaults to `"/"` → byte-identical backend output |
| `serves: SalesApi, CatalogApi` (no `at`)       | paths default to `/sales`, `/catalog` — **observable change** to URLs |
| `port: 3000` on a single hono                  | unchanged |
| Two undeclared hono deployables (silent clash) | validator now errors — **observable change**, surfaces a real bug |
| `ui: ShopUI` (sugar)                           | unchanged |
| `ui: ShopUI { Sales: shopApi }`                | unchanged (validator warns if `Sales` deployable ≠ `targets:`) |

The two **observable changes** are both moves from a broken or
ambiguous state to a defined one. They warrant a single coordinated
release.

---

## 6. Implementation order

Smallest, independent slices first:

1. **Port collision validator + hybrid auto-fill.** Smallest surface;
   unblocks confidence in the rest. No compose/frontend changes.
2. **`serves … at` grammar + IR + backend route mounting** (hono first,
   then dotnet, then phoenix). Single-api deployables emit identical
   output. The multi-api case becomes valid.
3. **Frontend per-api path baking** in the React client generator.
   Runtime config shape unchanged.
4. **Playground multi-backend mounting** (`PrepareInput` shape change,
   engine stitching). Single-backend playground keeps working — it's
   `backends: [{ deployable, entry, mountPath: "/" }]` instead of
   `honoEntry`.

Each slice ships independently and the generated output stays valid
throughout.

---

## 7. Open questions

1. **Auto-fill density: dense (3000, 3001, 3002) or spaced (3000, 3010,
   3020)?** Dense is friendlier URLs and what the current default-port
   convention suggests. Spacing is safer against manual overrides.
   *Recommendation:* dense. Manual override = explicit `port:`.

2. **Reserved port-range warning threshold.** `<1024` (system ports) is
   safe to warn on. Should `<3000` warn too? Probably not — too noisy
   when 8080, 4000 are platform defaults.

3. **Path default for the multi-api case** — kebab(api-name) is fine
   for `SalesApi`/`CatalogApi`. What about names that don't end in
   `Api`? Options: (a) strip a trailing `Api` only if present;
   (b) always kebab the full name. *Recommendation:* (a) — predictable
   for the common convention, full-name for the rest.

4. **`UiComposeBinding` with bindings that don't match `targets:`** —
   warn or error? *Recommendation:* error today (preserves the
   single-target invariant); relax to a deprecation warning the moment
   multi-target is on the table.

5. **Playground backend hot-reload semantics.** Changing one backend's
   source today rebuilds and remounts. With N backends, do we rebuild
   one and swap-route, or rebuild all and remount? *Recommendation:*
   per-deployable rebuild; the root Hono's `app.route(...)` is cheap
   to redo.

6. **Should we surface peer URLs in the IR now, even though
   backend-to-backend is being designed separately?** Tempting, but
   premature — the peer-URL model is the heart of that other proposal.
   This one stays scoped to "what a frontend sees" and "what a single
   backend exposes". A `peers: …` map on `DeployableIR` is for that
   proposal to add.

---

## 8. Forward compatibility — backend-to-backend (out of scope here)

When that proposal lands, the model from this one carries forward
without modification:

- The compose service hostname is already the deployable slug
  (`shop_api`). Backend-to-backend URLs become
  `http://${peerSlug}:${peerPort}${peerServePath}`.
- In the playground, peers reach each other through the same root
  Hono: `${peerMountPath}${peerServePath}`.
- A generated `__LOOM_PEER_BASES__` (or env-var) map on each backend
  resolves to the right shape per runtime — same source-code shape on
  both sides.

The piece *this* proposal does NOT preempt is the DSL surface for
declaring that one backend depends on another. That belongs to the
backend-to-backend proposal.

---

## 9. Why this shape and not another

- **Why `at` on `serves:` rather than `path:` on `api`?** Apis are
  contracts; their hosting deployable owns the URL. The same api can
  in principle be served by multiple deployables (today and in
  future), and forcing one canonical URL onto the contract pre-empts
  that flexibility for no benefit. (User-confirmed: apis are mostly
  1:1 with deployables, so this is a non-cost in the common case.)

- **Why a single `API_BASE_URL` knob, not a per-api map?** Because
  the frontend has a single target by construction. A per-api map
  would let users runtime-override individual apis to different
  hosts, but in single-target mode that's a feature without a
  matching topology — there's nowhere for those different hosts to
  exist.

- **Why hybrid port allocation, not pure manual?** Pure manual forces
  every deployable to spell its port out, which is friction for the
  90% case where the platform default is fine. Pure auto-allocation
  removes user control and makes URLs unstable across edits.

- **Why mount-path-based playground rather than one-Hono-per-iframe?**
  Lower complexity, same external behaviour, no cross-frame
  serialisation, no per-backend port simulation. The thing the
  playground exists to model is *routing topology*, which mount paths
  preserve.

---

## 10. References

- Current pipeline overview: [`docs/technical.md`](../../technical.md).
- Architecture mental model: [`docs/architecture.md`](../../architecture.md)
  (deployable composition).
- Platform contract: [`docs/platforms.md`](../../platforms.md)
  (`PlatformSurface`, `composeService`, `defaultPort`).
- Tooling: [`docs/tools.md`](../../tools.md) (CLI flags, watch mode,
  compose workflow).
