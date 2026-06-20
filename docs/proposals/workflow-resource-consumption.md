# RFC: Workflow-level Resource Consumption

**Status:** Draft / Proposed. Phase 4 of the resource model
([`resource-model-and-source-types.md`](./resource-model-and-source-types.md)).

> **[2026-06-20 status audit]** Shipped well past '4a put/get only' — `callKind: "resource-op"` + `resourceOp` IR field render the full verb set (put/get/list/signedUrl/delete, enqueue/publish, api get/post) on hono/dotnet/java/python/phoenix/vanilla; 4b tests present. Reclassify Draft→PARTIAL.

**Scope:** Define how domain logic *uses* a `resource` — the call surface that
turns the object-store / queue / external-API resources (and their generated
clients) into something a workflow can actually invoke. This is the consumer of
the `ResourceAdapter` clients emitted in Phase 2.4 and the activator of the
`need ⊆ sourceType` capability check and per-resource `interface` selection.

---

## 1. Summary

A `resource` becomes a **capability-typed handle** callable from a workflow body
through a **closed, per-kind verb vocabulary**:

```ddd
workflow ArchiveOrder(order: Order id) {
  let pdf = renderInvoice(order)
  files.put("invoices/" + order.id, pdf)
  jobs.enqueue({ kind: "archived", orderId: order.id })
}
```

- **Ambient handles** — a `resource` whose `for:` matches the workflow's context
  is in scope as an identifier, like `permissions.` / `currentUser` (no new
  declaration syntax).
- **Closed verb set per kind** — `objectStore` exposes `put`/`get`/`list`/
  `signedUrl`/`delete`; `queue` exposes `enqueue`/`publish`; `api` exposes
  `get`/`post`. Verbs are registry-defined and each maps to a `capability`.
- **Capability-gated** — `files.signedUrl(…)` is a validation error unless the
  bound `sourceType` offers the `signedUrl` capability. This is the dormant
  Phase-1 `need ⊆ sourceType` check coming alive: needs now derive from the
  verbs a context actually uses.
- **Vendor-neutral source, per-vendor emission** — the same `.put(…)` lowers to
  an S3 `PutObjectCommand` or a GCS call depending only on the bound
  `sourceType`'s `ResourceAdapter`. This is the payoff of the whole resource
  model.

This mirrors the page-walker design: a closed primitive vocabulary
(`_walker/registry.ts`) with a name-only mirror the validator pins
(`walker-stdlib.ts`), dispatched per-platform.

---

## 2. Decisions baked in (confirmed)

- **Surface = ambient handles.** No new declaration keyword; `files.put(…)` is
  ordinary member-access + call, resolved during lowering. (An explicit `uses:`
  audit clause is a possible additive follow-up, §9 — not in this RFC.)
- **Minimal verbs first**, with room to grow: `objectStore` ships the full
  natural set (`put`/`get`/`list`/`signedUrl`/`delete`), `queue`
  `enqueue`/`publish`, `api` `get`/`post`. New verbs are registry + mirror
  additions, gated by a completeness test.
- **Workflows only.** Resource-ops are allowed in workflow bodies, not in
  aggregate operations (which stay pure-ish domain logic). Revisit if pressure
  appears.
- **No resource-ops inside the transactional span.** An `objectStore.put` cannot
  roll back with the DB transaction, so a resource-op inside a
  `transactional(…)` workflow's transactional block is a validation error with a
  clear message pointing at the outbox pattern. Resource-ops before/after the
  transactional span are fine.
- **The need layer stays implicitly derived** — usage now feeds it; no
  user-facing `requires:`.

---

## 3. Surface syntax

A resource handle is the resource's name, ambient in any workflow whose context
matches the resource's `for:`. Verbs are method-call syntax on the handle:

```ddd
resource files { for: Sales, kind: objectStore, use: s3Bucket }
resource jobs  { for: Sales, kind: queue,       use: rabbit }
resource rates { for: Sales, kind: api,         use: fxApi }

workflow PlaceOrder(cmd: PlaceOrderCmd) {
  let order = Order.create(cmd)
  rates.get("/usd/" + cmd.currency)        // api.get → json
  files.put("orders/" + order.id, order.toJson())
  jobs.enqueue({ event: "placed", id: order.id })
}
```

