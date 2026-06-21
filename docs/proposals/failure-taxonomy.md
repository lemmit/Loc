# Failure taxonomy — error handling, reconsidered

> **[2026-06-20 status audit]** The `?` surface-only slice is ALREADY REMOVED (no `PropagateExpr`/`propagate` in `src/`), not 'slated for removal'.

> Status: proposal (design note). **Revisits**:
> [`exception-less.md`](./exception-less.md). That proposal shipped in
> slices A1–A3 (`or`-unions, the `error` payload keyword, root-level
> payloads, `httpStatus` edge mapping, the `?` propagation operator
> surface, Hono + .NET producer translation). This note steps back from
> those slices and asks what the *whole* error story should be, not
> just the next increment. The reconsideration of `?` it called for has
> since been **decided: the `?` operator is dropped** (maintainer,
> 2026-06-10 — its shipped surface-only slice is slated for removal;
> see the exception-less status header and the global plan's T1.2).
> Everything else that shipped stands; this note reframes it.
>
> **Scope note:** this note (with `exception-less.md`) owns the **backend**
> error→status mapping. The **frontend** global error boundary and the
> two-tier unification over one error vocabulary are
> [`error-handling-and-failure-sink.md`](./error-handling-and-failure-sink.md)
> ("Proposal C"), which defers its backend half here.

## TL;DR

The exception-less proposal **got the structure right and the
ergonomics wrong.**

- **Right (keep):** errors are data with names, visible in the
  signature; the domain is HTTP-blind and status is declared once at
  the edge (`httpStatus`); bugs throw → 500 while expected failures
  return a carrier shape (the two-regime split); inter-layer
  visibility follows the dependency direction; error→error translation
  is opt-in and inline.
- **Wrong (drop / reconsider):** the FP-ergonomics accretion — the
  carrier-monad stdlib (`.map`/`.orError`, exception-less A7) and the
  overloaded `?` propagation operator (A2). `?` does three jobs
  (absence, error short-circuit, ternary) and reads like "a method
  call on a maybe-null value." It is the most questionable piece that
  shipped.
- **Add (the highest-leverage missing investment):** route
  **value-object validation** to its own status. Validation is *not* a
  new construct — a value object already takes an `invariant`, and
  value construction runs it (grammar: `ValueObjectMember = Property |
  DerivedProp | Invariant | FunctionDecl`). The only missing piece is
  **mapping a VO-construction `invariant` failure to 422** instead of
  letting it fall to the generic 500/400 path. Most "errors" in a
  CRUD-ish system are malformed input; pulling that whole category onto
  the value object (and giving it a 422) is what keeps the `or`-unions
  small enough that the rest of the scheme reads cleanly. (A richer
  string-constraint operator like regex `matches` would be its *own*
  small proposal — not bundled here.)

The reframing: **stop calling it "exception-less" and call it a
*failure taxonomy*.** There are five kinds of failure; each gets the
lightest mechanism that fits, and they do not overlap.

## The five failure kinds

| Kind | Meaning | Mechanism | In a signature? | Maps to |
|---|---|---|---|---|
| **Absence** | the thing asked for isn't there | `T?` → native nullable + `match`/narrowing | no (it's the value's own shape) | `null` / 404-on-load |
| **Validation** | input is malformed | value-object `invariant`, run at construction | no (auto-surfaced) | 422 |
| **Expected domain failure** | a legitimate "no", the caller must branch on | `or`-union return + `match` | **yes** | declared status at the edge |
| **Bug** | an aggregate `invariant` is false → the program is wrong | aggregate `invariant` → **throw** | no | 500 |
| **Integration** | a downstream dependency failed | isolated infra result, translated inline at the boundary | only as the translated domain error | 502 / mapped |

The load-bearing line is between **expected domain failure** (returns,
is in the signature, caller branches) and **bug** (throws, is nowhere
in the signature, caller never "handles" it). The test is one
question: *could a correct caller do anything about this other than
crash?* If yes → union. If no → throw.

`match` is the single branching construct for both absence and
expected-failure. No sigil does three jobs.

### The throw paths are not all "bug" — status follows *which construct*

"Validation" and "bug" both ultimately throw, but Loom already has
**four distinct guard constructs**, and the right status falls out of
*which one* fired and *whose fault* the violation is. None of this is a
new keyword:

| Construct (shipped) | Checks | A violation means | Status |
|---|---|---|---|
| value-object `invariant` | a value's shape, at construction | the client sent a malformed value | **422** *(proposed routing)* |
| operation/workflow `precondition` | a request's domain validity | the request is invalid in context | **400** *(shipped)* |
| `requires` | the caller's authorization | not allowed | **403** *(shipped)* |
| aggregate `invariant` | a postcondition our own code must preserve | **our** bug | **500** |

So "validation vs bug" is really *where the `invariant` lives*: on a
**value object** (fires against raw input → 422) versus on an
**aggregate** (a postcondition → 500). The `precondition`/`requires`
pair (400/403) are the two other already-shipped throw paths. The only
new work is the 422 routing for VO-construction failures.

## Worked example

> **Illustrative — mixes shipped and proposed syntax.** Shipped here:
> `or`-union return types, `httpStatus <Error> <Int>`, value-object /
> aggregate `invariant`, `precondition`. **Proposed / not-yet-real**,
> called out inline: (a) routing a VO `invariant` failure to 422;
> (b) discriminating an `or`-union result — Loom's `match` today is a
> boolean-guard form (`match { cond => …, else => … }`) with **no
> variant-pattern binding**, so the variant `match` below is a sketch,
> not current grammar (see open questions); (c) qualified cross-context
> error references (`Payments.PaymentDeclined`).

```ddd
// ── Ambient transport kernel (root-level, shared across contexts) ──
// Content-free shapes no single context owns — the genuine shared kernel.
error NotFound      { resource: string }
error AlreadyExists { key: string }

context Payments {
  // A domain failure OWNED by the context whose ubiquitous language it
  // belongs to — NOT hoisted to root (that would leak Payments' vocabulary
  // into every context's namespace, the error-kernel equivalent of putting
  // `Order` in the shared kernel).
  error PaymentDeclined { reason: string }
  api charge(amount: Money): Receipt or PaymentDeclined
}

context Checkout {
  // VALIDATION kind: a value-object `invariant`, run at construction.
  // No new keyword — this is the shipped VO invariant. The proposed part
  // is only that a construction failure maps to 422 (not the generic path).
  // (`value > 0` is a real predicate; richer string constraints like a
  // regex `matches` would be a separate operator proposal.)
  valueobject Quantity { value: int  invariant value > 0 }

  aggregate Order ids guid {
    customer: string
    lines: OrderLine[]
    status: OrderStatus
    couponCode: string?            // ABSENCE — native nullable, no Option<T> wrapper

    // BUG regime: an aggregate invariant is a postcondition our own code
    // must preserve. If ever false, the program is wrong → THROW → 500.
    // Not in any signature. (invariant takes no message string.)
    invariant lines.count > 0

    // EXPECTED-FAILURE regime: a legitimate "no" the caller branches on →
    // IN THE SIGNATURE as an or-union. Checkout depends on Payments, so it
    // may name Payments.PaymentDeclined (dependency direction permits it).
    operation submit(): Confirmation or Payments.PaymentDeclined {
      // domain-validity guard on the transition → 400 (shipped `precondition`,
      // no message string). Submitting a non-draft order is a client mistake,
      // not a bug — hence 400, not 500.
      precondition status == Draft

      // INTEGRATION failure stays isolated to the infra boundary and is
      // translated INLINE to our vocabulary — no downstream codes leak up.
      // (variant-`match` is a sketch — see the disclaimer above.)
      match {
        payments.charge(this.total()).declined => return Payments.PaymentDeclined { reason: "declined" }
        else => {}
      }
      status := Submitted
      return Confirmation { orderId: id }
    }
  }

  repository Orders for Order {
    find byId(id: guid): Order?               // absence → nullable by default
    find required(id: guid): Order or NotFound // opt into the union when null is useless
  }
}

// ── HTTP lives at the edge, declared, never in the domain.
// `httpStatus <Error> <Int>` — bare error id + status int (no arrow). ──
api OrdersApi for Checkout {
  httpStatus NotFound        404
  httpStatus AlreadyExists   409
  httpStatus PaymentDeclined 402
  // Quantity VO-invariant failure → 422 (proposed). Aggregate invariant → 500.
  // precondition failure → 400.
}
```

### Generated shape (Hono/TS, abridged)

```ts
// domain/order.ts — pure, HTTP-blind, no Option<T>
submit(): SubmitResult {
  if (this.status !== "Draft")
    throw new InvariantViolation("submit is only valid on a draft order"); // → 500
  const charge = this.payments.charge(this.total());
  if (charge.kind === "Refused")
    return { kind: "PaymentDeclined", reason: charge.message };            // inline translation
  this.status = "Submitted";
  return { kind: "Confirmation", orderId: this.id };
}

// routes — the ONE place status codes appear (driven by the api block)
const r = order.submit();
switch (r.kind) {
  case "Confirmation":    return c.json(r, 200);
  case "PaymentDeclined": return c.json(problem(r, 402), 402);
}
// couponCode serializes as `string | null` — no wrapper, no special
// (de)serialization. A Quantity built from a bad value throws its VO
// invariant before this runs (→ 422); a violated aggregate invariant is
// caught by one middleware → 500; a failed precondition → 400.
```

`option` / `T?` **erases to native nullability** in every backend
(`string | null` in TS, `string?` in C#) — there is no `Option<T>`
wrapper in generated code. Canonicalize on `optional` in lowering;
the binary `[T, none]` union special-cases to native nullable in the
flow helpers, not in the serializers.

## Where errors live — the layering, settled

The classic three-layer error stack (domain / application / api) does
**not** grow a new namespace. It lands on the constructs Loom already
has, because *a layer you don't author is a layer that doesn't declare
errors* — it routes them.

| Layer | Authored error home? | Construct | Generated into |
|---|---|---|---|
| Domain (single aggregate) | yes | `operation … or E` | `<Ctx>/Domain/` |
| Domain (cross-aggregate rule) | yes | `service … or E` (see [`domain-service.md`](./domain-service.md)) | `<Ctx>/Domain/` |
| Application (cross-aggregate use case) | yes | `workflow … or E` | `<Ctx>/Application/` |
| API (public exposure) | yes, **off by default** | `api { error … expose … }` | `<Ctx>/Api/` (controller/route) |
| Policy (authz / concurrency / load / rate-limit / malformed) | **no** | declarative on the operation | synthesized in the handler |
| Status / exposure | n/a (declarative) | `httpStatus` on `api` | controller/route |

> The **domain-service** row was originally folded into "application"
> here; [`domain-service.md`](./domain-service.md) separates it out. The
> discriminator: a failure detectable over domain objects already in
> hand (no repository load) is a *domain* rule (`service`); one that
> needs to fetch state is a *use-case* concern (`workflow`).

Notes that fell out of the discussion:

- **Root vs context placement is a modelling decision, enforced by
  generated layout.** Ambient errors (`NotFound`) emit once into a
  shared kernel project everyone references; context errors
  (`PaymentDeclined`) emit *into* the owning context's project and
  can't be named from another context without an explicit dependency.
  The physical file placement *is* the proof of the layering.
- **Inter-context errors follow dependency direction.** Checkout →
  Payments is allowed, so Checkout may name `Payments.PaymentDeclined`;
  Payments may not name anything from Checkout (an upward edge → hard
  error, same machinery as the pipeline-layering guard). At that
  boundary the caller *chooses* per call: re-expose the downstream
  error, or translate it inline — the `match` arm is the seam.
- **Application errors have a real home: the `workflow`.** A failure
  meaningful only *across* aggregates ("coupon already redeemed by
  another order") is a use-case concern, declared on the workflow,
  scoped to its context. Almost everything else people cram into
  "application errors" is really **policy** (authz, optimistic-lock
  conflict, not-found-on-load) — declarative, auto-mapped, never named.
- **Custom API errors are real but off by default.** They split two
  ways. *Protocol-mechanical* (401 / 429 / 413 / 406 / malformed body)
  → generated middleware, never declared. A *public error contract*
  deliberately decoupled from internal vocabulary (versioned APIs,
  partner integrations, security-driven flattening) → declared on the
  `api` block (`error PublicFault { … }` + `expose <Internal> as …`),
  translated at the controller layer only. Default: **don't** — in
  Loom errors are already data with stable names + RFC-7807 `type`
  URIs, so the domain vocabulary is a fine public contract until it
  must diverge.

The whole layering is three optional declaration sites, each tied to a
construct that already exists (`operation` / `workflow` / `api`), plus
one declarative bucket for everything routed rather than named.

## Verdict against the shipped slices

| Slice | What shipped | Verdict |
|---|---|---|
| A1 `or`-unions + `error` payloads + root payloads | merged | **keep** — the structural core |
| A1 `httpStatus` edge mapping | merged | **keep** — domain stays HTTP-blind |
| Two-regime (invariants throw, rest returns) | merged (validator-enforced) | **keep**, reframed as bug vs expected-failure |
| A2 `?` propagation operator | merged (gated, Hono + .NET) | **reconsider / likely drop** — overloaded; `match` covers its cases more legibly |
| A3 Hono + .NET producer translation | merged | **keep** |
| A3 Phoenix translation | deferred | leave deferred |
| A7 carrier-monad stdlib (`.map`/`.orError`) | not shipped | **drop** — operations are short; the union is read by a `match` one frame up, so the monad never earns its keep |
| Validation → 422 | the VO `invariant` construct is **shipped**; 422 routing is not | **add only the routing** — map a VO-construction invariant failure to 422 (no new `validate` keyword; that was a hallucination in an earlier draft) |
| A4 find re-shape (`: X` → `X or NotFound`) | partial | **soften** from law to *default + `: X?` opt-out* |

## Open questions (for the "think further" pass)

1. **`?` — drop, or keep narrowly?** If kept, restrict it to a single
   job (error short-circuit only) and forbid the absence/ternary
   overloads, or replace entirely with `match` + a `guard … else`
   early-return form. Lean: drop; reassess only if real bodies turn
   out verbose under pure `match`.
2. **Validation → 422 routing.** The construct is settled (the VO
   `invariant`); the work is the *status mapping*: how does a
   VO-construction failure surface as 422 (vs the generic 400/500), and
   how does a multi-field-bad payload render (one 422 with a field
   list, à la RFC-7807 `errors[]` from `validation-error-extension.md`)?
3. **`or`-union consumption — the missing variant-`match`.** Shipped
   Loom has `or`-union *types* but no way to *discriminate* a result:
   `match` is boolean-guard-only (`match { cond => …, else => … }`),
   with no scrutinee and no variant binding, and there is no `is`/
   variant-pattern operator. Every example in this doc (and the
   exception-less premise) leans on pattern-matching a union — so a
   variant-`match` is a real prerequisite, not a nicety. Noted here as
   an open exception-less gap rather than a blocker, per the "land it
   for now" call.
4. **`expose` / public-contract syntax.** Concrete grammar for the
   `api`-block error translation, and whether it's worth shipping at
   all before a consumer needs it.
5. **`option` erasure corners.** `T??` (optional-of-optional),
   optional inside a union variant, and OpenAPI `nullable` emission
   parity across the four backends.
6. **Workflow error ergonomics.** Confirm `workflow … or E` reads and
   lowers like `operation … or E`, and that `?`-free `match` is
   pleasant in a multi-step handler.