No grammar change is required for the call form — the expression grammar already
parses `name.verb(args)`. The work is in resolution, validation, and emission.

### 3.1 Verb vocabulary (v1)

Registry-defined, one table per kind. Each verb declares its required
`capability`, parameter types, and result type:

| kind | verb | capability | signature |
|---|---|---|---|
| `objectStore` | `put` | `blob` | `(key: string, body: json) → void` |
| | `get` | `blob` | `(key: string) → json?` |
| | `list` | `list` | `(prefix: string) → string[]` |
| | `signedUrl` | `signedUrl` | `(key: string) → string` |
| | `delete` | `blob` | `(key: string) → void` |
| `queue` | `enqueue` | `enqueue` | `(message: json) → void` |
| | `publish` | `publish` | `(topic: string, message: json) → void` |
| `api` | `get` | `request` | `(path: string) → json` |
| | `post` | `request` | `(path: string, body: json) → json` |

**4a ships `objectStore` `put` / `get` only**, carrying `json` (the type Phase 2
already has) rather than `bytes` — so a workflow can produce a value to store with
no `extern` dependency and 4a is a self-contained vertical. `list` / `signedUrl` /
`delete` land in 4b; a `bytes` payload (for true binary blobs) is introduced later,
once domain code has a producer for it (an `extern` handler or an encoding
surface). The vocabulary lives in
`src/ir/resource-verbs.ts` (the data) with a name-only mirror pinned by a
completeness test, mirroring `walker-stdlib.ts`.

---

## 4. Pipeline threading

1. **Grammar** — no new keywords. `bytes` may be added to the primitive type
   list if not present.
2. **Lower (`lower-expr.ts`)** — a bare name resolving to an in-context resource
   lowers to `RefIR { refKind: "resource", resourceName, kind }`; a `.verb(args)`
   call on it lowers to `callKind: "resource-op"` carrying
   `{ resourceName, kind, verb, capability, interface }`. The `interface` is
   taken from `EnrichedSystemIR.resourceInterfaces` (Phase 3), with a
   per-call override hook for verb-specific needs (e.g. a browser-facing
   `signedUrl` may force `rest` over `sdk`).
3. **Enrich (`enrichments.ts`)** — `deriveNeeds` gains a second source: scan
   workflow bodies for `resource-op` calls and union their capabilities into the
   `(context, kind)` `NeedIR`. Needs become *usage-derived*, not just
   persistence-derived.
4. **Validate (`validate.ts`)** —
   - resource in scope for the workflow's context (else "no resource of kind X
     for context Y");
   - verb belongs to the kind's vocabulary;
   - `need.capabilities ⊆ sourceType.capabilities` (now load-bearing);
   - argument/result types match the verb signature;
   - no resource-op inside a transactional span.
5. **Emit** — `ResourceAdapter` grows `emitOperation(call, resource, ctx): Lines`.
   The body renderers (`render-expr` / `render-stmt`) dispatch a `resource-op`
   call to the bound adapter. Hono examples:
   - `files.put(k, v)` → `await files.send(new PutObjectCommand({ Bucket: filesBucket, Key: k, Body: v }))`
   - `jobs.enqueue(m)` → `await enqueueOn(jobs, m)` (a helper the client module exports)
   - `rates.get(p)` → `await rates.fetch(p).then((r) => r.json())`

   The adapter owns the verb→SDK mapping, so a different `sourceType` for the
   same kind emits different code from identical source.

---

## 5. Async & errors

Resource-ops are I/O: in TS they render with `await`, so any workflow body
containing one is async. Loom workflows already have an async/transactional
notion; a body transitively containing a `resource-op` is marked async and
`await` threads through `render-stmt`. Failures surface as a `ResourceError`
domain error mapped to a 5xx envelope, consistent with the existing
`ExternHandlerError` pattern. The `.NET` and Phoenix `ResourceAdapter`s follow
hono (per-platform, additive).

---

## 6. Examples

### 6.1 Object store

```ddd
workflow ArchiveInvoice(order: Order id) {
  let pdf = renderInvoice(order)
  files.put("invoices/" + order.id + ".pdf", pdf)
}
```
→ S3 `PutObjectCommand` (interface `sdk`).

### 6.2 Signed URL for a browser flow

```ddd
workflow ShareInvoice(order: Order id) {
  let url = files.signedUrl("invoices/" + order.id + ".pdf")
  // returned to the caller; browser downloads directly
}
```
`signedUrl` requires the `signedUrl` capability (s3 offers it); may resolve
interface `rest`.

### 6.3 Queue + API in one workflow

```ddd
workflow PlaceOrder(cmd: PlaceOrderCmd) {
  let fx = rates.get("/rate/" + cmd.currency)       // api → json
  let order = Order.create(cmd, fx)
  jobs.enqueue({ event: "placed", id: order.id })    // queue
}
```

---

## 7. Validation catalog

- `loom.resource-out-of-scope` — no resource of the named kind for the context.
- `loom.resource-unknown-verb` — verb not in the kind's vocabulary.
- `loom.resource-capability-gap` — bound sourceType lacks the verb's capability.
- `loom.resource-arg-type` — argument/result type mismatch vs the verb signature.
- `loom.resource-op-in-transaction` — resource-op inside a transactional span.

---

## 8. Phasing

- **4a** ✓ — `objectStore` `put`/`get` (carrying `json`) on hono: lowering +
  validation + usage-derived needs + async threading, delivered end to end.
  Notes vs the sketch: the verb registry (`src/ir/resource-verbs.ts`) needs no
  language-side mirror because resource-op validation runs in the IR layer; the
  s3 adapter emits per-resource async verb helpers (`<resource>$put`/`$get`) and
  call sites render `(await …)`, rather than threading adapter context into
  `render-expr`. Unknown-verb and no-op-in-transactional-span are the active
  validations; the capability gap rides the Phase-1 `need ⊆ sourceType` check.
- **4b** ✓ — `objectStore` `list`/`signedUrl`/`delete`, plus `queue`
  (`enqueue`/`publish`) and `api` (`get`/`post`) on hono, with the per-verb
  interface override (`signedUrl`→`rest`, threaded onto `resourceOp.interface`).
  The s3 adapter gains the presigner dep; rabbitmq emits a cached-channel
  enqueue/publish; restApi emits fetch get/post. **(Resolved)** the earlier
  object-literal limitation — `enqueue({ id })` — was a narrow grammar bug:
  `ObjectFieldInit` keyed on bare `ID`, so a reserved field name like `id`/`kind`
  failed (`{ foo: x }` worked). Fixed by keying the field on `LooseName` (the
  soft-keyword set `EmitField`/`ThemeProp` already use), so structured json
  payloads now parse — no resource-specific change needed.
- **4c** ✓ — `.NET` (#752) + Phoenix (#754) `ResourceAdapter`s for the same
  verbs, each verified by its `build-generated-*` CI gate.
- **4d (optional)** — explicit `uses:` / `requires:` authoring on top of the
  proven implicit derivation.

Each phase: parsing + negative-validator + generator tests; `LOOM_TS_BUILD`
(then dotnet/phoenix) build gates; byte-identical fixtures for models that use
no resource-ops.

---

## 9. Open questions

1. **`bytes` representation (post-4a)** — `Uint8Array` / `Buffer` in TS,
   `byte[]` / `Stream` in .NET; how is it produced by domain code (only from
   other resource-ops and `extern` handlers, or a literal/encoding surface)?
   Deferred — 4a uses `json`, so this is only relevant when binary blobs land.
2. **Result binding ergonomics** — `let x = files.get(k)` returns `bytes?`; how
   do downstream uses narrow it?
3. **Queue message typing** — opaque `json` (v1) vs a declared message schema per
   queue resource (richer, later).
4. **Per-call interface override syntax** — implicit (derive from verb) vs an
   explicit annotation; v1 leans implicit.
5. **Cross-context resources** — can a workflow reach a resource bound to another
   context, or strictly its own? (v1: own context only.)
